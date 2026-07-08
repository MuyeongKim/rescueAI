import { getChatModel } from "@/lib/llm";
import {
  createDataStreamResponse,
  streamText,
  convertToCoreMessages,
  formatDataStreamPart,
  type Message,
} from "ai";
import { createClient } from "@/lib/supabase/server";
import { searchContext, buildSystemPrompt } from "@/lib/rag";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { DEMO, demoChatAnswer, demoChatSources } from "@/lib/demo";
import type { DocSource } from "@/lib/database.types";

export const maxDuration = 60;

export async function POST(req: Request) {
  // 데모 모드: Anthropic/Supabase 없이 정해진 답변을 스트리밍
  if (DEMO) {
    return createDataStreamResponse({
      execute: async (dataStream) => {
        dataStream.writeData({ type: "conversationId", value: "demo-conv" });
        const parts = demoChatAnswer.match(/[\s\S]{1,6}/g) ?? [demoChatAnswer];
        for (const p of parts) {
          dataStream.write(formatDataStreamPart("text", p));
          await new Promise((r) => setTimeout(r, 35));
        }
        dataStream.writeMessageAnnotation({
          messageId: 1,
          conversationId: "demo-conv",
          sources: demoChatSources,
        });
      },
    });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // LLM 호출 남용 방지 (분당 30회/사용자)
  const rl = rateLimit(`chat:${user.id}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  let body: {
    messages?: Message[];
    conversationId?: string;
    category?: string | null;
    model?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // 클라이언트가 주입한 system/tool 메시지 제거 — 환각 가드레일(§9.2)은 서버(buildSystemPrompt)가
  // 단독으로 넣는다. user/assistant 만 남겨 클라이언트가 시스템 지시를 덮어쓰지 못하게 한다.
  const messages: Message[] = (body.messages ?? []).filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  const category: string | null = body.category ?? null;
  const modelKey: string | undefined = body.model || undefined;

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = (lastUser?.content ?? "").toString().trim();
  if (!question) return new Response("질문이 비어 있습니다.", { status: 400 });

  // 1~3) RAG 검색 + 컨텍스트 조립 (실패 시 빈 컨텍스트로 우아하게 강등)
  let contextText = "";
  let sources: DocSource[] = [];
  try {
    const r = await searchContext(question, category);
    contextText = r.contextText;
    sources = r.sources;
  } catch (e) {
    console.error("[chat] RAG 실패 — 컨텍스트 없이 진행:", e);
  }

  // 7) 대화 보장 (없으면 신규 생성, 제목=첫 질문 앞부분)
  // conversations 테이블 미생성(마이그레이션 전) 시에도 답변은 가능해야 한다 —
  // 저장 없이 임시 대화로 강등(기록·과거 대화 재열람만 비활성).
  let conversationId = body.conversationId;
  let ephemeral = conversationId?.startsWith("temp-") ?? false;
  if (!conversationId) {
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({ user_id: user.id, title: question.slice(0, 40) })
      .select("id")
      .single();
    if (error || !conv) {
      console.error("[chat] 대화 저장 불가 — 임시 대화로 진행:", error?.message);
      ephemeral = true;
      conversationId = `temp-${Date.now()}`;
    } else {
      conversationId = conv.id;
    }
  }
  const convId: string = conversationId;

  // 6) user 메시지 선행 저장 (스트림 실패해도 질문은 보존)
  if (!ephemeral) {
    await supabase
      .from("messages")
      .insert({ conversation_id: convId, role: "user", content: question });
  }

  const startedAt = Date.now();
  const system = buildSystemPrompt(contextText);

  // 4~5) Claude 스트리밍 + 메타데이터(conversationId, sources) 전달
  return createDataStreamResponse({
    execute: (dataStream) => {
      // 클라이언트가 신규 대화 id를 즉시 인지하도록 전송 (임시 대화는 URL 교체 안 함)
      if (!ephemeral) {
        dataStream.writeData({ type: "conversationId", value: convId });
      }

      const result = streamText({
        model: getChatModel(modelKey),
        system,
        messages: convertToCoreMessages(messages),
        temperature: 0.2,
        onFinish: async ({ text }) => {
          const latencyMs = Date.now() - startedAt;
          let saved: { id: number } | null = null;
          if (!ephemeral) {
            const { data, error } = await supabase
              .from("messages")
              .insert({
                conversation_id: convId,
                role: "assistant",
                content: text,
                sources: sources.length > 0 ? sources : null,
                latency_ms: latencyMs,
              })
              .select("id")
              .single();
            if (error) console.error("[chat] assistant 저장 실패:", error.message);
            saved = data;
          }

          // assistant 메시지에 출처/저장 id를 annotation으로 부착 (§8.1 응답)
          dataStream.writeMessageAnnotation({
            messageId: saved?.id ?? null,
            conversationId: convId,
            sources,
          });
        },
      });

      // 클라이언트가 중간에 끊거나(Stop·탭 닫기) 연결이 끊겨도 스트림을 끝까지 소비해
      // onFinish(assistant 메시지 저장)가 반드시 실행되게 한다. 없으면 질문만 남고 답변 유실.
      result.consumeStream();
      result.mergeIntoDataStream(dataStream);
    },
    onError: (error) => {
      console.error("[chat] stream error:", error);
      return error instanceof Error
        ? error.message
        : "답변 생성 중 오류가 발생했습니다.";
    },
  });
}
