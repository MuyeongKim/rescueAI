import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { generateObject, generateText } from "ai";
import { describe, expect, it } from "vitest";

function loadEnv(): void {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || match[1] in process.env) continue;
    const raw = match[2].trim();
    process.env[match[1]] = raw.replace(/^(['"])(.*)\1$/, "$2");
  }
}

type RagRow = { content: string; metadata: Record<string, unknown> | null };

function sourceLabel(metadata: RagRow["metadata"]): string {
  const source = typeof metadata?.source === "string" ? metadata.source : "교육자료";
  const page = metadata?.page_number ?? metadata?.page ?? metadata?.page_num;
  return `[${source}${page != null ? ` p.${String(page)}` : ""}]`;
}

async function loadFireContext(): Promise<{ contextText: string; rowCount: number }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const table = process.env.RAG_TABLE ?? "rag_rescue";
  if (!url || !serviceKey) throw new Error("Supabase 통합평가 환경변수가 없습니다.");

  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const selectRows = () =>
    supabase
      .from(table)
      .select("content, metadata")
      .eq("is_active", true)
      .eq("metadata->>category", "화재");
  const relevant = await selectRows().ilike("content", "%공기호흡기%").limit(24);
  if (relevant.error) throw relevant.error;
  let rows = (relevant.data ?? []) as RagRow[];
  if (rows.length < 6) {
    const fallback = await selectRows().limit(40);
    if (fallback.error) throw fallback.error;
    rows = (fallback.data ?? []) as RagRow[];
  }
  if (rows.length === 0) throw new Error("통합평가에 사용할 화재 근거자료가 없습니다.");

  return {
    rowCount: rows.length,
    contextText: rows
      .slice(0, 24)
      .map((row) => `${sourceLabel(row.metadata)}\n${row.content}`)
      .join("\n\n---\n\n"),
  };
}

