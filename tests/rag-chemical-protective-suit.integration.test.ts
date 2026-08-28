// 실제 운영 외부 RAG의 임베딩 장애 복구와 복합 주제 회수율을 확인하는 배포 전 canary.
// 기본 CI에서는 건너뛰고 RUN_RAG_INTEGRATION=1 일 때만 실행한다.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateObject, generateText } from "ai";
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

function loadEnv(snapshot: EnvSnapshot): void {
  const path = join(process.cwd(), ".env.local");
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    setTestEnv(snapshot, match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
}

const topic = "화학보호복 착용 전 점검·착의·탈의·오염통제와 이상 시 중단·보고";
const conversationalCheckQuery =
  "화학보호복을 입기 전에 대원이 점검해야 할 항목을 순서대로 알려줘";
const zoneQuery =
  "화학사고 현장의 Hot·Warm·Cold Zone은 어떤 기준으로 설정하고 운영해야 해?";
const crossTopicSourceLabel =
  /(?:\[|<)[^\]\n>]*11\.\s*방사능 물질 회수 및 인명구조[^\]\n>]*p\.269(?:\]|>)/i;

function expectChemicalSuitCoverage(contextText: string): void {
  expect(contextText).toMatch(/Level A|A급/);
  expect(contextText).toMatch(/점검|기밀|압력/);
  expect(contextText).toMatch(/착용/);
  expect(contextText).toMatch(/탈의/);
  expect(contextText).toMatch(/외부\s*제독|제독제|오염도/);
  expect(contextText).toMatch(/이상.*보고|파손/s);
}

function expectNoCrossTopicScenario(text: string): void {
  expect(text).not.toMatch(crossTopicSourceLabel);
  expect(text).not.toMatch(/방사능 물질 (?:회수|인명구조)/i);
  expect(text).not.toMatch(/20\s*km/i);
}

describe.skipIf(process.env.RUN_RAG_INTEGRATION !== "1")(
  "RAG: 화학보호복 복합 절차 회수(통합)",
  () => {
    const envSnapshot: EnvSnapshot = new Map();

    beforeAll(() => {
      loadEnv(envSnapshot);
      // 외부 LLM 재순위가 없어도 결정론적 검색 자체가 근거를 회수해야 한다.
      setTestEnv(envSnapshot, "QUERY_EXPANSION", "0");
      setTestEnv(envSnapshot, "RERANK", "0");
    });

    afterAll(() => restoreTestEnv(envSnapshot));

    it("벡터가 없어도 튜터용 키워드 검색이 필수 절차를 회수한다", async () => {
      const { searchExternalRag } = await import("@/lib/rag-external");
      const result = await searchExternalRag(topic, null, 8, "화학사고");

      expect(result.matched).toBeGreaterThanOrEqual(6);
      expectChemicalSuitCoverage(result.contextText);
      console.log("[rag-chemical:tutor]", {
        matched: result.matched,
        sources: result.sources.map((source) => `${source.doc} p.${source.page ?? "-"}`),
      });
    });

    it("실제 Gemini 벡터 검색도 필수 페이지를 유지하고 교차주제 p.269를 제외한다", async () => {
      const { searchContext } = await import("@/lib/rag");
      expect(process.env.EMBEDDING_PROVIDER).toBe("google");
      const result = await searchContext(topic, "화학사고", 8);

      expect(result.matched).toBeGreaterThanOrEqual(3);
      expectChemicalSuitCoverage(result.contextText);
      expect(result.contextText).toMatch(/p\.41/);
      expect(result.contextText).toMatch(/p\.58/);
      expect(result.contextText).toMatch(/p\.60/);
      expectNoCrossTopicScenario(result.contextText);
      console.log("[rag-chemical:gemini]", {
        matched: result.matched,
        degraded: result.degraded,
        sources: result.sources.map((source) => `${source.doc} p.${source.page ?? "-"}`),
      });
    }, 60_000);

    it("자연어 화학보호복·위험구역 질문도 과확장 없이 실제 근거를 회수한다", async () => {
      const { searchContext } = await import("@/lib/rag");
      const [checkResult, zoneResult] = await Promise.all([
        searchContext(conversationalCheckQuery, "화학사고", 8),
        searchContext(zoneQuery, "화학사고", 8),
      ]);

      expect(checkResult.matched).toBeGreaterThan(0);
      expect(checkResult.contextText).toMatch(/p\.41/);
      expect(checkResult.contextText).toMatch(/점검|기밀|압력/);
      expectNoCrossTopicScenario(checkResult.contextText);

      expect(zoneResult.matched).toBeGreaterThan(0);
      expect(zoneResult.contextText).toMatch(/Hot\s*zone/i);
      expect(zoneResult.contextText).toMatch(/Warm\s*zone/i);
      expect(zoneResult.contextText).toMatch(/Cold\s*zone/i);
      console.log("[rag-chemical:natural-queries]", {
        checkMatched: checkResult.matched,
        zoneMatched: zoneResult.matched,
      });
    }, 60_000);

    it("임베딩 연결 실패 시에도 자료제작이 분야 전체가 아닌 주제 근거를 회수한다", async () => {
      // 연결이 즉시 거부되는 로컬 포트로 Ollama 요청을 보내 벡터 실패 경로를 결정론적으로 만든다.
      setTestEnv(envSnapshot, "EMBEDDING_PROVIDER", "ollama");
      setTestEnv(envSnapshot, "EMBEDDING_API_URL", "http://127.0.0.1:1");
      setTestEnv(envSnapshot, "EMBEDDING_TIMEOUT_MS", "100");
      const { fetchExternalRagContext } = await import("@/lib/rag-external");
      const result = await fetchExternalRagContext("화학사고", 40, topic);

      expect(result.degraded).toBe(true);
      expectChemicalSuitCoverage(result.contextText);
      expect(result.contextText).toMatch(/p\.41/);
      expect(result.contextText).toMatch(/p\.58/);
      expect(result.contextText).toMatch(/p\.60/);
      expectNoCrossTopicScenario(result.contextText);
      console.log("[rag-chemical:generate]", {
        contextChars: result.contextText.length,
        sources: result.sources.map((source) => `${source.doc} p.${source.page ?? "-"}`),
      });
    }, 60_000);
  }
);

