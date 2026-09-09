import { safeServerError } from "@/lib/safe-server-error";
import { getChatModel } from "@/lib/llm";
import { streamText, generateText } from "ai";
import type { ChatMessage as Message } from "@/lib/chat-message";
import { createChatStreamResponse, writeChatText } from "@/lib/chat-stream";
import { createClient } from "@/lib/supabase/server";
import { requireApiUser } from "@/lib/auth";
import { prepareChatAnswerText, uniqueChatSources } from "@/lib/chat-answer";
import { trimChatHistory } from "@/lib/chat-history";
import { buildDirectChatReply, classifyChatTurn } from "@/lib/chat-turn";
import { expandChatQuery } from "@/lib/chat-query-expansion";
import { buildChatEvidenceFallback } from "@/lib/chat-evidence-fallback";
import { reviewChatLearningAnswer } from "@/lib/chat-learning-review";
import { answerPlanGuidance, buildChatAnswerPlan } from "@/lib/chat-answer-plan";
import { searchContext, buildSystemPrompt, NOT_FOUND_MESSAGE } from "@/lib/rag";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { guardAiUsage } from "@/lib/ai-usage";
import { DEMO, demoChatAnswer, demoChatSources } from "@/lib/demo";
import type { DocSource } from "@/lib/database.types";

export const maxDuration = 60;

