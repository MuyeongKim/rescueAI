import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function OperationalHeader({
  eyebrow,
  title,
  description,
  icon: Icon,
  status,
  className,
}: {
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  status?: string;
  className?: string;
}) {
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
          <div className="flex min-h-10 shrink-0 items-center gap-2 self-start border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <span className="command-status-pulse h-2 w-2 rounded-full bg-emerald-600" aria-hidden />
            {status}
          </div>
        )}
      </div>
    </header>
  );
}