describe.skipIf(process.env.RUN_CHEMICAL_GENERATION_INTEGRATION !== "1")(
  "화학보호복 검색 개선 후 실제 Gemini 생성(통합)",
  () => {
    let contextText = "";
    const envSnapshot: EnvSnapshot = new Map();

    beforeAll(async () => {
      loadEnv(envSnapshot);
      setTestEnv(envSnapshot, "QUERY_EXPANSION", "0");
      setTestEnv(envSnapshot, "RERANK", "0");
      const { fetchExternalRagContext } = await import("@/lib/rag-external");
      contextText = (
        await fetchExternalRagContext("화학사고", 40, topic)
      ).contextText;
      expectChemicalSuitCoverage(contextText);
    }, 60_000);

    afterAll(() => restoreTestEnv(envSnapshot));

    it("튜터가 착용 전 점검부터 탈의·제독까지 출처와 함께 설명한다", async () => {
      const { buildSystemPrompt } = await import("@/lib/rag");
      const { getChatModel } = await import("@/lib/llm");
      const { text } = await generateText({
        model: getChatModel("gemini-flash"),
        system: buildSystemPrompt(contextText),
        prompt:
          "화학보호복을 착용하기 전에 무엇을 점검해야 하고, 착의·탈의는 어떤 순서로 진행해야 하나요? 오염구역 통제와 이상 발견 시 중단·보고 기준까지 일반 대원이 현장에서 바로 확인할 수 있게 설명해 주세요.",
        temperature: 0.2,
      });

      expect(text).toMatch(/Level A|A급/);
      expect(text).toMatch(/경보|압력|기밀/);
      expect(text).toMatch(/2인\s*1조/);
      expect(text).toMatch(/외부\s*제독/);
      expect(text).toMatch(/상의.*속장갑.*헬멧.*면체/s);
      expect(text).toMatch(/오염도.*검사/s);
      expect(text).toMatch(/p\.41/);
      expect(text).toMatch(/p\.58/);
      expectNoCrossTopicScenario(text);
      console.log("[rag-chemical:answer]", {
        chars: text.replace(/\s+/g, " ").trim().length,
        citations: Array.from(text.matchAll(/p\.(\d+)/g), (match) => match[1]),
      });
    }, 180_000);

    it("훈련계획이 실제 착용·탈의·제독 수행 근거를 포함한다", async () => {
      const generate = await import("@/lib/generate");
      const { getChatModel } = await import("@/lib/llm");
      const request = {
        type: "plan" as const,
        category: "화학사고",
        audience: "일반 대원" as const,
        duration: "1시간" as const,
        topic,
      };
      const allowedSourceRefs = generate.extractSourceLabels(contextText);
      const system = generate.buildGenerateSystemPrompt(request.category, contextText);
      const run = async (prompt: string) =>
        (
          await generateObject({
            model: getChatModel("gemini-flash"),
            schema: generate.generatedPlanSchema,
            system,
            prompt,
            temperature: 0.4,
          })
        ).object;

      let draft = await run(generate.buildGeneratePrompt(request));
      let report = generate.inspectGeneratedPlan(
        draft,
        request.duration,
        allowedSourceRefs
      );
      if (!report.ok) {
        draft = await run(
          generate.buildGenerationRepairPrompt({
            type: "plan",
            request,
            draft,
            report,
          })
        );
        report = generate.inspectGeneratedPlan(draft, request.duration, allowedSourceRefs);
      }
      const text = draft.sections.map((section) => section.content).join("\n");

      expect(report).toEqual({ ok: true, issues: [] });
      expect(text).toMatch(/2인\s*1조/);
      expect(text).toMatch(/하의.*등지게/s);
      expect(text).toMatch(/외부\s*제독/);
      expect(text).toMatch(/상의.*속장갑.*헬멧.*면체/s);
      expect(text).toMatch(/오염도.*검사/s);
      expect(text).toMatch(/p\.41/);
      expect(text).toMatch(/p\.58/);
      expectNoCrossTopicScenario(text);
      console.log("[rag-chemical:plan]", {
        sectionChars: draft.sections.map((section) => ({
          heading: section.heading,
          chars: section.content.replace(/\s+/g, " ").trim().length,
        })),
      });
    }, 240_000);
  }
);
