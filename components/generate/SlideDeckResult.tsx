"use client";

// 슬라이드(PPTX) 결과 카드 — 16:9 미리보기 · 항목 편집 · 항목별 AI 재생성 · PPTX 다운로드.
import {
  ArrowDown,
  ArrowUp,
  Download,
  Presentation,
  Trash2,
} from "lucide-react";

import type {
  GeneratedSlide,
  GeneratedSlideDeck,
  SlideLayoutType,
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

const LAYOUT_OPTIONS = Object.entries(LAYOUT_META) as Array<
  [SlideLayoutType, (typeof LAYOUT_META)[SlideLayoutType]]
>;

/** 과거 저장본처럼 layout이 없는 경우에도 미리보기의 의미 구조를 유지한다. */
function resolvePreviewLayout(slide: GeneratedSlide): SlideLayoutType {
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
}: {
  slide: GeneratedSlide;
  index: number;
  accent: string;
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
      aria-label={`슬라이드 ${index + 1} 미리보기: ${meta.label}`}
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
  return (
    <>
      {slide.sourceRefs && slide.sourceRefs.length > 0 && (
        <p className="break-words border-t px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground/70">근거</span>{" "}
          {slide.sourceRefs.join(" · ")}
        </p>
      )}
      {slide.notes && (
        <details className="border-t px-3 py-2 text-xs text-muted-foreground">
          <summary className="cursor-pointer font-medium text-foreground/70">발표자 노트 보기</summary>
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

export function SlideDeckResult({
  deck,
  chrome,
  regen,
  onTitleChange,
  onPatchSlide,
  onPatchBullet,
  onMoveSlide,
  onDeleteSlide,
  onDownloadPptx,
  quality,
}: {
  deck: GeneratedSlideDeck;
  chrome: ResultChrome;
  regen: RegenState;
  onTitleChange: (title: string) => void;
  onPatchSlide: (index: number, patch: Partial<GeneratedSlide>) => void;
  onPatchBullet: (slideIndex: number, bulletIndex: number, value: string) => void;
  onMoveSlide?: (index: number, direction: -1 | 1) => void;
  onDeleteSlide?: (index: number) => void;
  onDownloadPptx: () => void;
  quality?: GenerationQuality | null;
}) {
  const { accent, editing } = chrome;

  return (
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
              className="h-12 text-base font-semibold"
              aria-label="발표 제목"
            />
          ) : (
            <CardTitle className="flex items-center gap-2 text-base">
              <Presentation className="h-4 w-4" style={{ color: accent }} /> {deck.title}
            </CardTitle>
          )}
          <div className="flex shrink-0 items-center gap-1.5 self-end sm:self-auto">
            <SaveButton chrome={chrome} />
            <EditToggleButton chrome={chrome} />
          </div>
        </div>
        <CardDescription className="flex flex-wrap items-center gap-1.5">
          슬라이드 {deck.slides.length}장 · 근거:
          <SourceBadges sources={deck.sources} />
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <QualityBanner quality={quality} />
        <div className={cn("grid gap-4", !editing && "lg:grid-cols-2")}>
          {deck.slides.map((slide, index) => {
            const resolvedLayout = resolvePreviewLayout(slide);
            return (
              <article key={index} className="overflow-hidden rounded-lg border bg-card">
                {editing ? (
                  <div className="grid gap-4 p-3 xl:grid-cols-[minmax(280px,0.9fr)_minmax(0,1.1fr)]">
                    <SlidePreview slide={slide} index={index} accent={accent} />
                    <div className="min-w-0 space-y-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="mr-auto text-xs font-semibold text-muted-foreground">
                          슬라이드 {index + 1}
                        </span>
                        {onMoveSlide && (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-12 w-12"
                              disabled={regen.loadingIndex !== null || index === 0}
                              onClick={() => onMoveSlide(index, -1)}
                              aria-label={`슬라이드 ${index + 1} 위로 이동`}
                              title="위로 이동"
                            >
                              <ArrowUp className="h-4 w-4" />
                            </Button>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              className="h-12 w-12"
                              disabled={
                                regen.loadingIndex !== null || index === deck.slides.length - 1
                              }
                              onClick={() => onMoveSlide(index, 1)}
                              aria-label={`슬라이드 ${index + 1} 아래로 이동`}
                              title="아래로 이동"
                            >
                              <ArrowDown className="h-4 w-4" />
                            </Button>
                          </>
                        )}
                        {onDeleteSlide && (
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-12 w-12 text-destructive hover:text-destructive"
                            disabled={regen.loadingIndex !== null || deck.slides.length <= 1}
                            onClick={() => onDeleteSlide(index)}
                            aria-label={`슬라이드 ${index + 1} 삭제`}
                            title="삭제"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold" htmlFor={`slide-layout-${index}`}>
                          화면 구성
                        </label>
                        <Select
                          value={slide.layout ?? resolvedLayout}
                          onValueChange={(value) =>
                            onPatchSlide(index, { layout: value as SlideLayoutType })
                          }
                        >
                          <SelectTrigger
                            id={`slide-layout-${index}`}
                            className="h-12 text-base md:text-sm"
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {LAYOUT_OPTIONS.map(([value, meta]) => (
                              <SelectItem key={value} value={value}>
                                {meta.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold" htmlFor={`slide-title-${index}`}>
                          제목
                        </label>
                        <Input
                          id={`slide-title-${index}`}
                          value={slide.title}
                          onChange={(e) => onPatchSlide(index, { title: e.target.value })}
                          className="h-12 text-base font-semibold md:text-sm"
                        />
                      </div>

                      <div className="space-y-1.5">
                        <span className="text-xs font-semibold">핵심 내용</span>
                        {slide.bullets.map((bullet, bulletIndex) => (
                          <Input
                            key={bulletIndex}
                            value={bullet}
                            onChange={(e) => onPatchBullet(index, bulletIndex, e.target.value)}
                            className="h-12 text-base md:text-sm"
                            aria-label={`슬라이드 ${index + 1} 항목 ${bulletIndex + 1}`}
                          />
                        ))}
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold" htmlFor={`slide-steps-${index}`}>
                          절차 단계{" "}
                          <span className="font-normal text-muted-foreground">(선택, 한 줄에 하나)</span>
                        </label>
                        <Textarea
                          id={`slide-steps-${index}`}
                          value={(slide.steps ?? []).join("\n")}
                          onChange={(e) => {
                            const value = e.target.value;
                            onPatchSlide(index, {
                              steps: value === "" ? undefined : value.split("\n").slice(0, 5),
                            });
                          }}
                          className="min-h-[112px] text-base md:text-sm"
                          placeholder={"위험 확인\n장비 점검\n대원 수행\n결과 보고"}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          절차 화면은 3~5단계가 가장 읽기 좋습니다.
                        </p>
                      </div>

                      <div className="space-y-1.5">
                        <label className="text-xs font-semibold" htmlFor={`slide-notes-${index}`}>
                          발표자 노트
                        </label>
                        <Textarea
                          id={`slide-notes-${index}`}
                          value={slide.notes}
                          onChange={(e) => onPatchSlide(index, { notes: e.target.value })}
                          className="min-h-[112px] text-base md:text-sm"
                          placeholder="교관이 설명할 내용과 확인 질문"
                        />
                      </div>
                      <RegenControls index={index} regen={regen} />
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="p-3">
                      <SlidePreview slide={slide} index={index} accent={accent} />
                    </div>
                    <SlideReadableContent slide={slide} accent={accent} />
                  </>
                )}
                <SlideEvidence slide={slide} />
              </article>
            );
          })}
        </div>
        <Button className="h-12 w-full gap-2 text-base" onClick={onDownloadPptx}>
          <Download className="h-4 w-4" /> PPTX 다운로드 (발표자 노트 포함)
        </Button>
        <p className="text-xs text-muted-foreground">
          분야 색 표준 양식으로 만들어집니다. 미리보기는 화면 구성을 간략히 보여 주며, 실제
          PPTX는 16:9 발표 화면에 맞춰 생성됩니다. AI가 인덱싱된 교육자료를 근거로 생성한
          초안이므로 시행 전 내용을 반드시 검토·보완하세요.
        </p>
      </CardContent>
    </Card>
  );
}
