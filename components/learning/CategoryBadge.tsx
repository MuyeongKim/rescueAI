import { cn } from "@/lib/utils";
import { categoryStyle } from "@/lib/category";

// 분야 색이 적용된 배지. category가 없으면 회색 fallback.
export function CategoryBadge({
  category,
  className,
}: {
  category: string | null | undefined;
  className?: string;
}) {
  const s = categoryStyle(category);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        s.badge,
        className
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", s.dot)} aria-hidden />
      {category || "기타"}
    </span>
  );
}
