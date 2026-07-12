import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

type StatusTone = "neutral" | "success" | "warning" | "danger";

const STATUS_STYLES: Record<StatusTone, { container: string; dot: string }> = {
  neutral: {
    container:
      "border-slate-300 bg-white text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200",
    dot: "bg-slate-400",
  },
  success: {
    container:
      "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-300",
    dot: "bg-emerald-600 dark:bg-emerald-400",
  },
  warning: {
    container:
      "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200",
    dot: "bg-amber-500",
  },
  danger: {
    container:
      "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/30 dark:text-red-300",
    dot: "bg-red-600 dark:bg-red-400",
  },
};

export function OperationalHeader({
  eyebrow,
  title,
  description,
  icon: Icon,
  status,
  statusTone = "neutral",
  statusPulse = false,
  className,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  status?: string;
  statusTone?: StatusTone;
  statusPulse?: boolean;
  className?: string;
}) {
  const statusStyle = STATUS_STYLES[statusTone];

  return (
    <header className={cn("border-b border-slate-300 pb-5 dark:border-slate-700", className)}>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[11px] font-bold text-primary">
            <span className="h-0.5 w-7 bg-primary" aria-hidden />
            {eyebrow}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center border border-slate-300 bg-white text-primary dark:border-slate-700 dark:bg-slate-900">
              <Icon className="h-4.5 w-4.5" aria-hidden />
            </span>
            <h1 className="text-2xl font-extrabold leading-tight text-slate-950 dark:text-slate-50">
              {title}
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            {description}
          </p>
        </div>
        {status && (
          <div
            className={cn(
              "flex min-h-10 shrink-0 items-center gap-2 self-start border px-3 text-xs font-semibold",
              statusStyle.container
            )}
          >
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                statusStyle.dot,
                statusPulse && "command-status-pulse"
              )}
              aria-hidden
            />
            {status}
          </div>
        )}
      </div>
    </header>
  );
}
