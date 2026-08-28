// 통합 테스트(실제 Gemini·Supabase 호출): 사용자가 "드론 운용" 분야를 선택해도
// 현장지휘·공통으로 분류된 SOP 운용 절차를 전 분야 안전 폴백으로 회수하는지 검증한다.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

function restoreTestEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// .env.local 로드 (앱과 동일 환경). CI에서는 이미 주입된 환경변수만 사용한다.
function loadEnv(snapshot: EnvSnapshot): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;

  for (const line of readFileSync(p, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      setTestEnv(snapshot, m[1], m[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
    }
  }
}

// 외부 서비스(Gemini·Ollama·Supabase)를 호출하는 통합 테스트.
// 기본 `npm test`에서는 건너뛰고, RUN_RAG_INTEGRATION=1 일 때만 실행한다.
//   RUN_RAG_INTEGRATION=1 npx vitest run tests/rag-drone.integration.test.ts
describe.skipIf(process.env.RUN_RAG_INTEGRATION !== "1")(
  "RAG: 드론 운용 분야 선택 시 SOP 본문 검색(통합)",
  () => {
    const envSnapshot: EnvSnapshot = new Map();

    beforeAll(() => {
      loadEnv(envSnapshot);
      setTestEnv(envSnapshot, "QUERY_EXPANSION", "0");
      setTestEnv(envSnapshot, "RERANK", "0");
    });

    afterAll(() => restoreTestEnv(envSnapshot));

    it("분야 필터가 0건이면 전 분야 폴백으로 운용 절차 본문을 회수한다", async () => {
      const { searchContext } = await import("@/lib/rag");
      const query = "소방드론 비행 전 기체와 배터리, 현장 환경 점검 항목을 알려줘";
      const result = await searchContext(query, "드론 운용", 5);

      // 출처에 SOP 원본 문서가 잡혀야 한다
      const docs = result.sources.map((s) => s.doc).join(" | ");
      // 운용 절차 본문(드론 운용자/비행/상황분석)이 컨텍스트에 있어야 한다
      const hasBody = /드론\s*운용|비행|상황분석|사고특성|통제관/.test(
        result.contextText
      );

      console.log("출처:", docs);
      console.log("본문 포함:", hasBody, "| 매칭 청크 수:", result.matched);

      // 제목·본문 주제순도 필터가 저관련 청크로 topK를 강제 충전하지 않아도 실제 근거는 남아야 한다.
      expect(result.matched).toBeGreaterThan(0);
      expect(hasBody).toBe(true);
      expect(result.contextText).toMatch(/기체점검|기체\s*점검/);
      expect(result.contextText).toMatch(/배터리\s*충전상태|배터리\s*상태/);
      expect(result.contextText).toMatch(/장애물.*기상|기상.*비행가능여부/s);
      expect(result.degraded).toBe(true);
    }, 60_000);
  }
);
