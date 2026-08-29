"use client";

// 슬라이드(PPTX) 결과 카드 — 16:9 미리보기 · 항목 편집 · 항목별 AI 재생성 · PPTX 다운로드.
import { useEffect, useState } from "react";
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
  Plus,
  Presentation,
  Trash2,
  X,
} from "lucide-react";

import type {
  GeneratedSlide,
  GeneratedSlideDeck,
  SlideCompositionType,
  SlideLayoutType,
} from "@/lib/generate";
import { generatedPptxSlideCount } from "@/lib/pptx-plan";
import { fallbackSlideVisualMode, resolveSlideDeckMode } from "@/lib/generate";
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
  type GenerationQuality,
  type ResultChrome,
} from "@/components/generate/parts";

const LAYOUT_META: Record<SlideLayoutType, { label: string; eyebrow: string }> = {
  objectives: { label: "교육 목표", eyebrow: "오늘 교육이 끝나면" },
  concept: { label: "핵심 개념", eyebrow: "핵심 메시지" },
  process: { label: "절차", eyebrow: "현장 절차" },
  equipment: { label: "장비 점검", eyebrow: "현장 확인 체크" },
  case: { label: "상황 사례", eyebrow: "상황을 읽고 대응합니다" },
  safety: { label: "안전 수칙", eyebrow: "현장 확인 체크" },
  summary: { label: "핵심 정리", eyebrow: "교육 핵심 정리" },
};

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

