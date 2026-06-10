// 분야(카테고리)별 색 시스템.
// Tailwind purge가 클래스를 유지하도록 "전체 클래스 문자열"을 그대로 둔다(동적 조합 금지).

export type CategoryStyle = {
  badge: string; // 배지 배경/글자/테두리
  dot: string; // 색 점/막대
  tint: string; // 연한 배경(아이콘 원 등)
  text: string; // 글자색
  hex: string; // 차트용
};

const STYLES: Record<string, CategoryStyle> = {
  산악: {
    badge: "bg-emerald-100 text-emerald-700 border-emerald-200",
    dot: "bg-emerald-500",
    tint: "bg-emerald-100",
    text: "text-emerald-700",
    hex: "#10b981",
  },
  수난: {
    badge: "bg-sky-100 text-sky-700 border-sky-200",
    dot: "bg-sky-500",
    tint: "bg-sky-100",
    text: "text-sky-700",
    hex: "#0ea5e9",
  },
  화재: {
    badge: "bg-orange-100 text-orange-700 border-orange-200",
    dot: "bg-orange-500",
    tint: "bg-orange-100",
    text: "text-orange-700",
    hex: "#f97316",
  },
  구급: {
    badge: "bg-rose-100 text-rose-700 border-rose-200",
    dot: "bg-rose-500",
    tint: "bg-rose-100",
    text: "text-rose-700",
    hex: "#f43f5e",
  },
};

const FALLBACK: CategoryStyle = {
  badge: "bg-secondary text-secondary-foreground border-transparent",
  dot: "bg-muted-foreground",
  tint: "bg-muted",
  text: "text-muted-foreground",
  hex: "#64748b",
};

export function categoryStyle(category?: string | null): CategoryStyle {
  return (category && STYLES[category]) || FALLBACK;
}
