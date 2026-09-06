import type { createClient } from "@/lib/supabase/server";
import { generatedSourceLabels, type GenType } from "@/lib/generate";
import { buildFocusedTrainingQuery } from "@/lib/generate-focus";
import { generationRetrievalQuery } from "@/lib/generation-evidence-coverage";
import { ragTableEnabled } from "@/lib/rag-external";
import { inspectSopContract, type SopEvidence, type SopInspectableResult } from "@/lib/sop-evidence";
import { rebindNormalizedSlideContent } from "@/lib/generated-material-save";
import { createGenerationRagReader, type GenerationRagReader } from "@/lib/supabase/generation-rag";
import { claimedGeneratedSources, sameVerifiedSourceSet, verifyNativeDocumentSourceProvenance } from "@/lib/source-provenance";

type EvidenceValidationBody = {
  kind: GenType;
  title: string;
  category?: string | null;
  topic?: string | null;
  content: Record<string, unknown>;
};
const EMPTY_SOP_EVIDENCE: SopEvidence = { status: "not_found", sourceLabels: [] };

// 저장·공유·다운로드가 동일한 실제 출처와 SOP 계약을 확인한다.
function normalizeVerifiedSopEvidence(evidence: SopEvidence): SopEvidence {
  const sourceLabels = Array.from(
    new Set(
      evidence.sourceLabels
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, 20)
    )
  );
  if (evidence.status === "found" && sourceLabels.length > 0) {
    return { status: "found", sourceLabels };
  }
  return {
    status: evidence.status === "degraded" ? "degraded" : "not_found",
    sourceLabels: [],
  };
}

export function clientSopEvidence(content: Record<string, unknown>): SopEvidence | null {
  const value = content.sopEvidence;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SopEvidence>;
  if (
    !["found", "not_found", "degraded"].includes(candidate.status ?? "") ||
    !Array.isArray(candidate.sourceLabels)
  ) {
    return null;
  }
  return normalizeVerifiedSopEvidence(candidate as SopEvidence);
}

function sameSopEvidence(left: SopEvidence, right: SopEvidence): boolean {
  if (left.status !== right.status) return false;
  const leftLabels = [...left.sourceLabels].sort();
  const rightLabels = [...right.sourceLabels].sort();
  return (
    leftLabels.length === rightLabels.length &&
    leftLabels.every((label, index) => label === rightLabels[index])
  );
}

export async function verifySopBeforeSave(
  body: EvidenceValidationBody,
  ragReader: GenerationRagReader | null,
  options: { requireAvailable?: boolean } = {}
): Promise<Response | null> {
  if (body.kind === "notebooklm") return null;

  let expected = EMPTY_SOP_EVIDENCE;
  if (body.category && body.topic && ragTableEnabled()) {
    try {
      const focus = typeof body.content.focus === "string" ? body.content.focus : "";
      const conditions = typeof body.content.conditions === "string" ? body.content.conditions : undefined;
      // 생성·부분 보완과 같은 조건으로 검색해야 정상 근거 집합을 변경으로 오인하지 않는다.
      const query = generationRetrievalQuery(buildFocusedTrainingQuery(body.topic, focus), conditions);
      if (!ragReader) throw new Error("서버 RAG 검증기가 준비되지 않았습니다.");
      const result = await ragReader.fetchSopContext(body.category, query, 4);
      expected = options.requireAvailable && result.degraded
        ? { status: "degraded", sourceLabels: [] }
        : normalizeVerifiedSopEvidence(result.evidence);
    } catch (error) {
      // 조회 자체가 실패한 경우 클라이언트의 주장으로 대체하지 않는다. 근거 없음과도
      // 구분해 장애 상태 전용 고정 안내문을 요구한다.
      console.error(
        "[generate/save] SOP 근거 재검증 실패:",
        error instanceof Error ? error.message : error
      );
      expected = { status: "degraded", sourceLabels: [] };
    }
  }

  // 개인 초안 보관 정책과 달리, 공식 다운로드는 조회 장애를 확인 완료로 처리하지 않는다.
  if (options.requireAvailable && expected.status === "degraded") {
    return Response.json({
      code: "sop_verification_unavailable",
      error: "현재 SOP 근거를 확인하지 못했습니다. 초안을 보존하고 잠시 후 다시 시도해 주세요.",
    }, { status: 503 });
  }

  const claimed = clientSopEvidence(body.content);
  if (claimed && !sameSopEvidence(claimed, expected)) {
    // 문서명·사용자 입력은 로그에 남기지 않고 상태와 개수만 기록한다.
    if (process.env.NODE_ENV === "production") {
      console.warn("[generate/save] SOP 근거 충돌:", {
        claimedStatus: claimed.status,
        claimedLabelCount: claimed.sourceLabels.length,
        expectedStatus: expected.status,
        expectedLabelCount: expected.sourceLabels.length,
      });
    }
    return Response.json(
      {
        code: "sop_evidence_conflict",
        error:
          "자료의 SOP 근거 상태가 현재 서버 검증 결과와 일치하지 않습니다. 자료를 다시 생성하거나 현재 근거에 맞게 수정해 주세요.",
      },
      { status: 409 }
    );
  }

  const verifiedContent = { ...body.content, sopEvidence: expected };
  const report = inspectSopContract(
    body.kind,
    verifiedContent as unknown as SopInspectableResult,
    expected
  );
  if (!report.ok) {
    return Response.json(
      {
        code: "sop_contract_invalid",
        error:
          "SOP 필수 내용이 누락되었거나 현재 확인된 근거와 일치하지 않습니다. 해당 내용을 보완해 주세요.",
        issues: report.issues,
      },
      { status: 422 }
    );
  }

  // 저장되는 provenance는 클라이언트 값이 아니라 방금 서버가 확인한 값으로 고정한다.
  body.content = verifiedContent;
  return null;
}

