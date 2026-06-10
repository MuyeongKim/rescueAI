"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { WeeklyPoint } from "@/lib/fitness";

// 최근 8주 주간 마일리지 추이 차트.
export function WeeklyMileageChart({ data }: { data: WeeklyPoint[] }) {
  if (data.every((d) => d.points === 0)) {
    return (
      <div className="flex h-[220px] items-center justify-center text-sm text-muted-foreground">
        아직 표시할 기록이 없습니다.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      {/* left 음수 마진 금지 — Y축 라벨이 3자리(예: 240)일 때 앞자리가 잘린다 */}
      <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="week" tick={{ fontSize: 11 }} />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={36} />
        <Tooltip
          labelFormatter={(w) => `${w} 주`}
          formatter={(v) => [`${v}점`, "마일리지"]}
        />
        <Bar
          dataKey="points"
          fill="hsl(var(--primary))"
          radius={[4, 4, 0, 0]}
          maxBarSize={32}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}
