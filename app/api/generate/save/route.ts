import { clientSopEvidence, trustedRagVerificationReader, verifySourcesBeforeSave, verifySopBeforeSave } from "@/lib/generation-evidence-validation";
import { createClient } from "@/lib/supabase/server";
import { requireApiUser } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { DEMO } from "@/lib/demo";
import {
  DURATIONS,
  blockingGenerationQualityIssues,
  inspectCurrentGenerationQuality,
  type Duration,
  type GenType,
  type GeneratedDoc,
  type GeneratedDocSource,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import { checkStoredMaterialGrounding } from "@/lib/generation-grounding-server";
import {
  LimitedJsonBodyError,
  MAX_GENERATED_MATERIALS_PER_USER,
  normalizeGeneratedMaterialContent,
  readLimitedJsonBody,
} from "@/lib/generated-material-save";
import {
  claimedGeneratedSources,
} from "@/lib/source-provenance";

const KINDS: GenType[] = ["plan", "lesson", "slides", "notebooklm"];
// 도식의 조건·행동 관계를 현재 원문과 재검토할 시간을 확보한다.
export const maxDuration = 120;
const PREFLIGHT_QUALITY_CODES = new Set([
  "missing_section",
  "missing_safety",
  "missing_evaluation",
  "missing_time_allocation",
  "time_total_mismatch",
  "thin_content",
  "slide_count_limit",
]);

type SaveBody = {
  id?: number; // 있으면 재편집 저장(해당 행 업데이트)
  revision?: number; // 재편집을 시작할 때 읽은 개정 번호
  kind?: GenType;
  category?: string | null;
  audience?: string | null;
  duration?: string | null;
  topic?: string | null;
  title?: string;
  content?: unknown;
};

type ValidatedSaveBody = SaveBody & {
  kind: GenType;
  title: string;
  content: Record<string, unknown>;
};

type ValidatedShareBody = {
  id: number;
  shared: boolean;
};

function optionalString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().slice(0, max);
  return normalized || null;
}

async function validatedSaveBody(req: Request): Promise<ValidatedSaveBody | Response> {
  let raw: unknown;
  try {
    raw = await readLimitedJsonBody(req);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "저장 요청을 읽지 못했습니다." }, { status: 400 });
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  const candidate = raw as SaveBody;
  const kind = candidate.kind;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!kind || !KINDS.includes(kind) || !title || candidate.content == null) {
    return Response.json({ error: "잘못된 요청입니다." }, { status: 400 });
  }
  if (
    kind !== "notebooklm" &&
    candidate.content &&
    typeof candidate.content === "object" &&
    !Array.isArray(candidate.content) &&
    Object.prototype.hasOwnProperty.call(candidate.content, "sources") &&
    !claimedGeneratedSources(candidate.content).ok
  ) {
    return Response.json(
      {
        code: "source_provenance_invalid",
        error: "출처 정보의 문서 번호·제목·페이지 형식이 올바르지 않습니다.",
      },
      { status: 422 }
    );
  }
  const normalizedContent = normalizeGeneratedMaterialContent(kind, candidate.content);
  if (!normalizedContent.ok) {
    return Response.json({ error: normalizedContent.error }, { status: 400 });
  }
  if (
    candidate.id !== undefined &&
    (!Number.isSafeInteger(candidate.id) || (candidate.id as number) <= 0)
  ) {
    return Response.json({ error: "올바른 저장 자료 번호가 아닙니다." }, { status: 400 });
  }
  if (
    candidate.id !== undefined &&
    (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) <= 0)
  ) {
    return Response.json(
      { error: "재편집 저장에는 올바른 자료 개정 번호가 필요합니다." },
      { status: 400 }
    );
  }
  const category = optionalString(candidate.category, 100);
  const audience = optionalString(candidate.audience, 50);
  const duration = optionalString(candidate.duration, 20);
  const topic = optionalString(candidate.topic, 100);
  if (
    kind !== "notebooklm" &&
    (!category ||
      !audience ||
      !duration ||
      !DURATIONS.includes(duration as Duration) ||
      !topic)
  ) {
    return Response.json(
      { error: "훈련 자료를 저장하려면 분야·대상·올바른 교육 시간·주제가 필요합니다." },
      { status: 400 }
    );
  }

  return {
    id: candidate.id,
    revision: candidate.revision,
    kind,
    category,
    audience,
    duration,
    topic,
    title: title.slice(0, 200),
    content: normalizedContent.content,
  };
}

