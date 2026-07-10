import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// 통계/요약 지표 카드 — 관리자 대시보드·체력단련에서 공용.
export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="border-t-2 border-t-slate-800 dark:border-t-slate-200">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 p-4 pb-2">
        <CardTitle className="text-xs font-semibold text-muted-foreground">
          {label}
        </CardTitle>
        <span className="flex h-8 w-8 items-center justify-center border border-slate-200 text-primary dark:border-slate-700">
          <Icon className="h-4 w-4" />
        </span>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="text-2xl font-black tabular-nums">{value}</div>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}
