"use client";

// AI 자료제작 화면의 공용 조각들 — 입력 폼(GenerateForm)과 결과 카드들이 함께 쓴다.
import { Check, Loader2, Pencil, RefreshCw, Save } from "lucide-react";

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
      <h2 className="text-sm font-semibold">{title}</h2>
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
  saved: boolean;
  loadedId: number | null;
  onSave: () => void;
};

export function SaveButton({ chrome }: { chrome: ResultChrome }) {
  const { saving, saved, loadedId, onSave } = chrome;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      disabled={saving || saved}
      onClick={onSave}
    >
      {saved ? (
        <Check className="h-4 w-4" />
      ) : saving ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Save className="h-4 w-4" />
      )}
      {saved ? "저장됨" : loadedId ? "수정 저장" : "저장"}
    </Button>
  );
}

export function EditToggleButton({ chrome }: { chrome: ResultChrome }) {
  return (
    <Button
      variant={chrome.editing ? "default" : "outline"}
      size="sm"
      className="gap-1.5"
      onClick={chrome.onToggleEdit}
    >
      {chrome.editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
      {chrome.editing ? "완료" : "편집"}
    </Button>
  );
}

export function SourceBadges({ sources }: { sources: GeneratedDocSource[] }) {
  return (
    <>
      {sources.map((s, i) => (
        <Badge key={i} variant="secondary" className="font-normal">
          {s.doc}
          {s.page != null && ` p.${s.page}`}
        </Badge>
      ))}
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
        className="h-8 gap-1.5 text-xs text-muted-foreground"
        disabled={regen.loadingIndex !== null}
        onClick={() => regen.onOpen(index)}
      >
        <RefreshCw className="h-3.5 w-3.5" /> AI로 다시 생성
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
            className="h-8 gap-1 text-xs"
            disabled={isLoading}
            onClick={() => regen.onApply(index, ins.text)}
          >
            {isLoading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {ins.label}
          </Button>
        ))}
      </div>
      <div className="flex gap-1.5">
        <Input
          value={regen.text}
          onChange={(e) => regen.onTextChange(e.target.value)}
          placeholder="직접 지시 (예: 표로 정리)"
          className="h-8 text-xs"
          disabled={isLoading}
          onKeyDown={(e) => {
            if (e.key === "Enter" && trimmed) regen.onApply(index, trimmed);
          }}
        />
        <Button
          type="button"
          size="sm"
          className="h-8 text-xs"
          disabled={isLoading || !trimmed}
          onClick={() => regen.onApply(index, trimmed)}
        >
          적용
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 text-xs"
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
          {label}을(를) 만들고 있어요… 자료를 근거로 구성 중입니다.
        </p>
      </CardContent>
    </Card>
  );
}
