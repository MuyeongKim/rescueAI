"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  FileText,
  Lightbulb,
  Loader2,
  MessageSquareText,
  Presentation,
  Wand2,
} from "lucide-react";

import {
  AUDIENCES,
  blockingGenerationQualityIssues,
  DEFAULT_SLIDE_DECK_MODE,
  RECOMMENDED_SLIDE_DECK_MODE,
  DURATIONS,
  GEN_TYPES,
  buildNotebookLmPrompt,
  generationQualityMessages,
  inspectCurrentGenerationQuality,
  MAX_GENERATION_CONDITIONS_CHARS,
  resolveSlideDeckMode,
  type Audience,
  type Duration,
  type GenType,
  type GeneratedDoc,
  type GeneratedSection,
  type GeneratedSlide,
  type GeneratedSlideDeck,
  type GenerationQualityIssueCode,
  type SavedMaterial,
  type SlideDeckMode,
} from "@/lib/generate";
import {
  asAudience,
  asDuration,
  hydrateMaterial,
  initialGenerationType,
  mergeGeneratedSources,
  preferredGenerationModel,
  stripSlideDeckRuntimeData,
} from "@/lib/generate-material";
import { categoryStyle } from "@/lib/category";
import { cn, sanitizeFilename } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  OptionGroup,
  ResultSkeleton,
  StepHeader,
  type EvidenceRepairState,
  type GenerationQuality,
  type QualityRepairState,
  type RegenState,
  type ResultChrome,
} from "@/components/generate/parts";
import { DocResult } from "@/components/generate/DocResult";
import { NotebookLmResult } from "@/components/generate/NotebookLmResult";
import { SlideDeckResult } from "@/components/generate/SlideDeckResult";
import { TopicFocusPanel } from "@/components/generate/TopicFocusPanel";
import {
  CategoryRecommendationPanel,
  type CategoryRecommendationSource,
} from "@/components/generate/CategoryRecommendationPanel";
import {
  focusRequestFingerprint,
  isLikelyBroadTrainingTopic,
  shouldAutoRequestTrainingFocus,
  shouldOfferTrainingFocusSuggestions,
  type SimilarTrainingMaterial,
  type TrainingFocusOption,
  type TrainingFocusRequestMode,
} from "@/lib/generate-focus";
import type { SopEvidence } from "@/lib/sop-evidence";
import {
  isGenerationJobDispatchConfirmed,
  type PublicGenerationJob,
} from "@/lib/generation-job";
import type { ValidatedGenerateRequest } from "@/lib/generation-request";
import { autoAssignDeckSourceVisuals } from "@/lib/source-visuals";

const TOPIC_SUGGESTIONS: Record<string, readonly string[]> = {
  화재: ["공기호흡기 점검과 착용", "고립소방관 구조 절차", "화재현장 인명검색 안전수칙"],
  수난: ["급류구조 안전수칙", "잠수구조 사전 점검", "구명보트 운용과 전복 대응"],
  산악: ["로프 하강과 확보", "들것 결착과 환자 운반", "산악구조 안전관리"],
  일반구조: ["교통사고 구조장비 운용", "문 개방 구조 절차", "중량물 인양 안전수칙"],
  "현장지휘·공통": ["구조현장 지휘체계", "대원 안전관리와 위험성 평가", "현장 통신과 상황보고"],
  화학사고: ["화학사고 초동대응", "보호복 착용과 오염통제", "누출물질 확인과 안전구역 설정"],
};

const FALLBACK_TOPIC_SUGGESTIONS = [
  "공기호흡기 점검과 착용",
  "암모니아 누출 초동대응",
  "산악사고 대비 구조훈련",
] as const;

const DEFAULT_TRAINING_TYPE = "이론 + 현장실습";
const DEFAULT_TRAINING_METHOD = "자체훈련";
const RETRIEVAL_DEGRADED_WARNING = "자료 검색 일부 기능 제한 — 회수 근거 확인 필요";
const MODEL_FALLBACK_WARNING = "정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨";
// 동일 clientRequestId와 jobId를 유지하므로 응답이 끊겨도 주소로 작업을 복구하고
// 서버에 같은 작업이 중복 생성되지 않는다.
const DURABLE_CREATE_RETRY_DELAYS_MS = [0, 1_500, 4_000] as const;
const DURABLE_CREATE_REQUEST_TIMEOUT_MS = 85_000;
const DURABLE_RETRY_REQUEST_TIMEOUT_MS = 85_000;
const DURABLE_POLL_REQUEST_TIMEOUT_MS = 85_000;
const PENDING_JOB_LOOKUP_LEASE_MS = 5 * 60 * 1000;
// 같은 일반 계정을 여러 명이 함께 쓰는 시범운영에서 분당 제한을 한 작업이 독점하지 않도록
// 한 번에 최대 3장만 처리하고, 성공분은 원자적으로 반영한 뒤 남은 장을 이어서 보완하게 한다.
const SOP_QUALITY_REPAIR_BATCH_SIZE = 3;
const SOP_REPAIR_TARGET_UNAVAILABLE_MESSAGE =
  "자동 보완할 SOP 적용 장을 고를 수 없습니다. 위 입력 영역의 ‘슬라이드(PPTX) 만들기’를 다시 눌러 전체 초안을 생성해 주세요.";

type TopicFocusState =
  | { status: "idle" }
  | {
      status: "loading";
      options: TrainingFocusOption[];
      similarMaterials: SimilarTrainingMaterial[];
    }
  | {
      status: "refreshing";
      options: TrainingFocusOption[];
      similarMaterials: SimilarTrainingMaterial[];
      warnings: string[];
      recommendedId?: string;
      selectedId?: string;
      customValue: string;
      historyCompared: boolean;
    }
  | {
      status: "choosing";
      options: TrainingFocusOption[];
      similarMaterials: SimilarTrainingMaterial[];
      warnings: string[];
      recommendedId?: string;
      selectedId?: string;
      customValue: string;
      historyCompared: boolean;
      error?: string;
    }
  | {
      status: "error";
      message: string;
      similarMaterials: SimilarTrainingMaterial[];
    }
  | { status: "resolved"; focus: string }
  | { status: "bypassed" };

type TrainingFocusRequestOptions = {
  refresh?: boolean;
  mode?: TrainingFocusRequestMode;
  moveFocus?: boolean;
  generateIfSpecific?: boolean;
};

type CategoryRecommendationConfidence = "high" | "medium" | "low";

type SafeCategoryRecommendation = {
  category: string;
  confidence: CategoryRecommendationConfidence;
  alternatives: string[];
  source: "deterministic" | "model";
  warning?: string;
};

type CategoryRecommendationState =
  | { status: "idle" }
  | { status: "loading"; topic: string }
  | ({
      status: "ready";
      topic: string;
      confirmed: boolean;
      source: CategoryRecommendationSource;
    } & Omit<SafeCategoryRecommendation, "source">)
  | { status: "error"; topic: string; message: string };

/** 저장 당시 분야가 현재 활성 교범에도 있을 때만 새 생성 입력으로 복원한다. */
export function activeSavedCategory(
  savedCategory: string | null | undefined,
  categories: readonly string[]
): string {
  return savedCategory && categories.includes(savedCategory) ? savedCategory : "";
}

/** 같은 주제의 판정이 이미 끝났다면 단순 포커스 이동으로 다시 덮어쓰지 않는다. */
export function hasCategoryRecommendationForTopic(
  recommendation: CategoryRecommendationState,
  topic: string
): boolean {
  return (
    recommendation.status === "ready" && recommendation.topic === topic.trim()
  );
}

export function isConfirmedCategorySelection(
  recommendation: CategoryRecommendationState,
  category: string,
  topic: string
): boolean {
  return (
    recommendation.status === "ready" &&
    recommendation.confirmed &&
    recommendation.category === category &&
    recommendation.topic === topic.trim()
  );
}

/** API 응답은 브라우저에서도 활성 분야 목록으로 다시 제한한다. */
export function safeCategoryRecommendationResponse(
  value: unknown,
  categories: readonly string[]
): SafeCategoryRecommendation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const category =
    typeof candidate.category === "string"
      ? categories.find((item) => item === candidate.category)
      : undefined;
  const confidence = candidate.confidence;
  const source = candidate.source;
  if (
    !category ||
    (confidence !== "high" && confidence !== "medium" && confidence !== "low") ||
    (source !== "deterministic" && source !== "model")
  ) {
    return null;
  }
  const alternatives = Array.isArray(candidate.alternatives)
    ? Array.from(
        new Set(
          candidate.alternatives.filter(
            (item): item is string =>
              typeof item === "string" && item !== category && categories.includes(item)
          )
        )
      ).slice(0, 2)
    : [];
  const warning =
    typeof candidate.warning === "string" && candidate.warning.trim()
      ? candidate.warning.trim().slice(0, 240)
      : undefined;
  return { category, confidence, alternatives, source, warning };
}

export function shouldAutoConfirmCategoryRecommendation(
  recommendation: Pick<SafeCategoryRecommendation, "confidence" | "source">
): boolean {
  return recommendation.source === "deterministic" && recommendation.confidence === "high";
}

/** 세부 방향 새로고침이 폼 조건 변경으로 중단되면 마지막으로 확인한 선택 상태를 복원한다. */
export function restoreTopicFocusAfterRequestAbort(
  current: TopicFocusState
): TopicFocusState {
  if (current.status === "loading") return { status: "idle" };
  if (current.status !== "refreshing") return current;
  if (current.options.length === 0) return { status: "idle" };
  return {
    status: "choosing",
    options: current.options,
    similarMaterials: current.similarMaterials,
    warnings: current.warnings,
    recommendedId: current.recommendedId,
    selectedId: current.selectedId,
    customValue: current.customValue,
    historyCompared: current.historyCompared,
  };
}

/** 네트워크 응답의 저장 자료 ID·유형을 다시 제한해 편집 링크를 안전하게 만든다. */
export function safeSimilarTrainingMaterials(value: unknown): SimilarTrainingMaterial[] {
  if (!Array.isArray(value)) return [];
  const supportedKinds = new Set<SimilarTrainingMaterial["kind"]>([
    "plan",
    "lesson",
    "slides",
  ]);
  return value
    .filter((item): item is SimilarTrainingMaterial => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Partial<SimilarTrainingMaterial>;
      return (
        Number.isSafeInteger(candidate.id) &&
        Number(candidate.id) > 0 &&
        typeof candidate.title === "string" &&
        candidate.title.trim().length > 0 &&
        candidate.title.length <= 200 &&
        typeof candidate.topic === "string" &&
        candidate.topic.length <= 100 &&
        typeof candidate.focus === "string" &&
        candidate.focus.length <= 100 &&
        typeof candidate.kind === "string" &&
        supportedKinds.has(candidate.kind as SimilarTrainingMaterial["kind"]) &&
        typeof candidate.createdAt === "string" &&
        Number.isFinite(Date.parse(candidate.createdAt))
      );
    })
    .slice(0, 5)
    .map((item) => ({
      ...item,
      title: item.title.trim(),
      topic: item.topic.trim(),
      focus: item.focus.trim(),
    }));
}

type ResultGenerationContext = {
  category: string;
  audience: Audience;
  duration: Duration;
  slideMode: SlideDeckMode;
  topic: string;
  focus: string;
  date: string;
  place: string;
  conditions: string;
};

function resultContextFromRequest(
  request: ValidatedGenerateRequest
): ResultGenerationContext {
  return {
    category: request.category,
    audience: request.audience,
    duration: request.duration,
    slideMode: resolveSlideDeckMode(request.slideMode ?? DEFAULT_SLIDE_DECK_MODE),
    topic: request.topic,
    focus: request.focus ?? "",
    date: request.type === "plan" ? request.date ?? "" : "",
    place: request.type === "plan" ? request.place ?? "" : "",
    conditions: request.conditions ?? "",
  };
}

function isRunningGenerationJob(job: PublicGenerationJob | null): boolean {
  return Boolean(
    job &&
      job.status !== "completed" &&
      job.status !== "needs_attention" &&
      job.status !== "failed"
  );
}

function isCompletedQualityJob(
  job: PublicGenerationJob | null
): job is PublicGenerationJob & { result: Record<string, unknown> } {
  return Boolean(
    job?.status === "completed" && job.qualityPassed && job.result
  );
}

const GENERATION_JOB_STATUS_SET = new Set([
  "queued",
  "retrieving",
  "drafting",
  "reviewing",
  "repairing",
  "completed",
  "needs_attention",
  "failed",
]);

function generationJobFromPayload(
  payload: unknown,
  expectedId?: string
): PublicGenerationJob | null {
  if (!payload || typeof payload !== "object") return null;
  const job = (payload as { job?: unknown }).job;
  if (!job || typeof job !== "object") return null;
  const candidate = job as Partial<PublicGenerationJob>;
  if (
    typeof candidate.id !== "string" ||
    (expectedId && candidate.id !== expectedId) ||
    typeof candidate.status !== "string" ||
    !GENERATION_JOB_STATUS_SET.has(candidate.status) ||
    typeof candidate.stage !== "string" ||
    typeof candidate.progress !== "number" ||
    typeof candidate.estimatedSeconds !== "number" ||
    typeof candidate.qualityPassed !== "boolean" ||
    !candidate.request ||
    typeof candidate.request !== "object" ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    typeof candidate.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.updatedAt))
  ) {
    return null;
  }
  return candidate as PublicGenerationJob;
}

export function replaceGenerationJobUrl(id: string): void {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("j", id);
  nextUrl.searchParams.delete("m");
  window.history.replaceState(window.history.state, "", nextUrl);
}

function removeGenerationJobUrl(expectedId?: string): void {
  const nextUrl = new URL(window.location.href);
  if (expectedId && nextUrl.searchParams.get("j") !== expectedId) return;
  nextUrl.searchParams.delete("j");
  window.history.replaceState(window.history.state, "", nextUrl);
}

export interface PendingGenerationJobCreate {
  fingerprint: string;
  clientRequestId: string;
  jobId: string;
  deliveryUncertain: boolean;
}

export function preparePendingGenerationJobCreate(
  fingerprint: string,
  existing: PendingGenerationJobCreate | null,
  createUuid: () => string = () => crypto.randomUUID(),
  rememberJobUrl: (jobId: string) => void = replaceGenerationJobUrl
): PendingGenerationJobCreate {
  const pending =
    existing?.fingerprint === fingerprint
      ? existing
      : {
          fingerprint,
          clientRequestId: createUuid(),
          jobId: createUuid(),
          deliveryUncertain: false,
        };
  // POST 응답보다 먼저 주소에 작업 ID를 남겨, 탭을 닫아도 접수된 행을 다시 찾을 수 있게 한다.
  rememberJobUrl(pending.jobId);
  return pending;
}

export function isDefinitiveGenerationJobCreateRejection(
  status: number,
  deliveryUncertain: boolean
): boolean {
  return !deliveryUncertain && status >= 400 && status < 500;
}

const SLIDE_MODE_OPTIONS: ReadonlyArray<{
  key: SlideDeckMode;
  label: string;
  description: string;
}> = [
  {
    key: "detailed",
    label: "상세형 (추천)",
    description: "현장교육에서 화면만 읽어도 이해되는 구성",
  },
  {
    key: "presenter",
    label: "발표형",
    description: "교관 설명을 전제로 핵심 문장만 표시",
  },
];

function mergedSourceLabels(
  current: readonly string[] | undefined,
  incoming: unknown
): string[] | undefined {
  if (!Array.isArray(incoming)) return current ? [...current] : undefined;
  const next = Array.from(
    new Set([
      ...(current ?? []),
      ...incoming
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim().slice(0, 300))
        .filter(Boolean),
    ])
  ).slice(0, 80);
  return next.length > 0 ? next : undefined;
}

function normalizedSopEvidence(value: unknown): SopEvidence | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.status !== "found" &&
    candidate.status !== "not_found" &&
    candidate.status !== "degraded"
  ) {
    return undefined;
  }
  return {
    status: candidate.status,
    sourceLabels: Array.isArray(candidate.sourceLabels)
      ? candidate.sourceLabels
          .filter((label): label is string => typeof label === "string")
          .map((label) => label.trim().slice(0, 300))
          .filter(Boolean)
          .slice(0, 20)
      : [],
  };
}

/** exact SOP 표식이 없는 과거 슬라이드 저장본에서 사용자가 고른 한 장을 복구 대상으로 삼는다. */
export function shouldForceLegacySopSlideRecovery(
  kind: "section" | "slide",
  draft: Pick<GeneratedSlideDeck, "sopEvidence"> | null | undefined
): boolean {
  return kind === "slide" && Boolean(draft) && !draft?.sopEvidence;
}

export function localQuality(
  kind: "plan" | "lesson" | "slides",
  draft: GeneratedDoc | GeneratedSlideDeck,
  duration: Duration,
  previous: GenerationQuality | null
): GenerationQuality {
  const report = inspectCurrentGenerationQuality(kind, draft, duration);
  const operationalWarnings =
    previous?.warnings.filter(
      (warning) => warning.startsWith("자료 검색") || warning.startsWith("정밀 생성 모델")
    ) ?? [];
  const sopStatusWarnings =
    draft.sopEvidence?.status === "not_found"
      ? ["관련 SOP 근거 미확인 — 시행 전 최신 SOP 확인 필요"]
      : draft.sopEvidence?.status === "degraded"
        ? ["SOP 자료 검색 상태 확인 불가 — 시행 전 다시 확인 필요"]
        : [];
  const messages = generationQualityMessages(report, [
    ...operationalWarnings,
    ...sopStatusWarnings,
  ]);
  return {
    checked: true,
    repaired: previous?.repaired ?? false,
    issues: report.issues,
    ...messages,
  };
}