export async function POST(req: Request) {
  // 데모 모드: Anthropic/Supabase 없이 정해진 답변을 스트리밍
  if (DEMO) {
    return createChatStreamResponse(async (dataStream) => {
        dataStream.write({ type: "data-conversationId", data: { value: "demo-conv-1" }, transient: true });
        const parts = demoChatAnswer.match(/[\s\S]{1,6}/g) ?? [demoChatAnswer];
        for (const p of parts) {
          writeChatText(dataStream, p);
          await new Promise((r) => setTimeout(r, 35));
        }
        dataStream.write({ type: "message-metadata", messageMetadata: {
          messageId: 1,
          conversationId: "demo-conv-1",
          sources: demoChatSources,
        } });
    });
  }

  const requestDeadline = Date.now() + 55_000;
  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;
  const user = auth.user;

  // LLM 호출 남용 방지 (분당 30회/사용자)
  const rl = rateLimit(`chat:${user.id}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);
  const usageLimit = await guardAiUsage("chat", supabase);
  if (usageLimit) return usageLimit;

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
  const turnKind = classifyChatTurn(question);

  // 재시도는 같은 질문 행을 재사용한다. 키 조회도 세션 클라이언트/RLS를 통과하며,
  // 다른 사용자의 키를 추측한 충돌은 질문 내용이나 대화 ID를 반환하지 않는다.
  const findRequest = () => supabase.from("messages")
    .select("conversation_id, content")
    .eq("client_request_id", clientRequestId)
    .eq("role", "user")
    .maybeSingle();
  const { data: previous, error: lookupError } = await findRequest();
  if (lookupError) {
    console.error("[chat] 질문 복구 상태 조회 실패:", safeServerError(lookupError));
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
      console.error("[chat] 대화 저장 실패:", safeServerError(error));
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
      console.error("[chat] user 메시지 저장 실패:", safeServerError(umErr));
      return new Response("질문을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", { status: 503 });
    }
  }
  const convId = conversationId;

  const startedAt = Date.now();

  // 4~5) Claude 스트리밍 + 메타데이터(conversationId, sources) 전달
  return createChatStreamResponse(async (dataStream) => {
      // 검색을 기다리는 동안에도 저장된 질문의 복구 주소를 먼저 전달한다.
      dataStream.write({ type: "data-conversationId", data: { value: convId }, transient: true });
      let contextText = "";
      let sources: DocSource[] = [];
      let independentEvidenceTopics: string[] = [];
      let retrievalCoverage: import("@/lib/rag").RetrievalCoverage | undefined;
      let ragFailed = false;
      const persistAnswer = async (text: string, hideSources = false) => {
        const latencyMs = Date.now() - startedAt;
        const answerText = prepareChatAnswerText(text);
        if (!answerText.trim()) return;
        // 전체가 표준 거절문인 답변에만 출처를 숨긴다. 일부 조건의 근거를 설명한 뒤
        // 미확인 범위를 밝힌 답변은 표준 문구가 포함되어도 참고 자료를 보존한다.
        const effectiveSources = hideSources || answerText.replace(/\s+/g, " ").trim() === NOT_FOUND_MESSAGE
          ? []
          : uniqueChatSources(sources);
        const { data: saved, error } = await supabase
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
        if (error) console.error("[chat] assistant 저장 실패:", safeServerError(error));

        // 모델 응답과 표준 확인 불가 응답 모두 같은 저장·복구 메타데이터를 전달한다.
        dataStream.write({ type: "message-metadata", messageMetadata: {
          messageId: saved?.id ?? null,
          conversationId: convId,
          sources: effectiveSources,
          degraded: ragFailed,
          saveFailed: saved == null,
        } });
      };

      const directReply = buildDirectChatReply(turnKind, messages);
      if (directReply) {
        writeChatText(dataStream, directReply);
        await persistAnswer(directReply, true);
        console.info("[chat] outcome", { requestId: clientRequestId, kind: turnKind, state: "direct" });
        return;
      }

      const queryPlan = await expandChatQuery(messages);
      const retrievalQuestion = queryPlan.retrievalQuestion;
      let matched = 0;
      try {
        const r = await searchContext(retrievalQuestion, category, undefined, { expansion: queryPlan.expansion });
        contextText = r.contextText;
        sources = r.sources;
        matched = r.matched;
        independentEvidenceTopics = r.independentEvidenceTopics ?? [];
        retrievalCoverage = r.retrievalCoverage;
        ragFailed = r.degraded ?? false;
      } catch {
        ragFailed = true;
        console.error("[chat] RAG 검색 실패", { requestId: clientRequestId });
      }
      console.info("[chat] retrieval", {
        requestId: clientRequestId, kind: turnKind, queryMethod: queryPlan.method,
        matched, contextChars: contextText.length, degraded: ragFailed,
      });

      if (!contextText.trim()) {
        const state = ragFailed ? "degraded" : "empty";
        const reply = buildChatEvidenceFallback(state, category);
        writeChatText(dataStream, reply);
        await persistAnswer(reply, true);
        console.info("[chat] outcome", { requestId: clientRequestId, kind: turnKind, state });
        return;
      }

      const answerPlan = buildChatAnswerPlan(retrievalQuestion, { learningAdvice: turnKind === "learning" });
      const system = buildSystemPrompt(
        contextText,
        answerPlanGuidance(answerPlan),
        independentEvidenceTopics,
        retrievalCoverage,
        { learningAdvice: turnKind === "learning", retrievalQuestion }
      );

      if (answerPlan.mode === "learning") {
        // 학습 조언에 기술 사실이 섞일 수 있어 원문 대조 전 초안을 화면에 노출하지 않는다.
        const { text } = await generateText({
          model: getChatModel(modelKey), system, messages: messages.map(({ role, content }) => ({ role, content })),
          temperature: 0.2, maxRetries: 0,
          maxOutputTokens: 4_000,
          abortSignal: AbortSignal.timeout(Math.max(1, Math.min(30_000, requestDeadline - Date.now() - 4_000))),
        });
        if (prepareChatAnswerText(text).replace(/\s+/g, " ").trim() === NOT_FOUND_MESSAGE) {
          const reply = buildChatEvidenceFallback(ragFailed ? "degraded" : "insufficient", category);
          writeChatText(dataStream, reply);
          await persistAnswer(reply, true);
          console.info("[chat] outcome", { requestId: clientRequestId, kind: turnKind, state: "insufficient", degraded: ragFailed });
          return;
        }
        const reviewed = await reviewChatLearningAnswer(text, contextText, { deadline: requestDeadline });
        const reply = reviewed.status === "unverified" ? buildChatEvidenceFallback("review_failed") : reviewed.text;
        writeChatText(dataStream, reply);
        await persistAnswer(reply, reviewed.status === "unverified");
        console.info("[chat] outcome", {
          requestId: clientRequestId, kind: turnKind,
          state: reviewed.status === "unverified" ? "review_unverified" : "answered",
          review: reviewed.status, reviewChecks: reviewed.checks, degraded: ragFailed,
        });
        return;
      }

      const result = streamText({
        model: getChatModel(modelKey),
        system,
        messages: messages.map(({ role, content }) => ({ role, content })),
        temperature: 0.2,
        maxOutputTokens: 4_000,
        maxRetries: 0,
        // 연결 종료 뒤 답변 보관은 유지하되 함수 종료 전에 모델 호출을 닫는다.
        abortSignal: AbortSignal.timeout(Math.max(1, requestDeadline - Date.now() - 2_000)),
        onError: ({ error }) => console.error("[chat] model stream error:", safeServerError(error)),
      });

      // HTTP 수신 중단과 별도로 모델 스트림을 끝까지 읽는다. 저장과 추가 안내가
      // 끝난 뒤에만 완료 이벤트를 보내 본문·출처·저장 상태 순서를 유지한다.
      const textId = crypto.randomUUID();
      dataStream.write({ type: "text-start", id: textId });
      let text = "";
      for await (const part of result.fullStream) {
        // textStream은 SDK 오류 이벤트를 생략하므로 fullStream에서 실패도 직접 확인한다.
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throw new DOMException("Model request aborted", "AbortError");
        if (part.type !== "text-delta") continue;
        text += part.text;
        dataStream.write({ type: "text-delta", id: textId, delta: part.text });
      }
      dataStream.write({ type: "text-end", id: textId });
      const refused = prepareChatAnswerText(text).replace(/\s+/g, " ").trim() === NOT_FOUND_MESSAGE;
      const tail = refused ? `\n\n${buildChatEvidenceFallback(ragFailed ? "degraded" : "insufficient", category)}` : "";
      if (tail) writeChatText(dataStream, tail);
      await persistAnswer(text + tail, refused);
      console.info("[chat] outcome", {
        requestId: clientRequestId, kind: turnKind,
        state: refused ? "insufficient" : "answered", degraded: ragFailed,
      });
  });
}
