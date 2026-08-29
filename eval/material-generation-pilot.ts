import { z } from "zod";
import fixtureJson from "./material-generation-pilot-cases.json";

const expectationSchema = z.object({
  label: z.string().trim().min(2).max(80),
  anyOf: z.array(z.string().trim().min(1).max(80)).min(1).max(8),
});

const pilotCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  label: z.string().trim().min(2).max(100),
  type: z.enum(["plan", "lesson", "slides"]),
  category: z.string().trim().min(1).max(50),
  topic: z.string().trim().min(2).max(100),
  focus: z.string().trim().min(2).max(100).optional(),
  audience: z.enum(["신임 대원", "일반 대원", "전문 과정"]),
  duration: z.enum(["1시간", "2시간", "4시간"]),
  expectedEvidence: z.array(expectationSchema).min(3).max(8),
  minimumRagExpectationGroups: z.number().int().positive(),
  minimumOutputExpectationGroups: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if (value.minimumRagExpectationGroups > value.expectedEvidence.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minimumRagExpectationGroups"],
      message: "RAG 기대항목 기준은 정의된 항목 수를 넘을 수 없습니다.",
    });
  }
  if (value.minimumOutputExpectationGroups > value.expectedEvidence.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["minimumOutputExpectationGroups"],
      message: "산출물 기대항목 기준은 정의된 항목 수를 넘을 수 없습니다.",
    });
  }
});

export const materialGenerationPilotFixtureSchema = z.object({
  version: z.literal(1),
  observedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ragTable: z.string().regex(/^[a-z_][a-z0-9_]*$/),
  ragSnapshot: z.array(z.object({
    category: z.string().trim().min(1).max(50),
    activeChunks: z.number().int().positive(),
    sourceDocuments: z.number().int().positive(),
  })).min(1),
  cases: z.array(pilotCaseSchema).length(5),
});

export type MaterialGenerationPilotFixture = z.infer<
  typeof materialGenerationPilotFixtureSchema
>;
export type MaterialGenerationPilotCase = MaterialGenerationPilotFixture["cases"][number];
export type MaterialPilotExpectation = MaterialGenerationPilotCase["expectedEvidence"][number];

export const MATERIAL_GENERATION_PILOT_FIXTURE =
  materialGenerationPilotFixtureSchema.parse(fixtureJson);
export const MATERIAL_GENERATION_PILOT_CASES = MATERIAL_GENERATION_PILOT_FIXTURE.cases;

function normalizedForMatch(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("ko-KR").replace(/\s+/g, " ");
}

export function matchedMaterialPilotExpectations(
  text: string,
  expectations: readonly MaterialPilotExpectation[],
): MaterialPilotExpectation[] {
  const normalizedText = normalizedForMatch(text);
  return expectations.filter((expectation) =>
    expectation.anyOf.some((term) => normalizedText.includes(normalizedForMatch(term)))
  );
}

export function materialPilotResultText(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const record = value as Record<string, unknown>;
  // 주제에서 그대로 복사되기 쉬운 문서 제목·섹션 제목·슬라이드 제목은 내용 품질의
  // 증거가 아니다. 실제 교육 본문과 발표 내용만 기대항목 채점에 사용한다.
  const parts: string[] = [];

  if (Array.isArray(record.sections)) {
    for (const section of record.sections) {
      if (!section || typeof section !== "object" || Array.isArray(section)) continue;
      const item = section as Record<string, unknown>;
      if (typeof item.content === "string") parts.push(item.content);
    }
  }
  if (Array.isArray(record.slides)) {
    for (const slide of record.slides) {
      if (!slide || typeof slide !== "object" || Array.isArray(slide)) continue;
      const item = slide as Record<string, unknown>;
      if (Array.isArray(item.bullets)) {
        parts.push(...item.bullets.filter((bullet): bullet is string => typeof bullet === "string"));
      }
      if (Array.isArray(item.steps)) {
        parts.push(...item.steps.filter((step): step is string => typeof step === "string"));
      }
      if (typeof item.notes === "string") parts.push(item.notes);
    }
  }
  return parts.join("\n");
}
