import "server-only";
import { createClient } from "@/lib/supabase/server";
import { createGenerationRagReader } from "@/lib/supabase/generation-rag";
import { ragTableEnabled } from "@/lib/rag-external";
import { claimedGeneratedSources, sameVerifiedSourceSet, verifyNativeDocumentSourceProvenance } from "@/lib/source-provenance";
import { inspectTechnicalGrounding, type GroundingRequest } from "@/lib/generation-grounding";
import { reviewGenerationGrounding } from "@/lib/generation-grounding-review";
import { inspectSlideDiagram } from "@/lib/slide-diagram";
import type { GeneratedDoc, GeneratedSlideDeck, GenerationQualityIssue } from "@/lib/generate";

export type GroundingCheck = { ok: true } | {
  ok: false; status: 422 | 503; error: string; issues?: GenerationQualityIssue[];
};

/** 저장·공유·내보내기 직전 기술 수치와 명시적 도식 관계를 서버 원문과 대조한다. 사실성 보증은 아니다. */
export async function checkStoredMaterialGrounding(args: {
  kind: "plan" | "lesson" | "slides";
  title: string;
  category: string;
  content: Record<string, unknown>;
  request: GroundingRequest;
  supabase: Awaited<ReturnType<typeof createClient>>;
}): Promise<GroundingCheck> {
  const draft = { ...args.content, title: args.title } as unknown as GeneratedDoc | GeneratedSlideDeck;
  const diagramSlides = "slides" in draft ? draft.slides.flatMap((slide, index) =>
    slide.diagram === undefined ? [] : [{ slide, index }]) : [];
  const invalidDiagram = diagramSlides.find(({ slide }) => !inspectSlideDiagram(slide).valid);
  if (invalidDiagram) return { ok: false, status: 422,
    error: `${invalidDiagram.index + 1}번 슬라이드의 도식 연결을 확인해 주세요.` };
  if (diagramSlides.length === 0 && inspectTechnicalGrounding(draft, "", args.request).ok) return { ok: true };
  const claimed = claimedGeneratedSources(args.content);
  if (!claimed.ok || claimed.sources.length === 0) {
    return { ok: false, status: 422, error: "기술 수치와 도식 관계를 대조할 원문 출처가 필요합니다." };
  }
  try {
    let evidenceText = "";
    if (ragTableEnabled()) {
      const evidence = await createGenerationRagReader().verifySourceEvidence(claimed.sources, args.category);
      if (evidence.degraded || !evidence.contextText) {
        return { ok: false, status: 503, error: "검증용 원문을 읽지 못했습니다. 잠시 후 다시 시도해 주세요." };
      }
      if (!sameVerifiedSourceSet(claimed.sources, evidence.sources)) {
        return { ok: false, status: 422, error: "검증용 출처가 현재 등록된 원본과 일치하지 않습니다." };
      }
      evidenceText = evidence.contextText;
    } else {
      const verified = await verifyNativeDocumentSourceProvenance(claimed.sources, args.category, args.supabase, true);
      if (verified.degraded) return { ok: false, status: 503, error: "검증용 원문 조회가 지연되었습니다." };
      if (!sameVerifiedSourceSet(claimed.sources, verified.sources)) {
        return { ok: false, status: 422, error: "검증용 출처가 원본과 일치하지 않습니다." };
      }
      evidenceText = verified.contextText ?? "";
      if (!evidenceText) {
        return { ok: false, status: 503, error: "검증용 원문의 분량을 확인해 주세요." };
      }
    }
    const quality = inspectTechnicalGrounding(draft, evidenceText, args.request);
    if (!quality.ok) return {
      ok: false, status: 422,
      error: "연결된 원문에서 확인되지 않은 기술 수치가 있습니다. 근거를 확인하거나 수치를 수정해 주세요.",
      issues: quality.issues,
    };
    if (diagramSlides.length > 0) {
      const review = await reviewGenerationGrounding({
        draft: { ...draft, slides: diagramSlides.map(({ slide }) => slide) } as GeneratedSlideDeck,
        evidenceText, request: args.request, modelKey: "gemini-flash", timeoutMs: 35_000,
      });
      if (!review.ok) {
        const issues = review.issues.map((issue) => {
          const match = /^slides\.(\d+)(.*)$/.exec(issue.path);
          const original = match && diagramSlides[Number(match[1])];
          if (!original) throw new Error("도식 근거 검토 위치를 복원하지 못했습니다.");
          return { code: issue.code, message: issue.message, excerpt: issue.excerpt,
            path: `slides.${original.index}${match[2]}` };
        });
        const first = issues[0];
        const slideNumber = first ? Number(/^slides\.(\d+)/.exec(first.path)?.[1]) + 1 : undefined;
        return {
          ok: false, status: 422,
          error: `${slideNumber ? `${slideNumber}번 슬라이드: ` : ""}${first?.message ?? "도식의 조건·행동 연결을 원문에서 확인하지 못했습니다."} 연결을 수정하거나 도식을 해제해 주세요.`,
          issues,
        };
      }
    }
    return { ok: true };
  } catch (error) {
    console.error("[generation-grounding] 원문 검증 실패:", error instanceof Error ? error.message : "unknown");
    return { ok: false, status: 503, error: "원문 검증을 완료하지 못했습니다. 초안을 보존하고 다시 시도해 주세요." };
  }
}