async function validatedShareBody(req: Request): Promise<ValidatedShareBody | Response> {
  let raw: unknown;
  try {
    raw = await readLimitedJsonBody(req, 2 * 1024);
  } catch (error) {
    if (error instanceof LimitedJsonBodyError) {
      return Response.json({ error: error.message }, { status: error.status });
    }
    return Response.json({ error: "공유 요청을 읽지 못했습니다." }, { status: 400 });
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Response.json({ error: "잘못된 공유 요청입니다." }, { status: 400 });
  }
  const candidate = raw as { id?: unknown; shared?: unknown };
  if (
    !Number.isSafeInteger(candidate.id) ||
    (candidate.id as number) <= 0 ||
    typeof candidate.shared !== "boolean"
  ) {
    return Response.json(
      { error: "올바른 자료 번호와 공유 상태가 필요합니다." },
      { status: 400 }
    );
  }
  return { id: candidate.id as number, shared: candidate.shared };
}

function storedMaterialForSopVerification(
  value: unknown,
  id: number
): ValidatedSaveBody | Response {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return Response.json({ error: "자료를 찾을 수 없습니다." }, { status: 404 });
  }
  const candidate = value as SaveBody;
  const kind = candidate.kind;
  const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
  if (!kind || !KINDS.includes(kind) || !title || candidate.content == null) {
    return Response.json(
      {
        code: "sop_revalidation_required",
        error: "이전 형식의 자료입니다. 편집에서 다시 생성·저장한 뒤 공유해 주세요.",
      },
      { status: 422 }
    );
  }
  if (
    kind !== "notebooklm" &&
    candidate.content &&
    typeof candidate.content === "object" &&
    !Array.isArray(candidate.content) &&
    Object.prototype.hasOwnProperty.call(candidate.content, "sources") &&
    !claimedGeneratedSources(candidate.content).ok
  ) {
    return Response.json(
      {
        code: "source_provenance_invalid",
        error: "저장된 출처 정보의 문서 번호·제목·페이지 형식이 올바르지 않습니다.",
      },
      { status: 422 }
    );
  }
  const normalizedContent = normalizeGeneratedMaterialContent(kind, candidate.content);
  if (!normalizedContent.ok) {
    return Response.json(
      {
        code: "sop_revalidation_required",
        error: "이전 형식의 자료입니다. 편집에서 다시 생성·저장한 뒤 공유해 주세요.",
      },
      { status: 422 }
    );
  }
  const category = optionalString(candidate.category, 100);
  const audience = optionalString(candidate.audience, 50);
  const duration = optionalString(candidate.duration, 20);
  const topic = optionalString(candidate.topic, 100);
  if (kind !== "notebooklm" && (!category || !audience || !duration || !topic)) {
    return Response.json(
      {
        code: "sop_revalidation_required",
        error:
          "분야·대상·교육 시간·주제 정보가 없는 이전 자료입니다. 다시 생성·저장한 뒤 공유해 주세요.",
      },
      { status: 422 }
    );
  }
  return {
    id,
    kind,
    category,
    audience,
    duration,
    topic,
    title: title.slice(0, 200),
    content: normalizedContent.content,
  };
}

function sourceVisualSignature(content: unknown): string {
  if (!content || typeof content !== "object" || Array.isArray(content)) return "[]";
  const slides = (content as { slides?: unknown }).slides;
  if (!Array.isArray(slides)) return "[]";
  return JSON.stringify(
    slides.map((slide, index) => {
      if (!slide || typeof slide !== "object" || Array.isArray(slide)) return null;
      const visual = (slide as { visual?: unknown }).visual;
      if (!visual || typeof visual !== "object" || Array.isArray(visual)) return null;
      const value = visual as Record<string, unknown>;
      if (value.mode !== "source-page" && value.mode !== "source-crop") return null;
      return [index, value.mode, value.documentId, value.page, value.sourceRef];
    })
  );
}

function isShareContractDatabaseError(error: { message?: string } | null): boolean {
  return Boolean(error?.message?.includes("generated_material_share_contract_invalid"));
}

function isCoreQualityDatabaseError(error: { message?: string } | null): boolean {
  return Boolean(error?.message?.includes("generated_material_core_quality_invalid"));
}