const SLIDE_EVIDENCE_ISSUE_CODES: ReadonlySet<GenerationQualityIssueCode> =
  new Set<GenerationQualityIssueCode>([
    "missing_source_refs",
    "invalid_source_ref",
  ]);
const SLIDE_EVIDENCE_PATH = /^slides\.(\d+)\.sourceRefs(?:\.|$)/;

/** 슬라이드별 근거 오류만 0-based 인덱스로 정규화한다. */
export function slideEvidenceIssueIndices(
  deck: GeneratedSlideDeck,
  duration: Duration
): number[] {
  const indices = new Set<number>();
  for (const issue of inspectCurrentGenerationQuality("slides", deck, duration).issues) {
    if (!SLIDE_EVIDENCE_ISSUE_CODES.has(issue.code)) continue;
    const match = issue.path.match(SLIDE_EVIDENCE_PATH);
    const index = match ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(index) && index >= 0 && index < deck.slides.length) {
      indices.add(index);
    }
  }
  return Array.from(indices).sort((a, b) => a - b);
}

const SLIDE_SOP_ISSUE_CODES: ReadonlySet<GenerationQualityIssueCode> =
  new Set<GenerationQualityIssueCode>([
    "missing_sop_application",
    "missing_sop_reference",
    "missing_sop_disclosure",
    "invalid_sop_reference",
    "unverified_sop_claim",
  ]);
const SLIDE_QUALITY_PATH = /^slides\.(\d+)(?:\.|$)/;

function fallbackSopRepairIndex(deck: GeneratedSlideDeck): number | null {
  if (deck.slides.length === 0) return null;
  const preferredRoles = ["procedure", "safety", "evidence"] as const;
  const roleIndex = preferredRoles
    .map((role) => deck.slides.findIndex((slide) => slide.role === role))
    .find((index) => index >= 0);
  // 목표·요약 장을 임의로 SOP 적용 장으로 바꾸지 않는다. 안전한 후보가 없으면
  // 정확한 위치를 화면에 남기고 사용자가 장을 고르도록 한다.
  return roleIndex ?? null;
}

/** SOP 계약 오류가 있는 장만 후속 부분 재생성 대상으로 고른다. */
export function slideSopIssueIndices(
  deck: GeneratedSlideDeck,
  duration: Duration
): number[] {
  const indices = new Set<number>();
  let needsFallbackTarget = false;
  for (const issue of inspectCurrentGenerationQuality("slides", deck, duration).issues) {
    if (!SLIDE_SOP_ISSUE_CODES.has(issue.code)) continue;
    const match = issue.path.match(SLIDE_QUALITY_PATH);
    const index = match ? Number(match[1]) : Number.NaN;
    if (Number.isSafeInteger(index) && index >= 0 && index < deck.slides.length) {
      indices.add(index);
    } else {
      needsFallbackTarget = true;
    }
  }
  if (needsFallbackTarget) {
    const fallbackIndex = fallbackSopRepairIndex(deck);
    if (fallbackIndex !== null) indices.add(fallbackIndex);
  }
  return Array.from(indices).sort((a, b) => a - b);
}

export function hasSlideSopQualityIssues(
  deck: GeneratedSlideDeck,
  duration: Duration
): boolean {
  return inspectCurrentGenerationQuality("slides", deck, duration).issues.some((issue) =>
    SLIDE_SOP_ISSUE_CODES.has(issue.code)
  );
}

/** 서버가 돌려준 인덱스를 현재 덱 범위 안의 중복 없는 0-based 값으로 제한한다. */
export function normalizedEvidenceIssueIndices(value: unknown, slideCount: number): number[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter(
        (index): index is number =>
          typeof index === "number" &&
          Number.isSafeInteger(index) &&
          index >= 0 &&
          index < slideCount
      )
    )
  ).sort((a, b) => a - b);
}

function slideDeckFingerprint(deck: GeneratedSlideDeck | null): string {
  return deck ? JSON.stringify(stripSlideDeckRuntimeData(deck)) : "";
}

export function isCurrentEvidenceRepairSnapshot(args: {
  expectedDeck: GeneratedSlideDeck;
  currentDeck: GeneratedSlideDeck | null;
  operationId: number;
  activeOperationId: number | null;
  expectedResultRevision: number;
  currentResultRevision: number;
}): boolean {
  return (
    args.activeOperationId === args.operationId &&
    args.currentResultRevision === args.expectedResultRevision &&
    slideDeckFingerprint(args.currentDeck) === slideDeckFingerprint(args.expectedDeck)
  );
}

type EvidenceRepairOperation = {
  controller: AbortController;
  id: number;
  resultRevision: number;
  deckFingerprint: string;
};

type EvidenceRepairPayload = {
  deck?: unknown;
  repairedIndices?: unknown;
  unresolvedIndices?: unknown;
  warnings?: unknown;
  error?: unknown;
};

type QualityRepairOperation = EvidenceRepairOperation;

type QualityRepairPayload = Partial<GeneratedSlide> & {
  sourceLabels?: unknown;
  sources?: unknown;
  sopEvidence?: unknown;
  error?: unknown;
};

export function shouldApplyQualityRepairResponse(
  responseOk: boolean,
  payload: QualityRepairPayload | null
): payload is GeneratedSlide & QualityRepairPayload {
  return Boolean(
    responseOk &&
      payload &&
      typeof payload.title === "string" &&
      Array.isArray(payload.bullets) &&
      payload.bullets.length > 0 &&
      payload.bullets.every((bullet) => typeof bullet === "string") &&
      typeof payload.notes === "string" &&
      Array.isArray(payload.sourceRefs) &&
      payload.sourceRefs.length > 0 &&
      Array.isArray(payload.sourceLabels) &&
      payload.sourceLabels.every((label) => typeof label === "string") &&
      Array.isArray(payload.sources) &&
      normalizedSopEvidence(payload.sopEvidence)
  );
}

export function shouldApplyEvidenceRepairResponse(
  responseOk: boolean,
  payload: EvidenceRepairPayload | null
): payload is EvidenceRepairPayload & { deck: GeneratedSlideDeck } {
  if (!responseOk || !payload?.deck || typeof payload.deck !== "object") return false;
  const candidate = payload.deck as Partial<GeneratedSlideDeck>;
  return (
    typeof candidate.title === "string" &&
    Array.isArray(candidate.slides) &&
    candidate.slides.length > 0 &&
    Array.isArray(candidate.sources)
  );
}

/**
 * 근거 보완 중 SOP 조회 결과가 바뀌면 기존 SOP 문장과 새 근거 상태가 어긋날 수 있다.
 * 레거시 덱처럼 기존 상태가 없을 때만 새 상태를 채택하고, 그 외에는 상태·라벨이 모두
 * 같은 서버 스냅샷만 허용한다.
 */
export function isCompatibleSopEvidenceRefresh(expected: unknown, received: unknown): boolean {
  const next = normalizedSopEvidence(received);
  if (!next) return false;
  const current = normalizedSopEvidence(expected);
  if (!current) return true;
  return (
    current.status === next.status &&
    JSON.stringify([...current.sourceLabels].sort()) ===
      JSON.stringify([...next.sourceLabels].sort())
  );
}

