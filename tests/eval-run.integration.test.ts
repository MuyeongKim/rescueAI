// 앱의 검색문 복원·답변 계획·RAG·모델을 사용하는 결정론적 기준 점검.
// HTTP 인증/저장은 별도 검사이며, 점검률은 사실 정확도를 뜻하지 않는다.
//   RUN_INTEGRATION=1 npx vitest run tests/eval-run.integration.test.ts --reporter=verbose
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, beforeAll, expect, vi } from "vitest";
import { convertToCoreMessages, generateText, type Message } from "ai";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import { scoreTutorEvalAnswer, tutorEvalCaseSchema } from "@/eval/scoring";
import { trimChatHistory } from "@/lib/chat-history";
import { prepareChatAnswerText } from "@/lib/chat-answer";
import { buildRetrievalQuestion } from "@/lib/chat-retrieval-query";
import { answerPlanGuidance, buildChatAnswerPlan } from "@/lib/chat-answer-plan";

// CLI 통합 평가는 서버 로직을 직접 호출하므로 Next 빌드의 경계 마커만 대체한다.
vi.mock("server-only", () => ({}));

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

function createEvaluationSupabaseClient() {
  if (process.env.NODE_ENV !== "test" || process.env.RUN_INTEGRATION !== "1") {
    throw new Error("service-role 평가 클라이언트는 명시적인 통합 테스트에서만 사용할 수 있습니다.");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("평가에 NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 필요합니다.");
  }
  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const integrationTimeoutMs = Math.max(
  60_000,
  Number(process.env.EVAL_TIMEOUT_MS) || 600_000
);

describe.skipIf(process.env.RUN_INTEGRATION !== "1")("튜터 자동 기준 점검", () => {
  beforeAll(loadEnv);

  it("eval 문항별 답변·검색 근거 기준 충족률", async () => {
    const file = process.env.EVAL_FILE || "eval/questions.example.jsonl";
    const { searchContext, buildSystemPrompt, DEFAULT_TOP_K } = await import("@/lib/rag");
    const { getChatModel } = await import("@/lib/llm");
    // Vitest/CLI에는 Next.js 요청 쿠키가 없다. 평가 파일에서만 service role을 명시적으로
    // 주입하고, 앱의 기본 호출은 계속 쿠키 세션 + RLS 경로를 사용한다.
    const evaluationSupabase = createEvaluationSupabaseClient();

    const items = readFileSync(file, "utf-8")
      .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => tutorEvalCaseSchema.parse(JSON.parse(l)));
    expect(items.length, "평가 파일에 문항이 없습니다.").toBeGreaterThan(0);

    let pass = 0;
    console.log(`\n자동 기준 점검 시작: ${items.length}문항 (${file}) — 사실 정확도는 별도 사람 검토가 필요합니다.\n`);
    for (let i = 0; i < items.length; i++) {
      const q = items[i];
      try {
        const messages = trimChatHistory<Message>([
          ...q.history, { role: "user", content: q.question },
        ]).map((message) => message.role === "assistant"
          ? { ...message, content: prepareChatAnswerText(message.content) } : message);
        const retrievalQuestion = buildRetrievalQuestion(messages);
        const r = await searchContext(retrievalQuestion, q.category || null, DEFAULT_TOP_K, {
          supabase: evaluationSupabase,
        });
        const { text } = await generateText({
          model: getChatModel(),
          system: buildSystemPrompt(r.contextText, answerPlanGuidance(buildChatAnswerPlan(retrievalQuestion)), r.independentEvidenceTopics),
          messages: convertToCoreMessages(messages),
          temperature: 0.2,
        });
        const result = scoreTutorEvalAnswer(q, prepareChatAnswerText(text), { ...r, retrievalQuestion });
        if (result.passed) pass++;
        console.log(`[${i + 1}/${items.length}] ${result.passed ? "✓" : "✗"} ${q.question}`);
        if (!result.passed) console.log({
          failedChecks: result.checks.filter((check) => !check.passed).map((check) => check.label),
          retrievalQuestion, matched: r.matched, degraded: r.degraded ?? false,
          answer: text.slice(0, 500),
        });
      } catch (e) {
        console.log(`[${i + 1}/${items.length}] ✗ (오류) ${q.question}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const rate = Math.round((pass / items.length) * 100);
    const minimum = Number(process.env.EVAL_MIN_CHECK_RATE ?? process.env.EVAL_MIN_ACCURACY ?? 60);
    console.log(`\n자동 기준 충족률(점검률): ${pass}/${items.length} = ${rate}%  (기준 ${minimum}% 이상)`);
    expect(Number.isFinite(minimum) && minimum >= 0 && minimum <= 100).toBe(true);
    expect(rate).toBeGreaterThanOrEqual(minimum);
  }, integrationTimeoutMs);
});