function PreviewList({
  bullets,
  accent,
  checklist = false,
}: {
  bullets: string[];
  accent: string;
  checklist?: boolean;
}) {
  return (
    <div className="space-y-1.5 overflow-hidden">
      {bullets.slice(0, 4).map((bullet, index) => (
        <div
          key={index}
          className="flex min-w-0 items-start gap-2 border-b border-border/50 pb-1.5 last:border-0"
        >
          <span
            className={cn(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold",
              checklist ? "border bg-background" : "text-white"
            )}
            style={checklist ? { borderColor: accent, color: accent } : { backgroundColor: accent }}
          >
            {checklist ? "✓" : String(index + 1).padStart(2, "0")}
          </span>
          <span className="line-clamp-2 text-[10px] leading-[1.45] text-foreground/80">
            {bullet}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 다운로드 결과의 의미 레이아웃을 축약해 보여 주는 16:9 미리보기. */
function SlidePreview({
  slide,
  index,
  accent,
  decorative = false,
}: {
  slide: GeneratedSlide;
  index: number;
  accent: string;
  decorative?: boolean;
}) {
  const layout = resolvePreviewLayout(slide);
  const meta = LAYOUT_META[layout];
  const bullets = slide.bullets.filter(Boolean);
  const steps = (slide.steps ?? []).filter(Boolean);
  const dark = layout === "summary";

  return (
    <div
      className={cn(
        "relative aspect-video w-full overflow-hidden rounded-md border shadow-sm",
        dark ? "border-slate-700 bg-slate-900 text-white" : "bg-background"
      )}
      role={decorative ? undefined : "img"}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : `슬라이드 ${index + 1} 미리보기: ${meta.label}`}
    >
      <div className="absolute inset-x-0 top-0 h-1" style={{ backgroundColor: accent }} />
      <div className="flex h-full flex-col px-[5.5%] pb-[4%] pt-[5%]">
        <div className="flex min-w-0 items-start gap-2 border-b border-current/10 pb-2">
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-[10px] font-bold text-white"
            style={{ backgroundColor: accent }}
          >
            {index + 1}
          </span>
          <h3 className="line-clamp-2 min-w-0 text-xs font-bold leading-tight sm:text-sm">
            {slide.title || "제목을 입력해 주세요"}
          </h3>
        </div>

        <div className="min-h-0 flex-1 pt-2">
          <p
            className="mb-2 text-[8px] font-bold uppercase tracking-[0.12em] sm:text-[9px]"
            style={{ color: dark ? "#9fb0cb" : accent }}
          >
            {meta.eyebrow}
          </p>

          {layout === "process" && steps.length >= 2 ? (
            <div className="flex h-[80%] flex-col justify-between">
              <div className="flex items-start justify-between gap-1">
                {steps.slice(0, 5).map((step, stepIndex) => (
                  <div
                    key={stepIndex}
                    className="relative flex min-w-0 flex-1 flex-col items-center text-center"
                  >
                    {stepIndex < Math.min(steps.length, 5) - 1 && (
                      <span
                        className="absolute left-[62%] top-2 h-px w-[76%] opacity-45"
                        style={{ backgroundColor: accent }}
                      />
                    )}
                    <span
                      className="relative z-10 flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white"
                      style={{ backgroundColor: accent }}
                    >
                      {stepIndex + 1}
                    </span>
                    <span className="mt-1 line-clamp-2 text-[8px] font-semibold leading-tight">
                      {step}
                    </span>
                  </div>
                ))}
              </div>
              <p className="line-clamp-2 text-[9px] leading-relaxed text-foreground/65">
                {bullets[0]}
              </p>
            </div>
          ) : layout === "case" && bullets.length >= 2 ? (
            <div className="grid h-[82%] grid-cols-[0.9fr_1.1fr] gap-3">
              <div
                className="flex min-w-0 items-center border-l-2 bg-muted/50 px-2"
                style={{ borderColor: accent }}
              >
                <p className="line-clamp-5 text-[10px] font-bold leading-relaxed">{bullets[0]}</p>
              </div>
              <PreviewList bullets={bullets.slice(1)} accent={accent} />
            </div>
          ) : layout === "concept" && bullets.length >= 2 ? (
            <div className="grid h-[82%] grid-cols-[0.9fr_1.1fr] gap-3">
              <div
                className="flex min-w-0 items-center border-l-2 pl-2"
                style={{ borderColor: accent }}
              >
                <p className="line-clamp-5 text-[10px] font-bold leading-relaxed">{bullets[0]}</p>
              </div>
              <PreviewList bullets={bullets.slice(1)} accent={accent} />
            </div>
          ) : layout === "summary" ? (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2">
              {bullets.slice(0, 4).map((bullet, bulletIndex) => (
                <div key={bulletIndex} className="flex min-w-0 gap-2">
                  <span className="text-[9px] font-bold" style={{ color: accent }}>
                    {String(bulletIndex + 1).padStart(2, "0")}
                  </span>
                  <span className="line-clamp-3 text-[9px] leading-relaxed text-white/85">
                    {bullet}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <PreviewList
              bullets={bullets}
              accent={accent}
              checklist={layout === "equipment" || layout === "safety"}
            />
          )}
        </div>

        <div className="flex items-center justify-between border-t border-current/10 pt-1 text-[7px] opacity-55">
          <span>전북특별자치도 소방본부</span>
          <span>{index + 1}</span>
        </div>
      </div>
    </div>
  );
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
  const steps = (slide.steps ?? []).filter(Boolean);
  return (
    <div className="space-y-3 border-t px-3 py-3">
      {steps.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="절차 단계">
          {steps.map((step, index) => (
            <span key={index} className="flex items-center gap-1.5 text-sm font-medium">
              <span
                className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-white"
                style={{ backgroundColor: accent }}
              >
                {index + 1}
              </span>
              {step}
              {index < steps.length - 1 && (
                <span className="text-muted-foreground" aria-hidden="true">
                  →
                </span>
              )}
            </span>
          ))}
        </div>
      )}
      <div>
        <p className="mb-1.5 text-xs font-semibold text-muted-foreground">핵심 내용</p>
        <ul className="list-disc space-y-1.5 pl-5 text-base leading-relaxed text-foreground/85 md:text-sm">
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
  list: "목록",
  process: "절차 흐름",
  comparison: "비교",
  timeline: "시간 흐름",
  "decision-flow": "판단 흐름",
  checklist: "점검표",
  scenario: "상황 사례",
  "visual-explanation": "시각 설명",
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
  fallbacks: readonly string[],
  maximum: number
): string[] {
  const items = (current ?? []).map((item) => item.trim()).filter(Boolean).slice(0, maximum);
  while (items.length < minimum) {
    items.push(fallbacks[items.length] ?? `항목 ${items.length + 1}`);
  }
  return items;
}

/** 구성을 바꾼 직후에도 해당 레이아웃이 깨지지 않도록 최소 문장·단계와 시각자료를 맞춘다. */
export function normalizedCompositionPatch(
  slide: GeneratedSlide,
  composition: SlideCompositionType
): Partial<GeneratedSlide> {
  const layout = legacyLayoutForComposition(composition, slide.layout);
  let bullets = fillSlideItems(slide.bullets, 1, ["핵심 내용을 입력해 주세요."], 4);
  let steps = (slide.steps ?? []).map((step) => step.trim()).filter(Boolean).slice(0, 5);

  if (composition === "comparison") {
    bullets = fillSlideItems(
      bullets,
      2,
      ["첫 번째 비교 내용을 입력해 주세요.", "두 번째 비교 내용을 입력해 주세요."],
      4
    );
    steps = fillSlideItems(steps, 2, ["비교 기준 1", "비교 기준 2"], 2);
  } else if (composition === "process") {
    steps = fillSlideItems(steps, 3, ["준비", "수행", "확인"], 5);
  } else if (composition === "decision-flow") {
    bullets = fillSlideItems(
      bullets,
      2,
      ["판단 조건을 입력해 주세요.", "조건별 조치를 입력해 주세요."],
      4
    );
    steps = fillSlideItems(steps, 3, ["판단 조건", "조건 충족", "조건 불충족"], 5);
  } else if (composition === "timeline") {
    steps = fillSlideItems(steps, 3, ["초기", "진행", "완료"], 5);
  }

  const patch: Partial<GeneratedSlide> = {
    composition,
    layout,
    bullets,
    steps: steps.length > 0 ? steps : undefined,
  };
  const isSourceVisual =
    slide.visual?.mode === "source-page" || slide.visual?.mode === "source-crop";
  if (isSourceVisual && composition !== "visual-explanation") {
    patch.visual = {
      mode: fallbackSlideVisualMode({ ...slide, composition, layout }),
    };
  }
  return patch;
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

  const status = hasPreview
    ? "미리보기 준비"
    : isSource
      ? "원본 연결"
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
                ? "교육자료에서 확인된 원본 이미지를 사용합니다."
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
  onPatchBullet,
  onAddSlide,
  onDuplicateSlide,
  onMoveSlide,
  onDeleteSlide,
  onDownloadPptx,
  pptxLoading,
  quality,
}: {
  deck: GeneratedSlideDeck;
  chrome: ResultChrome;
  regen: RegenState;
  onTitleChange: (title: string) => void;
  onPatchSlide: (index: number, patch: Partial<GeneratedSlide>) => void;
  onPatchBullet: (slideIndex: number, bulletIndex: number, value: string) => void;
  onAddSlide: (afterIndex: number) => void;
  onDuplicateSlide: (index: number) => void;
  onMoveSlide: (index: number, direction: -1 | 1) => void;
  onDeleteSlide: (index: number) => void;
  onDownloadPptx: () => void;
  pptxLoading: boolean;
  quality?: GenerationQuality | null;
}) {
  const { accent, editing } = chrome;
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const selectedSlide = deck.slides[selectedIndex];
  const mode = resolveSlideDeckMode(deck.mode);
  const downloadSlideCount = generatedPptxSlideCount(deck.slides.length, deck.sources.length);
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
    });
    setAnnouncement(
      `슬라이드 ${selectedIndex + 1}의 핵심 문장 ${bulletIndex + 1}을 삭제했습니다.`
    );
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
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
            {statusMessage}
          </p>
          <QualityBanner quality={quality} />

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
                          aria-label={`슬라이드 ${index + 1}: ${slide.title || "제목 없음"}`}
                          disabled={editorLocked}
                          onClick={() => {
                            setSelectedIndex(index);
                            regen.onClose();
                            setAnnouncement(`슬라이드 ${index + 1}을 선택했습니다.`);
                          }}
                          className="absolute inset-0 z-10 cursor-pointer rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed"
                        />
                        <SlidePreview
                          slide={slide}
                          index={index}
                          accent={accent}
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
                      <h3 id="selected-slide-heading" className="truncate text-base font-semibold">
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

                  <article className="overflow-hidden rounded-lg border bg-card">
                    <div className="grid gap-4 p-3 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
                      <div className="min-w-0 space-y-3 xl:sticky xl:top-4 xl:self-start">
                        <SlidePreview
                          slide={selectedSlide}
                          index={selectedIndex}
                          accent={accent}
                          decorative
                        />
                        <SlideVisualSlot slide={selectedSlide} />
                      </div>

                      <div className="min-w-0 space-y-4">
                        <div className="space-y-1.5">
                          <label className="text-sm font-semibold" htmlFor={`slide-layout-${selectedIndex}`}>
                            화면 구성
                          </label>
                          <Select
                            value={compositionFromLegacy(selectedSlide)}
                            onValueChange={(value) => {
                              const composition = value as SlideCompositionType;
                              onPatchSlide(
                                selectedIndex,
                                normalizedCompositionPatch(selectedSlide, composition)
                              );
                              setAnnouncement(
                                `슬라이드 ${selectedIndex + 1} 화면 구성을 ${COMPOSITION_LABELS[composition]}으로 바꿨습니다.`
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
                                <SelectItem key={value} value={value}>
                                  {label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

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
                                <Input
                                  value={bullet}
                                  onChange={(event) =>
                                    onPatchBullet(selectedIndex, bulletIndex, event.target.value)
                                  }
                                  className="h-12 min-w-0 flex-1 text-base"
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
                            className="min-h-11 gap-1.5"
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
                            절차 단계{" "}
                            <span className="font-normal text-muted-foreground">(선택, 한 줄에 하나)</span>
                          </label>
                          <Textarea
                            id={`slide-steps-${selectedIndex}`}
                            value={(selectedSlide.steps ?? []).join("\n")}
                            onChange={(event) => {
                              const value = event.target.value;
                              onPatchSlide(selectedIndex, {
                                steps: value === "" ? undefined : value.split("\n").slice(0, 5),
                              });
                            }}
                            className="min-h-[112px] text-base"
                            placeholder={"위험 확인\n장비 점검\n대원 수행\n결과 보고"}
                          />
                          <p className="text-sm leading-relaxed text-muted-foreground">
                            절차 화면은 3~5단계가 가장 읽기 좋습니다.
                          </p>
                        </div>

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
                    <SlidePreview slide={slide} index={index} accent={accent} decorative />
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
            disabled={pptxLoading || editorLocked || outputBlocked}
            title={outputBlocked ? "핵심 품질 오류를 수정한 뒤 내보낼 수 있습니다." : undefined}
            aria-busy={pptxLoading}
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
            분야 색 표준 양식으로 만들어집니다. 미리보기는 화면 구성을 간략히 보여 주며, 실제
            PPTX는 16:9 발표 화면에 맞춰 생성됩니다. AI가 인덱싱된 교육자료를 근거로 생성한
            초안이므로 시행 전 내용을 반드시 검토·보완하세요.
          </p>
        </CardContent>
      </Card>

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