export function GenerateForm({
  docsByCategory,
  models = [],
  initialMaterial,
  initialJob,
  pendingJobId,
  durableGenerationEnabled = false,
}: {
  docsByCategory: Record<string, string[]>;
  models?: { key: string; label: string; note?: string }[];
  initialMaterial?: SavedMaterial; // 저장본 재편집으로 진입 시 복원할 자료
  initialJob?: PublicGenerationJob;
  pendingJobId?: string;
  durableGenerationEnabled?: boolean;
}) {
  const categories = Object.keys(docsByCategory);
  // 저장본은 사용자가 고른 원문·도형·내용 구성을 그대로 복원한다.
  // 자동 시각 구성은 최초 전체 생성 결과에만 적용한다.
  const hydrated = hydrateMaterial(initialMaterial);
  const resumedRequest = initialMaterial ? undefined : initialJob?.request;
  // 과거 NotebookLM 저장본은 결과만 호환하고, 새 자료 입력은 지원하는 세 유형 중 계획으로 연다.
  const [type, setType] = useState<GenType>(
    resumedRequest?.type ?? initialGenerationType(initialMaterial?.kind)
  );
  const initialCategory = activeSavedCategory(
    resumedRequest?.category ?? initialMaterial?.category,
    categories
  );
  const [category, setCategory] = useState<string>(initialCategory);
  const [categoryRecommendation, setCategoryRecommendation] =
    useState<CategoryRecommendationState>(() =>
      initialCategory
        ? {
            status: "ready",
            topic: resumedRequest?.topic ?? initialMaterial?.topic?.trim() ?? "",
            category: initialCategory,
            confidence: "high",
            alternatives: [],
            source: "saved",
            confirmed: true,
          }
        : { status: "idle" }
    );
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);
  const [audience, setAudience] = useState<Audience>(
    resumedRequest?.audience ?? asAudience(initialMaterial?.audience)
  );
  const [duration, setDuration] = useState<Duration>(
    resumedRequest?.duration ?? asDuration(initialMaterial?.duration)
  );
  const [slideMode, setSlideMode] = useState<SlideDeckMode>(
    resolveSlideDeckMode(
      resumedRequest?.slideMode ?? hydrated.deck?.mode ?? RECOMMENDED_SLIDE_DECK_MODE
    )
  );
  const [topic, setTopic] = useState(resumedRequest?.topic ?? initialMaterial?.topic ?? "");
  const [topicError, setTopicError] = useState(false);
  const [topicFocus, setTopicFocus] = useState<TopicFocusState>(
    resumedRequest?.focus || hydrated.focus
      ? { status: "resolved", focus: resumedRequest?.focus ?? hydrated.focus }
      : { status: "idle" }
  );
  const [focusSelectionError, setFocusSelectionError] = useState("");
  const focusHistoryRef = useRef(
    new Set<string>(
      resumedRequest?.focus ? [resumedRequest.focus] : hydrated.focus ? [hydrated.focus] : []
    )
  );
  const topicRef = useRef(resumedRequest?.topic ?? initialMaterial?.topic ?? "");
  const topicEditedRef = useRef(false);
  const categoryRequestRef = useRef<AbortController | null>(null);
  const categoryRequestFingerprintRef = useRef("");
  const categoryDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const categoryRecommendationCacheRef = useRef(new Map<string, SafeCategoryRecommendation>());
  const pendingGenerateAfterCategoryRef = useRef<string | null>(null);
  const continueGenerationAfterCategoryRef = useRef<() => Promise<void>>(async () => undefined);
  const focusRequestRef = useRef<AbortController | null>(null);
  const requestTrainingFocusRef = useRef<
    (options?: TrainingFocusRequestOptions) => Promise<void>
  >(async () => undefined);
  const generationRequestRef = useRef<AbortController | null>(null);
  const regenRequestRef = useRef<AbortController | null>(null);
  const evidenceRepairRequestRef = useRef<EvidenceRepairOperation | null>(null);
  const evidenceRepairOperationIdRef = useRef(0);
  const qualityRepairRequestRef = useRef<QualityRepairOperation | null>(null);
  const qualityRepairOperationIdRef = useRef(0);
  const deckRef = useRef<GeneratedSlideDeck | null>(hydrated.deck);
  const savingRef = useRef(false);
  const exportBusyRef = useRef(false);
  const resultRevisionRef = useRef(0);
  const generationFingerprintRef = useRef("");
  const focusRequestFingerprintRef = useRef("");
  const activeFocusRequestFingerprintRef = useRef("");
  const focusHeadingRef = useRef<HTMLHeadingElement>(null);
  const appliedJobRevisionRef = useRef("");
  const applyCompletedJobRef = useRef<(job: PublicGenerationJob) => void>(() => undefined);
  const pendingJobCreateRef = useRef<PendingGenerationJobCreate | null>(null);
  const [date, setDate] = useState(resumedRequest?.date ?? hydrated.date);
  // 훈련계획 양식(training_plan.hwpx) 전용 폼 입력
  const [place, setPlace] = useState(resumedRequest?.place ?? hydrated.place);
  const [conditions, setConditions] = useState(
    resumedRequest?.conditions ?? hydrated.conditions
  );
  // 자료 제작은 품질 우선 모델을 자동 선택한다. 사용할 수 없을 때만 첫 모델로 폴백한다.
  const model = preferredGenerationModel(models);
  const [loading, setLoading] = useState(Boolean(pendingJobId && !initialJob));
  const [activeJob, setActiveJob] = useState<PublicGenerationJob | null>(
    initialJob ?? null
  );
  const [jobConnectionRetry, setJobConnectionRetry] = useState<{
    attempt: number;
    retryAt: number;
  } | null>(null);
  const [pendingLookupJobId, setPendingLookupJobId] = useState<string | undefined>(
    initialJob ? undefined : pendingJobId
  );
  const [pendingJobLookupActive, setPendingJobLookupActive] = useState(
    Boolean(pendingJobId && !initialJob)
  );
  const pendingJobLookupStartedAtRef = useRef(Date.now());
  const jobRetryingRef = useRef(false);
  const [jobRetrying, setJobRetrying] = useState(false);
  const [doc, setDoc] = useState<GeneratedDoc | null>(hydrated.doc);
  const [deck, setDeck] = useState<GeneratedSlideDeck | null>(hydrated.deck);
  const [nlmPrompt, setNlmPrompt] = useState<string | null>(hydrated.nlm);
  const [copied, setCopied] = useState(false);
  // 재편집 진입 시 문서/슬라이드는 편집 모드로 연다(프롬프트는 편집 UI 없음).
  const [editing, setEditing] = useState(
    !!initialMaterial && initialMaterial.kind !== "notebooklm"
  );
  const [regenIdx, setRegenIdx] = useState<number | null>(null); // 재생성 패널이 열린 항목
  const [regenLoading, setRegenLoading] = useState<number | null>(null);
  const [regenText, setRegenText] = useState(""); // 직접 입력 지시
  const [resultKind, setResultKind] = useState<GenType | null>(initialMaterial?.kind ?? null);
  // 생성 뒤 폼을 바꿔도 기존 본문이 새 분야·주제 메타데이터로 저장/출력되지 않도록 결과 조건을
  // 독립 스냅샷으로 보존한다.
  const [resultContext, setResultContext] = useState<ResultGenerationContext | null>(() =>
    initialMaterial
      ? {
          category: initialMaterial.category ?? "",
          audience: asAudience(initialMaterial.audience),
          duration: asDuration(initialMaterial.duration),
          slideMode: resolveSlideDeckMode(hydrated.deck?.mode ?? DEFAULT_SLIDE_DECK_MODE),
          topic: initialMaterial.topic ?? "",
          focus: hydrated.focus,
          date: hydrated.date,
          place: hydrated.place,
          conditions: hydrated.conditions,
        }
      : initialJob
        ? resultContextFromRequest(initialJob.request)
      : null
  );
  const [saving, setSaving] = useState(false);
  const [pptxLoading, setPptxLoading] = useState(false);
  const [docExporting, setDocExporting] = useState<"hwpx" | "docx" | null>(null);
  const [saved, setSaved] = useState(false);
  const [quality, setQuality] = useState<GenerationQuality | null>(() => {
    const initialDuration = asDuration(initialMaterial?.duration);
    if (initialMaterial?.kind === "slides" && hydrated.deck) {
      return localQuality("slides", hydrated.deck, initialDuration, null);
    }
    if (
      hydrated.doc &&
      (initialMaterial?.kind === "plan" || initialMaterial?.kind === "lesson")
    ) {
      return localQuality(initialMaterial.kind, hydrated.doc, initialDuration, null);
    }
    return null;
  });
  const [evidenceRepair, setEvidenceRepair] = useState<EvidenceRepairState>(() => {
    const initialDuration = asDuration(initialMaterial?.duration);
    const issueIndices =
      initialMaterial?.kind === "slides" && hydrated.deck
        ? slideEvidenceIssueIndices(hydrated.deck, initialDuration)
        : [];
    return { status: "idle", issueIndices };
  });
  const [qualityRepair, setQualityRepair] = useState<QualityRepairState>(() => {
    const initialDuration = asDuration(initialMaterial?.duration);
    if (initialMaterial?.kind !== "slides" || !hydrated.deck) {
      return { status: "idle", issueIndices: [] };
    }
    const issueIndices = slideSopIssueIndices(hydrated.deck, initialDuration);
    const hasSopIssues = hasSlideSopQualityIssues(hydrated.deck, initialDuration);
    return {
      status: hasSopIssues && issueIndices.length === 0 ? "failed" : "idle",
      issueIndices,
      message:
        hasSopIssues && issueIndices.length === 0
          ? SOP_REPAIR_TARGET_UNAVAILABLE_MESSAGE
          : undefined,
    };
  });
  const [localQualityRevision, setLocalQualityRevision] = useState(0);
  const [loadedId, setLoadedId] = useState<number | null>(initialMaterial?.id ?? null); // 재편집 대상 id
  const [loadedRevision, setLoadedRevision] = useState<number | null>(
    initialMaterial ? initialMaterial.revision ?? 1 : null
  );

  const resolvedFocus = topicFocus.status === "resolved" ? topicFocus.focus : "";
  const jobRunning = isRunningGenerationJob(activeJob);
  const activeJobId = activeJob?.id;
  const resultDuration = resultContext?.duration ?? duration;
  const broadTopic = isLikelyBroadTrainingTopic(topic);
  topicRef.current = topic;
  const categoryConfirmed = isConfirmedCategorySelection(
    categoryRecommendation,
    category,
    topic
  );
  const offerTopicFocusSuggestions = shouldOfferTrainingFocusSuggestions({
    categoryConfirmed,
    topic,
    status: topicFocus.status,
  });
  const autoRequestTopicFocus = shouldAutoRequestTrainingFocus({
    categoryConfirmed,
    topic,
    status: topicFocus.status,
    topicEdited: topicEditedRef.current,
  });

  const genReq = {
    type,
    category,
    audience,
    duration,
    slideMode: type === "slides" ? slideMode : undefined,
    topic: topic.trim(),
    focus: resolvedFocus || undefined,
    date: type === "plan" ? date : "",
    place: type === "plan" ? place.trim() : "",
    conditions: conditions.trim(),
    model,
  };
  generationFingerprintRef.current = JSON.stringify(genReq);
  const categoryIndependentGenerationFingerprint = JSON.stringify({
    ...genReq,
    category: "",
  });
  // 세부 방향 선택 상태 자체(resolved -> refreshing)는 요청을 무효화하면 안 된다.
  // 폼 조건만 따로 지문화해 실제 입력이 바뀐 경우에만 이전 응답을 폐기한다.
  focusRequestFingerprintRef.current = focusRequestFingerprint(genReq);
  const subtitle = resultContext
    ? `대상: ${resultContext.audience} · 교육 시간: ${resultContext.duration}${resultKind === "plan" && resultContext.date ? ` · ${resultContext.date}` : ""}`
    : "";
  const connectedDocs = docsByCategory[category]?.length ?? 0;
  const initialSuggestions = categories
    .flatMap((item) => TOPIC_SUGGESTIONS[item]?.slice(0, 1) ?? [`${item} 핵심 절차`])
    .slice(0, 3);
  const suggestions = categoryConfirmed && category
    ? (TOPIC_SUGGESTIONS[category] ?? [
        `${category} 핵심 절차`,
        `${category} 장비 점검`,
        `${category} 안전수칙`,
      ])
    : initialSuggestions.length > 0
      ? initialSuggestions
      : FALLBACK_TOPIC_SUGGESTIONS;

  // 사용자 편집은 함수형 상태 갱신으로 합치고, 최종 상태가 렌더된 뒤 한 번만 품질을 계산한다.
  // 비동기 부분 재생성 중 다른 입력을 고쳐도 이전 스냅샷이 최신 편집을 덮지 않게 한다.
  useEffect(() => {
    if (localQualityRevision === 0) return;
    if (resultKind === "slides" && deck) {
      setQuality((previous) => localQuality("slides", deck, resultDuration, previous));
      return;
    }
    if (doc && (resultKind === "plan" || resultKind === "lesson")) {
      setQuality((previous) => localQuality(resultKind, doc, resultDuration, previous));
    }
  }, [deck, doc, localQualityRevision, resultDuration, resultKind]);

  // 편집된 최신 덱을 비동기 근거 복구의 스냅샷 검증에 사용한다. 편집 자체가 근거 오류를
  // 해결한 경우에는 자동 API 호출 없이 차단 상태만 즉시 해제한다.
  useEffect(() => {
    deckRef.current = deck;
    if (
      resultKind !== "slides" ||
      !deck ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current
    ) {
      return;
    }
    const evidenceIssueIndices = slideEvidenceIssueIndices(deck, resultDuration);
    setEvidenceRepair((current) => {
      const unchanged =
        current.issueIndices.length === evidenceIssueIndices.length &&
        current.issueIndices.every(
          (index, position) => index === evidenceIssueIndices[position]
        );
      const status = evidenceIssueIndices.length === 0 ? "idle" : current.status;
      if (unchanged && status === current.status) return current;
      return {
        status,
        issueIndices: evidenceIssueIndices,
        message: evidenceIssueIndices.length > 0 ? current.message : undefined,
      };
    });
    const qualityIssueIndices = slideSopIssueIndices(deck, resultDuration);
    const hasSopIssues = hasSlideSopQualityIssues(deck, resultDuration);
    setQualityRepair((current) => {
      const unchanged =
        current.issueIndices.length === qualityIssueIndices.length &&
        current.issueIndices.every(
          (index, position) => index === qualityIssueIndices[position]
        );
      const targetUnavailable = hasSopIssues && qualityIssueIndices.length === 0;
      const status = targetUnavailable
        ? "failed"
        : qualityIssueIndices.length === 0
          ? "idle"
          : current.status;
      const message = targetUnavailable
        ? SOP_REPAIR_TARGET_UNAVAILABLE_MESSAGE
        : qualityIssueIndices.length > 0
          ? current.message
          : undefined;
      if (unchanged && status === current.status && message === current.message) return current;
      return {
        status,
        issueIndices: qualityIssueIndices,
        message,
      };
    });
  }, [deck, resultDuration, resultKind]);

  useEffect(
    () => () => {
      if (categoryDebounceRef.current) clearTimeout(categoryDebounceRef.current);
      categoryRequestRef.current?.abort();
      focusRequestRef.current?.abort();
      generationRequestRef.current?.abort();
      regenRequestRef.current?.abort();
      evidenceRepairRequestRef.current?.controller.abort();
      qualityRepairRequestRef.current?.controller.abort();
    },
    []
  );

  // 생성 작업 자체는 서버 Workflow가 계속 맡는다. 이 effect는 현재 상태만 느슨하게 조회하며,
  // 화면이 닫히거나 입력값이 바뀌어도 취소 API를 호출하지 않는다.
  useEffect(() => {
    const recoveringPendingJob =
      pendingJobLookupActive && Boolean(pendingLookupJobId) && !jobRunning;
    const jobId = jobRunning
      ? activeJobId
      : recoveringPendingJob
        ? pendingLookupJobId
        : undefined;
    if (!jobId || (!jobRunning && !recoveringPendingJob)) return;

    let disposed = false;
    let inFlight = false;
    let consecutiveErrors = 0;
    let timer: number | null = null;
    let activeRequest: AbortController | null = null;

    const schedule = (delayMs: number) => {
      if (disposed) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void poll(), delayMs);
    };

    const poll = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      const requestController = new AbortController();
      activeRequest = requestController;
      const requestTimeout = window.setTimeout(
        () => requestController.abort(),
        DURABLE_POLL_REQUEST_TIMEOUT_MS
      );
      try {
        const response = await fetch(`/api/generate/jobs/${encodeURIComponent(jobId)}`, {
          cache: "no-store",
          signal: requestController.signal,
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          if (
            response.status === 404 &&
            recoveringPendingJob &&
            Date.now() - pendingJobLookupStartedAtRef.current >= PENDING_JOB_LOOKUP_LEASE_MS
          ) {
            setPendingJobLookupActive(false);
            setPendingLookupJobId(undefined);
            setLoading(false);
            setJobConnectionRetry(null);
            if (pendingJobCreateRef.current?.jobId === jobId) {
              pendingJobCreateRef.current = null;
            }
            removeGenerationJobUrl(jobId);
            toast.error("접수된 생성 작업을 찾지 못했습니다", {
              description: "새 자료 생성을 다시 요청해 주세요.",
            });
            return;
          }
          const message =
            payload && typeof payload === "object" && typeof payload.error === "string"
              ? payload.error
              : "생성 작업 상태를 확인하지 못했습니다.";
          throw new Error(message);
        }
        const nextJob = generationJobFromPayload(payload, jobId);
        if (!nextJob) throw new Error("생성 작업 상태 응답 형식이 올바르지 않습니다.");
        if (disposed) return;

        consecutiveErrors = 0;
        setJobConnectionRetry(null);
        setPendingJobLookupActive(false);
        setPendingLookupJobId(undefined);
        if (pendingJobCreateRef.current?.jobId === jobId) {
          pendingJobCreateRef.current = null;
        }
        if (recoveringPendingJob) setLoading(false);
        setActiveJob(nextJob);
        if (isRunningGenerationJob(nextJob)) {
          schedule(document.visibilityState === "hidden" ? 10_000 : 2_500);
        }
      } catch {
        if (disposed) return;
        consecutiveErrors += 1;
        const baseDelay = document.visibilityState === "hidden" ? 10_000 : 2_500;
        const retryDelay = Math.min(
          60_000,
          baseDelay * 2 ** Math.min(consecutiveErrors - 1, 4)
        );
        setJobConnectionRetry({
          attempt: consecutiveErrors,
          retryAt: Date.now() + retryDelay,
        });
        schedule(retryDelay);
      } finally {
        window.clearTimeout(requestTimeout);
        if (activeRequest === requestController) activeRequest = null;
        inFlight = false;
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      if (timer) window.clearTimeout(timer);
      timer = null;
      void poll();
    };

    setJobConnectionRetry(null);
    schedule(document.visibilityState === "hidden" ? 10_000 : 2_500);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      if (timer) window.clearTimeout(timer);
      activeRequest?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [activeJobId, jobRunning, pendingJobLookupActive, pendingLookupJobId]);

  useEffect(() => {
    if (!isCompletedQualityJob(activeJob)) return;
    const appliedKey = `${activeJob.id}:${activeJob.revision}`;
    if (appliedJobRevisionRef.current === appliedKey) return;
    appliedJobRevisionRef.current = appliedKey;
    applyCompletedJobRef.current(activeJob);
  }, [activeJob]);

  // 생성 중 사용자가 입력 조건을 바꾸면 이전 조건의 응답이 새 폼에 표시되지 않게 즉시 중단한다.
  useEffect(() => {
    if (generationRequestRef.current) {
      generationRequestRef.current.abort();
      generationRequestRef.current = null;
      setLoading(false);
    }
    if (
      focusRequestRef.current &&
      activeFocusRequestFingerprintRef.current !== focusRequestFingerprintRef.current
    ) {
      focusRequestRef.current.abort();
      focusRequestRef.current = null;
      activeFocusRequestFingerprintRef.current = "";
      setTopicFocus(restoreTopicFocusAfterRequestAbort);
    }
  }, [audience, category, conditions, date, duration, place, slideMode, topic, type]);

  function resetTopicFocus() {
    focusRequestRef.current?.abort();
    focusRequestRef.current = null;
    focusHistoryRef.current.clear();
    setTopicFocus({ status: "idle" });
    setFocusSelectionError("");
  }

  async function requestCategoryRecommendation(topicOverride?: string) {
    const trimmedTopic = (topicOverride ?? topicRef.current).trim();
    if (trimmedTopic.length < 2 || topicRef.current.trim() !== trimmedTopic) return;

    const candidates = categories
      .map((name) => ({
        name,
        sourceTitles: (docsByCategory[name] ?? []).slice(0, 5),
      }))
      .sort((left, right) => left.name.localeCompare(right.name, "ko"));
    if (candidates.length === 0) {
      setCategory("");
      setCategoryRecommendation({
        status: "error",
        topic: trimmedTopic,
        message: "연결된 교범 분야가 없어 자동으로 정할 수 없습니다.",
      });
      setCategoryPickerOpen(true);
      return;
    }

    const requestFingerprint = JSON.stringify({ topic: trimmedTopic, categories: candidates });
    if (
      categoryRequestRef.current &&
      categoryRequestFingerprintRef.current === requestFingerprint
    ) {
      return;
    }

    const applyRecommendation = (recommendation: SafeCategoryRecommendation) => {
      if (topicRef.current.trim() !== trimmedTopic) return;
      // 핵심어가 명확한 규칙 판정만 자동 확정한다. 모델 경로는 애매한 주제에만 쓰므로
      // confidence 표기와 무관하게 사용자가 한 번 확인해야 잘못된 RAG 분야로 진행되지 않는다.
      const confirmed = shouldAutoConfirmCategoryRecommendation(recommendation);
      setCategory(recommendation.category);
      setCategoryRecommendation({
        status: "ready",
        topic: trimmedTopic,
        ...recommendation,
        confirmed,
      });
      setCategoryPickerOpen(!confirmed);
      setSaved(false);
      resetTopicFocus();
    };

    const cached = categoryRecommendationCacheRef.current.get(requestFingerprint);
    if (cached) {
      applyRecommendation(cached);
      return;
    }

    if (candidates.length === 1) {
      const onlyCategory: SafeCategoryRecommendation = {
        category: candidates[0].name,
        confidence: "high",
        alternatives: [],
        source: "deterministic",
      };
      categoryRecommendationCacheRef.current.set(requestFingerprint, onlyCategory);
      applyRecommendation(onlyCategory);
      return;
    }

    categoryRequestRef.current?.abort();
    const controller = new AbortController();
    categoryRequestRef.current = controller;
    categoryRequestFingerprintRef.current = requestFingerprint;
    setCategory("");
    setCategoryRecommendation({ status: "loading", topic: trimmedTopic });
    setCategoryPickerOpen(false);

    try {
      const response = await fetch("/api/generate/category", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ topic: trimmedTopic, categories: candidates }),
      });
      const payload = (await response.json().catch(() => null)) as
        | Record<string, unknown>
        | null;
      if (
        categoryRequestRef.current !== controller ||
        categoryRequestFingerprintRef.current !== requestFingerprint ||
        topicRef.current.trim() !== trimmedTopic
      ) {
        return;
      }
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const message =
          response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
            ? `요청이 잠시 몰렸습니다. ${Math.ceil(retryAfter)}초 후 다시 확인해 주세요.`
            : typeof payload?.error === "string"
              ? payload.error.slice(0, 200)
              : "분야를 자동으로 확인하지 못했습니다.";
        setCategoryRecommendation({ status: "error", topic: trimmedTopic, message });
        setCategoryPickerOpen(true);
        return;
      }

      const recommendation = safeCategoryRecommendationResponse(payload, categories);
      if (!recommendation) {
        setCategoryRecommendation({
          status: "error",
          topic: trimmedTopic,
          message: "분야 확인 결과가 현재 교범 분야와 맞지 않습니다.",
        });
        setCategoryPickerOpen(true);
        return;
      }
      categoryRecommendationCacheRef.current.set(requestFingerprint, recommendation);
      applyRecommendation(recommendation);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (
        categoryRequestRef.current !== controller ||
        topicRef.current.trim() !== trimmedTopic
      ) {
        return;
      }
      setCategoryRecommendation({
        status: "error",
        topic: trimmedTopic,
        message: "네트워크 연결을 확인한 뒤 다시 시도하거나 분야를 직접 골라 주세요.",
      });
      setCategoryPickerOpen(true);
    } finally {
      if (categoryRequestRef.current === controller) {
        categoryRequestRef.current = null;
        categoryRequestFingerprintRef.current = "";
      }
    }
  }

  function handleTopicChange(nextTopic: string, immediate = false) {
    topicEditedRef.current = true;
    topicRef.current = nextTopic;
    setTopic(nextTopic);
    setSaved(false);
    setCategory("");
    setCategoryRecommendation({ status: "idle" });
    setCategoryPickerOpen(false);
    pendingGenerateAfterCategoryRef.current = null;
    categoryRequestRef.current?.abort();
    categoryRequestRef.current = null;
    categoryRequestFingerprintRef.current = "";
    if (categoryDebounceRef.current) clearTimeout(categoryDebounceRef.current);
    categoryDebounceRef.current = null;
    resetTopicFocus();

    const trimmedTopic = nextTopic.trim();
    if (trimmedTopic.length >= 2) {
      setTopicError(false);
      if (immediate) {
        void requestCategoryRecommendation(nextTopic);
      } else {
        categoryDebounceRef.current = setTimeout(() => {
          categoryDebounceRef.current = null;
          void requestCategoryRecommendation(nextTopic);
        }, 650);
      }
    }
  }

  function handleTopicBlur() {
    const trimmedTopic = topicRef.current.trim();
    if (trimmedTopic.length < 2) return;
    if (categoryDebounceRef.current) clearTimeout(categoryDebounceRef.current);
    categoryDebounceRef.current = null;
    if (hasCategoryRecommendationForTopic(categoryRecommendation, trimmedTopic)) return;
    void requestCategoryRecommendation(trimmedTopic);
  }

  function handleCategoryConfirm() {
    setCategoryRecommendation((current) =>
      current.status === "ready" ? { ...current, confirmed: true } : current
    );
    setCategoryPickerOpen(false);
    requestAnimationFrame(() => {
      document.getElementById("category-recommendation-change")?.focus();
    });
  }

  function handleCategorySelect(nextCategory: string) {
    if (!categories.includes(nextCategory)) return;
    categoryRequestRef.current?.abort();
    categoryRequestRef.current = null;
    categoryRequestFingerprintRef.current = "";
    if (categoryDebounceRef.current) clearTimeout(categoryDebounceRef.current);
    categoryDebounceRef.current = null;
    setCategory(nextCategory);
    setCategoryRecommendation({
      status: "ready",
      topic: topicRef.current.trim(),
      category: nextCategory,
      confidence: "high",
      alternatives: [],
      source: "manual",
      confirmed: true,
    });
    setCategoryPickerOpen(false);
    setSaved(false);
    resetTopicFocus();
    requestAnimationFrame(() => {
      document.getElementById("category-recommendation-change")?.focus();
    });
  }

  // 결과 부분 편집 — 편집 내용은 그대로 다운로드/복사에 반영된다(빌더가 state를 받음).
  function patchSection(
    i: number,
    patch: Partial<GeneratedSection>,
    fromRegeneration = false
  ) {
    if (
      !fromRegeneration &&
      (savingRef.current ||
        regenRequestRef.current ||
        exportBusyRef.current)
    ) {
      return;
    }
    setSaved(false);
    setDoc((previous) =>
      previous
        ? {
            ...previous,
            sections: previous.sections.map((section, index) =>
              index === i ? { ...section, ...patch } : section
            ),
          }
        : previous
    );
    setLocalQualityRevision((revision) => revision + 1);
  }
  function patchSlide(
    i: number,
    patch: Partial<GeneratedSlide>,
    fromRegeneration = false
  ) {
    if (
      !fromRegeneration &&
      (savingRef.current ||
        regenRequestRef.current ||
        evidenceRepairRequestRef.current ||
        qualityRepairRequestRef.current ||
        exportBusyRef.current)
    ) {
      return;
    }
    setSaved(false);
    setDeck((previous) =>
      previous
        ? {
            ...previous,
            slides: previous.slides.map((slide, index) =>
              index === i ? { ...slide, ...patch } : slide
            ),
          }
        : previous
    );
    setLocalQualityRevision((revision) => revision + 1);
  }
  function patchBullet(slideI: number, bulletI: number, value: string) {
    if (
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current
    ) {
      return;
    }
    setSaved(false);
    setDeck((previous) =>
      previous
        ? {
            ...previous,
            slides: previous.slides.map((slide, slideIndex) =>
              slideIndex === slideI
                ? {
                    ...slide,
                    bullets: slide.bullets.map((bullet, bulletIndex) =>
                      bulletIndex === bulletI ? value : bullet
                    ),
                  }
                : slide
            ),
          }
        : previous
    );
    setLocalQualityRevision((revision) => revision + 1);
  }
  function moveSlide(index: number, direction: -1 | 1) {
    if (
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current
    ) return;
    setSaved(false);
    setRegenIdx(null);
    setDeck((previous) => {
      if (!previous) return previous;
      const target = index + direction;
      if (target < 0 || target >= previous.slides.length) return previous;
      const slides = [...previous.slides];
      [slides[index], slides[target]] = [slides[target], slides[index]];
      return { ...previous, slides };
    });
    setLocalQualityRevision((revision) => revision + 1);
  }

  function addSlide(afterIndex: number) {
    if (
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current
    ) return;
    setSaved(false);
    setRegenIdx(null);
    setDeck((previous) => {
      if (!previous || previous.slides.length >= 20) return previous;
      const insertAt = Math.min(Math.max(afterIndex + 1, 0), previous.slides.length);
      const slide: GeneratedSlide = {
        title: "새 슬라이드",
        bullets: ["핵심 내용을 입력해 주세요"],
        notes: "",
        layout: "concept",
        role: "concept",
        composition: "list",
        visual: { mode: "none" },
      };
      const slides = [...previous.slides];
      slides.splice(insertAt, 0, slide);
      return { ...previous, slides };
    });
    setLocalQualityRevision((revision) => revision + 1);
  }

  function duplicateSlide(index: number) {
    if (
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current
    ) return;
    setSaved(false);
    setRegenIdx(null);
    setDeck((previous) => {
      if (!previous || previous.slides.length >= 20) return previous;
      const source = previous.slides[index];
      if (!source) return previous;
      const duplicate: GeneratedSlide = {
        ...source,
        title: `${source.title} (복사본)`,
        bullets: [...source.bullets],
        steps: source.steps ? [...source.steps] : undefined,
        sourceRefs: source.sourceRefs ? [...source.sourceRefs] : undefined,
        visual: source.visual ? { ...source.visual } : undefined,
      };
      const slides = [...previous.slides];
      slides.splice(index + 1, 0, duplicate);
      return { ...previous, slides };
    });
    setLocalQualityRevision((revision) => revision + 1);
  }

  function deleteSlide(index: number) {
    if (
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current
    ) return;
    setSaved(false);
    setRegenIdx(null);
    setDeck((previous) =>
      previous
        ? {
            ...previous,
            slides: previous.slides.filter((_, slideIndex) => slideIndex !== index),
          }
        : previous
    );
    setLocalQualityRevision((revision) => revision + 1);
  }

  /** 저장·파일 생성 직전에 현재 편집본을 다시 점검한다. */
  function recheckCurrentQuality(): GenerationQuality | null {
    const next =
      resultKind === "slides" && deck
        ? localQuality("slides", deck, resultDuration, quality)
        : doc && (resultKind === "plan" || resultKind === "lesson")
          ? localQuality(resultKind, doc, resultDuration, quality)
          : null;
    if (next) setQuality(next);
    return next;
  }

  function notifyQualityWarnings(checked: GenerationQuality | null) {
    if (!checked || checked.warnings.length === 0) return;
    toast.warning("최종 확인이 필요한 항목이 있습니다", {
      description: checked.warnings.join(" · "),
    });
  }

  /** 핵심 품질 오류가 남은 초안은 공식 파일·공유 저장본으로 내보내지 않는다. */
  function ensureQualityForOutput(): boolean {
    if (resultKind === "notebooklm") return true;
    if (
      resultKind === "slides" &&
      (evidenceRepairRequestRef.current || qualityRepairRequestRef.current)
    ) {
      toast.info("슬라이드 품질을 자동으로 보완하고 있습니다", {
        description: "확인이 끝난 뒤 저장하거나 PPTX로 내보내 주세요.",
      });
      return false;
    }
    const kind = resultKind;
    const draft = kind === "slides" ? deck : doc;
    if (!draft || (kind !== "plan" && kind !== "lesson" && kind !== "slides")) return false;

    recheckCurrentQuality();
    if (!draft.sopEvidence) {
      toast.error("SOP 근거 상태를 먼저 갱신해 주세요", {
        description:
          "이전 형식의 초안입니다. 훈련내용·핵심이론 또는 SOP 적용 슬라이드를 다시 생성해 확인 상태를 반영해 주세요.",
      });
      return false;
    }

    const report = inspectCurrentGenerationQuality(kind, draft, resultDuration);
    const blockingIssues = blockingGenerationQualityIssues(report);
    if (blockingIssues.length === 0) return true;
    toast.error("저장·내보내기 전 핵심 항목을 수정해 주세요", {
      description: blockingIssues
        .slice(0, 2)
        .map((issue) => issue.message)
        .concat(
          blockingIssues.length > 2
            ? [`그 밖의 핵심 오류 ${blockingIssues.length - 2}개가 있습니다.`]
            : []
        )
        .join(" · "),
    });
    return false;
  }

  /** SOP 단정·근거 계약 오류가 있는 장만 빠른 모델로 후속 재생성하고 전체 덱을 재검증한다. */
  async function repairSlideSopQuality(
    candidateDeck: GeneratedSlideDeck,
    context: ResultGenerationContext,
    requestedIndices = slideSopIssueIndices(candidateDeck, context.duration)
  ) {
    if (
      requestedIndices.length === 0 ||
      qualityRepairRequestRef.current ||
      evidenceRepairRequestRef.current ||
      regenRequestRef.current ||
      savingRef.current ||
      exportBusyRef.current
    ) {
      return;
    }

    const expectedDeck = stripSlideDeckRuntimeData(candidateDeck);
    const operation: QualityRepairOperation = {
      controller: new AbortController(),
      id: ++qualityRepairOperationIdRef.current,
      resultRevision: resultRevisionRef.current,
      deckFingerprint: slideDeckFingerprint(expectedDeck),
    };
    qualityRepairRequestRef.current = operation;
    setQualityRepair({
      status: "repairing",
      issueIndices: requestedIndices,
      startedAt: Date.now(),
    });

    const isCurrentOperation = () =>
      isCurrentEvidenceRepairSnapshot({
        expectedDeck,
        currentDeck: deckRef.current,
        operationId: operation.id,
        activeOperationId: qualityRepairRequestRef.current?.id ?? null,
        expectedResultRevision: operation.resultRevision,
        currentResultRevision: resultRevisionRef.current,
      }) && slideDeckFingerprint(expectedDeck) === operation.deckFingerprint;

    let workingDeck = candidateDeck;
    let followUpDeck: GeneratedSlideDeck | null = null;
    let retrievalDegraded = false;
    let trustedEvidenceFingerprint: string | null = null;
    const initialReport = inspectCurrentGenerationQuality(
      "slides",
      candidateDeck,
      context.duration
    );
    const initialBlockingKeys = new Set(
      blockingGenerationQualityIssues(initialReport).map(
        (issue) => `${issue.code}\u0000${issue.path}`
      )
    );
    const initialSopIssueCount = initialReport.issues.filter((issue) =>
      SLIDE_SOP_ISSUE_CODES.has(issue.code)
    ).length;
    const attempted = new Set<number>();
    const completed = new Set<number>();

    const unexpectedBlockingIssuesFor = (report: ReturnType<typeof inspectCurrentGenerationQuality>) =>
      blockingGenerationQualityIssues(report).filter(
        (issue) =>
          !initialBlockingKeys.has(`${issue.code}\u0000${issue.path}`) &&
          !SLIDE_EVIDENCE_ISSUE_CODES.has(issue.code)
      );

    const applyQualityRepairDeck = (
      repairedDeck: GeneratedSlideDeck,
      repairState: QualityRepairState
    ) => {
      deckRef.current = repairedDeck;
      setDeck(repairedDeck);
      setSaved(false);
      setQuality((previous) => {
        const checked = localQuality("slides", repairedDeck, context.duration, previous);
        return {
          ...checked,
          repaired: true,
          warnings: Array.from(
            new Set([
              ...(retrievalDegraded ? [RETRIEVAL_DEGRADED_WARNING] : []),
              ...checked.warnings,
            ])
          ).slice(0, 8),
        };
      });
      setQualityRepair(repairState);
    };

    try {
      const pending = normalizedEvidenceIssueIndices(
        requestedIndices,
        workingDeck.slides.length
      );

      while (pending.length > 0 && attempted.size < SOP_QUALITY_REPAIR_BATCH_SIZE) {
        const index = pending.shift();
        if (index === undefined || attempted.has(index)) continue;
        // 앞 장을 고치면서 덱 수준 표식 누락까지 해결된 경우, 더는 문제가 아닌
        // fallback 장을 불필요하게 다시 생성하지 않는다.
        if (!slideSopIssueIndices(workingDeck, context.duration).includes(index)) continue;
        attempted.add(index);

        const requestSnapshot = stripSlideDeckRuntimeData(workingDeck);
        const current = requestSnapshot.slides[index];
        if (!current) continue;
        const currentReport = inspectCurrentGenerationQuality(
          "slides",
          workingDeck,
          context.duration
        );
        const issueInstruction = currentReport.issues
          .filter((issue) => {
            if (!SLIDE_SOP_ISSUE_CODES.has(issue.code)) return false;
            const match = issue.path.match(SLIDE_QUALITY_PATH);
            return !match || Number(match[1]) === index;
          })
          .map((issue) => issue.message)
          .join(" / ")
          .slice(0, 120);
        const repairInstruction =
          `확인되지 않은 SOP 단정과 근거 관계만 수정하세요. 근거 없는 번호·명칭·절차는 삭제하고 현재 SOP 계약을 지키세요.${issueInstruction ? ` ${issueInstruction}` : ""}`.slice(
            0,
            200
          );

        const response = await fetch("/api/generate/section", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: operation.controller.signal,
          body: JSON.stringify({
            kind: "slide",
            category: context.category,
            audience: context.audience,
            duration: context.duration,
            slideMode: resolveSlideDeckMode(workingDeck.mode ?? context.slideMode),
            topic: context.topic,
            focus: context.focus || undefined,
            conditions: context.conditions,
            // 짧은 후속 복구에서 정밀 모델을 다시 오래 기다리지 않는다.
            model: model === "gemini-pro" ? "gemini-flash" : model,
            docTitle: workingDeck.title,
            outline: workingDeck.slides.map((slide) => slide.title),
            index,
            current,
            sopTarget: true,
            instruction: repairInstruction,
          }),
        });
        const payload = (await response.json().catch(() => null)) as QualityRepairPayload | null;
        if (!isCurrentOperation()) return;
        if (!shouldApplyQualityRepairResponse(response.ok, payload)) {
          const message =
            typeof payload?.error === "string"
              ? payload.error
              : `슬라이드 ${index + 1}의 SOP 근거를 자동으로 보완하지 못했습니다.`;
          throw new Error(message);
        }

        retrievalDegraded ||= response.headers.get("X-RAG-Degraded") === "1";
        const { sourceLabels, sources, sopEvidence } = payload;
        const regenerated = { ...payload };
        delete regenerated.sourceLabels;
        delete regenerated.sources;
        delete regenerated.sopEvidence;
        delete regenerated.error;
        const verifiedSopEvidence = normalizedSopEvidence(sopEvidence) as SopEvidence;
        const trustedSourceLabels = mergedSourceLabels(undefined, sourceLabels) ?? [];
        const trustedSources = mergeGeneratedSources([], sources);
        const responseEvidenceFingerprint = JSON.stringify({
          sourceLabels: [...trustedSourceLabels].sort(),
          sopEvidence: {
            status: verifiedSopEvidence.status,
            sourceLabels: [...verifiedSopEvidence.sourceLabels].sort(),
          },
        });
        if (
          trustedEvidenceFingerprint !== null &&
          trustedEvidenceFingerprint !== responseEvidenceFingerprint
        ) {
          throw new Error(
            "SOP 근거 상태가 보완 도중 변경되었습니다. 현재 자료를 다시 조회해 시도해 주세요."
          );
        }
        trustedEvidenceFingerprint = responseEvidenceFingerprint;
        const slides = workingDeck.slides.map((slide, slideIndex) =>
          slideIndex === index ? (regenerated as GeneratedSlide) : slide
        );
        workingDeck = {
          ...workingDeck,
          slides,
          sourceLabels: trustedSourceLabels,
          sources: trustedSources,
          sopEvidence: verifiedSopEvidence,
        };
        completed.add(index);

        for (const nextIndex of slideSopIssueIndices(workingDeck, context.duration)) {
          if (!attempted.has(nextIndex) && !pending.includes(nextIndex)) pending.push(nextIndex);
        }
      }

      if (!isCurrentOperation()) return;
      const finalReport = inspectCurrentGenerationQuality(
        "slides",
        workingDeck,
        context.duration
      );
      const unresolvedIndices = slideSopIssueIndices(workingDeck, context.duration);
      const hasUnresolvedSopIssues = hasSlideSopQualityIssues(
        workingDeck,
        context.duration
      );
      const unexpectedBlockingIssues = unexpectedBlockingIssuesFor(finalReport);
      if (unexpectedBlockingIssues.length > 0) {
        throw new Error(
          `보완 결과에 새로운 핵심 오류가 생겨 원본을 유지했습니다: ${unexpectedBlockingIssues
            .slice(0, 2)
            .map((issue) => issue.message)
            .join(" / ")}`
        );
      }
      if (hasUnresolvedSopIssues) {
        if (unresolvedIndices.length === 0) {
          throw new Error(`${SOP_REPAIR_TARGET_UNAVAILABLE_MESSAGE} 원본은 그대로 유지했습니다.`);
        }
        const remainingSopIssueCount = finalReport.issues.filter((issue) =>
          SLIDE_SOP_ISSUE_CODES.has(issue.code)
        ).length;
        if (
          completed.size > 0 &&
          attempted.size >= SOP_QUALITY_REPAIR_BATCH_SIZE &&
          remainingSopIssueCount < initialSopIssueCount
        ) {
          const message = `이번에 ${completed.size}장을 보완했습니다. ${unresolvedIndices
            .map((index) => index + 1)
            .join(", ")}번 슬라이드가 남았습니다. ‘문제 슬라이드 AI로 보완’을 다시 눌러 이어서 처리해 주세요.`;
          applyQualityRepairDeck(workingDeck, {
            status: "failed",
            issueIndices: unresolvedIndices,
            message,
          });
          toast.warning("SOP 품질을 일부 보완했습니다", { description: message });
          return;
        }
        throw new Error(
          `SOP 품질 오류가 ${unresolvedIndices.map((index) => index + 1).join(", ")}번 슬라이드에 남아 원본을 유지했습니다.`
        );
      }
      applyQualityRepairDeck(workingDeck, {
        status: "idle",
        issueIndices: [],
      });
      followUpDeck = workingDeck;
      toast.success("SOP 표현과 근거를 자동으로 보완했습니다");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!isCurrentOperation()) return;
      const message =
        error instanceof Error
          ? error.message
          : "잠시 후 다시 시도하거나 문제 슬라이드를 직접 수정해 주세요.";
      const partialReport = inspectCurrentGenerationQuality(
        "slides",
        workingDeck,
        context.duration
      );
      const partialSopIssueCount = partialReport.issues.filter((issue) =>
        SLIDE_SOP_ISSUE_CODES.has(issue.code)
      ).length;
      const partialIndices = slideSopIssueIndices(workingDeck, context.duration);
      const canKeepPartialProgress =
        completed.size > 0 &&
        partialIndices.length > 0 &&
        partialSopIssueCount < initialSopIssueCount &&
        unexpectedBlockingIssuesFor(partialReport).length === 0;
      if (canKeepPartialProgress) {
        const partialMessage = `앞서 보완한 ${completed.size}장은 유지했습니다. ${partialIndices
          .map((index) => index + 1)
          .join(", ")}번 슬라이드는 잠시 후 다시 보완해 주세요. (${message})`;
        applyQualityRepairDeck(workingDeck, {
          status: "failed",
          issueIndices: partialIndices,
          message: partialMessage,
        });
        toast.warning("SOP 품질을 일부 보완했습니다", { description: partialMessage });
        return;
      }
      // 적용할 수 있는 성공분이 없거나 새 핵심 오류가 생긴 경우에만 원본 전체를 유지한다.
      const unresolvedIndices = slideSopIssueIndices(candidateDeck, context.duration);
      setQualityRepair({
        status: "failed",
        issueIndices: unresolvedIndices.length > 0 ? unresolvedIndices : requestedIndices,
        message,
      });
      toast.error("SOP 품질 자동 보완 중 오류가 발생했습니다", { description: message });
    } finally {
      if (qualityRepairRequestRef.current?.id === operation.id) {
        qualityRepairRequestRef.current = null;
      }
    }

    // SOP 장을 먼저 확정한 뒤, 다른 장의 일반 출처 누락만 별도 근거 복구로 처리한다.
    if (followUpDeck) {
      const evidenceIndices = slideEvidenceIssueIndices(followUpDeck, context.duration);
      if (evidenceIndices.length > 0) {
        void repairSlideEvidence(followUpDeck, context, evidenceIndices);
      }
    }
  }

  async function repairSlideEvidence(
    candidateDeck: GeneratedSlideDeck,
    context: ResultGenerationContext,
    requestedIndices = slideEvidenceIssueIndices(candidateDeck, context.duration)
  ) {
    if (
      requestedIndices.length === 0 ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current
    ) {
      return;
    }

    const requestDeck = stripSlideDeckRuntimeData(candidateDeck);
    const operation: EvidenceRepairOperation = {
      controller: new AbortController(),
      id: ++evidenceRepairOperationIdRef.current,
      resultRevision: resultRevisionRef.current,
      deckFingerprint: slideDeckFingerprint(requestDeck),
    };
    evidenceRepairRequestRef.current = operation;
    setEvidenceRepair({
      status: "repairing",
      issueIndices: requestedIndices,
      startedAt: Date.now(),
    });

    const isCurrentOperation = () =>
      isCurrentEvidenceRepairSnapshot({
        expectedDeck: requestDeck,
        currentDeck: deckRef.current,
        operationId: operation.id,
        activeOperationId: evidenceRepairRequestRef.current?.id ?? null,
        expectedResultRevision: operation.resultRevision,
        currentResultRevision: resultRevisionRef.current,
      }) && slideDeckFingerprint(requestDeck) === operation.deckFingerprint;

    try {
      const response = await fetch("/api/generate/evidence", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: operation.controller.signal,
        body: JSON.stringify({
          category: context.category,
          audience: context.audience,
          duration: context.duration,
          topic: context.topic,
          focus: context.focus || undefined,
          conditions: context.conditions || undefined,
          slideMode: resolveSlideDeckMode(requestDeck.mode ?? context.slideMode),
          model,
          deck: requestDeck,
        }),
      });
      const payload = (await response.json().catch(() => null)) as EvidenceRepairPayload | null;
      if (!isCurrentOperation()) return;

      // 실패 응답에 fresh deck이 실려 있어도 공식 성공 응답이 아니므로 현재 편집본을 보존한다.
      if (!response.ok) {
        const unresolved = normalizedEvidenceIssueIndices(
          payload?.unresolvedIndices,
          requestDeck.slides.length
        );
        const issueIndices = unresolved.length > 0 ? unresolved : requestedIndices;
        const message =
          typeof payload?.error === "string"
            ? payload.error
            : "교육자료에서 연결할 근거를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
        setEvidenceRepair({ status: "failed", issueIndices, message });
        toast.error("슬라이드 근거를 보완하지 못했습니다", { description: message });
        return;
      }
      if (!shouldApplyEvidenceRepairResponse(response.ok, payload)) {
        throw new Error("근거 보완 응답 형식이 올바르지 않습니다.");
      }

      const nextDeck = {
        ...payload.deck,
        mode: resolveSlideDeckMode(payload.deck.mode ?? context.slideMode),
      };
      if (!isCompatibleSopEvidenceRefresh(requestDeck.sopEvidence, nextDeck.sopEvidence)) {
        throw new Error(
          "SOP 근거 상태가 출처 보완 도중 변경되었습니다. 원본을 유지했으니 전체 초안을 다시 생성해 주세요."
        );
      }
      const serverUnresolved = normalizedEvidenceIssueIndices(
        payload.unresolvedIndices,
        nextDeck.slides.length
      );
      const localUnresolved = slideEvidenceIssueIndices(nextDeck, context.duration);
      const unresolvedIndices = Array.from(
        new Set([...serverUnresolved, ...localUnresolved])
      ).sort((a, b) => a - b);
      const repairedIndices = normalizedEvidenceIssueIndices(
        payload.repairedIndices,
        nextDeck.slides.length
      );
      const nextSopIssueIndices = slideSopIssueIndices(nextDeck, context.duration);
      const nextHasSopIssues = hasSlideSopQualityIssues(nextDeck, context.duration);
      const responseWarnings = Array.isArray(payload.warnings)
        ? payload.warnings
            .filter((warning): warning is string => typeof warning === "string")
            .map((warning) => warning.trim())
            .filter(Boolean)
            .slice(0, 5)
        : [];

      deckRef.current = nextDeck;
      setDeck(nextDeck);
      setSaved(false);
      setQuality((previous) => {
        const checked = localQuality("slides", nextDeck, context.duration, previous);
        return {
          ...checked,
          repaired: checked.repaired || repairedIndices.length > 0,
          warnings: Array.from(new Set([...responseWarnings, ...checked.warnings])).slice(0, 8),
        };
      });
      setEvidenceRepair({
        status: unresolvedIndices.length > 0 ? "failed" : "idle",
        issueIndices: unresolvedIndices,
        message:
          unresolvedIndices.length > 0
            ? "자동 보완하지 못한 장은 번호를 선택해 검증된 출처를 직접 연결할 수 있습니다."
            : undefined,
      });
      setQualityRepair({
        status:
          nextHasSopIssues && nextSopIssueIndices.length === 0
            ? "failed"
            : nextSopIssueIndices.length > 0
              ? "failed"
              : "idle",
        issueIndices: nextSopIssueIndices,
        message:
          nextHasSopIssues && nextSopIssueIndices.length === 0
            ? SOP_REPAIR_TARGET_UNAVAILABLE_MESSAGE
            : nextSopIssueIndices.length > 0
              ? "근거 보완 결과에 SOP 품질 오류가 남았습니다. 문제 슬라이드를 다시 보완해 주세요."
              : undefined,
      });
      if (unresolvedIndices.length > 0) {
        toast.warning("일부 슬라이드의 근거를 더 확인해 주세요", {
          description: `${unresolvedIndices.map((index) => index + 1).join(", ")}번 슬라이드가 남았습니다.`,
        });
      } else {
        toast.success("슬라이드별 근거를 확인해 보완했습니다");
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (!isCurrentOperation()) return;
      const message =
        error instanceof Error
          ? error.message
          : "잠시 후 다시 시도하거나 검증된 출처를 직접 선택해 주세요.";
      setEvidenceRepair({ status: "failed", issueIndices: requestedIndices, message });
      toast.error("슬라이드 근거 보완 중 오류가 발생했습니다", { description: message });
    } finally {
      if (evidenceRepairRequestRef.current?.id === operation.id) {
        evidenceRepairRequestRef.current = null;
      }
    }
  }

  // AI 부분 재생성 — 섹션/슬라이드 1개만 다시 생성해 해당 부분만 교체한다.
  async function handleRegen(
    kind: "section" | "slide",
    index: number,
    instruction?: string
  ) {
    if (
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current ||
      regenLoading !== null
    ) {
      return;
    }
    const context = resultContext;
    if (!context) return;
    const outline =
      kind === "section"
        ? (doc?.sections.map((s) => s.heading) ?? [])
        : (deck?.slides.map((s) => s.title) ?? []);
    const current = kind === "section" ? doc?.sections[index] : deck?.slides[index];
    const docTitle = kind === "section" ? doc?.title : deck?.title;
    if (!current) return;

    const controller = new AbortController();
    regenRequestRef.current = controller;
    const resultRevision = resultRevisionRef.current;
    setRegenLoading(index);
    try {
      const res = await fetch("/api/generate/section", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          kind,
          category: context.category,
          audience: context.audience,
          duration: context.duration,
          slideMode:
            kind === "slide"
              ? resolveSlideDeckMode(deck?.mode ?? context.slideMode)
              : undefined,
          topic: context.topic,
          focus: context.focus || undefined,
          conditions: context.conditions,
          model,
          docTitle,
          outline,
          index,
          current,
          sopTarget: shouldForceLegacySopSlideRecovery(kind, deck) || undefined,
          instruction,
        }),
      });
      if (
        regenRequestRef.current !== controller ||
        resultRevisionRef.current !== resultRevision
      ) {
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error("재생성 실패", {
          description: err?.error ?? "잠시 후 다시 시도해 주세요.",
        });
        return;
      }
      const json = await res.json();
      if (
        regenRequestRef.current !== controller ||
        resultRevisionRef.current !== resultRevision
      ) {
        return;
      }
      const retrievalDegraded = res.headers.get("X-RAG-Degraded") === "1";
      const modelFallbackUsed = res.headers.get("X-Model-Fallback") === "1";
      const { sourceLabels, sources, sopEvidence, ...regenerated } = json as Record<
        string,
        unknown
      > & {
        sourceLabels?: unknown;
        sources?: unknown;
        sopEvidence?: unknown;
      };
      const verifiedSopEvidence = normalizedSopEvidence(sopEvidence);
      if (kind === "section") {
        patchSection(index, regenerated as GeneratedSection, true);
        setDoc((previous) =>
          previous
            ? {
              ...previous,
              sourceLabels: mergedSourceLabels(previous.sourceLabels, sourceLabels),
              sources: mergeGeneratedSources(previous.sources, sources),
              sopEvidence: verifiedSopEvidence ?? previous.sopEvidence,
            }
          : previous
        );
      } else {
        patchSlide(index, regenerated as GeneratedSlide, true);
        setDeck((previous) =>
          previous
            ? {
              ...previous,
              sourceLabels: mergedSourceLabels(previous.sourceLabels, sourceLabels),
              sources: mergeGeneratedSources(previous.sources, sources),
              sopEvidence: verifiedSopEvidence ?? previous.sopEvidence,
            }
          : previous
        );
      }
      if (retrievalDegraded || modelFallbackUsed) {
        setQuality((previous) => ({
          checked: true,
          repaired: previous?.repaired ?? false,
          warnings: Array.from(
            new Set([
              ...(retrievalDegraded ? [RETRIEVAL_DEGRADED_WARNING] : []),
              ...(modelFallbackUsed ? [MODEL_FALLBACK_WARNING] : []),
              ...(previous?.warnings ?? []),
            ])
          ).slice(0, 5),
        }));
      }
      toast.success("다시 생성했습니다", {
        description: retrievalDegraded
          ? "자료 검색 일부 기능이 제한되어 회수 근거를 한 번 더 확인해 주세요."
          : modelFallbackUsed
            ? "정밀 모델이 일시 제한되어 빠른 모델로 생성했습니다. 결과를 한 번 더 확인해 주세요."
            : undefined,
      });
      setRegenIdx(null);
      setRegenText("");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("재생성 중 오류가 발생했습니다.");
    } finally {
      if (regenRequestRef.current === controller) {
        regenRequestRef.current = null;
        setRegenLoading(null);
      }
    }
  }

  function clearPreviousResult() {
    regenRequestRef.current?.abort();
    regenRequestRef.current = null;
    evidenceRepairRequestRef.current?.controller.abort();
    evidenceRepairRequestRef.current = null;
    qualityRepairRequestRef.current?.controller.abort();
    qualityRepairRequestRef.current = null;
    resultRevisionRef.current += 1;
    setCopied(false);
    setEditing(false);
    setRegenIdx(null);
    setRegenLoading(null);
    setSaved(false);
    setQuality(null);
    setEvidenceRepair({ status: "idle", issueIndices: [] });
    setQualityRepair({ status: "idle", issueIndices: [] });
    setLocalQualityRevision(0);
    setResultKind(null);
    setResultContext(null);
    setLoadedId(null); // 새 생성은 저장 안 된 새 결과
    setLoadedRevision(null);
    setDoc(null);
    deckRef.current = null;
    setDeck(null);
    setNlmPrompt(null);
  }

  function applyGenerationResult(
    json: Record<string, unknown> & { quality?: GenerationQuality },
    resultType: "plan" | "lesson" | "slides",
    context: ResultGenerationContext,
    autoRepair: boolean
  ) {
    const { quality: serverQuality, ...generatedResult } = json;
    if (resultType === "slides") {
      const generatedDeck = generatedResult as unknown as GeneratedSlideDeck;
      const normalizedDeck = autoAssignDeckSourceVisuals({
        ...generatedDeck,
        mode: resolveSlideDeckMode(generatedDeck.mode ?? context.slideMode),
      });
      const checkedQuality = localQuality(
        "slides",
        normalizedDeck,
        context.duration,
        serverQuality ?? null
      );
      const evidenceIssueIndices = slideEvidenceIssueIndices(
        normalizedDeck,
        context.duration
      );
      const qualityIssueIndices = slideSopIssueIndices(
        normalizedDeck,
        context.duration
      );
      const hasSopQualityIssues = hasSlideSopQualityIssues(
        normalizedDeck,
        context.duration
      );
      deckRef.current = normalizedDeck;
      setDeck(normalizedDeck);
      setQuality(checkedQuality);
      setResultKind("slides");
      setResultContext(context);
      setEvidenceRepair({
        status: !autoRepair && evidenceIssueIndices.length > 0 ? "failed" : "idle",
        issueIndices: evidenceIssueIndices,
        message:
          !autoRepair && evidenceIssueIndices.length > 0
            ? "서버 완료 결과와 브라우저 재검증 결과가 달라 자동 수정을 시작하지 않았습니다."
            : undefined,
      });
      setQualityRepair({
        status:
          hasSopQualityIssues &&
          (qualityIssueIndices.length === 0 || !autoRepair)
            ? "failed"
            : "idle",
        issueIndices: qualityIssueIndices,
        message:
          hasSopQualityIssues && qualityIssueIndices.length === 0
            ? SOP_REPAIR_TARGET_UNAVAILABLE_MESSAGE
            : !autoRepair && qualityIssueIndices.length > 0
              ? "서버 완료 결과를 브라우저에서 다시 확인했습니다. 필요한 경우 문제 장만 다시 보완해 주세요."
              : undefined,
      });
      // 동기 호환 경로만 브라우저 후속 보완을 실행한다. 영속 작업은 서버 Workflow에서
      // 품질 통과까지 마친 결과이므로 완료 응답을 받은 뒤 별도 재생성을 자동 시작하지 않는다.
      if (autoRepair && qualityIssueIndices.length > 0) {
        void repairSlideSopQuality(normalizedDeck, context, qualityIssueIndices);
      } else if (autoRepair && !hasSopQualityIssues && evidenceIssueIndices.length > 0) {
        void repairSlideEvidence(normalizedDeck, context, evidenceIssueIndices);
      }
      return;
    }

    setQuality(serverQuality ?? null);
    setDoc(generatedResult as unknown as GeneratedDoc);
    setResultKind(resultType);
    setResultContext(context);
  }

  applyCompletedJobRef.current = (job) => {
    if (!isCompletedQualityJob(job)) return;
    try {
      clearPreviousResult();
      applyGenerationResult(
        job.result as Record<string, unknown> & { quality?: GenerationQuality },
        job.request.type,
        resultContextFromRequest(job.request),
        false
      );
      setLoading(false);
      toast.success("품질 점검을 통과한 자료가 완성되었습니다");
    } catch {
      toast.error("완료된 자료를 화면에 표시하지 못했습니다", {
        description: "작업 주소를 새로 열어 다시 확인해 주세요.",
      });
    }
  };

  async function startDurableGeneration(requestBody: ValidatedGenerateRequest) {
    const requestFingerprint = JSON.stringify(requestBody);
    setLoading(true);
    let keepLoadingForLookup = false;
    let uncertainJobId: string | undefined;
    const beginUncertainLookup = (jobId: string) => {
      keepLoadingForLookup = true;
      pendingJobLookupStartedAtRef.current = Date.now();
      setPendingLookupJobId(jobId);
      setPendingJobLookupActive(true);
      setJobConnectionRetry(null);
      replaceGenerationJobUrl(jobId);
    };
    try {
      const pendingCreate = preparePendingGenerationJobCreate(
        requestFingerprint,
        pendingJobCreateRef.current
      );
      const { clientRequestId, jobId } = pendingCreate;
      let deliveryUncertain = pendingCreate.deliveryUncertain;
      const markDeliveryUncertain = () => {
        deliveryUncertain = true;
        uncertainJobId = jobId;
        if (
          pendingJobCreateRef.current?.clientRequestId === clientRequestId &&
          pendingJobCreateRef.current.jobId === jobId
        ) {
          pendingJobCreateRef.current = {
            ...pendingJobCreateRef.current,
            deliveryUncertain: true,
          };
        }
      };
      pendingJobCreateRef.current = pendingCreate;
      const body = JSON.stringify({ ...requestBody, clientRequestId, jobId });
      let response: Response | null = null;
      let payload: Record<string, unknown> | null = null;
      let lastNetworkError: unknown = null;
      for (let attempt = 0; attempt < DURABLE_CREATE_RETRY_DELAYS_MS.length; attempt += 1) {
        const delayMs = DURABLE_CREATE_RETRY_DELAYS_MS[attempt];
        if (delayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        }
        const requestController = new AbortController();
        const requestTimeout = window.setTimeout(
          () => requestController.abort(),
          DURABLE_CREATE_REQUEST_TIMEOUT_MS
        );
        try {
          response = await fetch("/api/generate/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            keepalive: true,
            body,
            signal: requestController.signal,
          });
          payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
          if (response.ok || response.status < 500 || attempt === DURABLE_CREATE_RETRY_DELAYS_MS.length - 1) {
            break;
          }
          // 5xx는 행 저장 뒤 응답 조립에서 났을 수도 있으므로 이후 4xx가 와도 주소를 지우지 않는다.
          markDeliveryUncertain();
        } catch (networkError) {
          // 네트워크 오류는 요청 미전송과 응답 유실을 구분할 수 없다.
          markDeliveryUncertain();
          response = null;
          const safeError =
            networkError instanceof DOMException && networkError.name === "AbortError"
              ? new Error("생성 작업 접수 응답이 지연되어 같은 작업 번호로 다시 확인합니다.")
              : networkError;
          lastNetworkError = safeError;
          if (attempt === DURABLE_CREATE_RETRY_DELAYS_MS.length - 1) throw safeError;
        } finally {
          window.clearTimeout(requestTimeout);
        }
      }
      if (!response) {
        throw lastNetworkError instanceof Error
          ? lastNetworkError
          : new Error("생성 작업 서버에 연결하지 못했습니다.");
      }
      if (!response.ok) {
        const existingActiveJob =
          response.status === 409 ? generationJobFromPayload(payload) : null;
        if (existingActiveJob) {
          clearPreviousResult();
          appliedJobRevisionRef.current = "";
          pendingJobCreateRef.current = null;
          setActiveJob(existingActiveJob);
          setPendingJobLookupActive(false);
          setPendingLookupJobId(undefined);
          setJobConnectionRetry(null);
          replaceGenerationJobUrl(existingActiveJob.id);
          toast.info("이미 진행 중인 품질 우선 작업을 이어서 표시합니다");
          return;
        }
        if (
          isDefinitiveGenerationJobCreateRejection(
            response.status,
            deliveryUncertain
          )
        ) {
          if (
            pendingJobCreateRef.current?.clientRequestId === clientRequestId &&
            pendingJobCreateRef.current.jobId === jobId
          ) {
            pendingJobCreateRef.current = null;
          }
          removeGenerationJobUrl(jobId);
        }
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string"
            ? payload.error
            : "잠시 후 다시 시도해 주세요.";
        if (!isDefinitiveGenerationJobCreateRejection(response.status, deliveryUncertain)) {
          beginUncertainLookup(jobId);
          toast.info("생성 작업 접수 결과를 확인하고 있습니다", {
            description: `${message} 같은 작업 번호로 서버 상태를 자동 확인합니다.`,
          });
          return;
        }
        toast.error("생성 작업을 시작하지 못했습니다", { description: message });
        return;
      }
      const job = generationJobFromPayload(payload, jobId);
      if (!job) {
        markDeliveryUncertain();
        throw new Error("생성 작업 응답 형식이 올바르지 않습니다.");
      }
      clearPreviousResult();
      appliedJobRevisionRef.current = "";
      pendingJobCreateRef.current = null;
      setActiveJob(job);
      setPendingJobLookupActive(false);
      setPendingLookupJobId(undefined);
      setJobConnectionRetry(null);
      replaceGenerationJobUrl(job.id);
      if (job.status === "failed") {
        toast.error("작업은 저장했지만 서버 실행을 시작하지 못했습니다", {
          description: job.errorMessage ?? "저장된 작업 다시 시도를 눌러 이어갈 수 있습니다.",
        });
      } else if (!isGenerationJobDispatchConfirmed(job)) {
        toast.info("생성 요청을 저장했습니다", {
          description: "서버 실행 연결을 확인 중입니다. 완료 안내가 보일 때까지 이 화면을 유지해 주세요.",
        });
      } else {
        toast.success("품질 우선 생성 작업을 시작했습니다", {
          description: "서버 접수가 완료되어 화면을 닫아도 계속 진행됩니다.",
        });
      }
    } catch (error) {
      if (uncertainJobId) {
        beginUncertainLookup(uncertainJobId);
        toast.info("생성 작업 접수 결과를 확인하고 있습니다", {
          description: "응답이 끊겼지만 같은 작업 번호로 서버 상태를 자동 확인합니다.",
        });
      } else {
        toast.error("생성 작업을 시작하지 못했습니다", {
          description:
            error instanceof Error ? error.message : "네트워크 연결을 확인해 주세요.",
        });
      }
    } finally {
      if (!keepLoadingForLookup) setLoading(false);
    }
  }

  async function retryDurableGeneration() {
    if (!activeJob || jobRetryingRef.current || isRunningGenerationJob(activeJob)) return;
    const retryJobId = activeJob.id;
    jobRetryingRef.current = true;
    setJobRetrying(true);
    const requestController = new AbortController();
    const requestTimeout = window.setTimeout(
      () => requestController.abort(),
      DURABLE_RETRY_REQUEST_TIMEOUT_MS
    );
    try {
      const response = await fetch(
        `/api/generate/jobs/${encodeURIComponent(activeJob.id)}/retry`,
        { method: "POST", signal: requestController.signal }
      );
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && typeof payload.error === "string"
            ? payload.error
            : "잠시 후 다시 시도해 주세요.";
        toast.error("저장된 작업을 다시 시작하지 못했습니다", { description: message });
        if (response.status === 409 || response.status >= 500) {
          pendingJobLookupStartedAtRef.current = Date.now();
          setPendingLookupJobId(retryJobId);
          setPendingJobLookupActive(true);
          setJobConnectionRetry(null);
        }
        return;
      }
      const job = generationJobFromPayload(payload, activeJob.id);
      if (!job) throw new Error("재시도 응답 형식이 올바르지 않습니다.");
      appliedJobRevisionRef.current = "";
      setActiveJob(job);
      setPendingJobLookupActive(false);
      setPendingLookupJobId(undefined);
      setJobConnectionRetry(null);
      replaceGenerationJobUrl(job.id);
      if (job.status === "failed") {
        toast.error("재시도 작업을 저장했지만 서버 실행을 시작하지 못했습니다", {
          description: job.errorMessage ?? "잠시 후 다시 시도해 주세요.",
        });
      } else {
        toast.success("저장된 단계에서 품질 점검을 다시 시작했습니다");
      }
    } catch (error) {
      pendingJobLookupStartedAtRef.current = Date.now();
      setPendingLookupJobId(retryJobId);
      setPendingJobLookupActive(true);
      setJobConnectionRetry(null);
      toast.error("저장된 작업을 다시 시작하지 못했습니다", {
        description:
          error instanceof DOMException && error.name === "AbortError"
            ? "서버 응답이 지연되었습니다. 작업 상태를 다시 확인한 뒤 재시도해 주세요."
            : error instanceof Error
              ? error.message
              : "네트워크 연결을 확인해 주세요.",
      });
    } finally {
      window.clearTimeout(requestTimeout);
      jobRetryingRef.current = false;
      setJobRetrying(false);
    }
  }

  async function runGeneration(focus?: string) {
    // 저장 응답이 돌아오기 전에 결과를 교체하면 이전 행 id가 새 결과에 연결될 수 있다.
    // 저장·부분 재생성 중에는 어떤 진입점(자동 통과·우회 버튼 포함)에서도 전체 생성을 시작하지 않는다.
    if (
      !category ||
      !categoryConfirmed ||
      jobRunning ||
      loading ||
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current
    ) return;
    const safeFocus = focus?.replace(/\s+/g, " ").trim().slice(0, 100) || undefined;
    const requestContext: ResultGenerationContext = {
      category,
      audience,
      duration,
      slideMode: resolveSlideDeckMode(slideMode),
      topic: topic.trim(),
      focus: safeFocus ?? "",
      date: type === "plan" ? date : "",
      place: type === "plan" ? place.trim() : "",
      conditions: conditions.trim(),
    };
    if (safeFocus) {
      focusHistoryRef.current.add(safeFocus);
      setTopicFocus({ status: "resolved", focus: safeFocus });
    } else if (isLikelyBroadTrainingTopic(topic)) {
      setTopicFocus({ status: "bypassed" });
    }

    const requestBody = { ...genReq, focus: safeFocus };

    // NotebookLM 프롬프트는 AI 호출 없이 즉시 조립 — 인덱싱된 자료 목록 포함
    if (type === "notebooklm") {
      clearPreviousResult();
      setActiveJob(null);
      setJobConnectionRetry(null);
      removeGenerationJobUrl();
      generationRequestRef.current?.abort();
      generationRequestRef.current = null;
      setNlmPrompt(buildNotebookLmPrompt(requestBody, docsByCategory[category] ?? []));
      setResultKind("notebooklm");
      setResultContext(requestContext);
      return;
    }

    if (durableGenerationEnabled) {
      await startDurableGeneration(requestBody as ValidatedGenerateRequest);
      return;
    }

    clearPreviousResult();
    setActiveJob(null);
    setJobConnectionRetry(null);
    removeGenerationJobUrl();
    generationRequestRef.current?.abort();
    const controller = new AbortController();
    generationRequestRef.current = controller;
    const requestFingerprint = JSON.stringify(requestBody);
    setLoading(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify(requestBody),
      });
      if (
        generationRequestRef.current !== controller ||
        generationFingerprintRef.current !== requestFingerprint
      ) {
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        toast.error("생성 실패", {
          description: err?.error ?? "잠시 후 다시 시도해 주세요.",
        });
        return;
      }
      const json = (await res.json()) as Record<string, unknown> & {
        quality?: GenerationQuality;
      };
      applyGenerationResult(json, type, requestContext, true);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      toast.error("생성 중 오류가 발생했습니다.");
    } finally {
      if (generationRequestRef.current === controller) {
        generationRequestRef.current = null;
        setLoading(false);
      }
    }
  }

  async function requestTrainingFocus({
    refresh = false,
    mode = "auto",
    moveFocus = true,
    generateIfSpecific = true,
  }: TrainingFocusRequestOptions = {}) {
    if (
      !category ||
      !categoryConfirmed ||
      focusRequestRef.current ||
      loading ||
      jobRunning ||
      jobRetrying ||
      pendingJobLookupActive ||
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current
    ) return;
    const trimmedTopic = topic.trim();
    const requestFocusFingerprint = focusRequestFingerprintRef.current;
    const previousResolvedFocus =
      topicFocus.status === "resolved" ? topicFocus.focus : null;
    // 새 세부 방향을 고르는 순간 이전 조건으로 진행 중인 전체 생성은 더 이상 유효하지 않다.
    generationRequestRef.current?.abort();
    generationRequestRef.current = null;
    setLoading(false);
    const previousChoice =
      topicFocus.status === "choosing" || topicFocus.status === "refreshing"
        ? {
            options: topicFocus.options,
            similarMaterials: topicFocus.similarMaterials,
            warnings: topicFocus.warnings,
            recommendedId: topicFocus.recommendedId,
            selectedId: topicFocus.selectedId,
            customValue: topicFocus.customValue,
            historyCompared: topicFocus.historyCompared,
          }
        : {
            options: [] as TrainingFocusOption[],
            similarMaterials: [] as SimilarTrainingMaterial[],
            warnings: [] as string[],
            recommendedId: undefined,
            selectedId: undefined,
            customValue: "",
            historyCompared: false,
          };
    const controller = new AbortController();
    focusRequestRef.current = controller;
    activeFocusRequestFingerprintRef.current = requestFocusFingerprint;
    const restoreResolvedFocus = (message: string): boolean => {
      if (!refresh || !previousResolvedFocus) return false;
      setTopicFocus({ status: "resolved", focus: previousResolvedFocus });
      toast.error("새 훈련 방향을 찾지 못했습니다", { description: message });
      return true;
    };
    setFocusSelectionError("");
    setTopicFocus(
      refresh
        ? { status: "refreshing", ...previousChoice }
        : { status: "loading", options: [], similarMaterials: [] }
    );
    // 사용자가 직접 요청한 경우에만 교체된 패널로 포커스를 옮긴다. 자동 추천은 입력 중인
    // 사용자의 키보드·스크린리더 위치를 바꾸지 않고 상태 영역으로만 진행을 알린다.
    if (moveFocus) {
      requestAnimationFrame(() => focusHeadingRef.current?.focus());
    }

    try {
      const response = await fetch("/api/generate/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          category,
          topic: trimmedTopic,
          // 세부 방향 추천은 짧은 선택 보조 작업이다. 정밀 모델 시간은 실제 계획·교안·PPT
          // 초안에 집중하고, 추천은 빠른 모델과 서버 근거 필터로 처리한다.
          model: model === "gemini-pro" ? "gemini-flash" : model,
          excludeFocuses: Array.from(focusHistoryRef.current).slice(-60),
          mode,
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            scope?: "specific" | "broad" | "refined";
            options?: TrainingFocusOption[];
            similarMaterials?: SimilarTrainingMaterial[];
            recommendedId?: string;
            warnings?: string[];
            historyBasis?: "demo" | "saved-materials" | "request-only";
            error?: string;
          }
        | null;
      if (focusRequestRef.current !== controller) return;
      if (focusRequestFingerprintRef.current !== requestFocusFingerprint) {
        setTopicFocus({ status: "idle" });
        return;
      }
      if (!response.ok) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const message =
          response.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0
            ? `요청이 잠시 몰렸습니다. ${Math.ceil(retryAfter)}초 후 다시 시도해 주세요.`
            : payload?.error ?? "세부 훈련 방향을 찾지 못했습니다.";
        if (restoreResolvedFocus(message)) return;
        if (refresh && previousChoice.options.length > 0) {
          setTopicFocus({
            status: "choosing",
            ...previousChoice,
            error: message,
          });
          if (moveFocus) {
            requestAnimationFrame(() => focusHeadingRef.current?.focus());
          }
          return;
        }
        setTopicFocus({
          status: "error",
          message,
          similarMaterials: safeSimilarTrainingMaterials(payload?.similarMaterials),
        });
        if (moveFocus) {
          requestAnimationFrame(() => focusHeadingRef.current?.focus());
        }
        return;
      }
      if (payload?.scope === "specific") {
        if (generateIfSpecific) {
          setTopicFocus({ status: "bypassed" });
          await runGeneration();
        } else {
          setTopicFocus({ status: "idle" });
        }
        return;
      }
      const options = Array.isArray(payload?.options) ? payload.options.slice(0, 5) : [];
      const similarMaterials = safeSimilarTrainingMaterials(payload?.similarMaterials);
      if (options.length === 0) {
        const message =
          similarMaterials.length > 0
            ? "새로 제안할 세부 방향은 찾지 못했습니다. 아래 저장 자료를 열거나 입력한 주제로 종합훈련을 만들 수 있습니다."
            : "연결 자료 범위에서는 근거가 있는 세부 방향을 찾지 못했습니다.";
        if (restoreResolvedFocus(message)) return;
        setTopicFocus({
          status: "error",
          message,
          similarMaterials,
        });
        if (moveFocus) {
          requestAnimationFrame(() => focusHeadingRef.current?.focus());
        }
        return;
      }
      options.forEach((option) => focusHistoryRef.current.add(option.title));
      const recommendedId = options.some((option) => option.id === payload?.recommendedId)
        ? payload?.recommendedId
        : undefined;
      setTopicFocus({
        status: "choosing",
        options,
        similarMaterials,
        recommendedId,
        warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
        customValue: "",
        historyCompared:
          payload?.historyBasis === "saved-materials",
      });
      if (moveFocus) {
        requestAnimationFrame(() => {
          const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          focusHeadingRef.current?.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start",
          });
          focusHeadingRef.current?.focus({ preventScroll: true });
        });
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (
        focusRequestRef.current !== controller ||
        focusRequestFingerprintRef.current !== requestFocusFingerprint
      ) {
        return;
      }
      const message = "네트워크 연결을 확인한 뒤 다시 시도해 주세요.";
      if (restoreResolvedFocus(message)) return;
      if (refresh && previousChoice.options.length > 0) {
        setTopicFocus({
          status: "choosing",
          ...previousChoice,
          error: message,
        });
        if (moveFocus) {
          requestAnimationFrame(() => focusHeadingRef.current?.focus());
        }
        return;
      }
      setTopicFocus({
        status: "error",
        message,
        similarMaterials: [],
      });
      if (moveFocus) {
        requestAnimationFrame(() => focusHeadingRef.current?.focus());
      }
    } finally {
      if (focusRequestRef.current === controller) {
        focusRequestRef.current = null;
        activeFocusRequestFingerprintRef.current = "";
      }
    }
  }

  async function continueGenerationAfterCategory() {
    const trimmedTopic = topic.trim();
    if (topicFocus.status === "loading" || topicFocus.status === "refreshing") return;
    if (topicFocus.status === "resolved") {
      await runGeneration(topicFocus.focus);
      return;
    }
    if (topicFocus.status === "bypassed") {
      await runGeneration();
      return;
    }
    if (topicFocus.status === "choosing") {
      const focus =
        topicFocus.selectedId === "custom"
          ? topicFocus.customValue.trim()
          : topicFocus.options.find((option) => option.id === topicFocus.selectedId)?.title;
      if (!focus || focus.length < 2) {
        setFocusSelectionError(
          topicFocus.selectedId === "custom"
            ? "직접 입력할 세부 방향을 두 글자 이상 적어 주세요."
            : "세부 훈련 방향을 하나 선택해 주세요."
        );
        if (topicFocus.selectedId === "custom") {
          document.getElementById("custom-topic-focus")?.focus();
        } else {
          requestAnimationFrame(() => {
            document
              .getElementById(`topic-focus-${topicFocus.options[0]?.id ?? ""}`)
              ?.focus();
          });
        }
        return;
      }
      await runGeneration(focus);
      return;
    }
    if (!isLikelyBroadTrainingTopic(trimmedTopic)) {
      await runGeneration();
      return;
    }
    await requestTrainingFocus();
  }

  async function handleGenerate() {
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
    const trimmedTopic = topic.trim();
    if (trimmedTopic.length < 2) {
      setTopicError(true);
      document.getElementById("topic")?.focus();
      toast.error("자료 주제를 입력해 주세요", {
        description: "구체적인 주제가 있어야 관련 교범을 정확히 찾아 좋은 자료를 만들 수 있습니다.",
      });
      return;
    }

    setTopicError(false);
    if (!categoryConfirmed) {
      if (categoryDebounceRef.current) clearTimeout(categoryDebounceRef.current);
      categoryDebounceRef.current = null;
      pendingGenerateAfterCategoryRef.current = categoryIndependentGenerationFingerprint;
      if (
        categoryRecommendation.status === "ready" &&
        categoryRecommendation.topic === trimmedTopic
      ) {
        setCategoryPickerOpen(true);
        requestAnimationFrame(() => {
          document.getElementById("category-recommendation-confirm")?.focus();
        });
        return;
      }
      if (
        categoryRecommendation.status !== "loading" ||
        categoryRecommendation.topic !== trimmedTopic
      ) {
        await requestCategoryRecommendation(trimmedTopic);
      }
      return;
    }

    pendingGenerateAfterCategoryRef.current = null;
    await continueGenerationAfterCategory();
  }

  continueGenerationAfterCategoryRef.current = continueGenerationAfterCategory;
  requestTrainingFocusRef.current = requestTrainingFocus;

  // 사용자가 새로 입력한 넓은 주제는 분야가 확정되는 즉시 세부 방향까지 자동으로 잇는다.
  // 저장본·진행 중 작업을 열었을 때는 원치 않는 모델 호출을 만들지 않는다.
  useEffect(() => {
    if (
      !autoRequestTopicFocus ||
      !category ||
      loading ||
      jobRunning ||
      jobRetrying ||
      pendingJobLookupActive ||
      topicFocus.status !== "idle"
    ) {
      return;
    }
    void requestTrainingFocusRef.current({
      mode: "auto",
      moveFocus: false,
      generateIfSpecific: false,
    });
  }, [
    autoRequestTopicFocus,
    category,
    jobRetrying,
    jobRunning,
    loading,
    pendingJobLookupActive,
    topicFocus.status,
  ]);

  // setCategory 직후에는 이전 렌더의 빈 분야가 남아 있으므로, 다음 렌더에서 생성 의도를 잇는다.
  useEffect(() => {
    const pendingFingerprint = pendingGenerateAfterCategoryRef.current;
    if (!pendingFingerprint || !categoryConfirmed || !category) return;
    pendingGenerateAfterCategoryRef.current = null;
    if (pendingFingerprint !== categoryIndependentGenerationFingerprint) return;
    void continueGenerationAfterCategoryRef.current();
  }, [category, categoryConfirmed, categoryIndependentGenerationFingerprint]);

  // 생성물 저장 — 현재 결과(편집 반영분)를 개인 이력에 저장.
  async function handleSave() {
    if (
      !resultKind ||
      !resultContext ||
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current ||
      exportBusyRef.current ||
      regenLoading !== null
    ) {
      return;
    }
    if (!ensureQualityForOutput()) return;
    const saveRevision = resultRevisionRef.current;
    const saveLoadedId = loadedId;
    const saveLoadedRevision = loadedRevision;
    const resultMeta = GEN_TYPES.find((item) => item.key === resultKind) ?? typeMeta;
    const storableDeck = deck ? stripSlideDeckRuntimeData(deck) : null;
    const payload =
      resultKind === "slides" && storableDeck
        ? {
            title: storableDeck.title,
            content: {
              mode: resolveSlideDeckMode(storableDeck.mode ?? resultContext.slideMode),
              slides: storableDeck.slides,
              sources: storableDeck.sources,
              sourceLabels: storableDeck.sourceLabels,
              sopEvidence: storableDeck.sopEvidence,
              focus: resultContext.focus || undefined,
              conditions: resultContext.conditions,
            },
          }
        : nlmPrompt && resultKind === "notebooklm"
          ? {
              title: `${resultContext.category} ${resultMeta.label}${resultContext.topic ? ` — ${resultContext.topic}` : ""}`.slice(0, 200),
              content: {
                prompt: nlmPrompt,
                focus: resultContext.focus || undefined,
                conditions: resultContext.conditions,
              },
            }
          : doc
            ? {
                title: doc.title,
                content: {
                  sections: doc.sections,
                  sources: doc.sources,
                  sourceLabels: doc.sourceLabels,
                  sopEvidence: doc.sopEvidence,
                  focus: resultContext.focus || undefined,
                  conditions: resultContext.conditions,
                  date: resultKind === "plan" ? resultContext.date : "",
                  place: resultKind === "plan" ? resultContext.place : "",
                },
              }
            : null;
    if (!payload) return;

    savingRef.current = true;
    setSaving(true);
    try {
      const res = await fetch("/api/generate/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: saveLoadedId ?? undefined,
          revision: saveLoadedId ? saveLoadedRevision : undefined,
          kind: resultKind,
          category: resultContext.category,
          audience: resultContext.audience,
          duration: resultContext.duration,
          topic: resultContext.topic,
          ...payload,
        }),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          code?: unknown;
          error?: unknown;
        } | null;
        const description =
          typeof err?.error === "string" ? err.error : "잠시 후 다시 시도해 주세요.";
        if (
          res.status === 409 &&
          err?.code === "material_revision_conflict" &&
          saveLoadedId
        ) {
          toast.warning("최신 저장본을 보호했습니다", {
            description,
            action: {
              label: "최신본 열기",
              onClick: () => window.location.assign(`/generate?m=${saveLoadedId}`),
            },
          });
        } else {
          toast.error("저장 실패", { description });
        }
        return;
      }
      // 신규 저장이면 id 를 받아 이후 저장은 같은 행을 수정(중복 저장 방지).
      const json = await res.json().catch(() => null);
      if (resultRevisionRef.current !== saveRevision) {
        toast.success("이전 결과를 저장했습니다", {
          description: "현재 화면의 새 결과와는 별도의 저장본으로 유지됩니다.",
        });
        return;
      }
      if (json?.id) setLoadedId(json.id);
      if (Number.isSafeInteger(json?.revision) && json.revision > 0) {
        setLoadedRevision(json.revision);
      }
      setSaved(true);
      toast.success(saveLoadedId ? "수정 저장했습니다" : "저장했습니다", {
        description: "‘저장한 자료’에서 다시 볼 수 있어요.",
      });
    } catch {
      toast.error("저장 중 오류가 발생했습니다.");
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function handlePptx() {
    if (
      !deck ||
      !resultContext ||
      exportBusyRef.current ||
      savingRef.current ||
      regenRequestRef.current ||
      evidenceRepairRequestRef.current ||
      qualityRepairRequestRef.current
    ) {
      return;
    }
    if (!ensureQualityForOutput()) return;
    const exportDeck = deck;
    const exportContext = resultContext;
    exportBusyRef.current = true;
    setPptxLoading(true);
    notifyQualityWarnings(recheckCurrentQuality());
    let visualToastId: string | number | undefined;
    try {
      // PPTX·PDF 렌더러는 무거워서 다운로드 시점에만 로드한다.
      visualToastId = toast.loading("원문 시각자료를 준비하고 있습니다…");
      const [{ downloadPptx }, { prepareDeckSourceVisuals }] = await Promise.all([
        import("@/lib/pptx"),
        import("@/lib/source-visuals"),
      ]);
      const prepared = await prepareDeckSourceVisuals(exportDeck, (progress) => {
        if (visualToastId === undefined) return;
        toast.loading("원문 시각자료를 준비하고 있습니다…", {
          id: visualToastId,
          description: `${progress.completed}/${progress.total} · ${progress.title} ${progress.page}쪽`,
        });
      });
      if (prepared.requested === 0) {
        toast.dismiss(visualToastId);
        visualToastId = undefined;
      } else if (prepared.failed > 0) {
        const textOnlyCount = prepared.fallbacks.filter(
          (fallback) => fallback.reason === "text-only-page"
        ).length;
        toast.warning("일부 원문 이미지는 도형·내용 구도로 대신했습니다", {
          id: visualToastId,
          description: `${prepared.resolved}개 반영 · ${prepared.failed}개 대체${
            textOnlyCount > 0 ? ` · 텍스트 위주 페이지 ${textOnlyCount}개 제외` : ""
          }`,
        });
        visualToastId = undefined;
      } else {
        toast.success("원문 시각자료를 반영했습니다", {
          id: visualToastId,
          description: `${prepared.resolved}개 페이지를 슬라이드에 넣었습니다.`,
        });
        visualToastId = undefined;
      }
      await downloadPptx(prepared.deck, exportContext.category, subtitle);
    } catch {
      if (visualToastId !== undefined) toast.dismiss(visualToastId);
      toast.error("PPTX 파일 생성에 실패했습니다");
    } finally {
      exportBusyRef.current = false;
      setPptxLoading(false);
    }
  }

  async function handleCopy(text: string) {
    if (exportBusyRef.current || savingRef.current || regenRequestRef.current) return;
    if (!ensureQualityForOutput()) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success("복사했습니다");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("복사에 실패했습니다");
    }
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDocx() {
    if (
      !doc ||
      !resultContext ||
      exportBusyRef.current ||
      savingRef.current ||
      regenRequestRef.current
    ) {
      return;
    }
    if (!ensureQualityForOutput()) return;
    const exportDoc = doc;
    exportBusyRef.current = true;
    setDocExporting("docx");
    notifyQualityWarnings(recheckCurrentQuality());
    try {
      // docx는 무거워서 다운로드 시점에만 로드
      const { buildDocxBlob } = await import("@/lib/docx");
      downloadBlob(await buildDocxBlob(exportDoc), `${sanitizeFilename(exportDoc.title)}.docx`);
    } catch {
      toast.error("문서 파일 생성에 실패했습니다");
    } finally {
      exportBusyRef.current = false;
      setDocExporting(null);
    }
  }

  async function handleHwpx() {
    if (
      !doc ||
      !resultContext ||
      exportBusyRef.current ||
      savingRef.current ||
      regenRequestRef.current
    ) {
      return;
    }
    if (!ensureQualityForOutput()) return;
    const exportDoc = doc;
    const exportContext = resultContext;
    exportBusyRef.current = true;
    setDocExporting("hwpx");
    notifyQualityWarnings(recheckCurrentQuality());
    try {
      // 미니서버(hwp-writer-api) 우선, 실패 시 로컬 생성 폴백.
      // 훈련계획(plan)은 전북소방 표준 양식(training_plan.hwpx)에 폼 입력 + AI 섹션을 채운다.
      const { downloadHwpx } = await import("@/lib/hwpx-download");
      const opts =
        resultKind === "plan"
          ? {
              template: "training_plan" as const,
              plan: {
                topic: exportContext.topic || `${exportContext.category} 훈련`,
                datetime: exportContext.date,
                formType: DEFAULT_TRAINING_TYPE,
                method: DEFAULT_TRAINING_METHOD,
                duration: exportContext.duration,
                target: exportContext.audience,
                place: exportContext.place,
              },
            }
          : undefined;
      const via = await downloadHwpx(exportDoc, opts);
      if (via === "local") {
        toast.info("한글 작성 서버 미연결 — 기본 양식으로 생성했습니다");
      }
    } catch (error) {
      toast.error("한글 파일 생성에 실패했습니다", {
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      exportBusyRef.current = false;
      setDocExporting(null);
    }
  }

  const typeMeta = GEN_TYPES.find((t) => t.key === type)!;
  const activeJobType = activeJob?.request.type ?? type;
  const timedActiveJobType: "plan" | "lesson" | "slides" =
    activeJob?.request.type ?? (type === "notebooklm" ? "plan" : type);
  const activeJobTypeMeta = GEN_TYPES.find((item) => item.key === activeJobType)!;
  const showDurableJobStatus = Boolean(activeJob && !isCompletedQualityJob(activeJob));
  const categoryBusy = categoryRecommendation.status === "loading";
  const focusBusy = topicFocus.status === "loading" || topicFocus.status === "refreshing";
  const evidenceRepairing = evidenceRepair.status === "repairing";
  const qualityRepairing = qualityRepair.status === "repairing";
  const resultMutationLocked =
    saving ||
    regenLoading !== null ||
    evidenceRepairing ||
    qualityRepairing ||
    pptxLoading ||
    docExporting !== null;
  const outputBlocked =
    (quality?.errors?.length ?? 0) > 0 ||
    (resultKind === "slides" &&
      (evidenceRepairing ||
        qualityRepairing ||
        evidenceRepair.issueIndices.length > 0 ||
        qualityRepair.issueIndices.length > 0));
  // 선택한 분야 색을 페이지 액센트로 흘린다(상단 바·분야 칩·생성 버튼). hex 인라인으로 동적 적용.
  const accent = categoryStyle(categoryConfirmed ? category : "").hex;
  const resultAccent = categoryStyle(resultContext?.category ?? category).hex;

  // 결과 카드 3종이 공유하는 상단 컨트롤(저장·편집)과 항목별 재생성 상태.
  const chrome: ResultChrome = {
    accent: resultAccent,
    editing,
    onToggleEdit: () => {
      if (
        saving ||
        regenLoading !== null ||
        evidenceRepairing ||
        qualityRepairing ||
        pptxLoading ||
        docExporting !== null
      ) return;
      setEditing((v) => !v);
    },
    saving,
    locked:
      regenLoading !== null ||
      evidenceRepairing ||
      qualityRepairing ||
      pptxLoading ||
      docExporting !== null,
    outputBlocked,
    saved,
    loadedId,
    onSave: handleSave,
  };
  // 재생성 대상(섹션/슬라이드)은 결과 종류마다 다르므로 kind 를 명시해 각각 만든다.
  const makeRegen = (kind: "section" | "slide"): RegenState => ({
    openIndex: regenIdx,
    loadingIndex: regenLoading,
    text: regenText,
    onTextChange: setRegenText,
    onOpen: (index) => {
      setRegenIdx(index);
      setRegenText("");
    },
    onClose: () => setRegenIdx(null),
    onApply: (index, instruction) => handleRegen(kind, index, instruction),
  });

  return (
    <div className="space-y-5">
      {/* 입력 폼 — 분야 색이 흐르는 단계형 카드 */}
      <Card className="overflow-hidden border-border/60 shadow-sm">
        {/* 분야 색 액센트 바 */}
        <div
          className="h-1 w-full transition-colors duration-500 motion-reduce:transition-none"
          style={{ backgroundColor: accent }}
        />
        <CardContent className="space-y-3 p-4 sm:p-5">
          {/* STEP 01 — 무엇을 만들까요 */}
          <section className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none">
            <StepHeader n="01" title="무엇을 만들까요" />
            {/* 생성 3종 — 인덱싱된 자료로 AI가 파일을 생성(선택 색은 분야 색으로 통일) */}
            <div className="grid grid-cols-3 gap-2.5" role="radiogroup" aria-label="생성할 자료">
              {GEN_TYPES.filter((t) => t.key !== "notebooklm").map((t) => {
                const Icon =
                  t.key === "slides"
                    ? Presentation
                    : t.key === "lesson"
                      ? MessageSquareText
                      : FileText;
                const active = type === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    onClick={() => setType(t.key)}
                    style={
                      active
                        ? { borderColor: accent, backgroundColor: `${accent}14`, color: accent }
                        : undefined
                    }
                    className={cn(
                      "group flex min-h-[68px] flex-col items-center justify-center gap-1.5 rounded-md border p-2.5 text-center transition-all duration-200 motion-reduce:transition-none",
                      "hover:-translate-y-0.5 hover:shadow-sm motion-reduce:hover:translate-y-0",
                      active ? "shadow-sm" : "border-border hover:border-primary/40"
                    )}
                  >
                    <span
                      className={cn(
                        "flex h-8 w-8 items-center justify-center rounded-lg transition-colors duration-200",
                        !active && "bg-muted text-muted-foreground group-hover:text-primary"
                      )}
                      style={active ? { backgroundColor: accent, color: "#ffffff" } : undefined}
                    >
                      <Icon className="h-4 w-4" />
                    </span>
                    <span className="text-sm font-medium">
                      {t.key === "lesson" ? "교안" : t.key === "slides" ? "슬라이드" : t.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {/* 선택한 유형 설명 — 한 줄 (생성 3종일 때) */}
            {type !== "notebooklm" && (
              <p className="text-sm text-muted-foreground">{typeMeta.description}</p>
            )}
            {type === "slides" && (
              <fieldset className="rounded-lg border border-border/70 bg-muted/20 p-3">
                <legend className="px-1 text-sm font-semibold">슬라이드 구성</legend>
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="슬라이드 구성">
                  {SLIDE_MODE_OPTIONS.map((option) => {
                    const active = slideMode === option.key;
                    return (
                      <button
                        key={option.key}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setSlideMode(option.key)}
                        className={cn(
                          "min-h-16 rounded-md border px-3 py-2.5 text-left transition-colors motion-reduce:transition-none",
                          active
                            ? "border-primary bg-primary/10 text-foreground"
                            : "border-border bg-background hover:border-primary/40 hover:bg-accent/40"
                        )}
                      >
                        <span className="block text-sm font-semibold">{option.label}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {option.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            )}
          </section>

          <div className="h-px bg-border/60" />

          {/* STEP 02 — 주제 입력 뒤 분야를 자동으로 추천 */}
          <section
            className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "70ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="02" title="무엇을 훈련할까요" hint="주제는 필수예요" />
            <div
              className="border-l-4 bg-muted/45 px-3 py-2.5"
              style={{ borderLeftColor: accent }}
            >
              <p className="text-sm font-medium">
                주제가 구체적일수록 교범의 정확한 절차를 찾습니다.
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {categoryConfirmed
                  ? `현재 ${category} 분야 자료 ${connectedDocs}개 연결 · 목표, 절차, 장비, 안전사항을 함께 점검해 구성합니다.`
                  : "주제를 입력하면 연결된 교범을 기준으로 분야를 자동 추천합니다. 추천 결과는 언제든 바꿀 수 있습니다."}
              </p>
              {categoryConfirmed && connectedDocs === 1 && (
                <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
                  연결 자료가 1개라 해당 교범 범위 안에서만 작성됩니다.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="topic" className="text-sm font-medium">
                자료 주제 <span className="text-destructive">*</span>
              </Label>
              <Input
                id="topic"
                placeholder="예: 공기호흡기 점검 절차"
                value={topic}
                onChange={(event) => handleTopicChange(event.target.value)}
                onBlur={handleTopicBlur}
                maxLength={100}
                aria-invalid={topicError}
                aria-describedby="topic-help category-recommendation-heading"
                className={cn("h-12 text-base md:h-10", topicError && "border-destructive")}
              />
              <p
                id="topic-help"
                className={cn(
                  "text-xs leading-relaxed",
                  topicError ? "font-medium text-destructive" : "text-muted-foreground"
                )}
              >
                {topicError
                  ? "훈련 주제를 두 글자 이상 입력해 주세요."
                  : "한 문장만 적으면 관련 자료를 찾아 교육 흐름까지 구성합니다."}
              </p>
              <div className="flex flex-wrap gap-1.5 pt-1" aria-label="빠른 입력 예시">
                <p className="w-full text-xs font-medium text-muted-foreground">
                  빠른 입력 예시
                </p>
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    aria-pressed={topic === suggestion}
                    onClick={(event) => {
                      // 상위 폼 구조가 바뀌어도 추천 선택이 제출로 이어져 유형·입력값을 초기화하지 않게 한다.
                      event.preventDefault();
                      handleTopicChange(suggestion, true);
                    }}
                    className={cn(
                      "min-h-12 rounded-full border bg-background px-3 text-left text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      topic === suggestion
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    )}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>

            <CategoryRecommendationPanel
              topic={topic}
              status={categoryRecommendation.status}
              category={
                categoryRecommendation.status === "ready"
                  ? categoryRecommendation.category
                  : undefined
              }
              confidence={
                categoryRecommendation.status === "ready"
                  ? categoryRecommendation.confidence
                  : undefined
              }
              source={
                categoryRecommendation.status === "ready"
                  ? categoryRecommendation.source
                  : undefined
              }
              confirmed={categoryConfirmed}
              alternatives={
                categoryRecommendation.status === "ready"
                  ? categoryRecommendation.alternatives
                  : []
              }
              warning={
                categoryRecommendation.status === "ready"
                  ? categoryRecommendation.warning
                  : undefined
              }
              error={
                categoryRecommendation.status === "error"
                  ? categoryRecommendation.message
                  : undefined
              }
              categories={categories}
              pickerOpen={categoryPickerOpen}
              disabled={resultMutationLocked || loading || focusBusy}
              onConfirm={handleCategoryConfirm}
              onTogglePicker={() => setCategoryPickerOpen((open) => !open)}
              onSelect={handleCategorySelect}
              onRetry={() => void requestCategoryRecommendation()}
            />

            {offerTopicFocusSuggestions && (
              <div className="flex flex-col gap-3 rounded-lg border border-primary/20 bg-primary/[0.035] px-3 py-3 text-sm leading-relaxed sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-semibold text-foreground">
                    {broadTopic
                      ? "입력한 주제를 세부 훈련 단위로 나눌 수 있습니다."
                      : "필요하면 이 주제를 한 단계 더 구체화할 수 있습니다."}
                  </p>
                  <p className="mt-0.5 text-muted-foreground">
                    연결 교범을 근거로 실습·평가에 바로 쓸 수 있는 세부 훈련주제를 제안합니다.
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-12 shrink-0 bg-background px-4"
                  disabled={
                    resultMutationLocked ||
                    loading ||
                    jobRunning ||
                    jobRetrying ||
                    pendingJobLookupActive ||
                    categoryBusy ||
                    focusBusy
                  }
                  onClick={() => void requestTrainingFocus({ mode: "refine" })}
                >
                  <Lightbulb className="h-4 w-4" aria-hidden="true" />
                  세부 훈련주제 제안받기
                </Button>
              </div>
            )}

            {(topicFocus.status === "loading" ||
              topicFocus.status === "refreshing" ||
              topicFocus.status === "choosing" ||
              topicFocus.status === "error") && (
              <TopicFocusPanel
                topic={topic.trim()}
                status={topicFocus.status}
                options={"options" in topicFocus ? topicFocus.options : []}
                similarMaterials={
                  "similarMaterials" in topicFocus ? topicFocus.similarMaterials : []
                }
                recommendedId={
                  topicFocus.status === "choosing" || topicFocus.status === "refreshing"
                    ? topicFocus.recommendedId
                    : undefined
                }
                selectedId={
                  topicFocus.status === "choosing" || topicFocus.status === "refreshing"
                    ? topicFocus.selectedId
                    : undefined
                }
                customValue={
                  topicFocus.status === "choosing" || topicFocus.status === "refreshing"
                    ? topicFocus.customValue
                    : ""
                }
                historyCompared={
                  topicFocus.status === "choosing" || topicFocus.status === "refreshing"
                    ? topicFocus.historyCompared
                    : false
                }
                warnings={
                  topicFocus.status === "choosing" || topicFocus.status === "refreshing"
                    ? topicFocus.warnings
                    : []
                }
                error={
                  topicFocus.status === "error"
                    ? topicFocus.message
                    : topicFocus.status === "choosing"
                      ? topicFocus.error
                      : undefined
                }
                selectionError={focusSelectionError || undefined}
                disabled={resultMutationLocked}
                headingRef={focusHeadingRef}
                onSelect={(id) => {
                  setFocusSelectionError("");
                  setTopicFocus((previous) =>
                    previous.status === "choosing"
                      ? { ...previous, selectedId: id, error: undefined }
                      : previous
                  );
                }}
                onCustomValueChange={(value) => {
                  setFocusSelectionError("");
                  setTopicFocus((previous) =>
                    previous.status === "choosing"
                      ? {
                          ...previous,
                          selectedId: "custom",
                          customValue: value,
                          error: undefined,
                        }
                      : previous
                  );
                }}
                onRefresh={() =>
                  void requestTrainingFocus({ refresh: true, mode: "refine" })
                }
                onBypass={() => {
                  if (savingRef.current || regenRequestRef.current) return;
                  setTopicFocus({ status: "bypassed" });
                  void runGeneration();
                }}
              />
            )}

            {topicFocus.status === "resolved" && (
              <div className="flex flex-col gap-2 rounded-lg border border-emerald-300/60 bg-emerald-50/70 px-3 py-2.5 text-sm text-emerald-950 dark:border-emerald-700/50 dark:bg-emerald-950/20 dark:text-emerald-100 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-xs font-medium opacity-80">선택한 세부 훈련 방향</p>
                  <p className="font-semibold">{topicFocus.focus}</p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  className="min-h-12 justify-start px-2 sm:justify-center"
                  disabled={resultMutationLocked}
                  onClick={() => {
                    focusHistoryRef.current.add(topicFocus.focus);
                    void requestTrainingFocus({ refresh: true, mode: "refine" });
                  }}
                >
                  다른 방향 선택
                </Button>
              </div>
            )}
          </section>

          <div className="h-px bg-border/60" />

          {/* STEP 03 — 운영 조건은 추천 분야가 정해진 뒤 보완 */}
          <section
            className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "140ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="03" title="대상 · 시간 · 현장 조건" />
            <OptionGroup
              label="대상"
              options={AUDIENCES}
              value={audience}
              onChange={(value) => {
                setAudience(value);
                setSaved(false);
              }}
            />
            <OptionGroup
              label="교육 시간"
              options={DURATIONS}
              value={duration}
              onChange={(value) => {
                setDuration(value);
                setSaved(false);
                setLocalQualityRevision((revision) => revision + 1);
              }}
            />

            <div className="space-y-1.5">
              <Label htmlFor="conditions" className="text-sm font-medium">
                현장 조건 <span className="font-normal text-muted-foreground">(선택)</span>
              </Label>
              <Textarea
                id="conditions"
                value={conditions}
                onChange={(event) => {
                  setConditions(event.target.value);
                  setSaved(false);
                }}
                maxLength={MAX_GENERATION_CONDITIONS_CHARS}
                rows={3}
                placeholder="예: 참여 12명, 교관 2명, 공기호흡기 6세트, 실내 훈련장"
                aria-describedby="conditions-help"
                className="min-h-24 resize-y text-base md:text-sm"
              />
              <div
                id="conditions-help"
                className="flex items-start justify-between gap-3 text-xs text-muted-foreground"
              >
                <span>인원·보유 장비·장소 제약을 적으면 실제 운영 조건에 맞춰 구성합니다.</span>
                <span className="shrink-0 tabular-nums">
                  {conditions.length}/{MAX_GENERATION_CONDITIONS_CHARS}
                </span>
              </div>
            </div>

            {/* 공문 양식에 필요한 값만 훈련계획에서 선택 입력으로 접어 둔다. */}
            {type === "plan" && (
              <details className="group rounded-md border border-border/70 bg-muted/20">
                <summary className="flex min-h-12 cursor-pointer items-center justify-between gap-3 px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span>문서 정보 (선택)</span>
                  <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
                    훈련 일자 · 장소
                    <ChevronDown
                      className="h-4 w-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </span>
                </summary>
                <div className="grid grid-cols-1 gap-3 border-t border-border/60 p-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="date" className="text-sm font-medium">
                      훈련 일자
                    </Label>
                    <Input
                      id="date"
                      type="date"
                      value={date}
                      onChange={(event) => {
                        setDate(event.target.value);
                        setSaved(false);
                      }}
                      className="h-12 text-base md:h-10"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="place" className="text-sm font-medium">
                      훈련 장소
                    </Label>
                    <Input
                      id="place"
                      placeholder="예: 소방교육훈련센터 훈련탑"
                      value={place}
                      onChange={(event) => {
                        setPlace(event.target.value);
                        setSaved(false);
                      }}
                      maxLength={100}
                      className="h-12 text-base md:h-10"
                    />
                  </div>
                </div>
              </details>
            )}
          </section>

          {/* 생성 바 — 요약 칩 + 분야 색 CTA */}
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span className="font-medium">만들 자료</span>
              <Badge variant="secondary" className="font-normal">
                {typeMeta.label}
              </Badge>
              {categoryConfirmed && category && (
                <Badge variant="secondary" className="gap-1 font-normal">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: accent }} />
                  {category}
                </Badge>
              )}
              {topic.trim() && (
                <Badge variant="secondary" className="max-w-full font-normal">
                  <span className="truncate">{topic.trim()}</span>
                </Badge>
              )}
              {resolvedFocus && (
                <Badge variant="outline" className="max-w-full border-emerald-300 font-normal">
                  <span className="truncate">세부 방향: {resolvedFocus}</span>
                </Badge>
              )}
              <Badge variant="secondary" className="font-normal">
                {audience}
              </Badge>
              <Badge variant="secondary" className="font-normal">
                {duration}
              </Badge>
            </div>
            <Button
              className="h-12 w-full gap-2 text-base font-semibold text-white shadow-sm transition-all duration-200 hover:shadow-md hover:brightness-105 active:scale-[0.99] motion-reduce:transition-none motion-reduce:active:scale-100"
              style={categoryConfirmed ? { backgroundColor: accent } : undefined}
              onClick={handleGenerate}
              disabled={
                loading ||
                jobRunning ||
                jobRetrying ||
                focusBusy ||
                regenLoading !== null ||
                evidenceRepairing ||
                qualityRepairing ||
                saving ||
                pptxLoading ||
                docExporting !== null
              }
            >
              {loading || jobRunning || focusBusy || categoryBusy ? (
                <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Wand2 className="h-5 w-5" />
              )}
              {loading
                ? durableGenerationEnabled && type !== "notebooklm"
                  ? "품질 우선 작업을 등록하는 중…"
                  : "자료를 찾고 초안을 점검하는 중…"
                : jobRunning
                  ? "서버에서 품질 우선 생성 중…"
                : categoryBusy
                  ? "주제에 맞는 분야를 확인하는 중…"
                  : focusBusy
                    ? "세부 훈련 방향을 찾는 중…"
                    : categoryRecommendation.status === "ready" && !categoryConfirmed
                      ? `추천 분야 확인 후 ${typeMeta.label} 만들기`
                      : topicFocus.status === "choosing"
                        ? `선택한 방향으로 ${typeMeta.label} 만들기`
                        : `${typeMeta.label} 만들기`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {((loading && type !== "notebooklm") || showDurableJobStatus) && (
        <ResultSkeleton
          key={activeJob?.id ?? "synchronous-generation"}
          accent={
            activeJob ? categoryStyle(activeJob.request.category).hex : accent
          }
          label={activeJobTypeMeta.label}
          type={timedActiveJobType}
          duration={activeJob?.request.duration ?? duration}
          job={activeJob}
          connectionRetry={jobConnectionRetry}
          verifyingDelivery={pendingJobLookupActive}
          retrying={jobRetrying}
          onRetry={
            activeJob?.status === "failed" || activeJob?.status === "needs_attention"
              ? () => void retryDurableGeneration()
              : undefined
          }
        />
      )}

      {/* 2-a. NotebookLM 프롬프트 결과 */}
      {nlmPrompt && (
        <NotebookLmResult
          prompt={nlmPrompt}
          chrome={chrome}
          copied={copied}
          onCopy={handleCopy}
        />
      )}

      {/* 2-b. 슬라이드 결과 — 표준 양식(분야 색) PPTX로 변환 */}
      {deck && (
        <SlideDeckResult
          deck={deck}
          chrome={chrome}
          regen={makeRegen("slide")}
          quality={quality}
          evidenceRepair={{
            ...evidenceRepair,
            disabled: resultMutationLocked,
          }}
          qualityRepair={{
            ...qualityRepair,
            disabled: resultMutationLocked,
          }}
          onRepairEvidence={() => {
            const currentDeck = deckRef.current;
            if (!currentDeck || !resultContext) return;
            const issueIndices = slideEvidenceIssueIndices(currentDeck, resultContext.duration);
            if (issueIndices.length === 0) {
              setEvidenceRepair({ status: "idle", issueIndices: [] });
              return;
            }
            void repairSlideEvidence(currentDeck, resultContext, issueIndices);
          }}
          onRepairQuality={() => {
            const currentDeck = deckRef.current;
            if (!currentDeck || !resultContext) return;
            const issueIndices = slideSopIssueIndices(currentDeck, resultContext.duration);
            if (issueIndices.length === 0) {
              const hasSopIssues = hasSlideSopQualityIssues(
                currentDeck,
                resultContext.duration
              );
              setQualityRepair({
                status: hasSopIssues ? "failed" : "idle",
                issueIndices: [],
                message: hasSopIssues ? SOP_REPAIR_TARGET_UNAVAILABLE_MESSAGE : undefined,
              });
              return;
            }
            void repairSlideSopQuality(currentDeck, resultContext, issueIndices);
          }}
          onTitleChange={(title) => {
            if (
              savingRef.current ||
              regenRequestRef.current ||
              evidenceRepairRequestRef.current ||
              qualityRepairRequestRef.current ||
              exportBusyRef.current
            ) return;
            setSaved(false);
            setDeck((previous) => (previous ? { ...previous, title } : previous));
            setLocalQualityRevision((revision) => revision + 1);
          }}
          onPatchSlide={patchSlide}
          onPatchBullet={patchBullet}
          onAddSlide={addSlide}
          onDuplicateSlide={duplicateSlide}
          onMoveSlide={moveSlide}
          onDeleteSlide={deleteSlide}
          onDownloadPptx={handlePptx}
          pptxLoading={pptxLoading}
        />
      )}

      {/* 2-c. 생성 문서 결과 */}
      {doc && (
        <DocResult
          doc={doc}
          chrome={chrome}
          regen={makeRegen("section")}
          copied={copied}
          quality={quality}
          onTitleChange={(title) => {
            if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
            setSaved(false);
            setDoc((previous) => (previous ? { ...previous, title } : previous));
            setLocalQualityRevision((revision) => revision + 1);
          }}
          onPatchSection={patchSection}
          onDownloadHwpx={handleHwpx}
          onDownloadDocx={handleDocx}
          onCopy={handleCopy}
          exporting={docExporting}
        />
      )}
    </div>
  );
}
