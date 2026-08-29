"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ChevronDown,
  FileText,
  Loader2,
  MessageSquareText,
  Presentation,
  Wand2,
} from "lucide-react";

import {
  AUDIENCES,
  blockingGenerationQualityIssues,
  DEFAULT_SLIDE_DECK_MODE,
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
  type GenerationQuality,
  type RegenState,
  type ResultChrome,
} from "@/components/generate/parts";
import { DocResult } from "@/components/generate/DocResult";
import { NotebookLmResult } from "@/components/generate/NotebookLmResult";
import { SlideDeckResult } from "@/components/generate/SlideDeckResult";
import { TopicFocusPanel } from "@/components/generate/TopicFocusPanel";
import {
  focusRequestFingerprint,
  isLikelyBroadTrainingTopic,
  type TrainingFocusOption,
} from "@/lib/generate-focus";
import type { SopEvidence } from "@/lib/sop-evidence";

const TOPIC_SUGGESTIONS: Record<string, readonly string[]> = {
  화재: ["공기호흡기 점검과 착용", "고립소방관 구조 절차", "화재현장 인명검색 안전수칙"],
  수난: ["급류구조 안전수칙", "잠수구조 사전 점검", "구명보트 운용과 전복 대응"],
  산악: ["로프 하강과 확보", "들것 결착과 환자 운반", "산악구조 안전관리"],
  일반구조: ["교통사고 구조장비 운용", "문 개방 구조 절차", "중량물 인양 안전수칙"],
  "현장지휘·공통": ["구조현장 지휘체계", "대원 안전관리와 위험성 평가", "현장 통신과 상황보고"],
  화학사고: ["화학사고 초동대응", "보호복 착용과 오염통제", "누출물질 확인과 안전구역 설정"],
};

const DEFAULT_TRAINING_TYPE = "이론 + 현장실습";
const DEFAULT_TRAINING_METHOD = "자체훈련";
const RETRIEVAL_DEGRADED_WARNING = "자료 검색 일부 기능 제한 — 회수 근거 확인 필요";
const MODEL_FALLBACK_WARNING = "정밀 생성 모델 일시 제한 — 빠른 모델로 생성됨";

type TopicFocusState =
  | { status: "idle" }
  | { status: "loading"; options: TrainingFocusOption[] }
  | {
      status: "refreshing";
      options: TrainingFocusOption[];
      warnings: string[];
      selectedId?: string;
      customValue: string;
      historyCompared: boolean;
    }
  | {
      status: "choosing";
      options: TrainingFocusOption[];
      warnings: string[];
      selectedId?: string;
      customValue: string;
      historyCompared: boolean;
      error?: string;
    }
  | { status: "error"; message: string }
  | { status: "resolved"; focus: string }
  | { status: "bypassed" };

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

const SLIDE_MODE_OPTIONS: ReadonlyArray<{
  key: SlideDeckMode;
  label: string;
  description: string;
}> = [
  {
    key: "presenter",
    label: "발표형",
    description: "핵심 문장과 시각 흐름 중심",
  },
  {
    key: "detailed",
    label: "상세형",
    description: "혼자 읽어도 이해되는 설명 중심",
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
    ...messages,
  };
}

