import { getChatModel } from "@/lib/llm";
import {
  createDataStreamResponse,
  streamText,
  convertToCoreMessages,
  formatDataStreamPart,
  type Message,
} from "ai";
import { createClient } from "@/lib/supabase/server";
import { requireApiUser } from "@/lib/auth";
import { prepareChatAnswerText, uniqueChatSources } from "@/lib/chat-answer";
import { trimChatHistory } from "@/lib/chat-history";
import { buildRetrievalQuestion } from "@/lib/chat-retrieval-query";
import { answerPlanGuidance, buildChatAnswerPlan } from "@/lib/chat-answer-plan";
import { searchContext, buildSystemPrompt, NOT_FOUND_MESSAGE } from "@/lib/rag";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { DEMO, demoChatAnswer, demoChatSources } from "@/lib/demo";
import type { DocSource } from "@/lib/database.types";

export const maxDuration = 60;

export async function POST(req: Request) {
  // 데모 모드: Anthropic/Supabase 없이 정해진 답변을 스트리밍
  if (DEMO) {
    return createDataStreamResponse({
      execute: async (dataStream) => {
        dataStream.writeData({ type: "conversationId", value: "demo-conv-1" });
        const parts = demoChatAnswer.match(/[\s\S]{1,6}/g) ?? [demoChatAnswer];
        for (const p of parts) {
          dataStream.write(formatDataStreamPart("text", p));
          await new Promise((r) => setTimeout(r, 35));
        }
        dataStream.writeMessageAnnotation({
          messageId: 1,
          conversationId: "demo-conv-1",
          sources: demoChatSources,
        });
      },
    });
  }

  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;
  const user = auth.user;

  // LLM 호출 남용 방지 (분당 30회/사용자)
  const rl = rateLimit(`chat:${user.id}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  let body: {
    messages?: Message[];
    conversationId?: string;
    category?: string | null;
    model?: string;
    clientRequestId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  if (!body || typeof body !== "object") return new Response("질문 요청 형식을 확인해 주세요.", { status: 400 });
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    (body.clientRequestId !== undefined && (typeof body.clientRequestId !== "string" || !uuid.test(body.clientRequestId))) ||
    (body.conversationId !== undefined && (typeof body.conversationId !== "string" || !uuid.test(body.conversationId))) ||
    (body.category != null && typeof body.category !== "string") ||
    (body.model !== undefined && typeof body.model !== "string")
  ) return new Response("질문 요청 정보를 확인해 주세요.", { status: 400 });
  const clientRequestId = body.clientRequestId ?? crypto.randomUUID();

  // 클라이언트가 주입한 system/tool 메시지 제거 + 개수·길이 상한 (lib/chat-history.ts).
  // 환각 가드레일(§9.2)은 서버(buildSystemPrompt)가 단독으로 넣는다.
  const messages: Message[] = trimChatHistory<Message>(body.messages).map((message) =>
    message.role === "assistant"
      ? { ...message, content: prepareChatAnswerText(String(message.content ?? "")) }
      : message
  );
  const category: string | null = body.category ?? null;
  const modelKey: string | undefined = body.model || undefined;

  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const question = (lastUser?.content ?? "").toString().trim();
  if (!question) return new Response("질문이 비어 있습니다.", { status: 400 });
  // 사용자는 분야나 검색어를 다시 지정하지 않아도 된다. "준비물은?" 같은 후속 질문은
  // 최근 독립 주제를 서버가 복원해 검색하고, LLM에는 원래 대화 흐름을 그대로 전달한다.
  const retrievalQuestion = buildRetrievalQuestion(messages);

  // 재시도는 같은 질문 행을 재사용한다. 키 조회도 세션 클라이언트/RLS를 통과하며,
  // 다른 사용자의 키를 추측한 충돌은 질문 내용이나 대화 ID를 반환하지 않는다.
  const findRequest = () => supabase.from("messages")
    .select("conversation_id, content")
    .eq("client_request_id", clientRequestId)
    .eq("role", "user")
    .maybeSingle();
  const { data: previous, error: lookupError } = await findRequest();
  if (lookupError) {
    console.error("[chat] 질문 복구 상태 조회 실패:", lookupError.message);
    return new Response("질문 저장 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.", { status: 503 });
  }
  if (previous && (previous.content !== question || (body.conversationId && previous.conversation_id !== body.conversationId))) {
    return new Response("같은 요청 번호로 질문을 변경할 수 없습니다.", { status: 409 });
  }
  let conversationId = previous?.conversation_id ?? body.conversationId;
  if (conversationId) {
    const { data: owned, error } = await supabase.from("conversations")
      .select("id").eq("id", conversationId).eq("user_id", user.id).maybeSingle();
    if (error) return new Response("대화를 확인하지 못했습니다.", { status: 503 });
    if (!owned) return new Response("대화를 찾을 수 없습니다.", { status: 404 });
  }
  if (!conversationId) {
    // 첫 요청의 응답이 유실되어도 같은 UUID의 대화를 재사용한다. 동시 재시도에도
    // 내용 없는 대화가 중복 생성되지 않으며, 기존 행의 소유권은 다시 확인한다.
    const { data: conv, error } = await supabase
      .from("conversations")
      .insert({ id: clientRequestId, user_id: user.id, title: question.slice(0, 40) })
      .select("id")
      .single();
    if (error?.code === "23505") {
      const { data: owned } = await supabase.from("conversations")
        .select("id").eq("id", clientRequestId).eq("user_id", user.id).maybeSingle();
      if (!owned) return new Response("질문 요청을 확인하지 못했습니다.", { status: 409 });
      conversationId = owned.id;
    } else if (error || !conv) {
      console.error("[chat] 대화 저장 실패:", error?.message);
      return new Response("대화를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", { status: 503 });
    } else {
      conversationId = conv.id;
    }
  }

  // 6) user 메시지 선행 저장 (스트림 실패해도 질문은 보존)
  if (!previous) {
    const { error: umErr } = await supabase
      .from("messages")
      .insert({ conversation_id: conversationId, role: "user", content: question, client_request_id: clientRequestId });
    if (umErr?.code === "23505") {
      const { data: concurrent, error } = await findRequest();
      if (error || !concurrent || concurrent.content !== question || concurrent.conversation_id !== conversationId) {
        return new Response("질문 요청을 확인하지 못했습니다.", { status: 409 });
      }
    } else if (umErr) {
      console.error("[chat] user 메시지 저장 실패:", umErr.message);
      return new Response("질문을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", { status: 503 });
    }
  }
  const convId = conversationId;

  const startedAt = Date.now();

  // 4~5) Claude 스트리밍 + 메타데이터(conversationId, sources) 전달
  return createDataStreamResponse({
    execute: async (dataStream) => {
      // 검색을 기다리는 동안에도 저장된 질문의 복구 주소를 먼저 전달한다.
      dataStream.writeData({ type: "conversationId", value: convId });
      let contextText = "";
      let sources: DocSource[] = [];
      let ragFailed = false;
      try {
        const r = await searchContext(retrievalQuestion, category);
        contextText = r.contextText;
        sources = r.sources;
        ragFailed = r.degraded ?? false;
      } catch (e) {
        ragFailed = true;
        console.error("[chat] RAG 인프라 장애 — 컨텍스트 없이 진행:", e);
      }
      const system = buildSystemPrompt(contextText, answerPlanGuidance(buildChatAnswerPlan(retrievalQuestion)));

      const result = streamText({
        model: getChatModel(modelKey),
        system,
        messages: convertToCoreMessages(messages),
        temperature: 0.2,
        onFinish: async ({ text }) => {
          const latencyMs = Date.now() - startedAt;
          const answerText = prepareChatAnswerText(text);
          if (!answerText.trim()) return;
          // "확인되지 않습니다" 답변에는 출처를 붙이지 않는다(검색됐지만 무관한 출처가
          // 근거 없음 답변과 모순되어 보이는 문제 방지).
          const effectiveSources = answerText.includes(NOT_FOUND_MESSAGE)
            ? []
            : uniqueChatSources(sources);
          let saved: { id: number } | null = null;
          {
            const { data, error } = await supabase
              .from("messages")
              .insert({
                conversation_id: convId,
                role: "assistant",
                content: answerText,
                sources: effectiveSources.length > 0 ? effectiveSources : null,
                latency_ms: latencyMs,
                retrieval_degraded: ragFailed,
              })
              .select("id")
              .single();
            if (error) {
              console.error("[chat] assistant 저장 실패:", error.message);
            }
            saved = data;
          }

          // assistant 메시지에 출처/저장 id를 annotation으로 부착 (§8.1 응답)
          dataStream.writeMessageAnnotation({
            messageId: saved?.id ?? null,
            conversationId: convId,
            sources: effectiveSources,
            degraded: ragFailed,
            saveFailed: saved == null,
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
      return "답변 생성 중 연결이 끊겼습니다. 잠시 후 같은 질문을 다시 시도해 주세요.";
    },
  });
}
