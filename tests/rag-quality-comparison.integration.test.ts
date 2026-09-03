// 실제 운영 코퍼스에서 검색 구조 변경 전·후를 같은 질문과 판정 규칙으로 비교한다.
// 기본 CI에서는 외부 호출을 하지 않고 RUN_RAG_QUALITY_COMPARISON=1일 때만 실행한다.
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

const CASES = [
  {
    id: "rescue2",
    question: "인명구조사 2급 관련 정보?",
    groups: [
      /기본역량|구조기술|평가종목/,
      /준비물|개인장비|평가장비/,
      /감점|실격|배점/,
      /평가방법|평가절차|진행/,
    ],
  },
  {
    id: "scba",
    question: "공기호흡기 착용 방법을 준비부터 완료까지 알려줘",
    groups: [/점검|검사/, /착용|면체|등지게/, /압력|기밀/, /안전|주의|이상/],
  },
  {
    id: "ammonia",
    question: "암모니아 누출 시 물질 파악부터 차단까지 대원 행동절차를 알려줘",
    groups: [
      /암모니아|물질.*확인|물질.*식별/s,
      /보호복|보호장비|공기호흡기/,
      /Hot|Warm|Cold|위험구역|통제구역/i,
      /차단|누출원|밸브|봉쇄/,
      /제독|오염/,
    ],
  },
  {
    id: "mountain",
    question: "산악사고 대비 훈련을 어떻게 구성해야 해?",
    groups: [
      /산악|경사면|추락/,
      /역할|지휘|팀/,
      /로프|장비|들것/,
      /절차|확보|인양|구조/,
      /안전|위험|점검/,
      /평가|숙달|훈련/,
    ],
  },
] as const;

describe.skipIf(process.env.RUN_RAG_QUALITY_COMPARISON !== "1")(
  "운영 RAG 품질 전후 비교",
  () => {
    const envSnapshot: EnvSnapshot = new Map();

    beforeAll(() => {
      loadEnv(envSnapshot);
      // 검색 구조 자체를 비교하므로 외부 LLM 쿼리 확장·재순위 변수는 고정한다.
      setTestEnv(envSnapshot, "QUERY_EXPANSION", "0");
      setTestEnv(envSnapshot, "RERANK", "0");
    });

    afterAll(() => {
      for (const [key, value] of envSnapshot) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });

    it("대표 질문의 근거 범위·출처·지연시간을 동일 형식으로 기록한다", async () => {
      const { searchContext } = await import("@/lib/rag");
      for (const item of CASES) {
        const startedAt = Date.now();
        const result = await searchContext(item.question, null, 8);
        // 검색 근거 본문만 평가한다. 모델용 '[확인 항목]' 라벨이 점수를 올리지 못하게 제거한다.
        const evidenceText = result.contextText.replace(/^\[확인 항목:.*$/gm, "");
        const coverageBits = item.groups.map((pattern) => pattern.test(evidenceText));
        console.log(
          "[rag-quality]",
          JSON.stringify({
            id: item.id,
            elapsedMs: Date.now() - startedAt,
            matched: result.matched,
            degraded: result.degraded ?? false,
            coverage: `${coverageBits.filter(Boolean).length}/${coverageBits.length}`,
            coverageBits,
            purposes: Array.from(
              result.contextText.matchAll(/^\[확인 항목: (.+)\]$/gm),
              (match) => match[1]
            ),
            evidenceLabels: Array.from(
              result.contextText.matchAll(/^\[(?!확인 항목:)(.+)\]$/gm),
              (match) => match[1]
            ),
            sources: result.sources.map(
              (source) => `${source.doc} p.${source.page ?? "-"}`
            ),
          })
        );
        expect(result.matched).toBeGreaterThan(0);
      }
    }, 120_000);
  }
);
