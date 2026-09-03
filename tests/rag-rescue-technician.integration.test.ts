// 실제 운영 RAG에서 사용자가 분야를 고르지 않고 자연스럽게 이어 묻는 흐름을 확인한다.
// 기본 CI에서는 건너뛰고 RUN_RAG_INTEGRATION=1 일 때만 실행한다.
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

function loadEnv(snapshot: EnvSnapshot): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    setTestEnv(snapshot, match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
}

describe.skipIf(process.env.RUN_RAG_INTEGRATION !== "1")(
  "RAG: 인명구조사 2급 자연어 후속 질문(통합)",
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

    it("분야 미선택 첫 질문에서 2급 평가표의 구성·장비·채점 근거를 회수한다", async () => {
      const { searchContext } = await import("@/lib/rag");
      const result = await searchContext("인명구조사 2급 관련 정보?", null, 8);

      expect(result.sources.some((source) => source.doc.includes("인명구조사 2급"))).toBe(
        true
      );
      expect(result.contextText).toMatch(/기본역량|구조기술|평가종목/);
      expect(result.contextText).toMatch(/준비물|개인장비|평가장비/);
      expect(result.contextText).toMatch(/감점|실격|배점/);
      expect(result.degraded).toBe(false);
      console.log("[rag-rescue-technician:first]", {
        matched: result.matched,
        sources: result.sources.map((source) => `${source.doc} p.${source.page ?? "-"}`),
      });
    }, 60_000);

    it("'각 세부 사항은?'을 앞 주제와 결합해 같은 2급 평가표를 검색한다", async () => {
      const { buildRetrievalQuestion } = await import("@/lib/chat-retrieval-query");
      const { searchContext } = await import("@/lib/rag");
      const query = buildRetrievalQuestion([
        { role: "user", content: "인명구조사 2급 관련 정보?" },
        { role: "assistant", content: "이전 답변" },
        { role: "user", content: "각 세부 사항은?" },
      ]);
      const result = await searchContext(query, null, 8);

      expect(query).toContain("인명구조사 2급");
      expect(result.sources.some((source) => source.doc.includes("인명구조사 2급"))).toBe(
        true
      );
      expect(result.contextText).toMatch(/준비물|감점|실격|평가방법/);
      expect(result.degraded).toBe(false);
    }, 60_000);
  }
);
