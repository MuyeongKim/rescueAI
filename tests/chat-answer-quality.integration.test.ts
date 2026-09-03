// 검색 근거와 질문별 답변 계획을 실제 튜터 모델에 함께 전달해 사용자 체감 결과를 확인한다.
// 기본 CI에서는 외부 호출을 하지 않고 RUN_CHAT_ANSWER_INTEGRATION=1일 때만 실행한다.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateText } from "ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", async () => {
  const { createClient } = await import("@supabase/supabase-js");
  return {
    createClient: async () =>
      createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false, autoRefreshToken: false } }
      ),
  };
});

type EnvSnapshot = Map<string, string | undefined>;

function setTestEnv(snapshot: EnvSnapshot, key: string, value: string): void {
  if (!snapshot.has(key)) snapshot.set(key, process.env[key]);
  process.env[key] = value;
}

function loadEnv(snapshot: EnvSnapshot): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    setTestEnv(snapshot, match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
}

describe.skipIf(process.env.RUN_CHAT_ANSWER_INTEGRATION !== "1")(
  "AI 튜터 질문별 답변 구성(통합)",
  () => {
    const envSnapshot: EnvSnapshot = new Map();

    beforeAll(() => {
      loadEnv(envSnapshot);
      setTestEnv(envSnapshot, "QUERY_EXPANSION", "0");
      setTestEnv(envSnapshot, "RERANK", "0");
    });

    afterAll(() => {
      for (const [key, value] of envSnapshot) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("암모니아 누출 답변이 물질·보호·구역·차단·제독을 근거 범위에서 설명한다", async () => {
      const question =
        "암모니아 누출 시 물질 파악부터 차단까지 대원 행동절차를 알려줘";
      const { searchContext, buildSystemPrompt } = await import("@/lib/rag");
      const { buildChatAnswerPlan, answerPlanGuidance } = await import(
        "@/lib/chat-answer-plan"
      );
      const { getChatModel } = await import("@/lib/llm");
      const result = await searchContext(question, null, 8);
      const { text } = await generateText({
        model: getChatModel("gemini-flash"),
        system: buildSystemPrompt(
          result.contextText,
          answerPlanGuidance(buildChatAnswerPlan(question))
        ),
        prompt: question,
        temperature: 0.2,
      });

      expect(text).toMatch(/암모니아|NH3/i);
      expect(text).toMatch(/보호복|보호장비|공기호흡기/);
      expect(text).toMatch(/Hot|Warm|Cold|위험구역|통제구역/i);
      expect(text).toMatch(/차단|봉쇄|누출원/);
      expect(text).toMatch(/제독|오염통제|오염/);
      expect(text).not.toMatch(/\[[^\]\r\n]+ p\.\d+\]/);
      console.log("[chat-answer-quality]", {
        chars: text.replace(/\s+/g, " ").trim().length,
        hasNumberedSteps: /(?:^|\n)\s*1[.)]/m.test(text),
        hasInlineCitation: /\[[^\]\r\n]+ p\.\d+\]/.test(text),
      });
    }, 180_000);
  }
);
