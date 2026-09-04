// jobs 모드만 실제 세션의 HTTP API를 호출한다. 인증·레이트리밋·DB 클라이언트를 mock하지 않는다.
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runDurableMaterialPilot } from "@/eval/material-generation-jobs";
import { MATERIAL_GENERATION_PILOT_CASES, matchedMaterialPilotExpectations, materialPilotResultText } from "@/eval/material-generation-pilot";
import { generatedDocSchemaFor, generatedSlidesSchema, inspectGenerationQuality } from "@/lib/generate";

describe.skipIf(process.env.RUN_MATERIAL_PILOT_JOBS !== "1")("사용자 세션으로 내구성 생성 작업 전체 경로 점검", () => {
  const addedEnv: string[] = [];
  beforeAll(() => {
    if (!existsSync(".env.local")) return;
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !(match[1] in process.env)) {
        process.env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
        addedEnv.push(match[1]);
      }
    }
  });
  afterAll(() => addedEnv.forEach((key) => delete process.env[key]));

  for (const pilotCase of MATERIAL_GENERATION_PILOT_CASES) {
    it(`${pilotCase.label}: 작업 생성부터 품질 통과 완성본까지`, async (context) => {
      const result = await runDurableMaterialPilot({
        enabled: process.env.RUN_MATERIAL_PILOT_JOBS === "1",
        baseUrl: process.env.MATERIAL_PILOT_BASE_URL,
        sessionCookie: process.env.MATERIAL_PILOT_SESSION_COOKIE,
        input: {
          type: pilotCase.type, category: pilotCase.category, topic: pilotCase.topic,
          focus: pilotCase.focus, audience: pilotCase.audience, duration: pilotCase.duration,
        },
        timeoutMs: 30 * 60_000,
        onProgress: (event) => console.log("[material-pilot:jobs]", { caseId: pilotCase.id, ...event }),
      });
      if (result.status === "skipped") context.skip(result.reason);
      const output = result.job.result!;
      const metadata = z.object({
        sourceLabels: z.array(z.string()).default([]),
        sources: z.array(z.object({ document_id: z.number(), doc: z.string(), page: z.number().nullable() })).min(1),
        sopEvidence: z.object({ status: z.enum(["found", "not_found"]), sourceLabels: z.array(z.string()) }),
        quality: z.object({ checked: z.literal(true), errors: z.array(z.unknown()).length(0), warnings: z.array(z.string()).default([]) }),
      }).parse(output);
      const parsed = pilotCase.type === "slides"
        ? generatedSlidesSchema.parse(output)
        : generatedDocSchemaFor(pilotCase.type).parse(output);
      expect(inspectGenerationQuality(pilotCase.type, parsed, pilotCase.duration, metadata.sourceLabels, metadata.sopEvidence)).toEqual({ ok: true, issues: [] });
      const matched = matchedMaterialPilotExpectations(materialPilotResultText(output), pilotCase.expectedEvidence);
      expect(matched.length).toBeGreaterThanOrEqual(pilotCase.minimumOutputExpectationGroups);
      expect(metadata.quality.warnings).not.toContain("자료 검색 일부 기능 제한 — 회수 근거 확인 필요");
      expect(metadata.quality.warnings).not.toContain("SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요");
      console.log("[material-pilot:jobs-completed]", { caseId: pilotCase.id, jobId: result.job.id, elapsedMs: result.elapsedMs, checkedGroups: matched.map((item) => item.label) });
    }, 31 * 60_000);
  }
});