function qualityGateBeforeSave(
  body: ValidatedSaveBody,
  includeVerifiedSop: boolean
): Response | null {
  if (body.kind === "notebooklm") return null;
  const duration = body.duration as Duration;
  const sourceLabels = Array.isArray(body.content.sourceLabels)
    ? body.content.sourceLabels.filter(
        (label): label is string => typeof label === "string" && Boolean(label.trim())
      )
    : undefined;
  const sopEvidence = includeVerifiedSop ? clientSopEvidence(body.content) ?? undefined : undefined;
  const sources = Array.isArray(body.content.sources)
    ? (body.content.sources as GeneratedDocSource[])
    : [];
  const draft =
    body.kind === "slides"
      ? ({
          title: body.title,
          mode: body.content.mode,
          slides: body.content.slides,
          sources,
          sourceLabels,
          sopEvidence,
        } as GeneratedSlideDeck)
      : ({
          title: body.title,
          sections: body.content.sections,
          sources,
          sourceLabels,
          sopEvidence,
        } as GeneratedDoc);
  const quality = inspectCurrentGenerationQuality(
    body.kind,
    draft,
    duration
  );
  const blockingIssues = blockingGenerationQualityIssues(quality).filter(
    (issue) => includeVerifiedSop || PREFLIGHT_QUALITY_CODES.has(issue.code)
  );
  if (blockingIssues.length === 0) return null;

  return Response.json(
    {
      code: "generation_quality_invalid",
      error:
        "핵심 품질 오류가 남아 저장할 수 없습니다. 편집하거나 해당 부분을 AI로 다시 생성한 뒤 다시 시도해 주세요.",
      issues: blockingIssues.slice(0, 20),
    },
    { status: 422 }
  );
}

