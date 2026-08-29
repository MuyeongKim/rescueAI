// AI 자료제작 3주 시범운영 대표 5주제 회귀평가.
// 기본 테스트는 fixture 계약만 확인하고 외부 API를 호출하지 않는다.
// 실제 RAG/LLM은 RUN_MATERIAL_PILOT_* 환경변수를 명시했을 때만 앱 운영 경로로 실행한다.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  MATERIAL_GENERATION_PILOT_CASES,
  MATERIAL_GENERATION_PILOT_FIXTURE,
  matchedMaterialPilotExpectations,
  materialGenerationPilotFixtureSchema,
  materialPilotResultText,
} from "@/eval/material-generation-pilot";
import fixtureJson from "@/eval/material-generation-pilot-cases.json";
import {
  buildFocusedTrainingQuery,
  isLikelyBroadTrainingTopic,
} from "@/lib/generate-focus";
import {
  LESSON_SECTIONS,
  TRAINING_PLAN_SECTIONS,
  inspectGenerationQuality,
} from "@/lib/generate";

const MATERIAL_PILOT_RUNNER = readFileSync(
  join(process.cwd(), "eval/run-material-generation-pilot.mjs"),
  "utf-8",
);

vi.mock("@/lib/auth", () => ({
  requireApiUser: async () => ({ ok: true, user: { id: "material-pilot-evaluator" } }),
}));
vi.mock("@/lib/rate-limit", () => ({
  rateLimit: () => ({ ok: true, retryAfterSec: 0 }),
  tooManyRequests: () => new Response("Too Many Requests", { status: 429 }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !serviceRoleKey) {
      throw new Error("시범운영 통합평가에 Supabase 환경변수가 필요합니다.");
    }
    return createSupabaseClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  },
}));

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
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    setTestEnv(snapshot, match[1], match[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
  }
}

function normalizeUnique(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/[^0-9a-z가-힣]+/g, "");
}

