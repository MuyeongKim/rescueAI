import { generateObject } from "ai";
import { getChatModel } from "@/lib/llm";
import { requireApiUser } from "@/lib/auth";
import {
  AUDIENCES,
  DURATIONS,
  buildGenerationRepairPrompt,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  generatedDocSchemaFor,
  generatedSlidesSchema,
  extractSourceLabels,
  inspectGenerationQuality,
  type GenerateRequest,
  type GeneratedDoc,
  type GeneratedSlideDeck,
  type GenerationQualityReport,
} from "@/lib/generate";
import { DEMO, demoGeneratedDoc, demoGeneratedSlides } from "@/lib/demo";
import { fetchCategoryContext } from "@/lib/generate-context";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const maxDuration = 120;

type QualityMeta = {
  checked: true;
  repaired: boolean;
  warnings: string[];
};

const QUALITY_LABELS: Partial<
  Record<GenerationQualityReport["issues"][number]["code"], string>
> = {
  missing_section: "필수 구성 누락",
  unexpected_section: "예정되지 않은 구성",
  section_order: "구성 순서",
  thin_content: "일부 내용의 구체성·분량",
  missing_safety: "안전·중단 기준",
  missing_evaluation: "평가·통과 기준",
  missing_time_allocation: "단계별 시간 배분",
  time_total_mismatch: "교육 시간 합계",
  slide_count: "교육 시간에 맞는 슬라이드 수",
  thin_notes: "일부 발표자 노트 분량",
  duplicate_slide_title: "중복 슬라이드 제목",
  duplicate_slide_content: "중복 슬라이드 내용",
  missing_slide_layout: "슬라이드 구성 방식",
  generic_slide_title: "슬라이드 결론형 제목",
  missing_source_citation: "핵심 내용의 근거 출처",
  missing_source_refs: "슬라이드별 근거 출처",
  invalid_source_ref: "근거 출처 표기",
};

function qualityMeta(report: GenerationQualityReport, repaired: boolean): QualityMeta {
  const labels = Array.from(
    new Set(report.issues.map((issue) => QUALITY_LABELS[issue.code] ?? issue.message))
  );
  const warnings = labels.slice(0, 4);
  if (labels.length > warnings.length) warnings.push(`그 밖의 점검 항목 ${labels.length - warnings.length}개`);
  return { checked: true, repaired, warnings };
}

// 인덱싱 자료를 근거로 훈련계획/교안을 생성한다. (NotebookLM 프롬프트는 클라이언트에서 조립)
export async function POST(req: Request) {
  let body: Partial<GenerateRequest> = {};
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const topic = (body.topic ?? "").trim().slice(0, 100);
  if (topic.length < 2) {
    return Response.json(
      { error: "훈련 주제를 두 글자 이상 입력해 주세요." },
      { status: 400 }
    );
  }

  // 데모 모드: AI/DB 없이 목 문서/슬라이드 반환
  if (DEMO) {
    if (body.type === "slides") {
      return Response.json({
        ...demoGeneratedSlides,
        title: body.category
          ? demoGeneratedSlides.title.replace("화재", body.category)
          : demoGeneratedSlides.title,
        quality: { checked: true, repaired: false, warnings: [] },
      } satisfies GeneratedSlideDeck & { quality: QualityMeta });
    }
    return Response.json({
      ...demoGeneratedDoc,
      title: body.category
        ? demoGeneratedDoc.title.replace("화재", body.category)
        : demoGeneratedDoc.title,
      quality: { checked: true, repaired: false, warnings: [] },
    } satisfies GeneratedDoc & { quality: QualityMeta });
  }

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  // 문서 생성은 비용이 크므로 더 타이트하게 (분당 10회/사용자)
  const rl = rateLimit(`generate:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const type = body.type;
  const category = (body.category ?? "").trim();
  const audience = body.audience;
  const duration = body.duration;
  if (
    (type !== "plan" && type !== "lesson" && type !== "slides") ||
    !category ||
    !audience ||
    !AUDIENCES.includes(audience) ||
    !duration ||
    !DURATIONS.includes(duration)
  ) {
    return new Response("잘못된 요청입니다.", { status: 400 });
  }
  const genReq: GenerateRequest = {
    type,
    category,
    audience,
    duration,
    topic,
    date: /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "") ? body.date : undefined,
    place: body.place?.slice(0, 100),
    model: body.model,
  };

  const { contextText, sources } = await fetchCategoryContext(category, 40, genReq.topic);
  if (!contextText) {
    return Response.json(
      { error: "해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다." },
      { status: 422 }
    );
  }

  try {
    const system = buildGenerateSystemPrompt(category, contextText);
    const allowedSourceRefs = extractSourceLabels(contextText);
    // 폼에서 선택한 모델 — 미지정/사용불가 시 서버 기본값으로 폴백
    const model = getChatModel(genReq.model);

    if (type === "slides") {
      const generateSlides = async (prompt: string) => {
        const { object } = await generateObject({
          model,
          schema: generatedSlidesSchema,
          system,
          prompt,
          temperature: 0.4,
        });
        return object;
      };
      let object = await generateSlides(buildGeneratePrompt(genReq));
      let report = inspectGenerationQuality("slides", object, duration, allowedSourceRefs);
      let repaired = false;
      if (!report.ok) {
        try {
          object = await generateSlides(
            buildGenerationRepairPrompt({ type: "slides", request: genReq, draft: object, report })
          );
          report = inspectGenerationQuality("slides", object, duration, allowedSourceRefs);
          repaired = true;
        } catch (repairError) {
          console.error("[generate] 슬라이드 자동 보완 실패, 1차 초안 반환:", repairError);
        }
      }
      return Response.json({
        ...object,
        sources,
        quality: qualityMeta(report, repaired),
      } satisfies GeneratedSlideDeck & { quality: QualityMeta });
    }

    const generateDoc = async (prompt: string) => {
      const { object } = await generateObject({
        model,
        schema: generatedDocSchemaFor(type),
        system,
        prompt,
        temperature: 0.4,
      });
      return object;
    };
    let object = await generateDoc(buildGeneratePrompt(genReq));
    let report = inspectGenerationQuality(type, object, duration, allowedSourceRefs);
    let repaired = false;
    if (!report.ok) {
      try {
        object = await generateDoc(
          buildGenerationRepairPrompt({ type, request: genReq, draft: object, report })
        );
        report = inspectGenerationQuality(type, object, duration, allowedSourceRefs);
        repaired = true;
      } catch (repairError) {
        console.error("[generate] 문서 자동 보완 실패, 1차 초안 반환:", repairError);
      }
    }
    return Response.json({
      ...object,
      sources,
      quality: qualityMeta(report, repaired),
    } satisfies GeneratedDoc & { quality: QualityMeta });
  } catch (e) {
    console.error("[generate] 실패:", e);
    return Response.json(
      { error: "문서 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
