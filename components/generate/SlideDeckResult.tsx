"use client";

// 슬라이드(PPTX) 결과 카드 — 16:9 미리보기 · 항목 편집 · 항목별 AI 재생성 · PPTX 다운로드.
import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Download,
  FileImage,
  ImageOff,
  LayoutTemplate,
  Loader2,
  Maximize2,
  Plus,
  Presentation,
  Scissors,
  Trash2,
  X,
} from "lucide-react";

import type {
  GeneratedDocSource,
  GeneratedSlide,
  GeneratedSlideDeck,
  SlideCompositionType,
  SlideLayoutType,
} from "@/lib/generate";
import { generatedPptxSlideCount } from "@/lib/pptx-plan";
import { buildSlideLayoutPlan, inspectSlideDeckLayout, type SlideTextMeasurer } from "@/lib/slide-layout";
import { validSlideDiagram } from "@/lib/slide-diagram";
import { planSlideSplit } from "@/lib/slide-split";
import { SOURCE_VISUAL_FOCUS, SOURCE_VISUAL_FOCUS_LABELS, validSourceVisualFocus } from "@/lib/source-visual-focus";
import { editableDiagramKind, SlideDiagramEditor, SlideDiagramReadable } from "@/components/generate/SlideDiagramEditor";
import { SlideLayoutIssues, slideIssueLocation } from "@/components/generate/SlideLayoutIssues";
import { SlidePlanPreview as SlidePreview } from "@/components/generate/SlidePlanPreview";
import {
  fallbackSlideVisualMode,
  generatedSourceLabel,
  normalizedSourceLabelKey,
  resolveSlideDeckMode,
} from "@/lib/generate";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AccentBar,
  EditToggleButton,
  QualityBanner,
  RegenControls,
  SaveButton,
  SourceBadges,
  type RegenState,
  type EvidenceRepairState,
  type GenerationQuality,
  type QualityRepairState,
  type ResultChrome,
} from "@/components/generate/parts";

type SlideVisualKind = "source" | "diagram" | "content";

const SOURCE_VISUAL_UNSELECTED_VALUE = "__source_visual_unselected__";

export function slideVisualKind(slide: GeneratedSlide): SlideVisualKind {
  if (slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop") {
    return "source";
  }
  if (editableDiagramKind(slide.composition)) return validSlideDiagram(slide) ? "diagram" : "content";
  if (
    slide.visual?.mode === "native-diagram" ||
    slide.composition === "process" ||
    slide.composition === "comparison" ||
    slide.composition === "timeline" ||
    slide.composition === "decision-flow" ||
    slide.composition === "checklist"
  ) {
    return "diagram";
  }
  return "content";
}

export function slideVisualSummary(slides: readonly GeneratedSlide[]) {
  return slides.reduce(
    (summary, slide) => {
      summary[slideVisualKind(slide)] += 1;
      return summary;
    },
    { source: 0, diagram: 0, content: 0 }
  );
}

export type VerifiedSlideVisualCandidate = {
  label: string;
  documentId: number;
  page: number;
  documentTitle: string;
};

/** 사용자가 임의 ID를 입력하지 않도록 현재 장의 검증된 근거 교집합만 반환한다. */
export function verifiedSlideVisualCandidates(
  slide: GeneratedSlide,
  sources: readonly GeneratedDocSource[]
): VerifiedSlideVisualCandidate[] {
  const candidatesByLabel = new Map<string, Map<string, VerifiedSlideVisualCandidate>>();
  for (const source of sources) {
    if (
      !Number.isSafeInteger(source.document_id) ||
      source.document_id <= 0 ||
      source.page == null ||
      !Number.isSafeInteger(source.page) ||
      source.page <= 0 ||
      !source.doc.trim()
    ) {
      continue;
    }
    const label = generatedSourceLabel(source);
    const labelKey = normalizedSourceLabelKey(label);
    const identity = `${source.document_id}:${source.page}`;
    const byIdentity = candidatesByLabel.get(labelKey) ?? new Map();
    byIdentity.set(identity, {
      label,
      documentId: source.document_id,
      page: source.page,
      documentTitle: source.doc.trim(),
    });
    candidatesByLabel.set(labelKey, byIdentity);
  }

  const result: VerifiedSlideVisualCandidate[] = [];
  const used = new Set<string>();
  for (const rawRef of slide.sourceRefs ?? []) {
    const label = normalizedSourceLabelKey(rawRef);
    const byIdentity = candidatesByLabel.get(label);
    if (!byIdentity || byIdentity.size !== 1) continue;
    const candidate = byIdentity.values().next().value;
    if (!candidate) continue;
    const identity = `${candidate.documentId}:${candidate.page}`;
    if (used.has(identity)) continue;
    used.add(identity);
    result.push(candidate);
  }
  return result.slice(0, 4);
}

/** 서버가 덱에 보관한 출처 라벨 중 수동 선택에 안전한 형식만 노출한다. */
export function verifiedDeckSourceLabels(labels: readonly string[] | undefined): string[] {
  const unique = new Map<string, string>();
  for (const rawLabel of labels ?? []) {
    const label = rawLabel.trim();
    if (
      label.length < 4 ||
      label.length > 300 ||
      !label.startsWith("[") ||
      !label.endsWith("]") ||
      /[\r\n]/.test(label)
    ) {
      continue;
    }
    const key = normalizedSourceLabelKey(label);
    if (!unique.has(key)) unique.set(key, label);
    if (unique.size >= 80) break;
  }
  return Array.from(unique.values());
}

/** 과거 저장본처럼 layout이 없는 경우에도 미리보기의 의미 구조를 유지한다. */
export function resolvePreviewLayout(slide: GeneratedSlide): SlideLayoutType {
  // 새 저장본은 composition이 실제 PPTX 배치를 결정하므로 과거 호환용 layout보다 우선한다.
  if (slide.composition) {
    switch (slide.composition) {
      case "process":
      case "timeline":
      case "decision-flow":
        return "process";
      case "checklist":
        return slide.layout === "equipment" ? "equipment" : "safety";
      case "scenario":
        return "case";
      case "summary":
        return "summary";
      default:
        return "concept";
    }
  }
  if (slide.layout) return slide.layout;

  const title = slide.title.replace(/\s+/g, "");
  if (/(학습|교육|훈련)?목표/.test(title)) return "objectives";
  if ((slide.steps ?? []).filter(Boolean).length >= 2) return "process";
  if (/(장비|준비|점검|확인|체크)/.test(title)) return "equipment";
  if (/(안전|주의|금지)/.test(title)) return "safety";
  if (/(사례|상황|시나리오|현장대응)/.test(title)) return "case";
  if (/(핵심요약|요약|정리|마무리)/.test(title)) return "summary";
  return "concept";
}

function SlideEvidence({ slide }: { slide: GeneratedSlide }) {
  const visualSource = visualSourceLabel(slide);
  return (
    <>
      {slide.sourceRefs && slide.sourceRefs.length > 0 && (
        <p className="break-words border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground/70">근거</span>{" "}
          {slide.sourceRefs.join(" · ")}
        </p>
      )}
      {visualSource && (
        <p className="break-words border-t px-3 py-2 text-xs leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground/70">시각자료 출처</span>{" "}
          {visualSource}
        </p>
      )}
      {slide.notes && (
        <details className="border-t px-3 py-2 text-sm text-muted-foreground">
          <summary className="flex min-h-11 cursor-pointer items-center font-medium text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
            발표자 노트 보기
          </summary>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{slide.notes}</p>
        </details>
      )}
    </>
  );
}