function requestWith(body: unknown): Request {
  return new Request("http://localhost/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("AI 자료제작 시범운영 5주제 계약", () => {
  it("fixture 구조와 필수 기대항목 기준이 유효하다", () => {
    expect(materialGenerationPilotFixtureSchema.safeParse(fixtureJson).success).toBe(true);
    expect(MATERIAL_GENERATION_PILOT_CASES).toHaveLength(5);
    expect(MATERIAL_GENERATION_PILOT_CASES.every((item) => item.expectedEvidence.length >= 3))
      .toBe(true);
  });

  it("운영 RAG에서 확인한 5개 분야를 사용하고 공통 SOP를 독립 주제로 오인하지 않는다", () => {
    const snapshotCategories = new Set(
      MATERIAL_GENERATION_PILOT_FIXTURE.ragSnapshot.map((item) => item.category),
    );
    const caseCategories = MATERIAL_GENERATION_PILOT_CASES.map((item) => item.category);

    expect(new Set(caseCategories)).toEqual(
      new Set(["산악", "화재", "화학사고", "수난", "일반구조"]),
    );
    expect(caseCategories.every((category) => snapshotCategories.has(category))).toBe(true);
    expect(caseCategories).not.toContain("현장지휘·공통");
    expect(caseCategories).not.toContain("구급");
  });

  it("식별자·주제·세부방향·기대항목에 중복이 없다", () => {
    const ids = MATERIAL_GENERATION_PILOT_CASES.map((item) => item.id);
    const topics = MATERIAL_GENERATION_PILOT_CASES.map((item) =>
      normalizeUnique(`${item.category}:${item.topic}:${item.focus ?? ""}`),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(topics).size).toBe(topics.length);

    for (const pilotCase of MATERIAL_GENERATION_PILOT_CASES) {
      const labels = pilotCase.expectedEvidence.map((item) => normalizeUnique(item.label));
      const terms = pilotCase.expectedEvidence.flatMap((item) => item.anyOf.map(normalizeUnique));
      expect(new Set(labels).size).toBe(labels.length);
      expect(new Set(terms).size).toBe(terms.length);
    }
  });

  it("문서·슬라이드 제목과 섹션 제목만 기대어 내용 평가를 통과할 수 없다", () => {
    for (const pilotCase of MATERIAL_GENERATION_PILOT_CASES) {
      const copiedHeadings = pilotCase.expectedEvidence
        .flatMap((item) => item.anyOf)
        .join(" / ");
      const title = `${pilotCase.topic} ${pilotCase.focus ?? ""}`.trim();
      const titleOnlyResult = pilotCase.type === "slides"
        ? {
            title,
            slides: [{ title: copiedHeadings, bullets: ["일반적인 교육 본문입니다."] }],
          }
        : {
            title,
            sections: [{ heading: copiedHeadings, content: "일반적인 교육 본문입니다." }],
          };

      const matched = matchedMaterialPilotExpectations(
        materialPilotResultText(titleOnlyResult),
        pilotCase.expectedEvidence,
      );
      expect(matched, pilotCase.id).toEqual([]);
    }
  });

  it("contract 모드는 상속된 실제 RAG·LLM 실행 플래그를 먼저 제거한다", () => {
    const ragDelete = MATERIAL_PILOT_RUNNER.indexOf("delete env.RUN_MATERIAL_PILOT_RAG");
    const generationDelete = MATERIAL_PILOT_RUNNER.indexOf(
      "delete env.RUN_MATERIAL_PILOT_GENERATION",
    );
    const ragEnable = MATERIAL_PILOT_RUNNER.indexOf(
      'env.RUN_MATERIAL_PILOT_RAG = "1"',
    );
    const generationEnable = MATERIAL_PILOT_RUNNER.indexOf(
      'env.RUN_MATERIAL_PILOT_GENERATION = "1"',
    );

    expect(ragDelete).toBeGreaterThan(-1);
    expect(generationDelete).toBeGreaterThan(-1);
    expect(ragEnable).toBeGreaterThan(ragDelete);
    expect(generationEnable).toBeGreaterThan(generationDelete);
  });

  it("넓은 산악 주제는 구체적 세부방향을 남기고 세 산출물 유형을 모두 대표한다", () => {
    const mountain = MATERIAL_GENERATION_PILOT_CASES.find((item) => item.category === "산악");
    expect(mountain).toBeDefined();
    expect(isLikelyBroadTrainingTopic(mountain!.topic)).toBe(true);
    expect(mountain!.focus).toBeTruthy();
    expect(isLikelyBroadTrainingTopic(mountain!.focus!)).toBe(false);
    const focusedQuery = buildFocusedTrainingQuery(mountain!.topic, mountain!.focus!);
    expect(focusedQuery).toContain(mountain!.focus!);
    expect(focusedQuery).toContain(mountain!.topic);
    expect(new Set(MATERIAL_GENERATION_PILOT_CASES.map((item) => item.type))).toEqual(
      new Set(["plan", "lesson", "slides"]),
    );
  });
});

describe.skipIf(process.env.RUN_MATERIAL_PILOT_RAG !== "1")(
  "AI 자료제작 시범운영 실제 RAG",
  () => {
    const envSnapshot: EnvSnapshot = new Map();

    beforeAll(() => {
      loadEnv(envSnapshot);
      // 검색 자체를 결정론적으로 평가한다. 생성 평가는 별도 suite에서 UI와 같은 설정을 쓴다.
      setTestEnv(envSnapshot, "QUERY_EXPANSION", "0");
      setTestEnv(envSnapshot, "RERANK", "0");
    });

    afterAll(() => restoreTestEnv(envSnapshot));

    it("현재 RAG가 다섯 대표 분야와 원본 문서를 제공한다", async () => {
      const { listExternalRagCategories } = await import("@/lib/rag-external");
      const categories = await listExternalRagCategories();
      for (const pilotCase of MATERIAL_GENERATION_PILOT_CASES) {
        expect(categories[pilotCase.category]?.length ?? 0).toBeGreaterThan(0);
      }
    }, 60_000);

    it.each(MATERIAL_GENERATION_PILOT_CASES)(
      "$label: 앱 생성 컨텍스트가 핵심 근거를 회수한다",
      async (pilotCase) => {
        const { fetchCategoryContext } = await import("@/lib/generate-context");
        const query = buildFocusedTrainingQuery(pilotCase.topic, pilotCase.focus ?? "");
        const result = await fetchCategoryContext(pilotCase.category, 40, query);
        const matched = matchedMaterialPilotExpectations(
          result.contextText,
          pilotCase.expectedEvidence,
        );

        console.log("[material-pilot:rag]", {
          id: pilotCase.id,
          category: pilotCase.category,
          matched: matched.map((item) => item.label),
          sources: result.sources.map((source) => `${source.doc} p.${source.page ?? "-"}`),
          sopStatus: result.sopEvidence.status,
          degraded: result.degraded,
        });

        expect(result.contextText.length).toBeGreaterThan(200);
        expect(result.sources.length).toBeGreaterThan(0);
        expect(matched.length).toBeGreaterThanOrEqual(pilotCase.minimumRagExpectationGroups);
        expect(result.degraded).toBe(false);
        expect(["found", "not_found"]).toContain(result.sopEvidence.status);
        if (result.sopEvidence.status === "found") {
          expect(result.sopEvidence.sourceLabels.length).toBeGreaterThan(0);
          for (const sourceLabel of result.sopEvidence.sourceLabels) {
            expect(result.contextText).toContain(sourceLabel);
          }
        } else {
          expect(result.sopEvidence.sourceLabels).toEqual([]);
        }
      },
      90_000,
    );
  },
);