describe.skipIf(process.env.RUN_GENERATION_INTEGRATION !== "1")(
  "현재 LLM 자료제작 스모크",
  () => {
    it("실제 근거로 튜터가 본문 인용 없이 구체적인 절차·안전사항을 답한다", async () => {
      loadEnv();
      const { contextText, rowCount } = await loadFireContext();
      const { getChatModel } = await import("@/lib/llm");
      const { buildSystemPrompt } = await import("@/lib/rag");

      const { text } = await generateText({
        model: getChatModel(),
        system: buildSystemPrompt(contextText),
        prompt:
          "공기호흡기를 착용하기 전에 무엇을 어떤 순서로 점검해야 하나요? 이상을 발견했을 때의 조치와 안전 유의사항까지 일반 대원이 현장에서 바로 확인할 수 있게 설명해 주세요.",
        temperature: 0.3,
      });
      const compact = text.replace(/\s+/g, " ").trim();

      console.log("\n[generate-live:tutor]", {
        provider: process.env.LLM_PROVIDER ?? "default",
        model: process.env.GEMINI_MODEL ?? "default",
        contextRows: rowCount,
        chars: compact.length,
        hasInlineCitation: /\[[^\]\r\n]+ p\.\d+\]/.test(text),
        hasNumberedSteps: /(?:^|\n)\s*1[.)]/m.test(text) && /(?:^|\n)\s*2[.)]/m.test(text),
        hasSafetyCue: /안전|위험|중단|보고|이상/.test(text),
      });

      expect(compact.length).toBeGreaterThanOrEqual(450);
      expect(text).not.toMatch(/\[[^\]\r\n]+ p\.\d+\]/);
      expect(text).toMatch(/(?:^|\n)\s*1[.)]/m);
      expect(text).toMatch(/(?:^|\n)\s*2[.)]/m);
      expect(text).toMatch(/안전|위험|중단|보고|이상/);
    }, 240_000);

    it("실제 근거로 훈련계획을 만들고 필요하면 한 번 보완한다", async () => {
      loadEnv();
      const { contextText, rowCount } = await loadFireContext();
      const generate = await import("@/lib/generate");
      const { getChatModel } = await import("@/lib/llm");
      const request = {
        type: "plan" as const,
        category: "화재",
        audience: "일반 대원" as const,
        duration: "1시간" as const,
        topic: "공기호흡기 점검과 착용",
      };
      const model = getChatModel();
      const allowedSourceRefs = generate.extractSourceLabels(contextText);
      const system = generate.buildGenerateSystemPrompt(request.category, contextText);
      const run = async (prompt: string) =>
        (
          await generateObject({
            model,
            schema: generate.generatedPlanSchema,
            system,
            prompt,
            temperature: 0.4,
          })
        ).object;

      let draft = await run(generate.buildGeneratePrompt(request));
      const initial = generate.inspectGeneratedPlan(draft, request.duration, allowedSourceRefs);
      let repaired = false;
      if (!initial.ok) {
        draft = await run(
          generate.buildGenerationRepairPrompt({
            type: "plan",
            request,
            draft,
            report: initial,
          })
        );
        repaired = true;
      }
      const final = generate.inspectGeneratedPlan(draft, request.duration, allowedSourceRefs);

      console.log("\n[generate-live]", {
        provider: process.env.LLM_PROVIDER ?? "default",
        model: process.env.GEMINI_MODEL ?? "default",
        contextRows: rowCount,
        repaired,
        initialIssues: initial.issues.map((issue) => issue.code),
        finalIssues: final.issues.map((issue) => issue.code),
        sections: draft.sections.map((section) => ({
          heading: section.heading,
          chars: section.content.replace(/\s+/g, " ").trim().length,
        })),
      });

      expect(final).toEqual({ ok: true, issues: [] });
      expect(draft.sections.map((section) => section.heading)).toEqual(
        generate.TRAINING_PLAN_SECTIONS
      );
    }, 240_000);

    it("실제 근거로 실습형 교안을 만들고 필요하면 한 번 보완한다", async () => {
      loadEnv();
      const { contextText, rowCount } = await loadFireContext();
      const generate = await import("@/lib/generate");
      const { getChatModel } = await import("@/lib/llm");
      const request = {
        type: "lesson" as const,
        category: "화재",
        audience: "일반 대원" as const,
        duration: "1시간" as const,
        topic: "공기호흡기 점검과 착용",
      };
      const model = getChatModel();
      const allowedSourceRefs = generate.extractSourceLabels(contextText);
      const system = generate.buildGenerateSystemPrompt(request.category, contextText);
      const run = async (prompt: string) =>
        (
          await generateObject({
            model,
            schema: generate.generatedLessonSchema,
            system,
            prompt,
            temperature: 0.4,
          })
        ).object;

      let draft = await run(generate.buildGeneratePrompt(request));
      const initial = generate.inspectGeneratedLesson(draft, request.duration, allowedSourceRefs);
      let repaired = false;
      if (!initial.ok) {
        draft = await run(
          generate.buildGenerationRepairPrompt({
            type: "lesson",
            request,
            draft,
            report: initial,
          })
        );
        repaired = true;
      }
      const final = generate.inspectGeneratedLesson(draft, request.duration, allowedSourceRefs);

      console.log("\n[generate-live:lesson]", {
        contextRows: rowCount,
        repaired,
        initialIssues: initial.issues.map((issue) => issue.code),
        finalIssues: final.issues.map((issue) => issue.code),
        sections: draft.sections.map((section) => ({
          heading: section.heading,
          chars: section.content.replace(/\s+/g, " ").trim().length,
        })),
      });

      expect(final).toEqual({ ok: true, issues: [] });
      expect(draft.sections.map((section) => section.heading)).toEqual(generate.LESSON_SECTIONS);
    }, 240_000);

    it("실제 근거로 장별 출처와 교관 대본이 있는 슬라이드를 만들고 보완한다", async () => {
      loadEnv();
      const { contextText, rowCount } = await loadFireContext();
      const generate = await import("@/lib/generate");
      const { getChatModel } = await import("@/lib/llm");
      const request = {
        type: "slides" as const,
        category: "화재",
        audience: "일반 대원" as const,
        duration: "1시간" as const,
        topic: "공기호흡기 점검과 착용",
      };
      const model = getChatModel();
      const allowedSourceRefs = generate.extractSourceLabels(contextText);
      const system = generate.buildGenerateSystemPrompt(request.category, contextText);
      const run = async (prompt: string) =>
        (
          await generateObject({
            model,
            schema: generate.generatedSlidesSchema,
            system,
            prompt,
            temperature: 0.4,
          })
        ).object;

      let draft = await run(generate.buildGeneratePrompt(request));
      const initial = generate.inspectGeneratedSlides(draft, request.duration, allowedSourceRefs);
      let repaired = false;
      if (!initial.ok) {
        draft = await run(
          generate.buildGenerationRepairPrompt({
            type: "slides",
            request,
            draft,
            report: initial,
          })
        );
        repaired = true;
      }
      const final = generate.inspectGeneratedSlides(draft, request.duration, allowedSourceRefs);

      console.log("\n[generate-live:slides]", {
        contextRows: rowCount,
        repaired,
        initialIssues: initial.issues.map((issue) => issue.code),
        finalIssues: final.issues.map((issue) => issue.code),
        slideCount: draft.slides.length,
        minimumNotesChars: Math.min(
          ...draft.slides.map((slide) => slide.notes.replace(/\s+/g, " ").trim().length)
        ),
        layouts: Array.from(new Set(draft.slides.map((slide) => slide.layout))),
        slidesWithSources: draft.slides.filter((slide) => slide.sourceRefs?.length).length,
      });

      expect(final).toEqual({ ok: true, issues: [] });
      expect(draft.slides.every((slide) => (slide.sourceRefs?.length ?? 0) > 0)).toBe(true);
    }, 240_000);
  }
);
