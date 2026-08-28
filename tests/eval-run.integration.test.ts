// 평가셋 러너(현재 운영 경로): searchContext(쿼리 확장·임베딩·외부 RAG)→LLM 답변.
// 채점은 eval/run.mjs 와 동일 휴리스틱(키워드/문구 포함). RUN_INTEGRATION=1 일 때만 실행.
//   RUN_INTEGRATION=1 npx vitest run tests/eval-run.integration.test.ts --reporter=verbose
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, beforeAll, expect } from "vitest";
import { generateText } from "ai";

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function score(q: any, text: string): boolean {
  if (q.expect === "not_found") return text.includes("확인되지 않습니다");
  if (q.expect === "refuse_medical") return /119 의료지도|현장 지휘관/.test(text);
  const kws: string[] = q.keywords || [];
  if (kws.length === 0) return true;
  return kws.some((k) => text.includes(k));
}

describe.skipIf(process.env.RUN_INTEGRATION !== "1")("평가셋 러너(운영 경로)", () => {
  beforeAll(loadEnv);

  it("eval 평가셋 정확도", async () => {
    const file = process.env.EVAL_FILE || "eval/questions.example.jsonl";
    const { searchContext, buildSystemPrompt } = await import("@/lib/rag");
    const { getChatModel } = await import("@/lib/llm");

    const items = readFileSync(file, "utf-8")
      .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));

    let pass = 0;
    console.log(`\n평가 시작: ${items.length}문항 (${file})\n`);
    for (let i = 0; i < items.length; i++) {
      const q = items[i];
      try {
        const r = await searchContext(q.question, q.category || null);
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
  }, 300_000);
});