describe.skipIf(process.env.RUN_MATERIAL_PILOT_GENERATION !== "1")(
  "AI 자료제작 시범운영 실제 LLM 생성",
  () => {
    const envSnapshot: EnvSnapshot = new Map();
    let modelKey = "";

    beforeAll(async () => {
      loadEnv(envSnapshot);
      const explicitModel = process.env.MATERIAL_PILOT_MODEL?.trim();
      if (explicitModel) {
        modelKey = explicitModel;
        return;
      }
      const [{ availableModels }, { preferredGenerationModel }] = await Promise.all([
        import("@/lib/llm"),
        import("@/lib/generate-material"),
      ]);
      modelKey = preferredGenerationModel(availableModels());
      if (!modelKey) throw new Error("시범운영 생성평가에 사용할 LLM이 설정되지 않았습니다.");
    });

    afterAll(() => restoreTestEnv(envSnapshot));

    it.each(MATERIAL_GENERATION_PILOT_CASES)(
      "$label: 운영 API가 품질검사를 통과한 근거 기반 산출물을 만든다",
      async (pilotCase) => {
        const { POST } = await import("@/app/api/generate/route");
        const response = await POST(requestWith({
          type: pilotCase.type,
          category: pilotCase.category,
          audience: pilotCase.audience,
          duration: pilotCase.duration,
          topic: pilotCase.topic,
          focus: pilotCase.focus,
          model: modelKey,
        }));
        const result = await response.json();

        expect(response.status, JSON.stringify(result).slice(0, 500)).toBe(200);
        expect(result.quality?.checked).toBe(true);
        expect(result.quality?.errors ?? []).toEqual([]);
        expect(result.sources?.length ?? 0).toBeGreaterThan(0);
        expect(["found", "not_found"]).toContain(result.sopEvidence?.status);
        expect(result.quality?.warnings ?? []).not.toContain(
          "자료 검색 일부 기능 제한 — 회수 근거 확인 필요",
        );
        expect(result.quality?.warnings ?? []).not.toContain(
          "SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요",
        );

        const quality = inspectGenerationQuality(
          pilotCase.type,
          result,
          pilotCase.duration,
          result.sourceLabels ?? [],
          result.sopEvidence,
        );
        expect(quality).toEqual({ ok: true, issues: [] });

        if (pilotCase.type === "plan") {
          expect(result.sections.map((section: { heading: string }) => section.heading))
            .toEqual(TRAINING_PLAN_SECTIONS);
        } else if (pilotCase.type === "lesson") {
          expect(result.sections.map((section: { heading: string }) => section.heading))
            .toEqual(LESSON_SECTIONS);
        } else {
          expect(result.slides.length).toBeGreaterThanOrEqual(8);
        }

        const outputText = materialPilotResultText(result);
        const matched = matchedMaterialPilotExpectations(
          outputText,
          pilotCase.expectedEvidence,
        );
        console.log("[material-pilot:generation]", {
          id: pilotCase.id,
          model: modelKey,
          repaired: result.quality.repaired,
          matched: matched.map((item) => item.label),
          warnings: result.quality.warnings,
        });
        expect(matched.length).toBeGreaterThanOrEqual(
          pilotCase.minimumOutputExpectationGroups,
        );
      },
      360_000,
    );
  },
);