export function trustedRagVerificationReader(): GenerationRagReader | null | Response {
  if (!ragTableEnabled()) return null;
  try {
    // 내구성 Workflow와 같은 RAG 권한으로 재조회해야 공통 SOP가 사용자 RLS에서
    // 누락되더라도 생성 당시 서버 검증 집합과 저장 검증 집합이 갈라지지 않는다.
    return createGenerationRagReader();
  } catch (error) {
    console.error(
      "[generate/save] 서버 RAG 검증기 준비 실패:",
      error instanceof Error ? error.message : error
    );
    return Response.json(
      {
        code: "source_provenance_unavailable",
        error: "서버 자료 검증을 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      },
      { status: 503 }
    );
  }
}

export async function verifySourcesBeforeSave(
  body: EvidenceValidationBody,
  supabase: Awaited<ReturnType<typeof createClient>>,
  ragReader: GenerationRagReader | null
): Promise<Response | null> {
  if (body.kind === "notebooklm") return null;
  const claimed = claimedGeneratedSources(body.content);
  if (!claimed.ok) {
    return Response.json(
      {
        code: "source_provenance_invalid",
        error: "출처 정보의 문서 번호·제목·페이지 형식이 올바르지 않습니다.",
      },
      { status: 422 }
    );
  }
  const claimedSources = claimed.sources;
  if (claimedSources.length === 0) {
    // 클라이언트가 임의 sourceLabels를 보내도 출처가 하나도 검증되지 않은 자료가
    // 일반 인용 품질 게이트를 통과하지 못하도록 서버 기준의 빈 목록으로 고정한다.
    body.content = { ...body.content, sources: [], sourceLabels: [] };
    return null;
  }

  const verified = ragTableEnabled()
    ? ragReader
      ? await ragReader.verifySourceProvenance(
          claimedSources,
          body.category ?? ""
        )
      : { sources: [], degraded: true }
    : await verifyNativeDocumentSourceProvenance(
        claimedSources,
        body.category ?? "",
        supabase
      );
  if (verified.degraded) {
    return Response.json(
      {
        code: "source_provenance_unavailable",
        error: "문서 출처를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      },
      { status: 503 }
    );
  }
  if (!sameVerifiedSourceSet(claimedSources, verified.sources)) {
    return Response.json(
      {
        code: "source_provenance_invalid",
        error:
          "문서 출처가 현재 등록된 원본의 분야·문서 번호·제목·페이지와 일치하지 않습니다.",
      },
      { status: 422 }
    );
  }

  const verifiedSources = [...verified.sources];
  const verifiedSourceLabels = generatedSourceLabels(verifiedSources);
  body.content =
    body.kind === "slides"
      ? {
          ...rebindNormalizedSlideContent(body.content, verifiedSources),
          sourceLabels: verifiedSourceLabels,
        }
      : {
          ...body.content,
          sources: verifiedSources,
          sourceLabels: verifiedSourceLabels,
        };
  return null;
}
