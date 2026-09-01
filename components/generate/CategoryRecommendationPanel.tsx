"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Sparkles,
} from "lucide-react";

import { categoryStyle } from "@/lib/category";
import type {
  CategoryRecommendationConfidence,
  CategoryRecommendationSource as InferredCategoryRecommendationSource,
} from "@/lib/generate-category";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

export type CategoryRecommendationStatus = "idle" | "loading" | "ready" | "error";
export type CategoryRecommendationSource =
  | InferredCategoryRecommendationSource
  | "saved"
  | "manual";

function orderedCategoryOptions(
  categories: readonly string[],
  category: string,
  alternatives: readonly string[]
): string[] {
  return Array.from(new Set([category, ...alternatives, ...categories])).filter(Boolean);
}

export function CategoryRecommendationPanel({
  topic,
  status,
  category,
  confidence,
  source,
  confirmed,
  alternatives,
  warning,
  error,
  categories,
  pickerOpen,
  disabled,
  onConfirm,
  onTogglePicker,
  onSelect,
  onRetry,
}: {
  topic: string;
  status: CategoryRecommendationStatus;
  category?: string;
  confidence?: CategoryRecommendationConfidence;
  source?: CategoryRecommendationSource;
  confirmed: boolean;
  alternatives: readonly string[];
  warning?: string;
  error?: string;
  categories: readonly string[];
  pickerOpen: boolean;
  disabled: boolean;
  onConfirm: () => void;
  onTogglePicker: () => void;
  onSelect: (category: string) => void;
  onRetry: () => void;
}) {
  const trimmedTopic = topic.trim();
  if (trimmedTopic.length < 2) {
    return (
      <span id="category-recommendation-heading" className="sr-only">
        주제를 두 글자 이상 입력하면 분야를 자동 추천합니다.
      </span>
    );
  }

  const automatic = source === "deterministic" || source === "model";
  const lowConfidence = confidence === "low";
  const needsConfirmation = !confirmed;
  const categoryOptions = orderedCategoryOptions(categories, category ?? "", alternatives);
  const liveMessage =
    status === "loading"
      ? "입력한 주제에 맞는 분야를 확인하고 있습니다."
      : status === "ready" && category
        ? confirmed
          ? `${category} 분야로 확인했습니다.`
          : `${category} 분야를 추천했습니다. 확인이 필요합니다.`
        : status === "error"
          ? error ?? "분야를 자동으로 확인하지 못했습니다."
          : "주제 입력을 마치면 분야를 자동으로 확인합니다.";

  return (
    <section
      className="space-y-2.5 rounded-lg border border-border/80 bg-background/80 p-3"
      aria-labelledby="category-recommendation-heading"
      aria-busy={status === "loading"}
    >
      {status !== "error" && (
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {liveMessage}
        </p>
      )}

      {status === "loading" ? (
        <div className="flex min-h-12 items-center gap-2 text-sm text-muted-foreground">
          <Loader2
            className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div>
            <p id="category-recommendation-heading" className="font-semibold text-foreground">
              주제에 맞는 분야를 확인하고 있습니다
            </p>
            <p className="mt-0.5 text-xs leading-relaxed">
              연결된 교범의 분야 안에서 가장 관련 있는 범위를 찾습니다.
            </p>
          </div>
        </div>
      ) : status === "ready" && category ? (
        <div className="space-y-2.5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p
                id="category-recommendation-heading"
                className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-muted-foreground"
              >
                {automatic ? "자동 추천 분야" : "선택한 분야"}
                {automatic && (
                  <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                    (추천)
                  </span>
                )}
              </p>
              <div className="mt-1 flex min-w-0 items-center gap-2">
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: categoryStyle(category).hex }}
                  aria-hidden="true"
                />
                <p className="break-words text-base font-semibold text-foreground">{category}</p>
              </div>
              <p
                className={cn(
                  "mt-1 flex items-start gap-1.5 text-xs leading-relaxed",
                  confirmed
                    ? "text-emerald-700 dark:text-emerald-300"
                    : "text-amber-700 dark:text-amber-300"
                )}
              >
                {confirmed ? (
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                )}
                <span>
                  {confirmed
                    ? "이 분야의 교범과 SOP를 기준으로 자료를 구성합니다."
                    : lowConfidence
                      ? "주제가 여러 분야에 걸칠 수 있어 추천 결과를 한 번 확인해 주세요."
                      : "추천 분야를 확인하거나 다른 분야로 변경해 주세요."}
                </span>
              </p>
            </div>
            <div className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2">
              {needsConfirmation && (
                <Button
                  id="category-recommendation-confirm"
                  type="button"
                  className="min-h-12"
                  disabled={disabled}
                  onClick={onConfirm}
                >
                  {lowConfidence ? "추천 분야 확인" : "이 분야로 사용"}
                </Button>
              )}
              <Button
                id="category-recommendation-change"
                type="button"
                variant="outline"
                className="min-h-12 gap-1.5"
                aria-expanded={pickerOpen}
                aria-controls="category-manual-options"
                disabled={disabled}
                onClick={onTogglePicker}
              >
                분야 변경
                <ChevronDown
                  className={cn(
                    "h-4 w-4 transition-transform motion-reduce:transition-none",
                    pickerOpen && "rotate-180"
                  )}
                  aria-hidden="true"
                />
              </Button>
            </div>
          </div>
          {warning && (
            <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-300">
              {warning}
            </p>
          )}
        </div>
      ) : status === "error" ? (
        <div className="space-y-2.5">
          <div
            role="alert"
            className="flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200"
          >
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <div>
              <p id="category-recommendation-heading" className="font-semibold">
                분야를 자동으로 확인하지 못했습니다
              </p>
              <p className="mt-0.5 text-xs leading-relaxed">
                {error ?? "다시 시도하거나 아래에서 분야를 직접 골라 주세요."}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              className="min-h-12"
              disabled={disabled}
              onClick={onRetry}
            >
              다시 확인
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-12"
              aria-expanded={pickerOpen}
              aria-controls="category-manual-options"
              disabled={disabled}
              onClick={onTogglePicker}
            >
              분야 직접 선택
            </Button>
          </div>
        </div>
      ) : (
        <button
          id="category-recommendation-heading"
          type="button"
          className="flex min-h-12 w-full items-center gap-2 rounded-md px-1 text-left text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          disabled={disabled}
          onClick={onRetry}
        >
          <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
          <span>
            입력을 마쳤다면 눌러서 <strong className="text-foreground">추천 분야</strong>를
            확인할 수 있습니다.
          </span>
        </button>
      )}

      {pickerOpen && (
        <fieldset id="category-manual-options" className="border-t border-border/70 pt-2.5">
          <legend className="px-1 text-xs font-semibold text-muted-foreground">
            분야 직접 변경
          </legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {categoryOptions.map((option, index) => {
              const active = category === option && confirmed;
              const style = categoryStyle(option);
              const inputId = `training-category-option-${index}`;
              return (
                <div key={option} className="relative">
                  <input
                    id={inputId}
                    type="radio"
                    name="training-category"
                    value={option}
                    checked={active}
                    disabled={disabled}
                    onChange={() => onSelect(option)}
                    className="peer sr-only"
                  />
                  <Label
                    htmlFor={inputId}
                    style={
                      active
                        ? {
                            borderColor: style.hex,
                            color: style.hex,
                            backgroundColor: `${style.hex}14`,
                          }
                        : undefined
                    }
                    className={cn(
                      "inline-flex min-h-12 cursor-pointer items-center gap-2 rounded-full border px-4 text-sm font-medium transition-colors motion-reduce:transition-none",
                      "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
                      active
                        ? "shadow-sm"
                        : "border-border bg-background text-foreground hover:bg-accent/40",
                      "peer-disabled:cursor-not-allowed peer-disabled:opacity-50"
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: style.hex }}
                      aria-hidden="true"
                    />
                    <span>{option}</span>
                    {active && (
                      <CheckCircle2 className="h-4 w-4 shrink-0" aria-label="선택됨" />
                    )}
                  </Label>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
    </section>
  );
}
