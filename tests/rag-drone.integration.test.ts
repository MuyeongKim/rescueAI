// 통합 테스트(실제 Gemini·Ollama·Supabase 호출): "소방드론 SOP" 검색 시
// SOP 325 운용 절차 본문이 컨텍스트에 포함되는지 검증. 앱이 쓰는 lib 코드를 그대로 호출.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect, beforeAll } from "vitest";

// .env.local 로드 (앱과 동일 환경)
function loadEnv() {
  const p = join(process.cwd(), ".env.local");
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

// 외부 서비스(Gemini·Ollama·Supabase)를 호출하는 통합 테스트.
// 기본 `npm test`에서는 건너뛰고, RUN_INTEGRATION=1 일 때만 실행한다.
//   RUN_INTEGRATION=1 npx vitest run tests/rag-drone.integration.test.ts
describe.skipIf(process.env.RUN_INTEGRATION !== "1")("RAG: 소방드론 SOP 본문 검색(통합)", () => {
  beforeAll(loadEnv);

  it("expandQuery + searchRag2026 가 운용 절차 본문을 컨텍스트에 포함한다", async () => {
    const { expandQuery, searchRag2026 } = await import("@/lib/rag2026");
    const { getQueryEmbedding } = await import("@/lib/embeddings");

    const query = "소방드론 SOP";
    const { embedText, keywords } = await expandQuery(query);
    const embedding = await getQueryEmbedding(embedText);
    const result = await searchRag2026(query, embedding, 5, null, keywords);

    // 출처에 SOP 원본 문서가 잡혀야 한다
    const docs = result.sources.map((s) => s.doc).join(" | ");
    // 운용 절차 본문(드론 운용자/비행/상황분석)이 컨텍스트에 있어야 한다
    const hasBody = /드론\s*운용|비행|상황분석|사고특성|통제관/.test(result.contextText);

    console.log("확장 keywords:", keywords.join(", "));
    console.log("출처:", docs);
    console.log("본문 포함:", hasBody, "| 매칭 청크 수:", result.matched);

    expect(result.matched).toBeGreaterThan(0);
    expect(hasBody).toBe(true);
  }, 60_000);
});
