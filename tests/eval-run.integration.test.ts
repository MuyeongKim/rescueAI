// 평가셋 러너(현재 운영 경로): searchContext(쿼리 확장·임베딩·외부 RAG)→LLM 답변.
// 채점은 eval/run.mjs 와 동일 휴리스틱(키워드/문구 포함). RUN_INTEGRATION=1 일 때만 실행.
//   RUN_INTEGRATION=1 npx vitest run tests/eval-run.integration.test.ts --reporter=verbose
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, beforeAll, expect, vi } from "vitest";
import { generateText } from "ai";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// CLI 통합 평가는 서버 로직을 직접 호출하므로 Next 빌드의 경계 마커만 대체한다.
vi.mock("server-only", () => ({}));

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
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

function score(q: any, text: string): boolean {
  if (q.expect === "not_found") return text.includes("확인되지 않습니다");
  if (q.expect === "refuse_medical") return /119 의료지도|현장 지휘관/.test(text);
  const kws: string[] = q.keywords || [];
  if (kws.length === 0) return true;
  return kws.some((k) => text.includes(k));
}

const integrationTimeoutMs = Math.max(
  60_000,
  Number(process.env.EVAL_TIMEOUT_MS) || 600_000
);

describe.skipIf(process.env.RUN_INTEGRATION !== "1")("평가셋 러너(운영 경로)", () => {
  beforeAll(loadEnv);

  it("eval 평가셋 정확도", async () => {
    const file = process.env.EVAL_FILE || "eval/questions.example.jsonl";
    const { searchContext, buildSystemPrompt, DEFAULT_TOP_K } = await import("@/lib/rag");
    const { getChatModel } = await import("@/lib/llm");
    // Vitest/CLI에는 Next.js 요청 쿠키가 없다. 평가 파일에서만 service role을 명시적으로
    // 주입하고, 앱의 기본 호출은 계속 쿠키 세션 + RLS 경로를 사용한다.
    const evaluationSupabase = createEvaluationSupabaseClient();

    const items = readFileSync(file, "utf-8")
      .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

    let pass = 0;
    console.log(`\n평가 시작: ${items.length}문항 (${file})\n`);
    for (let i = 0; i < items.length; i++) {
      const q = items[i];
      try {
        const r = await searchContext(q.question, q.category || null, DEFAULT_TOP_K, {
          supabase: evaluationSupabase,
        });
        const { text } = await generateText({
          model: getChatModel(),
          system: buildSystemPrompt(r.contextText),
          prompt: q.question,
          temperature: 0.2,
        });
        const ok = score(q, text);
        if (ok) pass++;
        console.log(`[${i + 1}/${items.length}] ${ok ? "✓" : "✗"} ${q.question}`);
        if (!ok) console.log(`    답변: ${text.slice(0, 140).replace(/\n/g, " ")}…  (매칭 ${r.matched})`);
      } catch (e: any) {
        console.log(`[${i + 1}/${items.length}] ✗ (오류) ${q.question}: ${e.message}`);
      }
    }
    const acc = items.length ? Math.round((pass / items.length) * 100) : 0;
    const minAcc = Number(process.env.EVAL_MIN_ACCURACY ?? 60);
    console.log(`\n정확도: ${pass}/${items.length} = ${acc}%  (목표 ${minAcc}% 이상)`);
    // 회귀 방어: 목표 정확도 미달 시 실패(기존엔 assert 가 없어 0%여도 통과했음)
    expect(acc).toBeGreaterThanOrEqual(minAcc);
  }, integrationTimeoutMs);
});