/** 썸네일은 구성 확인용이고, 실제 문장 검토는 모바일에서도 16px 이상으로 모두 보여 준다. */
function SlideReadableContent({ slide, accent }: { slide: GeneratedSlide; accent: string }) {
  if (validSlideDiagram(slide)) return <div className="border-t px-3 py-3"><SlideDiagramReadable slide={slide} /></div>;
  const steps = (slide.steps ?? []).filter(Boolean);
  return (
    <div className="space-y-3 border-t px-3 py-3">
      {steps.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="절차 단계">
          {steps.map((step, index) => (
            <span key={index} className="flex items-center gap-1.5 text-base font-medium">
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ backgroundColor: accent }}
              >
                {index + 1}
              </span>
              {step}
            </span>
          ))}
        </div>
      )}
      <div>
        <p className="mb-1.5 text-xs font-semibold text-muted-foreground">핵심 내용</p>
        <ul className="list-disc space-y-1.5 pl-5 text-base leading-relaxed text-foreground/85">
          {slide.bullets.map((bullet, index) => (
            <li key={index}>{bullet}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const COMPOSITION_LABELS: Record<NonNullable<GeneratedSlide["composition"]>, string> = {
  statement: "핵심 메시지",
  list: "내용 중심",
  process: "절차 흐름",
  comparison: "비교",
  timeline: "시간 흐름",
  "decision-flow": "판단 흐름",
  checklist: "점검표",
  scenario: "상황 사례",
  "visual-explanation": "원문 자료 + 설명",
  summary: "핵심 정리",
};

const COMPOSITION_OPTIONS = Object.entries(COMPOSITION_LABELS) as Array<
  [SlideCompositionType, string]
>;

function compositionFromLegacy(slide: GeneratedSlide): SlideCompositionType {
  if (slide.composition) return slide.composition;
  switch (resolvePreviewLayout(slide)) {
    case "objectives":
      return "list";
    case "process":
      return "process";
    case "equipment":
    case "safety":
      return "checklist";
    case "case":
      return "scenario";
    case "summary":
      return "summary";
    default:
      return "statement";
  }
}

/** 새 composition을 실제 출력에 적용하면서 과거 저장본용 layout도 함께 맞춘다. */
function legacyLayoutForComposition(
  composition: SlideCompositionType,
  current: SlideLayoutType | undefined
): SlideLayoutType {
  switch (composition) {
    case "process":
    case "timeline":
    case "decision-flow":
      return "process";
    case "checklist":
      return current === "equipment" ? "equipment" : "safety";
    case "scenario":
      return "case";
    case "summary":
      return "summary";
    default:
      return "concept";
  }
}

function fillSlideItems(
  current: readonly string[] | undefined,
  minimum: number,
  fallbacks: readonly string[]
): string[] {
  const items = [...(current ?? [])];
  while (items.length < minimum) {
    items.push(fallbacks[items.length] ?? `항목 ${items.length + 1}`);
  }
  return items;
}

/** 구성을 바꾼 직후에도 해당 레이아웃이 깨지지 않도록 최소 문장·단계와 시각자료를 맞춘다. */
export function normalizedCompositionPatch(
  slide: GeneratedSlide,
  composition: SlideCompositionType,
  sourceCandidate?: VerifiedSlideVisualCandidate
): Partial<GeneratedSlide> {
  if (composition === "visual-explanation") {
    if (!sourceCandidate) {
      // 검증된 원문이 없으면 저장을 막는 불완전한 visual-explanation 상태를 만들지 않는다.
      return {};
    }
    return {
      composition,
      layout: "concept",
      ...(slide.composition !== composition ? { diagram: undefined } : {}),
      visual: {
        mode: "source-page",
        documentId: sourceCandidate.documentId,
        page: sourceCandidate.page,
        sourceRef: sourceCandidate.label,
        altText: `${sourceCandidate.documentTitle} ${sourceCandidate.page}쪽 원문 페이지`,
        caption: sourceCandidate.label,
        fit: "contain",
        sourceFocus: slide.visual?.documentId === sourceCandidate.documentId && slide.visual?.page === sourceCandidate.page
          ? validSourceVisualFocus(slide.visual.sourceFocus) : undefined,
      },
    };
  }

  const layout = legacyLayoutForComposition(composition, slide.layout);
  let bullets = fillSlideItems(slide.bullets, 1, ["핵심 내용을 입력해 주세요."]);
  let steps = [...(slide.steps ?? [])];

  if (composition === "comparison") {
    bullets = fillSlideItems(
      bullets,
      2,
      ["첫 번째 비교 내용을 입력해 주세요.", "두 번째 비교 내용을 입력해 주세요."]
    );
    steps = fillSlideItems(steps, 2, ["비교 기준 1", "비교 기준 2"]);
  } else if (composition === "process") {
    steps = fillSlideItems(steps, 3, ["준비", "수행", "확인"]);
  } else if (composition === "decision-flow") {
    bullets = fillSlideItems(
      bullets,
      2,
      ["판단 조건을 입력해 주세요.", "조건별 조치를 입력해 주세요."]
    );
    steps = fillSlideItems(steps, 3, ["판단 조건", "조건 충족", "조건 불충족"]);
  } else if (composition === "timeline") {
    steps = fillSlideItems(steps, 3, ["초기", "진행", "완료"]);
  }

  const patch: Partial<GeneratedSlide> = {
    composition,
    layout,
    bullets,
    steps: steps.length > 0 ? steps : undefined,
    ...(slide.composition !== composition || JSON.stringify(slide.steps ?? []) !== JSON.stringify(steps) || JSON.stringify(slide.bullets) !== JSON.stringify(bullets)
      ? { diagram: undefined } : {}),
  };
  const isSourceVisual =
    slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop";
  if (isSourceVisual) {
    patch.visual = {
      mode: fallbackSlideVisualMode({ ...slide, composition, layout }),
    };
  }
  return patch;
}

/** 근거 체크와 원문 페이지 메타데이터를 한 번에 맞춰 화면·저장·PPTX 상태를 동일하게 한다. */
export function normalizedSourceRefsPatch(
  slide: GeneratedSlide,
  sourceRefs: readonly string[],
  sources: readonly GeneratedDocSource[]
): Partial<GeneratedSlide> {
  const refs = Array.from(
    new Map(
      sourceRefs
        .map((label) => label.trim())
        .filter(Boolean)
        .map((label) => [normalizedSourceLabelKey(label), label] as const)
    ).values()
  ).slice(0, 4);
  const isSourceVisual =
    slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop";
  if (!isSourceVisual) return { sourceRefs: refs };

  const candidates = verifiedSlideVisualCandidates({ ...slide, sourceRefs: refs }, sources);
  const current = candidates.find(
    (candidate) =>
      candidate.documentId === slide.visual?.documentId &&
      candidate.page === slide.visual?.page
  );
  const selected = current ?? candidates[0];
  if (selected) {
    return {
      sourceRefs: refs,
      ...normalizedCompositionPatch(
        { ...slide, sourceRefs: refs },
        "visual-explanation",
        selected
      ),
    };
  }

  return {
    sourceRefs: refs,
    ...normalizedCompositionPatch({ ...slide, sourceRefs: refs }, "list"),
  };
}

function minimumBulletCount(slide: GeneratedSlide): number {
  const composition = compositionFromLegacy(slide);
  return composition === "comparison" || composition === "decision-flow" ? 2 : 1;
}

function visualSourceLabel(slide: GeneratedSlide): string | null {
  const visual = slide.visual;
  if (!visual || (visual.mode !== "source-page" && visual.mode !== "source-crop")) return null;
  if (visual.sourceRef) return visual.sourceRef;
  if (visual.documentId && visual.page) return `자료 #${visual.documentId} · p.${visual.page}`;
  if (visual.page) return `원본 자료 p.${visual.page}`;
  return "원본 자료";
}

/** 원본 근거 이미지와 기본 도형을 구분해 보여 주는 안전한 시각자료 슬롯. */
function SlideVisualSlot({ slide }: { slide: GeneratedSlide }) {
  const visual = slide.visual;
  const mode = visual?.mode ?? "none";
  const isSource = mode === "source-page" || mode === "source-crop";
  const hasPreview = isSource && Boolean(visual?.imageData?.startsWith("data:image/"));
  const sourceLabel = visualSourceLabel(slide);
  const composition = slide.composition ? COMPOSITION_LABELS[slide.composition] : null;
  const needsDiagram = Boolean(editableDiagramKind(slide.composition)) && !validSlideDiagram(slide);

  const status = hasPreview
    ? "미리보기 준비"
    : isSource
      ? "그림 확인 전"
      : needsDiagram ? "연결 확인 전"
        : mode === "native-diagram"
        ? "도형 구성"
        : "사용 안 함";

  return (
    <section
      className="space-y-3 rounded-lg border border-border/70 bg-muted/20 p-3"
      aria-label="선택한 슬라이드 시각자료"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground shadow-sm">
            {isSource ? (
              <FileImage className="h-5 w-5" aria-hidden="true" />
            ) : mode === "native-diagram" ? (
              <LayoutTemplate className="h-5 w-5" aria-hidden="true" />
            ) : (
              <ImageOff className="h-5 w-5" aria-hidden="true" />
            )}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">시각자료</h3>
            <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
              {isSource
                ? hasPreview ? "확인한 원문 그림을 표시합니다." : "연결된 페이지의 그림은 사전 확인 후 표시됩니다."
                : needsDiagram ? "도식 연결을 확인하기 전에는 입력한 내용을 일반 배치로 보여 줍니다."
                  : mode === "native-diagram"
                  ? "내용을 PPT 기본 도형으로 안전하게 표현합니다."
                  : "이 장에는 원본 이미지나 별도 도형을 사용하지 않습니다."}
            </p>
          </div>
        </div>
        <span className="rounded-full border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground">
          {status}
        </span>
      </div>

      {hasPreview && visual?.imageData && (
        <div className="relative aspect-video overflow-hidden rounded-md border bg-background">
          <Image
            src={visual.imageData}
            alt={visual.altText || "원본 교육자료 시각자료"}
            fill
            unoptimized
            sizes="(max-width: 1024px) 100vw, 50vw"
            className={visual.fit === "cover" ? "object-cover" : "object-contain"}
          />
        </div>
      )}

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        {composition && (
          <div className="rounded-md bg-background px-3 py-2">
            <dt className="text-xs font-medium text-muted-foreground">화면 구성</dt>
            <dd className="mt-0.5 font-medium">{composition}</dd>
          </div>
        )}
        {sourceLabel && (
          <div className="rounded-md bg-background px-3 py-2">
            <dt className="text-xs font-medium text-muted-foreground">이미지 출처</dt>
            <dd className="mt-0.5 break-words font-medium">{sourceLabel}</dd>
          </div>
        )}
      </dl>

      {visual?.caption && (
        <p className="border-l-2 border-primary/60 pl-3 text-sm leading-relaxed">
          {visual.caption}
        </p>
      )}
      {visual?.altText && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground/70">대체 설명</span> {visual.altText}
        </p>
      )}
    </section>
  );
}

export function SlideDeckResult({
  deck,
  chrome,
  regen,
  onTitleChange,
  onPatchSlide,
  onAddSlide,
  onDuplicateSlide,
  onReplaceSlideRange,
  onMoveSlide,
  onDeleteSlide,
  onDownloadPptx,
  pptxLoading,
  quality,
  evidenceRepair,
  onRepairEvidence,
  qualityRepair,
  onRepairQuality,
}: {
  deck: GeneratedSlideDeck;
  chrome: ResultChrome;
  regen: RegenState;
  onTitleChange: (title: string) => void;
  onPatchSlide: (index: number, patch: Partial<GeneratedSlide>) => void;
  onPatchBullet: (slideIndex: number, bulletIndex: number, value: string) => void;
  onAddSlide: (afterIndex: number) => void;
  onDuplicateSlide: (index: number) => void;
  onReplaceSlideRange?: (index: number, expected: readonly GeneratedSlide[], replacement: readonly GeneratedSlide[]) => void;
  onMoveSlide: (index: number, direction: -1 | 1) => void;
  onDeleteSlide: (index: number) => void;
  onDownloadPptx: () => void;
  pptxLoading: boolean;
  quality?: GenerationQuality | null;
  evidenceRepair?: EvidenceRepairState & { disabled?: boolean };
  onRepairEvidence?: () => void;
  qualityRepair?: QualityRepairState & { disabled?: boolean };
  onRepairQuality?: () => void;
}) {
  const { accent, editing } = chrome;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const expandTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sourcePreviewRequestRef = useRef(0);
  const [sourcePreview, setSourcePreview] = useState<{
    key: string; status: "loading" | "ready" | "fallback" | "error";
    slide?: GeneratedSlide; message: string;
  } | null>(null);
  useEffect(() => () => { sourcePreviewRequestRef.current += 1; }, []);
  const [announcement, setAnnouncement] = useState("");
  const [lastSplit, setLastSplit] = useState<{ index: number; original: GeneratedSlide; parts: [GeneratedSlide, GeneratedSlide] } | null>(null);
  const pendingIssueFocusRef = useRef<{ index: number | null; fieldId?: string } | null>(null);
  const [textMeasurer, setTextMeasurer] = useState<SlideTextMeasurer | undefined>();
  const [fontCheckFailed, setFontCheckFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void import("@/lib/slide-text-browser").then(({ prepareSlideTextMeasurer }) => prepareSlideTextMeasurer())
      .then((measureText) => { if (active) setTextMeasurer(() => measureText); })
      .catch(() => { if (active) setFontCheckFailed(true); });
    return () => { active = false; };
  }, []);
  const selectedSlide = deck.slides[selectedIndex];
  const splitPlan = selectedSlide ? planSlideSplit(selectedSlide, deck.slides.length) : null;
  const splitCanUndo = lastSplit !== null && JSON.stringify(deck.slides.slice(lastSplit.index, lastSplit.index + 2)) === JSON.stringify(lastSplit.parts);
  const selectedVisualCandidates = selectedSlide
    ? verifiedSlideVisualCandidates(selectedSlide, deck.sources)
    : [];
  const selectedVisualCandidate = selectedVisualCandidates.find(
    (candidate) =>
      Boolean(selectedSlide?.visual?.sourceRef) &&
      normalizedSourceLabelKey(candidate.label) ===
        normalizedSourceLabelKey(selectedSlide?.visual?.sourceRef ?? "") &&
      candidate.documentId === selectedSlide?.visual?.documentId &&
      candidate.page === selectedSlide?.visual?.page
  );
  const verifiedSourceLabels = verifiedDeckSourceLabels(deck.sourceLabels);
  const verifiedSourceLabelByKey = new Map(
    verifiedSourceLabels.map((label) => [normalizedSourceLabelKey(label), label] as const)
  );
  const selectedVerifiedSourceRefs = Array.from(
    new Set(
      (selectedSlide?.sourceRefs ?? [])
        .map((label) => verifiedSourceLabelByKey.get(normalizedSourceLabelKey(label)))
        .filter((label): label is string => Boolean(label))
    )
  ).slice(0, 4);
  const invalidSourceRefs = Array.from(
    new Set(
      (selectedSlide?.sourceRefs ?? [])
        .map((label) => label.trim())
        .filter(
          (label) => label && !verifiedSourceLabelByKey.has(normalizedSourceLabelKey(label))
        )
    )
  );
  const evidenceIssueSet = new Set(evidenceRepair?.issueIndices ?? []);
  const qualityIssueSet = new Set(qualityRepair?.issueIndices ?? []);
  const mode = resolveSlideDeckMode(deck.mode);
  const previewKey = (slide: GeneratedSlide) => JSON.stringify([slide, deck.sources]);
  const preparedSlide = (slide: GeneratedSlide) => sourcePreview?.key === previewKey(slide) && sourcePreview.slide ? sourcePreview.slide : slide;
  const layoutReport = useMemo(() => inspectSlideDeckLayout({
    ...deck,
    slides: deck.slides.map((slide) => sourcePreview?.key === JSON.stringify([slide, deck.sources]) && sourcePreview.slide ? sourcePreview.slide : slide),
  }, textMeasurer ? { measureText: textMeasurer } : undefined), [deck, sourcePreview, textMeasurer]);
  const layoutIssueSet = new Set(layoutReport.issues.flatMap((issue) => {
    const location = slideIssueLocation(issue.path);
    return location.slideIndex === null ? [] : [location.slideIndex];
  }));
  const visualSummary = slideVisualSummary(deck.slides.map(preparedSlide));
  const layoutCounts = new Map<string, number>();
  const layoutOccurrences = deck.slides.map((slide) => {
    const layout = buildSlideLayoutPlan(preparedSlide(slide), mode).layout;
    const count = layoutCounts.get(layout) ?? 0;
    layoutCounts.set(layout, count + 1);
    return count;
  });
  const expandedSlide = expandedIndex !== null ? deck.slides[expandedIndex] : undefined;

  async function handlePreviewSource(index: number, selected?: GeneratedSlide) {
    const slide = selected ?? deck.slides[index];
    if (!slide || slideVisualKind(slide) !== "source") return;
    const key = previewKey(slide);
    const request = ++sourcePreviewRequestRef.current;
    setSourcePreview({ key, status: "loading", message: "원문 그림을 확인하고 있습니다…" });
    try {
      const { prepareDeckSourceVisuals } = await import("@/lib/source-visuals");
      const prepared = await prepareDeckSourceVisuals({ ...deck, slides: [slide] });
      if (request !== sourcePreviewRequestRef.current) return;
      const next = prepared.deck.slides[0];
      setSourcePreview({
        key, slide: next, status: prepared.resolved > 0 ? "ready" : "fallback",
        message: prepared.resolved > 0
          ? `원문 그림 확인 완료 · ${next.visual?.sourceRef ?? "연결된 페이지"}${next.visual?.sourceFocus ? ` · ${SOURCE_VISUAL_FOCUS_LABELS[next.visual.sourceFocus]} 확대` : ""}`
          : prepared.fallbacks.some((fallback) => fallback.reason === "text-only-page")
            ? "그림이 없는 텍스트 위주 페이지입니다. 다운로드에서도 아래 내용 구도로 대체합니다."
            : "원문 그림을 가져오지 못해 현재는 아래 내용 구도로 표시합니다. 다운로드할 때 다시 확인합니다.",
      });
    } catch {
      if (request !== sourcePreviewRequestRef.current) return;
      setSourcePreview({ key, status: "error", message: "원문 그림 확인에 실패했습니다. 잠시 후 다시 확인해 주세요." });
    }
  }

  function sourcePreviewControl(slide: GeneratedSlide, index: number) {
    if (slideVisualKind(slide) !== "source") return null;
    const current = sourcePreview?.key === previewKey(slide) ? sourcePreview : null;
    return (
      <div className="space-y-2">
        <Button type="button" variant="outline" className="min-h-12 w-full gap-2" disabled={current?.status === "loading" || editorLocked} onClick={() => void handlePreviewSource(index)}>
          {current?.status === "loading" ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FileImage className="h-4 w-4" aria-hidden="true" />}
          {current?.status === "loading" ? "원문 그림 확인 중…" : current ? "원문 그림 다시 확인" : "원문 그림 미리 확인"}
        </Button>
        <p role="status" className="text-sm leading-relaxed text-muted-foreground">{current?.message ?? "실제 원문 그림과 대체 여부를 다운로드 전에 확인합니다."}</p>
        {current?.slide?.visual?.sourcePageImageData && (
          <details className="rounded-md border bg-background p-3">
            <summary className="min-h-12 cursor-pointer py-3 text-base font-medium">전체 원문과 확대 범위 확인</summary>
            <p className="mb-3 text-sm leading-relaxed text-muted-foreground">
              {SOURCE_VISUAL_FOCUS_LABELS[current.slide.visual.sourceFocus!]}을 확대했습니다. 그림의 설명이나 주의사항이 범위 밖에 있으면 전체 페이지로 되돌려 주세요. PPT에도 전체 페이지를 함께 넣습니다.
            </p>
            <Image src={current.slide.visual.sourcePageImageData} alt={`${current.slide.visual.sourceRef ?? "원문"} 전체 페이지`}
              width={900} height={1200} unoptimized className="h-auto w-full object-contain" />
          </details>
        )}
      </div>
    );
  }
  const downloadSlideCount = generatedPptxSlideCount(deck.slides.length, deck.sources);
  const editorLocked =
    chrome.saving || Boolean(chrome.locked) || regen.loadingIndex !== null || pptxLoading;
  const outputBlocked = Boolean(chrome.outputBlocked);
  const statusMessage = pptxLoading
    ? "PPTX 파일을 준비하고 있습니다."
    : chrome.saving
      ? "자료를 저장하고 있습니다."
      : regen.loadingIndex !== null
        ? `슬라이드 ${regen.loadingIndex + 1}을 다시 생성하고 있습니다.`
        : announcement;

  useEffect(() => {
    setSelectedIndex((current) =>
      Math.min(Math.max(current, 0), Math.max(deck.slides.length - 1, 0))
    );
  }, [deck.slides.length]);

  useEffect(() => {
    const target = pendingIssueFocusRef.current;
    if (!editing || target === null || (target.index !== null && selectedIndex !== target.index)) return;
    pendingIssueFocusRef.current = null;
    requestAnimationFrame(() => {
      focusIssueField(target.fieldId);
    });
  }, [editing, selectedIndex]);

  function focusIssueField(fieldId?: string) {
    const target = document.getElementById(fieldId ?? "selected-slide-heading");
    const details = target?.querySelector("details");
    if (details) details.open = true;
    target?.scrollIntoView({ block: "center" });
    if (details) details.querySelector("summary")?.focus();
    else target?.focus();
  }

  function handleSelectIssueSlide(index: number) {
    if (index < 0 || index >= deck.slides.length || editorLocked) return;
    pendingIssueFocusRef.current = { index };
    setSelectedIndex(index);
    regen.onClose();
    setAnnouncement(`품질 확인이 필요한 슬라이드 ${index + 1}을 선택했습니다.`);
    if (!editing) {
      chrome.onToggleEdit();
      return;
    }
    requestAnimationFrame(() => {
      pendingIssueFocusRef.current = null;
      document.getElementById("selected-slide-heading")?.focus();
    });
  }

  function handleSelectLayoutIssue(path: string) {
    if (editorLocked) return;
    const location = slideIssueLocation(path);
    if (location.slideIndex !== null && (location.slideIndex < 0 || location.slideIndex >= deck.slides.length)) return;
    pendingIssueFocusRef.current = { index: location.slideIndex, fieldId: location.fieldId };
    if (location.slideIndex !== null) setSelectedIndex(location.slideIndex);
    regen.onClose();
    setAnnouncement(`${location.label} 수정 위치를 선택했습니다.`);
    if (!editing) {
      chrome.onToggleEdit();
      return;
    }
    requestAnimationFrame(() => {
      pendingIssueFocusRef.current = null;
      focusIssueField(location.fieldId);
    });
  }

  function handleMoveSelected(direction: -1 | 1) {
    const target = selectedIndex + direction;
    if (editorLocked || target < 0 || target >= deck.slides.length) return;
    onMoveSlide(selectedIndex, direction);
    setSelectedIndex(target);
    setAnnouncement(`슬라이드를 ${target + 1}번으로 이동했습니다.`);
  }

  function handleAddAfterSelected() {
    if (editorLocked || deck.slides.length >= 20) return;
    onAddSlide(selectedIndex);
    setSelectedIndex(selectedIndex + 1);
    setAnnouncement(`새 슬라이드를 ${selectedIndex + 2}번에 추가하고 선택했습니다.`);
  }

  function handleDuplicateSelected() {
    if (editorLocked || !selectedSlide || deck.slides.length >= 20) return;
    onDuplicateSlide(selectedIndex);
    setSelectedIndex(selectedIndex + 1);
    setAnnouncement(`슬라이드 ${selectedIndex + 1}을 복제해 ${selectedIndex + 2}번에 추가했습니다.`);
  }

  function handleSplitSelected() {
    if (editorLocked || !selectedSlide || !splitPlan?.ok || !onReplaceSlideRange) return;
    onReplaceSlideRange(selectedIndex, [selectedSlide], splitPlan.slides);
    setLastSplit({ index: selectedIndex, original: selectedSlide, parts: splitPlan.slides });
    setAnnouncement(`슬라이드 ${selectedIndex + 1}을 두 장으로 나눴습니다. 문장·발표자 노트·출처를 유지했습니다. 나눈 장을 수정하기 전에는 되돌릴 수 있습니다.`);
  }

  function handleUndoSplit() {
    if (editorLocked || !lastSplit || !splitCanUndo || !onReplaceSlideRange) return;
    onReplaceSlideRange(lastSplit.index, lastSplit.parts, [lastSplit.original]);
    setSelectedIndex(lastSplit.index);
    setLastSplit(null);
    setAnnouncement("장 나누기를 되돌렸습니다. 다른 장의 수정 내용은 유지됩니다.");
  }

  function confirmDelete() {
    if (editorLocked || pendingDelete === null || deck.slides.length <= 1) return;
    const deletedNumber = pendingDelete + 1;
    const nextIndex = Math.min(pendingDelete, deck.slides.length - 2);
    onDeleteSlide(pendingDelete);
    setSelectedIndex(nextIndex);
    setPendingDelete(null);
    setAnnouncement(`슬라이드 ${deletedNumber}를 삭제했습니다. 현재 ${nextIndex + 1}번 슬라이드입니다.`);
  }

  function handleAddBullet() {
    if (!selectedSlide || editorLocked || selectedSlide.bullets.length >= 4) return;
    onPatchSlide(selectedIndex, {
      bullets: [...selectedSlide.bullets, "핵심 내용을 입력해 주세요."],
      diagram: undefined,
    });
    setAnnouncement(`슬라이드 ${selectedIndex + 1}에 핵심 문장을 추가했습니다.`);
  }

  function handleDeleteBullet(bulletIndex: number) {
    if (
      !selectedSlide ||
      editorLocked ||
      selectedSlide.bullets.length <= minimumBulletCount(selectedSlide)
    ) {
      return;
    }
    onPatchSlide(selectedIndex, {
      bullets: selectedSlide.bullets.filter((_, index) => index !== bulletIndex),
      diagram: undefined,
    });
    setAnnouncement(
      `슬라이드 ${selectedIndex + 1}의 핵심 문장 ${bulletIndex + 1}을 삭제했습니다.`
    );
  }

  function handleSourceRefChange(label: string, checked: boolean) {
    if (
      !selectedSlide ||
      editorLocked ||
      !verifiedSourceLabelByKey.has(normalizedSourceLabelKey(label))
    ) return;
    let sourceRefs = selectedVerifiedSourceRefs;
    if (checked) {
      if (sourceRefs.includes(label) || sourceRefs.length >= 4) return;
      sourceRefs = [...sourceRefs, label];
    } else {
      if (!sourceRefs.includes(label) || sourceRefs.length <= 1) return;
      sourceRefs = sourceRefs.filter((sourceRef) => sourceRef !== label);
    }
    onPatchSlide(
      selectedIndex,
      normalizedSourceRefsPatch(selectedSlide, sourceRefs, deck.sources)
    );
    setAnnouncement(
      `슬라이드 ${selectedIndex + 1}에 검증된 근거 ${sourceRefs.length}개를 연결했습니다.`
    );
  }

  function handleRemoveInvalidSourceRefs() {
    if (!selectedSlide || editorLocked || selectedVerifiedSourceRefs.length === 0) return;
    onPatchSlide(
      selectedIndex,
      normalizedSourceRefsPatch(selectedSlide, selectedVerifiedSourceRefs, deck.sources)
    );
    setAnnouncement(`슬라이드 ${selectedIndex + 1}의 검증되지 않은 출처 표기를 제거했습니다.`);
  }

  return (
    <>
      <Card
        className={cn(
          "animate-in fade-in slide-in-from-bottom-3 overflow-hidden border-border/60 shadow-sm duration-500 motion-reduce:animate-none",
          editing && "ring-1 ring-primary/40"
        )}
      >
        <AccentBar accent={accent} />
        <CardHeader className="pb-3">
          <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:justify-between">
            {editing ? (
              <Input
                id="slide-deck-title"
                value={deck.title}
                onChange={(e) => onTitleChange(e.target.value)}
                disabled={editorLocked}
                className="h-12 text-base font-semibold"
                aria-label="발표 제목"
              />
            ) : (
              <CardTitle className="flex items-center gap-2 text-base">
                <Presentation className="h-4 w-4" style={{ color: accent }} aria-hidden="true" />
                {deck.title}
              </CardTitle>
            )}
            <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
              <SaveButton chrome={chrome} />
              <EditToggleButton chrome={chrome} />
            </div>
          </div>
          <CardDescription className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full border bg-muted/40 px-2 py-0.5 text-xs font-medium text-foreground/80">
              {mode === "presenter" ? "발표형" : "상세형"}
            </span>
            <span>
              본문 {deck.slides.length}장 · 다운로드 총 {downloadSlideCount}장(표지·근거 포함) · 근거:
            </span>
            <SourceBadges sources={deck.sources} />
            <span className="basis-full text-xs text-muted-foreground" aria-label="슬라이드 시각 구성 요약">
              현재 구성 · 원문 {visualSummary.source}장 · 편집 가능한 도형 {visualSummary.diagram}장 · 내용 중심 {visualSummary.content}장
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {statusMessage}
          </p>
          <QualityBanner
            quality={quality}
            deckTitle={deck.title}
            slideTitles={deck.slides.map((slide) => slide.title)}
            onSelectSlide={handleSelectIssueSlide}
            evidenceRepair={
              evidenceRepair && onRepairEvidence
                ? {
                    ...evidenceRepair,
                    onRepair: onRepairEvidence,
                  }
                : undefined
            }
            qualityRepair={
              qualityRepair && onRepairQuality
                ? {
                    ...qualityRepair,
                    onRepair: onRepairQuality,
                  }
                : undefined
            }
          />
          <SlideLayoutIssues issues={layoutReport.issues} disabled={editorLocked} onSelect={handleSelectLayoutIssue} />
          {fontCheckFailed && <p role="status" className="text-sm leading-relaxed text-muted-foreground">글꼴을 확인하지 못해 기본 기준으로 넘침을 점검합니다. 다운로드할 때 글꼴을 다시 확인합니다.</p>}

          {editing ? (
            <fieldset
              disabled={editorLocked}
              aria-busy={editorLocked}
              className="grid min-w-0 gap-4 border-0 p-0 lg:grid-cols-[minmax(190px,240px)_minmax(0,1fr)]"
            >
              <legend className="sr-only">슬라이드 편집</legend>
              <aside className="min-w-0 rounded-lg border border-border/70 bg-muted/20 p-3">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">슬라이드 목록</h3>
                    <p className="text-xs text-muted-foreground">한 장을 선택해 집중 편집</p>
                  </div>
                  <span className="rounded-full bg-background px-2 py-1 text-xs font-medium tabular-nums">
                    {selectedIndex + 1}/{deck.slides.length}
                  </span>
                </div>
                <nav
                  className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2 lg:mx-0 lg:max-h-[70vh] lg:flex-col lg:overflow-y-auto lg:px-0"
                  aria-label="편집할 슬라이드 선택"
                >
                  {deck.slides.map((slide, index) => {
                    const active = selectedIndex === index;
                    return (
                      <div
                        key={index}
                        className={cn(
                          "relative w-44 shrink-0 rounded-lg border p-2 transition-colors lg:w-full",
                          active
                            ? "border-primary bg-primary/10 shadow-sm"
                            : "border-border bg-background hover:border-primary/40 hover:bg-accent/40"
                        )}
                      >
                        <button
                          type="button"
                          aria-current={active ? "page" : undefined}
                          aria-label={`슬라이드 ${index + 1}: ${slide.title || "제목 없음"}${layoutIssueSet.has(index) ? ", 글자·도식 확인 필요" : qualityIssueSet.has(index) ? ", 품질 확인 필요" : evidenceIssueSet.has(index) ? ", 근거 확인 필요" : ""}`}
                          disabled={editorLocked}
                          onClick={() => {
                            setSelectedIndex(index);
                            regen.onClose();
                            setAnnouncement(`슬라이드 ${index + 1}을 선택했습니다.`);
                          }}
                          className="absolute inset-0 z-10 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed"
                        />
                        <SlidePreview
                          slide={preparedSlide(slide)}
                          index={index}
                          accent={accent}
                          mode={mode}
                          occurrence={layoutOccurrences[index]}
                          decorative
                        />
                        <div
                          aria-hidden="true"
                          className="mt-2 flex min-w-0 items-center gap-2 text-sm font-medium"
                        >
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="truncate">{slide.title || "제목 없음"}</span>
                          {(layoutIssueSet.has(index) || qualityIssueSet.has(index) || evidenceIssueSet.has(index)) && (
                            <span className="ml-auto shrink-0 rounded-full bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800 dark:bg-red-950/50 dark:text-red-100">
                              {layoutIssueSet.has(index) ? "표현 확인" : qualityIssueSet.has(index) ? "품질 확인" : "근거 확인"}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </nav>
                <Button
                  type="button"
                  variant="outline"
                  className="mt-2 h-12 w-full gap-1.5 md:h-11"
                  disabled={regen.loadingIndex !== null || deck.slides.length >= 20}
                  onClick={handleAddAfterSelected}
                >
                  <Plus className="h-4 w-4" aria-hidden="true" /> 뒤에 새 슬라이드
                </Button>
                {deck.slides.length >= 20 && (
                  <p className="mt-2 text-xs text-muted-foreground">슬라이드는 최대 20장까지 만들 수 있습니다.</p>
                )}
              </aside>

              {selectedSlide && (
                <section className="min-w-0 space-y-3" aria-labelledby="selected-slide-heading">
                  <div className="flex flex-col gap-3 rounded-lg border border-border/70 bg-muted/20 p-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-muted-foreground">
                        슬라이드 {selectedIndex + 1}
                      </p>
                      <h3
                        id="selected-slide-heading"
                        tabIndex={-1}
                        className="scroll-mt-4 truncate rounded-sm text-base font-semibold focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                      >
                        {selectedSlide.title || "제목 없음"}
                      </h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-12 w-12 md:h-11 md:w-11"
                        disabled={regen.loadingIndex !== null || selectedIndex === 0}
                        onClick={() => handleMoveSelected(-1)}
                        aria-label={`슬라이드 ${selectedIndex + 1} 위로 이동`}
                        title="위로 이동"
                      >
                        <ArrowUp className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-12 w-12 md:h-11 md:w-11"
                        disabled={
                          regen.loadingIndex !== null || selectedIndex === deck.slides.length - 1
                        }
                        onClick={() => handleMoveSelected(1)}
                        aria-label={`슬라이드 ${selectedIndex + 1} 아래로 이동`}
                        title="아래로 이동"
                      >
                        <ArrowDown className="h-4 w-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-12 gap-1.5 md:h-11"
                        disabled={regen.loadingIndex !== null || deck.slides.length >= 20}
                        onClick={handleDuplicateSelected}
                      >
                        <Copy className="h-4 w-4" aria-hidden="true" /> 복제
                      </Button>
                      {onReplaceSlideRange && <Button type="button" variant="outline" className="h-12 gap-1.5 md:h-11"
                        disabled={editorLocked || !splitPlan?.ok} aria-describedby="slide-split-guidance" onClick={handleSplitSelected}>
                        <Scissors className="h-4 w-4" aria-hidden="true" /> 장 나누기
                      </Button>}
                      <Button
                        type="button"
                        variant="outline"
                        className="h-12 gap-1.5 md:h-11"
                        disabled={regen.loadingIndex !== null || deck.slides.length >= 20}
                        onClick={handleAddAfterSelected}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" /> 뒤에 추가
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-12 w-12 text-destructive hover:text-destructive md:h-11 md:w-11"
                        disabled={regen.loadingIndex !== null || deck.slides.length <= 1}
                        onClick={() => setPendingDelete(selectedIndex)}
                        aria-label={`슬라이드 ${selectedIndex + 1} 삭제`}
                        title="삭제"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </div>

                  {onReplaceSlideRange && splitPlan && <div className="space-y-1 text-sm text-muted-foreground">
                    <p id="slide-split-guidance">{splitPlan.ok ? splitPlan.description : splitPlan.reason}</p>
                    {lastSplit && (splitCanUndo ? <Button type="button" variant="outline" className="min-h-12" disabled={editorLocked} onClick={handleUndoSplit}>나누기 되돌리기</Button>
                      : <p>나눈 장이 수정되거나 이동되어 되돌리기를 종료했습니다. 현재 편집 내용은 유지됩니다.</p>)}
                  </div>}

                  <article className="overflow-hidden rounded-lg border bg-card">
                    <div className="grid gap-4 p-3 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
                      <div className="min-w-0 space-y-3 xl:sticky xl:top-4 xl:self-start">
                        <SlidePreview
                          slide={preparedSlide(selectedSlide)}
                          index={selectedIndex}
                          accent={accent}
                          mode={mode}
                          occurrence={layoutOccurrences[selectedIndex]}
                          decorative
                        />
                        <Button type="button" variant="outline" className="min-h-12 w-full gap-2" onClick={(event) => { expandTriggerRef.current = event.currentTarget; setExpandedIndex(selectedIndex); }}>
                          <Maximize2 className="h-4 w-4" aria-hidden="true" /> 크게 보기
                        </Button>
                        {sourcePreviewControl(selectedSlide, selectedIndex)}
                        <SlideVisualSlot slide={preparedSlide(selectedSlide)} />
                      </div>

                      <div className="min-w-0 space-y-4">
                        <div className="space-y-1.5">
                          <label className="text-sm font-semibold" htmlFor={`slide-layout-${selectedIndex}`}>
                            슬라이드 표현 방식
                          </label>
                          <Select
                            value={compositionFromLegacy(selectedSlide)}
                            onValueChange={(value) => {
                              const composition = value as SlideCompositionType;
                              const sourceCandidate =
                                composition === "visual-explanation"
                                  ? selectedVisualCandidate ?? selectedVisualCandidates[0]
                                  : undefined;
                              onPatchSlide(
                                selectedIndex,
                                normalizedCompositionPatch(
                                  selectedSlide,
                                  composition,
                                  sourceCandidate
                                )
                              );
                              setAnnouncement(
                                `슬라이드 ${selectedIndex + 1} 표현 방식을 ${COMPOSITION_LABELS[composition]}으로 바꿨습니다.`
                              );
                            }}
                          >
                            <SelectTrigger
                              id={`slide-layout-${selectedIndex}`}
                              className="h-12 text-base"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {COMPOSITION_OPTIONS.map(([value, label]) => (
                                <SelectItem
                                  key={value}
                                  value={value}
                                  disabled={
                                    value === "visual-explanation" &&
                                    selectedVisualCandidates.length === 0
                                  }
                                >
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {selectedVisualCandidates.length === 0 && (
                            <p className="text-xs leading-relaxed text-muted-foreground">
                              원문 방식은 이 장에 검증된 페이지 근거가 연결된 경우에만 선택할 수 있습니다.
                            </p>
                          )}
                        </div>

                        {compositionFromLegacy(selectedSlide) === "visual-explanation" &&
                          selectedVisualCandidates.length > 0 && (
                            <div className="space-y-1.5">
                              <label
                                className="text-sm font-semibold"
                                htmlFor={`slide-source-visual-${selectedIndex}`}
                              >
                                원문 페이지
                              </label>
                              <Select
                                value={
                                  selectedVisualCandidate?.label ?? SOURCE_VISUAL_UNSELECTED_VALUE
                                }
                                onValueChange={(label) => {
                                  const candidate = selectedVisualCandidates.find(
                                    (item) => item.label === label
                                  );
                                  if (!candidate) return;
                                  onPatchSlide(
                                    selectedIndex,
                                    normalizedCompositionPatch(
                                      selectedSlide,
                                      "visual-explanation",
                                      candidate
                                    )
                                  );
                                  setAnnouncement(
                                    `슬라이드 ${selectedIndex + 1}의 원문 페이지를 ${label}로 바꿨습니다.`
                                  );
                                }}
                              >
                                <SelectTrigger
                                  id={`slide-source-visual-${selectedIndex}`}
                                  className="h-12 text-base"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {!selectedVisualCandidate && (
                                    <SelectItem value={SOURCE_VISUAL_UNSELECTED_VALUE} disabled>
                                      원문 페이지를 다시 선택해 주세요
                                    </SelectItem>
                                  )}
                                  {selectedVisualCandidates.map((candidate) => (
                                    <SelectItem key={candidate.label} value={candidate.label}>
                                      {candidate.label}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              {!selectedVisualCandidate && (
                                <p className="text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                                  현재 표시 정보와 연결된 근거가 달라졌습니다. 사용할 원문 페이지를
                                  선택해 주세요.
                                </p>
                              )}
                              <p className="text-xs leading-relaxed text-muted-foreground">
                                실제 사진·도해·표가 없는 페이지는 내보낼 때 자동으로 도형·내용 구도로 대체합니다.
                              </p>
                              {selectedVisualCandidate && (
                                <div className="space-y-1.5 pt-3">
                                  <label htmlFor={`slide-source-focus-${selectedIndex}`} className="text-sm font-semibold">원문 확대 범위</label>
                                  <select id={`slide-source-focus-${selectedIndex}`} value={selectedSlide.visual?.sourceFocus ?? "full"}
                                    disabled={editorLocked} aria-describedby={`slide-source-focus-help-${selectedIndex}`}
                                    className="h-12 w-full rounded-md border border-input bg-background px-3 text-base focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    onChange={(event) => {
                                      if (!selectedSlide.visual) return;
                                      const visual = { ...selectedSlide.visual, sourceFocus: validSourceVisualFocus(event.target.value),
                                        imageData: undefined, sourcePageImageData: undefined, fit: "contain" as const };
                                      onPatchSlide(selectedIndex, { visual });
                                      void handlePreviewSource(selectedIndex, { ...selectedSlide, visual });
                                    }}>
                                    <option value="full">전체 페이지</option>
                                    {SOURCE_VISUAL_FOCUS.map((focus) => <option key={focus} value={focus}>{SOURCE_VISUAL_FOCUS_LABELS[focus]} 확대</option>)}
                                  </select>
                                  <p id={`slide-source-focus-help-${selectedIndex}`} className="text-sm leading-relaxed text-muted-foreground">
                                    원문을 보고 필요한 범위를 선택하세요. 확대해도 전체 페이지와 출처는 함께 유지하며, 언제든 전체 표시로 되돌릴 수 있습니다.
                                  </p>
                                </div>
                              )}
                            </div>
                          )}

                        <div className="space-y-1.5">
                          <label className="text-sm font-semibold" htmlFor={`slide-title-${selectedIndex}`}>
                            제목
                          </label>
                          <Input
                            id={`slide-title-${selectedIndex}`}
                            value={selectedSlide.title}
                            onChange={(event) =>
                              onPatchSlide(selectedIndex, { title: event.target.value })
                            }
                            className="h-12 text-base font-semibold"
                          />
                        </div>

                        <fieldset className="space-y-2">
                          <legend className="text-sm font-semibold">핵심 내용</legend>
                          {selectedSlide.bullets.map((bullet, bulletIndex) => {
                            const minimum = minimumBulletCount(selectedSlide);
                            return (
                              <div key={bulletIndex} className="flex items-center gap-2">
                                <Textarea
                                  id={`slide-bullet-${selectedIndex}-${bulletIndex}`}
                                  value={bullet}
                                  onChange={(event) => onPatchSlide(selectedIndex, {
                                    bullets: selectedSlide.bullets.map((current, index) => index === bulletIndex ? event.target.value : current),
                                    diagram: undefined,
                                  })}
                                  className="min-h-24 min-w-0 flex-1 resize-y text-base leading-relaxed"
                                  aria-label={`슬라이드 ${selectedIndex + 1} 핵심 내용 ${bulletIndex + 1}`}
                                />
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-12 w-12 shrink-0 text-muted-foreground hover:text-destructive"
                                  disabled={selectedSlide.bullets.length <= minimum}
                                  onClick={() => handleDeleteBullet(bulletIndex)}
                                  aria-label={`핵심 문장 ${bulletIndex + 1} 삭제`}
                                  title="핵심 문장 삭제"
                                >
                                  <X className="h-4 w-4" aria-hidden="true" />
                                </Button>
                              </div>
                            );
                          })}
                          <Button
                            type="button"
                            variant="outline"
                            className="min-h-12 gap-1.5 text-base"
                            disabled={selectedSlide.bullets.length >= 4}
                            onClick={handleAddBullet}
                          >
                            <Plus className="h-4 w-4" aria-hidden="true" /> 핵심 문장 추가
                          </Button>
                          <p className="text-xs leading-relaxed text-muted-foreground">
                            최대 4개까지 작성할 수 있습니다. 비교·판단 흐름은 최소 2개를 유지합니다.
                          </p>
                        </fieldset>

                        <div className="space-y-1.5">
                          <label className="text-sm font-semibold" htmlFor={`slide-steps-${selectedIndex}`}>
                            {selectedSlide.composition === "comparison" ? "비교 기준과 추가 단계" : "절차 단계"}{" "}
                            <span className="font-normal text-muted-foreground">(선택, 한 줄에 하나)</span>
                          </label>
                          <Textarea
                            id={`slide-steps-${selectedIndex}`}
                            value={(selectedSlide.steps ?? []).join("\n")}
                            onChange={(event) => {
                              const value = event.target.value;
                              onPatchSlide(selectedIndex, {
                                steps: value === "" ? undefined : value.split("\n"),
                                diagram: undefined,
                              });
                            }}
                            className="min-h-[112px] text-base"
                            placeholder={"위험 확인\n장비 점검\n대원 수행\n결과 보고"}
                          />
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            {selectedSlide.composition === "comparison"
                              ? "비교 대상과 항목 이름을 입력한 뒤 아래 도식 연결에서 대응하는 설명을 선택하세요."
                              : selectedSlide.composition === "decision-flow" ? "조건 1개와 서로 다른 갈림길 이름 2개를 입력한 뒤 아래에서 행동을 연결하세요."
                                : "절차 화면은 3~5단계가 가장 읽기 좋습니다."}
                          </p>
                          {(selectedSlide.steps?.length ?? 0) > 5 && <p role="alert" className="text-base leading-relaxed text-destructive">입력한 {selectedSlide.steps!.length}개 단계를 모두 보존했습니다. 이 장에는 최대 5개까지 사용할 수 있으므로 정리하거나 다른 장으로 나눠 주세요.</p>}
                        </div>

                        {editableDiagramKind(selectedSlide.composition) && <div id={`slide-diagram-${selectedIndex}`} tabIndex={-1} className="space-y-2 rounded-md focus:outline-none focus:ring-2 focus:ring-ring">
                          <p className="text-sm leading-relaxed text-muted-foreground">본문·단계를 수정하면 기존 도식 연결이 해제됩니다. 내용 확인 후 아래에서 다시 연결해 주세요.</p>
                          <SlideDiagramEditor key={`${selectedIndex}:${selectedSlide.composition}`} slide={selectedSlide} index={selectedIndex} disabled={editorLocked}
                            onChange={(diagram) => {
                              onPatchSlide(selectedIndex, { diagram });
                              setAnnouncement(diagram ? `슬라이드 ${selectedIndex + 1} 도식 연결을 적용했습니다.` : `슬라이드 ${selectedIndex + 1}의 도식 연결을 해제했습니다. 본문과 단계는 유지됩니다.`);
                            }} />
                        </div>}

                        <div className="space-y-1.5">
                          <label className="text-sm font-semibold" htmlFor={`slide-notes-${selectedIndex}`}>
                            발표자 노트
                          </label>
                          <Textarea
                            id={`slide-notes-${selectedIndex}`}
                            value={selectedSlide.notes}
                            onChange={(event) =>
                              onPatchSlide(selectedIndex, { notes: event.target.value })
                            }
                            className="min-h-[144px] text-base"
                            placeholder="교관이 설명할 내용과 확인 질문"
                          />
                        </div>

                        <fieldset className="space-y-2 rounded-lg border border-border/70 bg-muted/20 p-3">
                          <legend className="px-1 text-sm font-semibold">근거 출처 (1~4개)</legend>
                          <div className="flex justify-end">
                            <span className="text-xs font-medium tabular-nums text-muted-foreground">
                              선택 {selectedVerifiedSourceRefs.length}/4
                            </span>
                          </div>
                          <p
                            id={`slide-source-help-${selectedIndex}`}
                            className="text-xs leading-relaxed text-muted-foreground"
                          >
                            생성 시 서버가 확인한 출처만 선택할 수 있습니다. 자유 입력은 지원하지 않습니다.
                          </p>
                          {verifiedSourceLabels.length > 0 ? (
                            <div className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                              {verifiedSourceLabels.map((label, labelIndex) => {
                                const checked = selectedVerifiedSourceRefs.includes(label);
                                const selectionLimitReached =
                                  (!checked && selectedVerifiedSourceRefs.length >= 4) ||
                                  (checked && selectedVerifiedSourceRefs.length <= 1);
                                const inputId = `slide-source-${selectedIndex}-${labelIndex}`;
                                return (
                                  <label
                                    key={label}
                                    htmlFor={inputId}
                                    className={cn(
                                      "flex min-h-11 cursor-pointer items-center gap-3 rounded-md border bg-background px-3 py-2 text-sm transition-colors",
                                      checked && "border-primary/50 bg-primary/5",
                                      selectionLimitReached && "cursor-not-allowed opacity-60"
                                    )}
                                  >
                                    <input
                                      id={inputId}
                                      type="checkbox"
                                      checked={checked}
                                      disabled={selectionLimitReached}
                                      aria-describedby={`slide-source-help-${selectedIndex}`}
                                      onChange={(event) =>
                                        handleSourceRefChange(label, event.target.checked)
                                      }
                                      className="h-5 w-5 shrink-0 accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                                    />
                                    <span className="min-w-0 break-words leading-relaxed">{label}</span>
                                  </label>
                                );
                              })}
                            </div>
                          ) : (
                            <p
                              role="alert"
                              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm leading-relaxed text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
                            >
                              검증된 출처 목록이 없습니다. ‘누락 근거 다시 보완’을 실행해 주세요.
                            </p>
                          )}
                          {invalidSourceRefs.length > 0 && (
                            <div
                              role="alert"
                              className="space-y-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-950 dark:border-red-900 dark:bg-red-950/30 dark:text-red-100"
                            >
                              <p className="leading-relaxed">
                                검증되지 않은 기존 출처 {invalidSourceRefs.length}개가 있습니다. 검증된 출처를
                                선택해 교체해 주세요.
                              </p>
                              {selectedVerifiedSourceRefs.length > 0 && (
                                <Button
                                  type="button"
                                  variant="outline"
                                  className="min-h-11 bg-background/80"
                                  onClick={handleRemoveInvalidSourceRefs}
                                >
                                  검증되지 않은 표기 제거
                                </Button>
                              )}
                            </div>
                          )}
                          {selectedVerifiedSourceRefs.length >= 4 && (
                            <p className="text-xs text-muted-foreground">
                              최대 4개를 선택했습니다. 다른 출처를 고르려면 기존 선택을 먼저 해제하세요.
                            </p>
                          )}
                          {selectedVerifiedSourceRefs.length === 1 && (
                            <p className="text-xs text-muted-foreground">
                              근거는 최소 1개를 유지해야 합니다. 교체하려면 새 출처를 먼저 추가하세요.
                            </p>
                          )}
                        </fieldset>
                        <RegenControls index={selectedIndex} regen={regen} />
                      </div>
                    </div>
                    <SlideEvidence slide={selectedSlide} />
                  </article>
                </section>
              )}
            </fieldset>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {deck.slides.map((slide, index) => (
                <article
                  key={index}
                  className="overflow-hidden rounded-lg border bg-card"
                  aria-labelledby={`slide-review-title-${index}`}
                >
                  <div className="p-3">
                    <SlidePreview slide={preparedSlide(slide)} index={index} accent={accent} mode={mode} occurrence={layoutOccurrences[index]} decorative />
                    <Button type="button" variant="outline" className="mt-3 min-h-12 w-full gap-2" onClick={(event) => { expandTriggerRef.current = event.currentTarget; setExpandedIndex(index); }}>
                      <Maximize2 className="h-4 w-4" aria-hidden="true" /> {index + 1}번 슬라이드 크게 보기
                    </Button>
                    <div className="mt-2">{sourcePreviewControl(slide, index)}</div>
                  </div>
                  <h3
                    id={`slide-review-title-${index}`}
                    className="px-3 pb-3 text-base font-semibold leading-snug"
                  >
                    <span className="mr-2 text-sm font-medium tabular-nums text-muted-foreground">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    {slide.title || "제목 없음"}
                  </h3>
                  <SlideReadableContent slide={slide} accent={accent} />
                  <SlideEvidence slide={slide} />
                </article>
              ))}
            </div>
          )}

          <Button
            type="button"
            className="h-12 w-full gap-2 text-base"
            onClick={onDownloadPptx}
            disabled={pptxLoading || editorLocked || outputBlocked || !layoutReport.ok}
            aria-busy={pptxLoading}
            aria-describedby={[outputBlocked ? "generation-quality-summary" : "", !layoutReport.ok ? "slide-layout-check" : ""].filter(Boolean).join(" ") || undefined}
          >
            {pptxLoading ? (
              <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : (
              <Download className="h-4 w-4" aria-hidden="true" />
            )}
            {pptxLoading
              ? "PPTX 준비 중…"
              : `PPTX 다운로드 · 총 ${downloadSlideCount}장 (발표자 노트 포함)`}
          </Button>
          <p className="text-sm leading-relaxed text-muted-foreground">
            분야 색 표준 양식으로 만들어집니다. 미리보기와 PPTX는 같은 내용과 화면 구도를 사용합니다.
            PC에 설치된 글꼴에 따라 줄바꿈이 달라질 수 있습니다. AI가 인덱싱된 교육자료를 근거로 생성한
            초안이므로 시행 전 내용을 반드시 검토·보완하세요.
          </p>
        </CardContent>
      </Card>

      <Dialog open={expandedIndex !== null && Boolean(expandedSlide)} onOpenChange={(open) => { if (!open) setExpandedIndex(null); }}>
        <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-[min(96vw,1200px)]" onCloseAutoFocus={(event) => { event.preventDefault(); expandTriggerRef.current?.focus(); }}>
          <DialogHeader>
            <DialogTitle>슬라이드 {expandedIndex !== null ? expandedIndex + 1 : ""} 크게 보기</DialogTitle>
            <DialogDescription>그림과 전체 내용을 확인한 뒤 다운로드하세요.</DialogDescription>
          </DialogHeader>
          {expandedSlide && expandedIndex !== null && (
            <>
              <SlidePreview slide={preparedSlide(expandedSlide)} index={expandedIndex} accent={accent} mode={mode} occurrence={layoutOccurrences[expandedIndex]} decorative />
              {sourcePreviewControl(expandedSlide, expandedIndex)}
              <SlideReadableContent slide={expandedSlide} accent={accent} />
              <SlideEvidence slide={expandedSlide} />
              <div className="flex justify-between gap-2">
                <Button type="button" variant="outline" className="min-h-12" disabled={expandedIndex === 0} onClick={() => setExpandedIndex(expandedIndex - 1)}>이전 장</Button>
                <Button type="button" variant="outline" className="min-h-12" onClick={() => setExpandedIndex(null)}>닫기</Button>
                <Button type="button" variant="outline" className="min-h-12" disabled={expandedIndex === deck.slides.length - 1} onClick={() => setExpandedIndex(expandedIndex + 1)}>다음 장</Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>이 슬라이드를 삭제할까요?</DialogTitle>
            <DialogDescription>
              슬라이드 {pendingDelete !== null ? pendingDelete + 1 : ""}과 편집한 내용이 삭제됩니다.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              className="h-12 md:h-11"
              disabled={editorLocked}
              onClick={() => setPendingDelete(null)}
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-12 md:h-11"
              disabled={editorLocked}
              onClick={confirmDelete}
            >
              삭제
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