async function technicalGateBeforeUse(
  body: ValidatedSaveBody,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<Response | null> {
  if (body.kind === "notebooklm") return null;
  const check = await checkStoredMaterialGrounding({
    kind: body.kind,
    title: body.title,
    category: body.category ?? "",
    content: body.content,
    request: {
      topic: body.topic ?? undefined,
      audience: body.audience ?? undefined,
      duration: body.duration ?? undefined,
      focus: typeof body.content.focus === "string" ? body.content.focus : undefined,
      conditions: typeof body.content.conditions === "string" ? body.content.conditions : undefined,
    },
    supabase,
  });
  return check.ok ? null : Response.json({
    code: check.status === 503 ? "grounding_verification_unavailable" : "generation_grounding_invalid",
    error: check.error,
    issues: check.issues ?? [],
  }, { status: check.status });
}

// 생성물 저장 — insert/update는 본인 세션과 RLS로만 수행한다. service role은 인증 뒤
// 생성 Workflow와 같은 RAG 근거를 읽어 재검증하는 데만 제한적으로 사용한다.
export async function POST(req: Request) {
  // 데모 모드: DB 없이 저장 성공으로 처리(UI 흐름 확인용)
  if (DEMO) {
    const body = await validatedSaveBody(req);
    if (body instanceof Response) return body;
    return Response.json({
      id: body.id ?? 0,
      revision: body.id ? (body.revision ?? 1) + 1 : 1,
      demo: true,
    });
  }

  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;

  const rl = rateLimit(`generate-save:${auth.user.id}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  // 인증·사용자별 레이트리밋을 통과한 뒤에만 제한된 크기로 JSON을 읽는다.
  const body = await validatedSaveBody(req);
  if (body instanceof Response) return body;

  // 시간·안전·평가·필수 구성은 외부 조회 전에 먼저 검사해 불필요한 DB 작업을 피한다.
  const initialQualityError = qualityGateBeforeSave(body, false);
  if (initialQualityError) return initialQualityError;

  // 동일 계정을 여러 명이 쓰는 시범운영에서는 오래 열린 편집 화면이 최신 저장본을
  // 덮어쓰지 않도록, 외부 RAG 재검증 전에 현재 개정 번호부터 확인한다.
  if (typeof body.id === "number") {
    const { data: current, error: currentError } = await supabase
      .from("generated_materials")
      .select("id, revision")
      .eq("id", body.id)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (currentError) {
      console.error("[generate/save] 개정 번호 확인 실패:", currentError.message);
      return Response.json({ error: "저장본의 최신 상태를 확인하지 못했습니다." }, { status: 500 });
    }
    if (!current) {
      return Response.json({ error: "저장할 자료를 찾을 수 없습니다." }, { status: 404 });
    }
    if (current.revision !== body.revision) {
      return Response.json(
        {
          code: "material_revision_conflict",
          error:
            "다른 사용자가 이 자료를 먼저 수정했습니다. 저장한 자료에서 최신본을 다시 열어 변경 내용을 확인해 주세요.",
          currentRevision: current.revision,
        },
        { status: 409 }
      );
    }
  }

  const ragVerificationReader =
    body.kind === "notebooklm" ? null : trustedRagVerificationReader();
  if (ragVerificationReader instanceof Response) return ragVerificationReader;
  const sourceError = await verifySourcesBeforeSave(
    body,
    supabase,
    ragVerificationReader
  );
  if (sourceError) return sourceError;
  const sopError = await verifySopBeforeSave(body, ragVerificationReader);
  if (sopError) return sopError;
  // 서버가 방금 고정한 SOP 근거까지 포함해 최종 품질 계약을 다시 검사한다.
  const verifiedQualityError = qualityGateBeforeSave(body, true);
  if (verifiedQualityError) return verifiedQualityError;
  const groundingError = await technicalGateBeforeUse(body, supabase);
  if (groundingError) return groundingError;

  const fields = {
    kind: body.kind,
    category: body.category ?? null,
    audience: body.audience ?? null,
    duration: body.duration ?? null,
    topic: body.topic ?? null,
    title: body.title,
    content: body.content,
  };

  // 재편집 저장: id 가 있으면 해당 행 업데이트(RLS 로 본인 것만).
  if (typeof body.id === "number") {
    const { data, error } = await supabase
      .from("generated_materials")
      .update(fields)
      .eq("id", body.id)
      .eq("revision", body.revision as number)
      .select("id, revision");
    if (error) {
      console.error("[generate/save] update 실패:", error.message);
      if (isShareContractDatabaseError(error)) {
        return Response.json(
          {
            code: "sop_contract_invalid",
            error: "공유 중인 자료의 SOP 근거 계약과 맞지 않아 저장할 수 없습니다. 다시 생성하거나 공유를 해제한 뒤 수정해 주세요.",
          },
          { status: 422 }
        );
      }
      if (isCoreQualityDatabaseError(error)) {
        return Response.json(
          {
            code: "generation_quality_invalid",
            error: "DB 핵심 품질 기준과 맞지 않아 저장할 수 없습니다.",
          },
          { status: 422 }
        );
      }
      return Response.json({ error: "저장 중 오류가 발생했습니다." }, { status: 500 });
    }
    // 사전 확인 뒤 다른 화면이 먼저 저장한 경우 CAS 조건에서 0행이 된다.
    if (!data || data.length === 0) {
      return Response.json(
        {
          code: "material_revision_conflict",
          error:
            "다른 사용자가 이 자료를 먼저 수정했습니다. 저장한 자료에서 최신본을 다시 열어 변경 내용을 확인해 주세요.",
        },
        { status: 409 }
      );
    }
    return Response.json({ id: body.id, revision: data[0].revision });
  }

  // DB 트리거가 동시 삽입까지 최종 차단하며, 이 조회는 사용자에게 친절한 오류를 먼저 돌려준다.
  const { count, error: countError } = await supabase
    .from("generated_materials")
    .select("id", { count: "exact", head: true })
    .eq("user_id", auth.user.id);
  if (countError) {
    console.error("[generate/save] 저장 개수 확인 실패:", countError.message);
    return Response.json({ error: "저장 공간을 확인하지 못했습니다." }, { status: 500 });
  }
  if ((count ?? 0) >= MAX_GENERATED_MATERIALS_PER_USER) {
    return Response.json(
      { error: `저장 자료는 계정당 최대 ${MAX_GENERATED_MATERIALS_PER_USER}개까지 보관할 수 있습니다.` },
      { status: 409 }
    );
  }

  const { data, error } = await supabase
    .from("generated_materials")
    .insert({ user_id: auth.user.id, ...fields })
    .select("id, revision")
    .single();

  if (error) {
    console.error("[generate/save] insert 실패:", error.message);
    if (error.message.includes("generated_materials_user_limit_exceeded")) {
      return Response.json(
        { error: `저장 자료는 계정당 최대 ${MAX_GENERATED_MATERIALS_PER_USER}개까지 보관할 수 있습니다.` },
        { status: 409 }
      );
    }
    if (isShareContractDatabaseError(error)) {
      return Response.json(
        {
          code: "sop_contract_invalid",
          error: "SOP 근거 계약과 맞지 않아 저장할 수 없습니다.",
        },
        { status: 422 }
      );
    }
    if (isCoreQualityDatabaseError(error)) {
      return Response.json(
        {
          code: "generation_quality_invalid",
          error: "DB 핵심 품질 기준과 맞지 않아 저장할 수 없습니다.",
        },
        { status: 422 }
      );
    }
    return Response.json({ error: "저장 중 오류가 발생했습니다." }, { status: 500 });
  }
  return Response.json({ id: data.id, revision: data.revision ?? 1 });
}

// 저장본 삭제 — RLS + revision CAS로 본인 최신본만 삭제된다.
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const revision = Number(url.searchParams.get("revision"));
  if (
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(revision) ||
    revision <= 0
  ) {
    return new Response("잘못된 요청입니다.", { status: 400 });
  }
  if (DEMO) return Response.json({ ok: true, demo: true });

  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;

  const rl = rateLimit(`generate-del:${auth.user.id}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const { data: current, error: currentError } = await supabase
    .from("generated_materials")
    .select("id, revision")
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  if (currentError) {
    console.error("[generate/save] 삭제 전 개정 번호 확인 실패:", currentError.message);
    return Response.json({ error: "삭제할 자료의 최신 상태를 확인하지 못했습니다." }, { status: 500 });
  }
  if (!current) {
    return Response.json({ error: "삭제할 자료를 찾을 수 없습니다." }, { status: 404 });
  }
  if (current.revision !== revision) {
    return Response.json(
      {
        code: "material_revision_conflict",
        error:
          "다른 화면에서 이 자료가 수정되었습니다. 최신 목록을 불러온 뒤 다시 확인해 주세요.",
        currentRevision: current.revision,
      },
      { status: 409 }
    );
  }

  const { data, error } = await supabase
    .from("generated_materials")
    .delete()
    .eq("id", id)
    .eq("user_id", auth.user.id)
    .eq("revision", revision)
    .select("id");
  if (error) {
    console.error("[generate/save] delete 실패:", error.message);
    return Response.json({ error: "삭제 중 오류가 발생했습니다." }, { status: 500 });
  }
  // 조회 직후 다른 화면이 저장했다면 CAS 조건에서 0행이 되어 최신본을 보존한다.
  if (!data || data.length === 0) {
    return Response.json(
      {
        code: "material_revision_conflict",
        error:
          "다른 화면에서 이 자료가 수정되었습니다. 최신 목록을 불러온 뒤 다시 확인해 주세요.",
      },
      { status: 409 }
    );
  }
  return Response.json({ ok: true });
}

// 공유 토글 — 본인 자료를 다른 대원에게 공개/비공개(RLS 로 본인 것만).
// 공유 시 작성자 이름을 비정규화 저장(profiles 는 본인만 읽혀 목록에서 이름을 못 가져오므로).
export async function PATCH(req: Request) {
  if (DEMO) {
    const body = await validatedShareBody(req);
    if (body instanceof Response) return body;
    return Response.json({ ok: true, shared: body.shared, demo: true });
  }

  const supabase = await createClient();
  const auth = await requireApiUser(supabase);
  if (!auth.ok) return auth.response;

  const rl = rateLimit(`generate-share:${auth.user.id}`, 30, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  // 인증·사용자별 레이트리밋 뒤에만 작은 상한으로 본문을 읽는다.
  const body = await validatedShareBody(req);
  if (body instanceof Response) return body;

  const patch: { shared: boolean; author_name?: string } = { shared: body.shared };
  let verifiedRevision: number | undefined;
  if (body.shared) {
    // RLS가 본인 행만 돌려준다. 클라이언트가 보낸 content가 아니라 저장된 원본을 검증한다.
    const { data: stored, error: storedError } = await supabase
      .from("generated_materials")
      .select("id, revision, kind, category, audience, duration, topic, title, content")
      .eq("id", body.id)
      .eq("user_id", auth.user.id)
      .maybeSingle();
    if (storedError) {
      console.error("[generate/save] 공유 전 자료 조회 실패:", storedError.message);
      return Response.json({ error: "공유할 자료를 확인하지 못했습니다." }, { status: 500 });
    }
    if (!stored) {
      return Response.json({ error: "자료를 찾을 수 없습니다." }, { status: 404 });
    }
    if (!Number.isSafeInteger(stored.revision) || stored.revision < 1) {
      return Response.json({ error: "공유할 자료의 최신 개정 번호를 확인하지 못했습니다." }, { status: 503 });
    }
    verifiedRevision = stored.revision;

    const rawVisualSignature = sourceVisualSignature(
      (stored as { content?: unknown }).content
    );
    const verifiedBody = storedMaterialForSopVerification(stored, body.id);
    if (verifiedBody instanceof Response) return verifiedBody;
    if (verifiedBody.kind !== "notebooklm" && !clientSopEvidence(verifiedBody.content)) {
      return Response.json(
        {
          code: "sop_revalidation_required",
          error: "SOP 근거 상태가 없는 이전 자료입니다. 다시 생성·저장한 뒤 공유해 주세요.",
        },
        { status: 422 }
      );
    }
    const visualBefore = sourceVisualSignature(verifiedBody.content);
    if (rawVisualSignature !== visualBefore) {
      return Response.json(
        {
          code: "source_provenance_invalid",
          error:
            "저장된 원문 시각자료 연결이 출처 목록과 일치하지 않습니다. 편집 화면에서 다시 저장한 뒤 공유해 주세요.",
        },
        { status: 422 }
      );
    }
    const ragVerificationReader =
      verifiedBody.kind === "notebooklm" ? null : trustedRagVerificationReader();
    if (ragVerificationReader instanceof Response) return ragVerificationReader;
    const sourceError = await verifySourcesBeforeSave(
      verifiedBody,
      supabase,
      ragVerificationReader
    );
    if (sourceError) return sourceError;
    const visualAfter = sourceVisualSignature(verifiedBody.content);
    if (visualBefore !== visualAfter) {
      return Response.json(
        {
          code: "source_provenance_invalid",
          error:
            "원문 시각자료 출처가 현재 RAG 자료와 일치하지 않습니다. 편집 화면에서 다시 저장한 뒤 공유해 주세요.",
        },
        { status: 422 }
      );
    }

    const sopError = await verifySopBeforeSave(verifiedBody, ragVerificationReader);
    if (sopError) return sopError;
    const verifiedQualityError = qualityGateBeforeSave(verifiedBody, true);
    if (verifiedQualityError) return verifiedQualityError;
    const groundingError = await technicalGateBeforeUse(verifiedBody, supabase);
    if (groundingError) return groundingError;
    if (clientSopEvidence(verifiedBody.content)?.status === "degraded") {
      return Response.json(
        {
          code: "sop_search_unavailable",
          error:
            "현재 SOP 자료 검색 상태를 확인할 수 없어 공유할 수 없습니다. 검색이 정상화된 뒤 자료를 다시 생성·저장해 주세요.",
        },
        { status: 422 }
      );
    }

    const { data: prof } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", auth.user.id)
      .maybeSingle();
    patch.author_name = prof?.full_name ?? auth.user.email?.split("@")[0] ?? "구조대원";
  }

  let shareUpdate = supabase
    .from("generated_materials")
    .update(patch)
    .eq("id", body.id)
    .eq("user_id", auth.user.id);
  // 검토를 기다리는 동안 다른 화면이 저장한 새 내용을 대신 공개하지 않는다.
  // 공유 해제는 원문 검토나 개정 번호와 무관하게 본인 자료에서 즉시 허용한다.
  if (verifiedRevision !== undefined) shareUpdate = shareUpdate.eq("revision", verifiedRevision);
  const { data, error } = await shareUpdate.select("id");
  if (error) {
    console.error("[generate/save] 공유 토글 실패:", error.message);
    if (isShareContractDatabaseError(error)) {
      return Response.json(
        {
          code: "sop_contract_invalid",
          error:
            "현재 DB에서 확인한 SOP 근거와 공유 자료가 일치하지 않습니다. 자료를 다시 생성·저장한 뒤 공유해 주세요.",
        },
        { status: 422 }
      );
    }
    return Response.json({ error: "공유 설정에 실패했습니다." }, { status: 500 });
  }
  if (!data || data.length === 0) {
    if (verifiedRevision !== undefined) return Response.json({
      code: "material_revision_conflict",
      error: "근거를 검토하는 동안 자료가 변경되어 공유하지 않았습니다. 최신 목록을 불러온 뒤 다시 확인해 주세요.",
    }, { status: 409 });
    return Response.json({ error: "자료를 찾을 수 없습니다." }, { status: 404 });
  }
  return Response.json({ ok: true, shared: body.shared });
}
