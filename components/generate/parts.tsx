"use client";

// AI 자료제작 화면의 공용 조각들 — 입력 폼(GenerateForm)과 결과 카드들이 함께 쓴다.
import {
  Check,
  CircleCheck,
  Loader2,
  Pencil,
  RefreshCw,
  Save,
  TriangleAlert,
} from "lucide-react";

import { REGEN_INSTRUCTIONS, type GeneratedDocSource } from "@/lib/generate";
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
};

export function QualityBanner({ quality }: { quality?: GenerationQuality | null }) {
  if (!quality?.checked) return null;

  const errors = quality.errors ?? [];
  const blocked = errors.length > 0;
  const needsReview = quality.warnings.length > 0;
  const Icon = blocked || needsReview ? TriangleAlert : CircleCheck;
  return (
    <div
      role={blocked ? "alert" : "status"}
      className={cn(
        "flex gap-2.5 border-l-4 px-3 py-2.5 text-sm",
        blocked
          ? "border-l-red-600 bg-red-50 text-red-950 dark:bg-red-950/30 dark:text-red-100"
          : needsReview
          ? "border-l-amber-500 bg-amber-50 text-amber-950 dark:bg-amber-950/30 dark:text-amber-100"
          : "border-l-emerald-600 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/30 dark:text-emerald-100"
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <div className="min-w-0">
        <p className="font-semibold">
          {blocked
            ? "핵심 품질 오류가 있어 저장·내보내기가 잠겼습니다"
            : quality.repaired
              ? "초안을 한 번 보완하고 자동 점검했습니다"
              : "초안 구성을 자동 점검했습니다"}
        </p>
        <p className="mt-0.5 text-sm leading-relaxed opacity-80">
          {blocked
            ? `먼저 수정할 항목: ${errors.join(" · ")}. 편집하거나 해당 부분을 AI로 다시 생성해 주세요.`
            : needsReview
            ? `최종 확인이 필요한 항목: ${quality.warnings.join(" · ")}`
            : "필수 구성과 교육 흐름을 확인했습니다. 현장 적용 전 내용과 수치는 최종 검토해 주세요."}
        </p>
        {blocked && needsReview && (
          <p className="mt-1 text-xs leading-relaxed opacity-75">
            차단하지 않는 추가 검토 항목: {quality.warnings.join(" · ")}
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
      title={outputBlocked ? "핵심 품질 오류를 수정한 뒤 저장할 수 있습니다." : undefined}
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

/** 생성 중 스켈레톤 — 수십 초 대기를 채우는 미리보기 골격 */
export function ResultSkeleton({ accent, label }: { accent: string; label: string }) {
  return (
    <Card className="animate-in fade-in overflow-hidden border-border/60 shadow-sm duration-300">
      <AccentBar accent={accent} />
      <CardHeader className="pb-3">
        <Skeleton className="h-5 w-2/3" />
        <Skeleton className="mt-1 h-4 w-40" />
      </CardHeader>
      <CardContent className="space-y-5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-4/5" />
          </div>
        ))}
        <p className="text-center text-xs text-muted-foreground">
          {label}을(를) 만들고 있어요. 잠시만 기다려 주세요.
        </p>
        <div className="grid grid-cols-3 gap-2 border-t pt-4 text-center text-[11px] text-muted-foreground">
          <span>1. 관련 교범 선별</span>
          <span>2. 현장형 초안 작성</span>
          <span>3. 누락·중복 점검</span>
        </div>
      </CardContent>
    </Card>
  );
}