export function GenerateForm({
  docsByCategory,
  models = [],
  initialMaterial,
}: {
  docsByCategory: Record<string, string[]>;
  models?: { key: string; label: string; note?: string }[];
  initialMaterial?: SavedMaterial; // 저장본 재편집으로 진입 시 복원할 자료
}) {
  const categories = Object.keys(docsByCategory);
  const hydrated = hydrateMaterial(initialMaterial);
  // 과거 NotebookLM 저장본은 결과만 호환하고, 새 자료 입력은 지원하는 세 유형 중 계획으로 연다.
  const [type, setType] = useState<GenType>(initialGenerationType(initialMaterial?.kind));
  const [category, setCategory] = useState<string>(
    initialMaterial?.category ?? categories[0] ?? ""
  );
  const [audience, setAudience] = useState<Audience>(asAudience(initialMaterial?.audience));
  const [duration, setDuration] = useState<Duration>(asDuration(initialMaterial?.duration));
  const [slideMode, setSlideMode] = useState<SlideDeckMode>(
    resolveSlideDeckMode(hydrated.deck?.mode ?? DEFAULT_SLIDE_DECK_MODE)
  );
  const [topic, setTopic] = useState(initialMaterial?.topic ?? "");
  const [topicError, setTopicError] = useState(false);
  const [topicFocus, setTopicFocus] = useState<TopicFocusState>(
    hydrated.focus
      ? { status: "resolved", focus: hydrated.focus }
      : { status: "idle" }
  );
  const [focusSelectionError, setFocusSelectionError] = useState("");
  const focusHistoryRef = useRef(new Set<string>(hydrated.focus ? [hydrated.focus] : []));
  const focusRequestRef = useRef<AbortController | null>(null);
  const generationRequestRef = useRef<AbortController | null>(null);
  const regenRequestRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const exportBusyRef = useRef(false);
  const resultRevisionRef = useRef(0);
  const generationFingerprintRef = useRef("");
  const focusRequestFingerprintRef = useRef("");
  const activeFocusRequestFingerprintRef = useRef("");
  const focusHeadingRef = useRef<HTMLHeadingElement>(null);
  const [date, setDate] = useState(hydrated.date);
  // 훈련계획 양식(training_plan.hwpx) 전용 폼 입력
  const [place, setPlace] = useState(hydrated.place);
  const [conditions, setConditions] = useState(hydrated.conditions);
  // 자료 제작은 품질 우선 모델을 자동 선택한다. 사용할 수 없을 때만 첫 모델로 폴백한다.
  const model = preferredGenerationModel(models);
  const [loading, setLoading] = useState(false);
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
          category: initialMaterial.category ?? categories[0] ?? "",
          audience: asAudience(initialMaterial.audience),
          duration: asDuration(initialMaterial.duration),
          slideMode: resolveSlideDeckMode(hydrated.deck?.mode ?? DEFAULT_SLIDE_DECK_MODE),
          topic: initialMaterial.topic ?? "",
          focus: hydrated.focus,
          date: hydrated.date,
          place: hydrated.place,
          conditions: hydrated.conditions,
        }
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
  const [localQualityRevision, setLocalQualityRevision] = useState(0);
  const [loadedId, setLoadedId] = useState<number | null>(initialMaterial?.id ?? null); // 재편집 대상 id
  const [loadedRevision, setLoadedRevision] = useState<number | null>(
    initialMaterial ? initialMaterial.revision ?? 1 : null
  );

  const resolvedFocus = topicFocus.status === "resolved" ? topicFocus.focus : "";
  const resultDuration = resultContext?.duration ?? duration;
  const broadTopic = isLikelyBroadTrainingTopic(topic);

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
  // 세부 방향 선택 상태 자체(resolved -> refreshing)는 요청을 무효화하면 안 된다.
  // 폼 조건만 따로 지문화해 실제 입력이 바뀐 경우에만 이전 응답을 폐기한다.
  focusRequestFingerprintRef.current = focusRequestFingerprint(genReq);
  const subtitle = resultContext
    ? `대상: ${resultContext.audience} · 교육 시간: ${resultContext.duration}${resultKind === "plan" && resultContext.date ? ` · ${resultContext.date}` : ""}`
    : "";
  const connectedDocs = docsByCategory[category]?.length ?? 0;
  const suggestions =
    TOPIC_SUGGESTIONS[category] ??
    ([`${category} 핵심 절차`, `${category} 장비 점검`, `${category} 안전수칙`] as const);

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

  useEffect(
    () => () => {
      focusRequestRef.current?.abort();
      generationRequestRef.current?.abort();
      regenRequestRef.current?.abort();
    },
    []
  );

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
      setTopicFocus((current) => {
        if (current.status === "loading") return { status: "idle" };
        if (current.status !== "refreshing") return current;
        if (current.options.length === 0) return { status: "idle" };
        return {
          status: "choosing",
          options: current.options,
          warnings: current.warnings,
          selectedId: current.selectedId,
          customValue: current.customValue,
          historyCompared: current.historyCompared,
        };
      });
    }
  }, [audience, category, conditions, date, duration, place, slideMode, topic, type]);

  function resetTopicFocus() {
    focusRequestRef.current?.abort();
    focusRequestRef.current = null;
    focusHistoryRef.current.clear();
    setTopicFocus({ status: "idle" });
    setFocusSelectionError("");
  }

  // 결과 부분 편집 — 편집 내용은 그대로 다운로드/복사에 반영된다(빌더가 state를 받음).
  function patchSection(
    i: number,
    patch: Partial<GeneratedSection>,
    fromRegeneration = false
  ) {
    if (
      !fromRegeneration &&
      (savingRef.current || regenRequestRef.current || exportBusyRef.current)
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
      (savingRef.current || regenRequestRef.current || exportBusyRef.current)
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
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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

  // AI 부분 재생성 — 섹션/슬라이드 1개만 다시 생성해 해당 부분만 교체한다.
  async function handleRegen(
    kind: "section" | "slide",
    index: number,
    instruction?: string
  ) {
    if (
      savingRef.current ||
      regenRequestRef.current ||
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
    resultRevisionRef.current += 1;
    setCopied(false);
    setEditing(false);
    setRegenIdx(null);
    setRegenLoading(null);
    setSaved(false);
    setQuality(null);
    setLocalQualityRevision(0);
    setResultKind(null);
    setResultContext(null);
    setLoadedId(null); // 새 생성은 저장 안 된 새 결과
    setLoadedRevision(null);
    setDoc(null);
    setDeck(null);
    setNlmPrompt(null);
  }

  async function runGeneration(focus?: string) {
    // 저장 응답이 돌아오기 전에 결과를 교체하면 이전 행 id가 새 결과에 연결될 수 있다.
    // 저장·부분 재생성 중에는 어떤 진입점(자동 통과·우회 버튼 포함)에서도 전체 생성을 시작하지 않는다.
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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
    clearPreviousResult();
    if (safeFocus) {
      focusHistoryRef.current.add(safeFocus);
      setTopicFocus({ status: "resolved", focus: safeFocus });
    } else if (isLikelyBroadTrainingTopic(topic)) {
      setTopicFocus({ status: "bypassed" });
    }

    const requestBody = { ...genReq, focus: safeFocus };

    // NotebookLM 프롬프트는 AI 호출 없이 즉시 조립 — 인덱싱된 자료 목록 포함
    if (type === "notebooklm") {
      generationRequestRef.current?.abort();
      generationRequestRef.current = null;
      setNlmPrompt(buildNotebookLmPrompt(requestBody, docsByCategory[category] ?? []));
      setResultKind("notebooklm");
      setResultContext(requestContext);
      return;
    }

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
      setQuality(json.quality ?? null);
      if (type === "slides") {
        const generatedDeck = json as unknown as GeneratedSlideDeck;
        setDeck({
          ...generatedDeck,
          mode: resolveSlideDeckMode(generatedDeck.mode ?? slideMode),
        });
      } else setDoc(json as unknown as GeneratedDoc);
      setResultKind(type);
      setResultContext(requestContext);
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

  async function requestTrainingFocus(refresh = false) {
    if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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
            warnings: topicFocus.warnings,
            selectedId: topicFocus.selectedId,
            customValue: topicFocus.customValue,
            historyCompared: topicFocus.historyCompared,
          }
        : {
            options: [] as TrainingFocusOption[],
            warnings: [] as string[],
            selectedId: undefined,
            customValue: "",
            historyCompared: false,
          };
    focusRequestRef.current?.abort();
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
        : { status: "loading", options: [] }
    );

    try {
      const response = await fetch("/api/generate/focus", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          category,
          topic: trimmedTopic,
          model,
          excludeFocuses: Array.from(focusHistoryRef.current).slice(-60),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            scope?: "specific" | "broad";
            options?: TrainingFocusOption[];
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
          requestAnimationFrame(() => focusHeadingRef.current?.focus());
          return;
        }
        setTopicFocus({
          status: "error",
          message,
        });
        requestAnimationFrame(() => focusHeadingRef.current?.focus());
        return;
      }
      if (payload?.scope === "specific") {
        setTopicFocus({ status: "bypassed" });
        await runGeneration();
        return;
      }
      const options = Array.isArray(payload?.options) ? payload.options.slice(0, 5) : [];
      if (options.length === 0) {
        const message = "연결 자료 범위에서는 근거가 있는 세부 방향을 찾지 못했습니다.";
        if (restoreResolvedFocus(message)) return;
        setTopicFocus({
          status: "error",
          message,
        });
        requestAnimationFrame(() => focusHeadingRef.current?.focus());
        return;
      }
      options.forEach((option) => focusHistoryRef.current.add(option.title));
      setTopicFocus({
        status: "choosing",
        options,
        warnings: Array.isArray(payload?.warnings) ? payload.warnings : [],
        customValue: "",
        historyCompared:
          payload?.historyBasis === "saved-materials" || payload?.historyBasis === "demo",
      });
      requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        focusHeadingRef.current?.scrollIntoView({
          behavior: reduceMotion ? "auto" : "smooth",
          block: "start",
        });
        focusHeadingRef.current?.focus({ preventScroll: true });
      });
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
        requestAnimationFrame(() => focusHeadingRef.current?.focus());
        return;
      }
      setTopicFocus({
        status: "error",
        message,
      });
      requestAnimationFrame(() => focusHeadingRef.current?.focus());
    } finally {
      if (focusRequestRef.current === controller) {
        focusRequestRef.current = null;
        activeFocusRequestFingerprintRef.current = "";
      }
    }
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
    if (!isLikelyBroadTrainingTopic(trimmedTopic)) {
      await runGeneration();
      return;
    }
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
    await requestTrainingFocus(false);
  }

  // 생성물 저장 — 현재 결과(편집 반영분)를 개인 이력에 저장.
  async function handleSave() {
    if (
      !resultKind ||
      !resultContext ||
      savingRef.current ||
      regenRequestRef.current ||
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
        const err = await res.json().catch(() => null);
        toast.error("저장 실패", { description: err?.error ?? "잠시 후 다시 시도해 주세요." });
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
      regenRequestRef.current
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
        toast.warning("일부 원문 이미지는 기본 도형으로 대신했습니다", {
          id: visualToastId,
          description: `${prepared.resolved}개 반영 · ${prepared.failed}개 대체`,
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
  const focusBusy = topicFocus.status === "loading" || topicFocus.status === "refreshing";
  const resultMutationLocked =
    saving || regenLoading !== null || pptxLoading || docExporting !== null;
  const outputBlocked = (quality?.errors?.length ?? 0) > 0;
  // 선택한 분야 색을 페이지 액센트로 흘린다(상단 바·분야 칩·생성 버튼). hex 인라인으로 동적 적용.
  const accent = categoryStyle(category).hex;
  const resultAccent = categoryStyle(resultContext?.category ?? category).hex;

  // 결과 카드 3종이 공유하는 상단 컨트롤(저장·편집)과 항목별 재생성 상태.
  const chrome: ResultChrome = {
    accent: resultAccent,
    editing,
    onToggleEdit: () => {
      if (saving || regenLoading !== null || pptxLoading || docExporting !== null) return;
      setEditing((v) => !v);
    },
    saving,
    locked: regenLoading !== null || pptxLoading || docExporting !== null,
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

          {/* STEP 02 — 분야·대상·시간 */}
          <section
            className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "70ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="02" title="분야 · 대상 · 시간" />
            {/* 분야 — 선택 시 분야 색으로 강조 */}
            <div className="space-y-2.5">
              <Label className="text-xs font-semibold uppercase text-muted-foreground">
                분야
              </Label>
              <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="분야">
                {categories.map((c) => {
                  const st = categoryStyle(c);
                  const active = category === c;
                  return (
                    <button
                      key={c}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setCategory(c);
                        setSaved(false);
                        resetTopicFocus();
                      }}
                      style={
                        active
                          ? { borderColor: st.hex, color: st.hex, backgroundColor: `${st.hex}14` }
                          : undefined
                      }
                      className={cn(
                        "inline-flex h-12 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-all duration-200 motion-reduce:transition-none md:h-10",
                        "hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
                        active ? "shadow-sm" : "border-border hover:bg-accent/40"
                      )}
                    >
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: st.hex }} />
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>
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
          </section>

          <div className="h-px bg-border/60" />

          {/* STEP 03 — 검색 품질을 좌우하는 주제와 세부 설정 */}
          <section
            className="animate-in fade-in slide-in-from-bottom-2 space-y-3 duration-500 motion-reduce:animate-none"
            style={{ animationDelay: "140ms", animationFillMode: "backwards" }}
          >
            <StepHeader n="03" title="무엇을 훈련할까요" hint="주제는 필수예요" />
            <div
              className="border-l-4 bg-muted/45 px-3 py-2.5"
              style={{ borderLeftColor: accent }}
            >
              <p className="text-sm font-medium">
                주제가 구체적일수록 교범의 정확한 절차를 찾습니다.
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                현재 {category} 분야 자료 {connectedDocs}개 연결 · 목표, 절차, 장비, 안전사항을 함께
                점검해 구성합니다.
              </p>
              {connectedDocs === 1 && (
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
                onChange={(e) => {
                  setTopic(e.target.value);
                  setSaved(false);
                  resetTopicFocus();
                  if (e.target.value.trim().length >= 2) setTopicError(false);
                }}
                maxLength={100}
                aria-invalid={topicError}
                aria-describedby="topic-help"
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
              <div className="flex flex-wrap gap-1.5 pt-1" aria-label="추천 훈련 주제">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    aria-pressed={topic === suggestion}
                    onClick={(event) => {
                      // 상위 폼 구조가 바뀌어도 추천 선택이 제출로 이어져 유형·입력값을 초기화하지 않게 한다.
                      event.preventDefault();
                      setTopic(suggestion);
                      setTopicError(false);
                      setSaved(false);
                      resetTopicFocus();
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

            {broadTopic && topicFocus.status === "idle" && (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50/70 px-3 py-2.5 text-sm leading-relaxed text-amber-900 dark:border-amber-700/50 dark:bg-amber-950/20 dark:text-amber-100">
                <p className="font-semibold">이 주제는 여러 훈련 방향으로 나눌 수 있습니다.</p>
                <p className="mt-0.5">
                  만들기를 누르면 연결 교범에서 세부 방향을 먼저 찾아, 매번 같은 내용이 반복되는
                  가능성을 줄입니다.
                </p>
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
                onRefresh={() => void requestTrainingFocus(true)}
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
                    void requestTrainingFocus(true);
                  }}
                >
                  다른 방향 선택
                </Button>
              </div>
            )}

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
              {category && (
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
              style={category ? { backgroundColor: accent } : undefined}
              onClick={handleGenerate}
              disabled={
                loading ||
                focusBusy ||
                regenLoading !== null ||
                saving ||
                pptxLoading ||
                docExporting !== null ||
                !category
              }
            >
              {loading || focusBusy ? (
                <Loader2 className="h-5 w-5 animate-spin motion-reduce:animate-none" />
              ) : (
                <Wand2 className="h-5 w-5" />
              )}
              {loading
                ? "자료를 찾고 초안을 점검하는 중…"
                : focusBusy
                  ? "세부 훈련 방향을 찾는 중…"
                  : topicFocus.status === "choosing"
                    ? `선택한 방향으로 ${typeMeta.label} 만들기`
                    : `${typeMeta.label} 만들기`}
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading && <ResultSkeleton accent={accent} label={typeMeta.label} />}

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
          onTitleChange={(title) => {
            if (savingRef.current || regenRequestRef.current || exportBusyRef.current) return;
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
