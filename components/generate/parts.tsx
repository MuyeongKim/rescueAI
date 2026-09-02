"use client";

// AI 자료제작 화면의 공용 조각들 — 입력 폼(GenerateForm)과 결과 카드들이 함께 쓴다.
import { useEffect, useState } from "react";
import {
  Check,
  CircleCheck,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  TriangleAlert,
} from "lucide-react";

import {
  BLOCKING_GENERATION_QUALITY_CODES,
  REGEN_INSTRUCTIONS,
  type Duration,
  type GeneratedDocSource,
  type GenerationQualityIssue,
} from "@/lib/generate";
import {
  estimatedGenerationStage,
  formatApproximateDuration,
  formatElapsedSeconds,
  generationEstimateSeconds,
  type TimedGenerationType,
} from "@/lib/generation-timing";
import {
  isGenerationJobDispatchConfirmed,
  type PublicGenerationJob,
} from "@/lib/generation-job";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

/** 선택형 옵션 버튼 그룹 (터치 48px+) */
export function OptionGroup<T extends string>({
  label,
  options,
  value,
  onChange,
  render,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  render?: (v: T) => React.ReactNode;
}) {
  return (
    <div className="space-y-2.5">
      <span className="text-xs font-semibold uppercase text-muted-foreground">{label}</span>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={label}>
        {options.map((o) => {
          const active = value === o;
          return (
            <button
              key={o}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(o)}
              className={cn(
                "inline-flex h-12 items-center gap-2 rounded-full border px-4 text-sm font-medium transition-all duration-200 motion-reduce:transition-none md:h-10",
                "hover:-translate-y-0.5 motion-reduce:hover:translate-y-0",
                active
                  ? "border-primary bg-primary/10 text-primary shadow-sm"
                  : "border-border hover:bg-accent/40"
              )}
            >
              {render ? render(o) : o}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 단계 헤더 — 폼은 "유형 → 설정 → 세부 → 생성" 순서가 있는 흐름이라 번호를 단다. */
export function StepHeader({ n, title, hint }: { n: string; title: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-2.5">
      <span className="font-mono text-xs font-semibold tabular-nums text-primary">{n}</span>
      <h2 className="text-base font-semibold">{title}</h2>
      {hint && <span className="text-xs font-normal text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** 결과 카드 공통 상태 — 저장/편집 토글과 분야 액센트 색. */
export type ResultChrome = {
  accent: string;
  editing: boolean;
  onToggleEdit: () => void;
  saving: boolean;
  /** 부분 재생성처럼 결과 스냅샷과 경합할 수 있는 작업 중 상단 동작을 잠근다. */
  locked?: boolean;
  /** 핵심 품질 오류가 남아 공식 저장·내보내기를 허용하지 않는 상태. */
  outputBlocked?: boolean;
  saved: boolean;
  loadedId: number | null;
  onSave: () => void;
};

/** 서버가 생성 직후 수행한 구조·분량 점검 결과. 사용자가 최종 확인할 지점을 짧게 보여준다. */
export type GenerationQuality = {
  checked: boolean;
  repaired: boolean;
  /** 저장·공식 파일 내보내기 전에 반드시 해결해야 하는 핵심 오류. */
  errors?: string[];
  warnings: string[];
  /** 요약 문구로 잃어버린 정확한 위치·원인을 결과 화면에서 안내하기 위한 원본 검사 결과. */
  issues?: GenerationQualityIssue[];
};

export type EvidenceRepairStatus = "idle" | "repairing" | "failed";

/** 슬라이드별 근거 자동 보완 상태. issueIndices는 API와 동일한 0-based 인덱스다. */
export type EvidenceRepairState = {
  status: EvidenceRepairStatus;
  issueIndices: number[];
  message?: string;
  startedAt?: number;
};

export type EvidenceRepairControls = EvidenceRepairState & {
  disabled?: boolean;
  onRepair: () => void;
};

export type QualityRepairStatus = "idle" | "repairing" | "failed";

/** 슬라이드 본문·구성 품질 자동 보완 상태. 근거 전용 보완과 독립적으로 관리한다. */
export type QualityRepairState = {
  status: QualityRepairStatus;
  issueIndices: number[];
  message?: string;
  startedAt?: number;
};

export type QualityRepairControls = QualityRepairState & {
  disabled?: boolean;
  onRepair: () => void;
};

type SlideQualityIssueGroup = {
  index: number;
  title: string;
  issues: GenerationQualityIssue[];
};

const SLIDE_QUALITY_ISSUE_PATH = /^slides\.(\d+)(?:\.|$)/;

function issueExcerpt(issue: GenerationQualityIssue): string | null {
  const excerpt = issue.excerpt;
  return typeof excerpt === "string" && excerpt.trim() ? excerpt.trim() : null;
}

/** 차단 오류 중 정확한 슬라이드 경로를 가진 항목만 장별로 묶는다. */
export function blockingSlideQualityIssueGroups(
  issues: readonly GenerationQualityIssue[] | undefined,
  slideTitles: readonly string[] | undefined
): SlideQualityIssueGroup[] {
  if (!issues?.length || !slideTitles?.length) return [];
  const groups = new Map<number, SlideQualityIssueGroup>();
  for (const issue of issues) {
    if (!BLOCKING_GENERATION_QUALITY_CODES.has(issue.code)) continue;
    const match = issue.path.match(SLIDE_QUALITY_ISSUE_PATH);
    const index = match ? Number(match[1]) : Number.NaN;
    if (!Number.isSafeInteger(index) || index < 0 || index >= slideTitles.length) continue;
    const current = groups.get(index) ?? {
      index,
      title: slideTitles[index]?.trim() || "제목 없음",
      issues: [],
    };
    current.issues.push(issue);
    groups.set(index, current);
  }
  return Array.from(groups.values()).sort((a, b) => a.index - b.index);
}

/** 특정 장으로 좁힐 수 없는 덱 수준 차단 오류를 별도로 안내한다. */
export function blockingDeckQualityIssues(
  issues: readonly GenerationQualityIssue[] | undefined
): GenerationQualityIssue[] {
  if (!issues?.length) return [];
  return issues.filter(
    (issue) =>
      BLOCKING_GENERATION_QUALITY_CODES.has(issue.code) &&
      !SLIDE_QUALITY_ISSUE_PATH.test(issue.path)
  );
}

export function QualityBanner({
  quality,
  evidenceRepair,
  qualityRepair,
  deckTitle,
  slideTitles,
  onSelectSlide,
}: {
  quality?: GenerationQuality | null;
  evidenceRepair?: EvidenceRepairControls;
  qualityRepair?: QualityRepairControls;
  deckTitle?: string;
  slideTitles?: readonly string[];
  onSelectSlide?: (index: number) => void;
}) {
  const evidenceBusy = evidenceRepair?.status === "repairing";
  const qualityBusy = qualityRepair?.status === "repairing";
  const repairBusy = evidenceBusy || qualityBusy;
  const evidenceIssues = evidenceRepair?.issueIndices ?? [];
  const hasEvidenceIssues = evidenceIssues.length > 0;
  const qualityIssues = qualityRepair?.issueIndices ?? [];
  const hasQualityRepairTargets = qualityIssues.length > 0;
  const slideIssueGroups = blockingSlideQualityIssueGroups(quality?.issues, slideTitles);
  const deckQualityIssues = blockingDeckQualityIssues(quality?.issues);
  const hasDetailedQualityIssues =
    hasQualityRepairTargets || slideIssueGroups.length > 0 || deckQualityIssues.length > 0;
  if (!quality?.checked && !repairBusy && !hasEvidenceIssues && !hasDetailedQualityIssues) {
    return null;
  }

  const errors = quality?.errors ?? [];
  const blocked =
    !repairBusy &&
    (errors.length > 0 || hasEvidenceIssues || hasDetailedQualityIssues);
  const needsReview = (quality?.warnings.length ?? 0) > 0;
  const Icon = blocked || needsReview ? TriangleAlert : CircleCheck;
  const selectionDisabled =
    repairBusy || Boolean(evidenceRepair?.disabled) || Boolean(qualityRepair?.disabled);
  const fallbackErrorLabel =
    hasEvidenceIssues && !hasQualityRepairTargets
      ? "슬라이드별 근거 출처"
      : "슬라이드 품질 오류";
  let summaryTitle = quality?.repaired
    ? "초안을 한 번 보완하고 자동 점검했습니다"
    : "초안 구성을 자동 점검했습니다";
  let summaryDescription =
    "필수 구성과 교육 흐름을 확인했습니다. 현장 적용 전 내용과 수치는 최종 검토해 주세요.";
  if (qualityBusy) {
    summaryTitle = "문제 슬라이드 보완 중";
    summaryDescription = `슬라이드 ${qualityIssues.map((index) => index + 1).join(", ")}의 내용과 구성을 다시 점검하고 있습니다. 잠시만 기다려 주세요.`;
  } else if (evidenceBusy) {
    summaryTitle = "근거 확인 중";
    summaryDescription = `슬라이드 ${evidenceIssues.map((index) => index + 1).join(", ")}의 출처를 교육자료와 대조하고 있습니다. 잠시만 기다려 주세요.`;
  } else if (blocked) {
    summaryTitle = "핵심 품질 오류가 있어 저장·내보내기가 잠겼습니다";
    summaryDescription = `먼저 수정할 항목: ${errors.join(" · ") || fallbackErrorLabel}. 편집하거나 해당 부분을 AI로 다시 생성해 주세요.`;
  } else if (needsReview) {
    summaryDescription = `최종 확인이 필요한 항목: ${quality?.warnings.join(" · ")}`;
  }
  return (
    <div
      id="generation-quality-summary"
      // 보완 중에는 아래 타이머가 매초 바뀐다. 상위 전체를 live region으로 두면
      // 화면낭독기가 배너 전체를 반복 낭독하므로, 단계 안내만 별도 status로 알린다.
      role={repairBusy ? undefined : blocked ? "alert" : "status"}
      aria-live={repairBusy ? undefined : blocked ? "assertive" : "polite"}
      aria-atomic={repairBusy ? undefined : "true"}
      className={cn(
        "flex gap-2.5 border-l-4 px-3 py-3 text-sm",
        blocked
          ? "border-l-red-600 bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100"
          : repairBusy
            ? "border-l-sky-600 bg-sky-50 text-sky-950 dark:bg-sky-950/30 dark:text-sky-100"
          : needsReview
          ? "border-l-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
          : "border-l-emerald-600 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100"
      )}
    >
      {repairBusy ? (
        <Loader2
          className="mt-0.5 h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : (
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{summaryTitle}</p>
        <p className="mt-0.5 text-sm leading-relaxed opacity-80">{summaryDescription}</p>
        {qualityBusy && (
          <GenerationWaitStatus
            key={`quality-${qualityRepair?.startedAt ?? "current"}`}
            estimatedSeconds={180}
            startedAt={qualityRepair?.startedAt}
            fixedStage="SOP 표현과 근거를 보완하는 중"
            completionLabel="보완 예상 완료"
          />
        )}
        {evidenceBusy && (
          <GenerationWaitStatus
            key={`evidence-${evidenceRepair?.startedAt ?? "current"}`}
            estimatedSeconds={60}
            startedAt={evidenceRepair?.startedAt}
            fixedStage="슬라이드별 출처를 대조하는 중"
            completionLabel="근거 확인 예상 완료"
          />
        )}
        {deckQualityIssues.length > 0 && (
          <section className="mt-3 space-y-2" aria-labelledby="deck-quality-issues-title">
            <h3 id="deck-quality-issues-title" className="font-semibold">
              전체 구성에서 먼저 고칠 항목
            </h3>
            <ul className="space-y-1.5 rounded-lg border border-red-300/80 bg-background/80 p-3 text-foreground shadow-sm dark:border-red-900 dark:bg-background/60">
              {deckQualityIssues.map((issue, index) => (
                <li key={`${issue.code}-${issue.path}-${index}`} className="text-sm leading-relaxed">
                  {issue.message}
                </li>
              ))}
            </ul>
          </section>
        )}
        {slideIssueGroups.length > 0 && (
          <section
            className="mt-3 space-y-2"
            aria-labelledby="slide-quality-issues-title"
          >
            <h3 id="slide-quality-issues-title" className="font-semibold">
              {deckTitle?.trim() ? `‘${deckTitle.trim()}’에서 ` : ""}
              먼저 고칠 슬라이드
            </h3>
            <ol className="space-y-2">
              {slideIssueGroups.map((group) => (
                <li
                  key={group.index}
                  className="rounded-lg border border-red-300/80 bg-background/80 p-3 text-foreground shadow-sm dark:border-red-900 dark:bg-background/60"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 space-y-2">
                      <h4 className="font-semibold leading-snug">
                        <span className="mr-2 text-red-700 dark:text-red-300">
                          슬라이드 {group.index + 1}
                        </span>
                        <span className="break-words">{group.title}</span>
                      </h4>
                      <ul className="space-y-2">
                        {group.issues.map((issue, issueIndex) => {
                          const excerpt = issueExcerpt(issue);
                          return (
                            <li key={`${issue.code}-${issue.path}-${issueIndex}`}>
                              <p className="text-sm leading-relaxed">{issue.message}</p>
                              {excerpt && (
                                <blockquote className="mt-1 border-l-2 border-red-300 pl-2 text-xs leading-relaxed text-muted-foreground dark:border-red-800">
                                  문제 부분: “{excerpt}”
                                </blockquote>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    {onSelectSlide && (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11 shrink-0 bg-background"
                        onClick={() => onSelectSlide(group.index)}
                        disabled={selectionDisabled}
                        aria-label={`슬라이드 ${group.index + 1} ${group.title} 편집으로 이동`}
                      >
                        <Pencil className="h-4 w-4" aria-hidden="true" />
                        편집으로 이동
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        )}
        {qualityRepair && hasQualityRepairTargets && (
          <div className="mt-3 flex flex-col items-start gap-2 border-t border-current/15 pt-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-medium">문제 장의 내용·구성을 한 번에 다시 점검합니다.</p>
              {qualityRepair.message && (
                <p className="mt-0.5 text-xs leading-relaxed opacity-80">
                  {qualityRepair.message}
                </p>
              )}
            </div>
            <Button
              type="button"
              variant="outline"
              className="min-h-11 shrink-0 bg-background/80"
              onClick={qualityRepair.onRepair}
              disabled={qualityRepair.disabled || qualityBusy || evidenceBusy}
              aria-busy={qualityBusy}
            >
              {qualityBusy ? (
                <Loader2
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              {qualityBusy ? "문제 슬라이드 보완 중…" : "문제 슬라이드 AI로 보완"}
            </Button>
          </div>
        )}
        {qualityRepair?.message && !hasQualityRepairTargets && (
          <p className="mt-3 border-t border-current/15 pt-3 text-sm leading-relaxed opacity-85">
            {qualityRepair.message}
          </p>
        )}
        {!evidenceBusy && hasEvidenceIssues && evidenceRepair && (
          <div className="mt-3 space-y-2 border-t border-current/15 pt-3">
            <p className="text-sm font-medium">
              근거 확인이 필요한 슬라이드: {evidenceIssues.map((index) => index + 1).join(", ")}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              {evidenceIssues.map((index) => (
                <button
                  key={index}
                  type="button"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md border border-current/30 bg-background/70 px-3 font-semibold tabular-nums transition-colors hover:bg-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={() => onSelectSlide?.(index)}
                  disabled={selectionDisabled || !onSelectSlide}
                  aria-label={`근거 확인이 필요한 슬라이드 ${index + 1} 편집`}
                >
                  {index + 1}
                </button>
              ))}
              <Button
                type="button"
                variant="outline"
                className="min-h-11 bg-background/80"
                onClick={evidenceRepair.onRepair}
                disabled={evidenceRepair.disabled || qualityBusy}
              >
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                누락 근거 다시 보완
              </Button>
            </div>
            {evidenceRepair.message && (
              <p className="text-xs leading-relaxed opacity-80">{evidenceRepair.message}</p>
            )}
          </div>
        )}
        {blocked && needsReview && (
          <p className="mt-1 text-xs leading-relaxed opacity-75">
            차단하지 않는 추가 검토 항목: {quality?.warnings.join(" · ")}
          </p>
        )}
      </div>
    </div>
  );
}

export function SaveButton({ chrome }: { chrome: ResultChrome }) {
  const { saving, locked, outputBlocked, saved, loadedId, onSave } = chrome;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="min-h-12 gap-1.5"
      disabled={saving || locked || outputBlocked || saved}
      onClick={onSave}
      aria-busy={saving}
      aria-describedby={outputBlocked ? "generation-quality-summary" : undefined}
    >
      {saved ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : saving ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Save className="h-4 w-4" aria-hidden="true" />
      )}
      {saved ? "저장됨" : loadedId ? "수정 저장" : "저장"}
    </Button>
  );
}

export function EditToggleButton({ chrome }: { chrome: ResultChrome }) {
  return (
    <Button
      type="button"
      variant={chrome.editing ? "default" : "outline"}
      size="sm"
      className="min-h-12 gap-1.5"
      onClick={chrome.onToggleEdit}
      disabled={chrome.saving || chrome.locked}
    >
      {chrome.editing ? (
        <Check className="h-4 w-4" aria-hidden="true" />
      ) : (
        <Pencil className="h-4 w-4" aria-hidden="true" />
      )}
      {chrome.editing ? "완료" : "편집"}
    </Button>
  );
}

export function SourceBadges({ sources }: { sources: GeneratedDocSource[] }) {
  const visible = sources.slice(0, 5);
  return (
    <>
      {visible.map((s, i) => (
        <Badge key={i} variant="secondary" className="font-normal">
          {s.doc}
          {s.page != null && ` p.${s.page}`}
        </Badge>
      ))}
      {sources.length > visible.length && (
        <Badge variant="outline" className="font-normal">
          외 {sources.length - visible.length}개
        </Badge>
      )}
    </>
  );
}

/** 결과 카드 상단의 분야 색 액센트 바 */
export function AccentBar({ accent }: { accent: string }) {
  return <div className="h-1 w-full" style={{ backgroundColor: accent }} />;
}

/** 항목별 AI 재생성 상태·동작 (섹션/슬라이드 공용) */
export type RegenState = {
  openIndex: number | null;
  loadingIndex: number | null;
  text: string;
  onTextChange: (v: string) => void;
  onOpen: (index: number) => void;
  onClose: () => void;
  onApply: (index: number, instruction?: string) => void;
};

/** 편집 모드에서 항목별 재생성 컨트롤 (프리셋 + 직접 입력) */
export function RegenControls({ index, regen }: { index: number; regen: RegenState }) {
  const isOpen = regen.openIndex === index;
  const isLoading = regen.loadingIndex === index;

  if (!isOpen) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="min-h-12 gap-1.5 text-sm text-muted-foreground"
        disabled={regen.loadingIndex !== null}
        onClick={() => regen.onOpen(index)}
      >
        <RefreshCw className="h-4 w-4" aria-hidden="true" /> AI로 다시 생성
      </Button>
    );
  }

  const trimmed = regen.text.trim();
  return (
    <div className="space-y-2 rounded-md border border-dashed p-2">
      <div className="flex flex-wrap gap-1.5">
        {REGEN_INSTRUCTIONS.map((ins) => (
          <Button
            key={ins.key}
            type="button"
            variant="outline"
            size="sm"
            className="min-h-12 gap-1.5 text-sm"
            disabled={isLoading}
            onClick={() => regen.onApply(index, ins.text)}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
            {ins.label}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={regen.text}
          onChange={(e) => regen.onTextChange(e.target.value)}
          placeholder="직접 지시 (예: 표로 정리)"
          className="h-12 text-base sm:flex-1 md:h-10"
          disabled={isLoading}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed) regen.onApply(index, trimmed);
          }}
        />
        <Button
          type="button"
          size="sm"
          className="h-12 text-sm md:h-10"
          disabled={isLoading || !trimmed}
          onClick={() => regen.onApply(index, trimmed)}
        >
          적용
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-12 text-sm md:h-10"
          disabled={isLoading}
          onClick={regen.onClose}
        >
          닫기
        </Button>
      </div>
    </div>
  );
}

function expectedCompletionClock(timestampMs: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}

export function GenerationWaitStatus({
  estimatedSeconds,
  startedAt,
  endedAt,
  fixedStage,
  progress,
  persistent = false,
  dispatchPending = false,
  connectionRetry,
  completionLabel = "예상 완료",
}: {
  estimatedSeconds: number;
  startedAt?: number;
  endedAt?: number;
  fixedStage?: string;
  progress?: number;
  persistent?: boolean;
  dispatchPending?: boolean;
  connectionRetry?: { attempt: number; retryAt: number } | null;
  completionLabel?: string;
}) {
  const [fallbackBaseline] = useState(() => Date.now());
  const baseline = startedAt ?? fallbackBaseline;
  const [nowMs, setNowMs] = useState(baseline);

  useEffect(() => {
    setNowMs(endedAt ?? Date.now());
    if (endedAt) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [endedAt]);

  const effectiveNow = endedAt ?? nowMs;
  const elapsedSeconds = Math.max(0, Math.floor((effectiveNow - baseline) / 1_000));
  const remainingSeconds = Math.max(0, estimatedSeconds - elapsedSeconds);
  const overdue = elapsedSeconds >= estimatedSeconds;
  const stage = fixedStage ?? estimatedGenerationStage(elapsedSeconds, estimatedSeconds);
  const expectedClock = expectedCompletionClock(baseline + estimatedSeconds * 1_000);
  const safeProgress =
    typeof progress === "number" ? Math.max(0, Math.min(100, Math.floor(progress))) : null;
  const retrySeconds = connectionRetry
    ? Math.max(0, Math.ceil((connectionRetry.retryAt - nowMs) / 1_000))
    : null;

  return (
    <div className="mt-3 rounded-lg border border-current/15 bg-background/70 p-3 text-foreground">
      <div className="flex flex-col gap-1 text-xs sm:flex-row sm:items-center sm:justify-between">
        <span>
          경과 시간{" "}
          <time className="font-mono font-semibold tabular-nums" dateTime={`PT${elapsedSeconds}S`}>
            {formatElapsedSeconds(elapsedSeconds)}
          </time>
        </span>
        {!overdue && !endedAt && (
          <span className="font-medium">
            {completionLabel}{" "}
            <time dateTime={new Date(baseline + estimatedSeconds * 1_000).toISOString()}>
              {expectedClock}경
            </time>
          </span>
        )}
      </div>
      <p className="mt-2 text-sm font-semibold" aria-hidden="true">
        {fixedStage ? "현재 단계" : "예상 단계"} · {stage}
      </p>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {fixedStage ? "현재 진행 단계" : "예상 진행 단계"}: {stage}
      </p>
      {safeProgress !== null && (
        <div className="mt-2 space-y-1">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>서버 진행률</span>
            <span className="font-mono font-semibold tabular-nums">{safeProgress}%</span>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-label="자료 생성 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={safeProgress}
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
              style={{ width: `${safeProgress}%` }}
            />
          </div>
        </div>
      )}
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
        {endedAt
          ? `마지막 상태까지 ${formatApproximateDuration(elapsedSeconds)} 동안 처리했습니다.`
          : overdue
          ? "예상 시간을 넘겼지만 품질 점검과 보완은 계속됩니다. 완료될 때까지 현재 상태를 보존합니다."
          : `약 ${formatApproximateDuration(remainingSeconds)} 남음 · 통상 예상 ${formatApproximateDuration(estimatedSeconds)} 내외`}
      </p>
      {persistent && (
        <p className="mt-1 text-xs font-medium text-emerald-700 dark:text-emerald-300">
          서버 접수가 완료되어 화면을 닫아도 계속 진행됩니다. 이 주소를 다시 열면 현재 단계부터 확인할 수 있습니다.
        </p>
      )}
      {dispatchPending && (
        <p className="mt-1 text-xs font-medium text-amber-700 dark:text-amber-300">
          작업 번호를 보존했고 서버 접수·실행 연결을 확인하고 있습니다. 연결 완료 안내가 보일 때까지 이 화면을 유지해 주세요.
        </p>
      )}
      {connectionRetry && (
        <>
          <p
            className="mt-2 text-xs text-amber-700 dark:text-amber-300"
            aria-hidden="true"
          >
            서버 상태 연결을 다시 시도합니다 · {retrySeconds ?? 0}초 후 · {connectionRetry.attempt}번째
          </p>
          <p className="sr-only" role="status" aria-live="polite">
            서버 상태 연결이 잠시 지연되어 자동으로 다시 시도합니다.
          </p>
        </>
      )}
    </div>
  );
}

/** 생성 중 스켈레톤 — 정밀 모델 대기 중 경과시간과 보수적 완료 예상을 함께 보여준다. */
export function ResultSkeleton({
  accent,
  label,
  type,
  duration,
  job,
  connectionRetry,
  verifyingDelivery = false,
  retrying = false,
  onRetry,
}: {
  accent: string;
  label: string;
  type: TimedGenerationType;
  duration: Duration;
  job?: PublicGenerationJob | null;
  connectionRetry?: { attempt: number; retryAt: number } | null;
  verifyingDelivery?: boolean;
  retrying?: boolean;
  onRetry?: () => void;
}) {
  const estimatedSeconds = job?.estimatedSeconds ?? generationEstimateSeconds(type, duration);
  const terminalProblem =
    !verifyingDelivery &&
    (job?.status === "failed" ||
      job?.status === "needs_attention" ||
      (job?.status === "completed" && !job.qualityPassed));
  const startedAt = job ? Date.parse(job.startedAt ?? job.createdAt) : undefined;
  const endedAt = terminalProblem && job ? Date.parse(job.completedAt ?? job.updatedAt) : undefined;
  const statusTitle =
    job?.status === "needs_attention"
      ? "추가 품질 점검이 필요합니다"
      : job?.status === "completed"
        ? "품질 통과를 확인하지 못했습니다"
        : "자료 생성을 완료하지 못했습니다";
  return (
    <Card className="animate-in fade-in overflow-hidden border-border/60 shadow-sm duration-300">
      <AccentBar accent={accent} />
      {terminalProblem ? (
        <CardHeader className="space-y-2 pb-3">
          <div className="flex items-start gap-2 text-amber-800 dark:text-amber-200">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
            <div>
              <h2 className="font-semibold">{statusTitle}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {job?.errorMessage ??
                  "완료 기준을 통과하지 못했습니다. 저장된 작업 단계에서 다시 시도할 수 있습니다."}
              </p>
            </div>
          </div>
        </CardHeader>
      ) : (
        <CardHeader className="pb-3">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="mt-1 h-4 w-40" />
        </CardHeader>
      )}
      <CardContent className="space-y-5">
        {!terminalProblem && (
          <>
            {[0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-11/12" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))}
            <p className="text-center text-xs text-muted-foreground">
              {label}을(를) 만들고 있어요. 품질 기준을 통과할 때까지 단계별로 저장합니다.
            </p>
          </>
        )}
        <GenerationWaitStatus
          estimatedSeconds={estimatedSeconds}
          startedAt={Number.isFinite(startedAt) ? startedAt : undefined}
          endedAt={Number.isFinite(endedAt) ? endedAt : undefined}
          fixedStage={verifyingDelivery ? "서버 접수 상태를 확인하는 중" : job?.stage}
          progress={verifyingDelivery ? undefined : job?.progress}
          persistent={Boolean(
            job &&
              !terminalProblem &&
              !verifyingDelivery &&
              isGenerationJobDispatchConfirmed(job)
          )}
          dispatchPending={Boolean(
            verifyingDelivery ||
              (job && !terminalProblem && !isGenerationJobDispatchConfirmed(job))
          )}
          connectionRetry={connectionRetry}
          completionLabel={job ? "서버 예상 완료" : "1차 결과 예상 완료"}
        />
        {terminalProblem ? (
          <div className="space-y-2 border-t pt-4">
            <p className="text-xs leading-relaxed text-muted-foreground">
              완료 전 단계와 점검 기록은 서버에 남아 있습니다. 재시도해도 이미 저장된 작업은 잃지 않습니다.
            </p>
            {onRetry && (
              <Button type="button" className="min-h-11 w-full gap-2" disabled={retrying} onClick={onRetry}>
                {retrying ? (
                  <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : (
                  <RefreshCw className="h-4 w-4" aria-hidden="true" />
                )}
                {retrying ? "저장 지점 확인 중…" : "저장된 작업 다시 시도"}
              </Button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2 border-t pt-4 text-center text-[11px] text-muted-foreground">
            <span>1. 관련 교범 선별</span>
            <span>2. 현장형 초안 작성</span>
            <span>3. 누락·중복 점검</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
