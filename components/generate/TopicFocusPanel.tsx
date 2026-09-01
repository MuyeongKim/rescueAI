"use client";

import type { RefObject } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

import type { TrainingFocusOption } from "@/lib/generate-focus";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type TopicFocusPanelStatus = "loading" | "refreshing" | "choosing" | "error";

export function TopicFocusPanel({
  topic,
  status,
  options,
  recommendedId,
  selectedId,
  customValue,
  historyCompared,
  warnings,
  error,
  selectionError,
  disabled = false,
  headingRef,
  onSelect,
  onCustomValueChange,
  onRefresh,
  onBypass,
}: {
  topic: string;
  status: TopicFocusPanelStatus;
  options: readonly TrainingFocusOption[];
  recommendedId?: string;
  selectedId?: string;
  customValue: string;
  historyCompared: boolean;
  warnings: readonly string[];
  error?: string;
  selectionError?: string;
  disabled?: boolean;
  headingRef: RefObject<HTMLHeadingElement>;
  onSelect: (id: string) => void;
  onCustomValueChange: (value: string) => void;
  onRefresh: () => void;
  onBypass: () => void;
}) {
  const busy = status === "loading" || status === "refreshing";
  const interactionLocked = busy || disabled;
  const headingText =
    status === "loading"
      ? `‘${topic}’의 세부 방향을 찾고 있습니다`
      : status === "refreshing"
        ? "겹침이 적은 다른 세부 방향을 찾고 있습니다"
        : status === "error"
          ? "세부 훈련 방향을 찾지 못했습니다"
          : `‘${topic}’의 세부 방향을 선택하세요`;
  const liveMessage =
    status === "loading"
      ? "세부 훈련 방향을 찾고 있습니다."
      : status === "refreshing"
        ? "겹침이 적은 다른 훈련 방향을 찾고 있습니다."
        : `${options.length}개의 세부 훈련 방향을 제안했습니다.`;

  return (
    <section
      className="scroll-mt-24 space-y-3 rounded-xl border border-primary/20 bg-primary/[0.035] p-3.5 sm:p-4"
      aria-busy={busy}
      aria-labelledby="topic-focus-heading"
    >
      <div className="space-y-1">
        <h3
          id="topic-focus-heading"
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {headingText}
        </h3>
        <p className="text-sm leading-relaxed text-muted-foreground">
          연결된 교범과 최근 저장 자료를 바탕으로, 겹침이 적고 근거가 확인되는 방향만
          제안합니다. 추천 순위까지 확인된 경우 가장 잘 맞는 방향을 별도로 표시합니다.
        </p>
      </div>

      <div className="flex items-start gap-2 rounded-lg bg-background/80 px-3 py-2.5 text-sm leading-relaxed text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <p>
          모든 방향에 SOP·표준절차의 적용 여부와 근거 상태, 역할 분담, 안전 확인,
          중단·보고 기준, 평가 항목을 공통으로 포함합니다.
        </p>
      </div>

      {status !== "error" && (
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveMessage}
        </p>
      )}

      {status === "error" ? (
        <div className="space-y-3">
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>{error ?? "세부 훈련 방향을 찾지 못했습니다."}</p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-12"
              onClick={onRefresh}
              disabled={interactionLocked}
            >
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              다시 시도
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-12"
              onClick={onBypass}
              disabled={interactionLocked}
            >
              입력한 주제로 종합훈련 만들기
            </Button>
          </div>
        </div>
      ) : (
        <>
          {error && (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <p>{error}</p>
            </div>
          )}

          <fieldset
            disabled={interactionLocked}
            className="space-y-2.5"
            aria-invalid={Boolean(selectionError)}
            aria-describedby={
              selectionError
                ? selectedId === "custom"
                  ? "custom-topic-focus-help"
                  : "topic-focus-selection-error"
                : undefined
            }
          >
            <legend className="sr-only">세부 훈련 방향</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(busy && options.length === 0
                ? Array.from({ length: 4 }, (_, index) => ({
                    id: `skeleton-${index}`,
                    title: "",
                    description: "",
                    sourceRefs: [],
                  }))
                : options
              ).map((option) => {
                const skeleton = option.id.startsWith("skeleton-");
                if (skeleton) {
                  return (
                    <div
                      key={option.id}
                      className="min-h-24 animate-pulse rounded-lg border border-border bg-background p-3 motion-reduce:animate-none"
                      aria-hidden="true"
                    >
                      <div className="h-4 w-2/3 rounded bg-muted" />
                      <div className="mt-3 h-3 w-full rounded bg-muted" />
                      <div className="mt-2 h-3 w-4/5 rounded bg-muted" />
                    </div>
                  );
                }
                const inputId = `topic-focus-${option.id}`;
                const selected = selectedId === option.id;
                // 데모·이전 응답처럼 추천 순위를 확인할 수 없는 경우에는 임의 표시하지 않는다.
                const recommended = recommendedId === option.id;
                return (
                  <div key={option.id} className="relative">
                    <input
                      id={inputId}
                      type="radio"
                      name="topic-focus"
                      value={option.id}
                      checked={selectedId === option.id}
                      onChange={() => onSelect(option.id)}
                      className="peer sr-only"
                    />
                    <Label
                      htmlFor={inputId}
                      className={cn(
                        "flex min-h-24 flex-col rounded-lg border bg-background p-3 text-left transition-colors",
                        "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
                        busy
                          ? "cursor-wait opacity-70"
                          : "cursor-pointer hover:border-primary/50",
                        "peer-checked:border-primary peer-checked:bg-primary/5"
                      )}
                    >
                      <span className="flex flex-col items-start gap-1 sm:flex-row sm:justify-between sm:gap-2">
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span className="text-sm font-semibold leading-snug text-foreground">
                            {option.title}
                          </span>
                          {recommended && (
                            <span className="shrink-0 whitespace-nowrap rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-xs font-semibold leading-none text-primary">
                              (추천)
                            </span>
                          )}
                        </span>
                        {selected && (
                          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
                            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                            선택됨
                          </span>
                        )}
                      </span>
                      <span className="mt-1 text-sm font-normal leading-relaxed text-muted-foreground">
                        {option.description}
                      </span>
                      <span
                        className={cn(
                          "mt-auto pt-2 text-xs font-medium",
                          historyCompared
                            ? "text-emerald-700 dark:text-emerald-300"
                            : "text-amber-700 dark:text-amber-300"
                        )}
                      >
                        {historyCompared
                          ? "최근 세부 방향과 겹침 적음"
                          : "최근 저장 자료 비교 미완료"}
                      </span>
                    </Label>
                  </div>
                );
              })}

              <div className="relative">
                <input
                  id="topic-focus-custom"
                  type="radio"
                  name="topic-focus"
                  value="custom"
                  checked={selectedId === "custom"}
                  onChange={() => onSelect("custom")}
                  className="peer sr-only"
                />
                <Label
                  htmlFor="topic-focus-custom"
                  className={cn(
                    "flex min-h-24 flex-col rounded-lg border bg-background p-3 text-left transition-colors",
                    "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
                    busy
                      ? "cursor-wait opacity-70"
                      : "cursor-pointer hover:border-primary/50",
                    "peer-checked:border-primary peer-checked:bg-primary/5"
                  )}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      직접 세부 방향 입력
                    </span>
                    {selectedId === "custom" && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-primary">
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                        선택됨
                      </span>
                    )}
                  </span>
                  <span className="mt-1 text-sm font-normal leading-relaxed text-muted-foreground">
                    계획한 상황이나 수행 역량이 따로 있다면 직접 지정합니다.
                  </span>
                </Label>
              </div>
            </div>
          </fieldset>

          {selectedId === "custom" && !busy && (
            <div className="space-y-1.5">
              <Label htmlFor="custom-topic-focus" className="text-sm font-medium">
                직접 입력할 세부 방향
              </Label>
              <Input
                id="custom-topic-focus"
                value={customValue}
                onChange={(event) => onCustomValueChange(event.target.value)}
                maxLength={100}
                placeholder="예: 야간 조난자 수색구역 설정과 대원 추적"
                aria-invalid={Boolean(selectionError)}
                aria-describedby="custom-topic-focus-help"
                className="h-12 text-base md:h-10"
              />
              <p
                id="custom-topic-focus-help"
                role={selectionError ? "alert" : undefined}
                className={cn(
                  "text-sm",
                  selectionError ? "font-medium text-destructive" : "text-muted-foreground"
                )}
              >
                {selectionError ?? "두 글자 이상 구체적으로 입력해 주세요."}
              </p>
            </div>
          )}

          {selectionError && selectedId !== "custom" && (
            <p
              id="topic-focus-selection-error"
              role="alert"
              className="text-sm font-medium text-destructive"
            >
              {selectionError}
            </p>
          )}

          {warnings.length > 0 && (
            <ul className="space-y-1 text-sm leading-relaxed text-amber-700 dark:text-amber-300">
              {warnings.map((warning) => (
                <li key={warning}>· {warning}</li>
              ))}
            </ul>
          )}

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-12"
              onClick={onRefresh}
              disabled={interactionLocked}
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
              )}
              다른 방향 추천
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-12"
              onClick={onBypass}
              disabled={interactionLocked}
            >
              입력한 주제로 종합훈련 만들기
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
