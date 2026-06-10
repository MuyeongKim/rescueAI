"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { categoryStyle } from "@/lib/category";

export type DailyPoint = { date: string; count: number };
export type CategoryPoint = { category: string; count: number };

export function DailyQuestionsChart({ data }: { data: DailyPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11 }}
          tickFormatter={(d: string) => d.slice(5)}
          interval="preserveStartEnd"
          minTickGap={20}
        />
        <YAxis tick={{ fontSize: 11 }} allowDecimals={false} width={36} />
        <Tooltip
          labelFormatter={(d) => `${d}`}
          formatter={(v) => [`${v}건`, "질문"]}
        />
        <Bar
          dataKey="count"
          fill="hsl(var(--primary))"
          radius={[4, 4, 0, 0]}
          maxBarSize={28}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

export function CategoryCitationsChart({ data }: { data: CategoryPoint[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        인용 데이터가 아직 없습니다.
      </div>
    );
  }
  return (
    <ResponsiveContainer width="100%" height={260}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
      >
        <CartesianGrid strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
        <YAxis
          type="category"
          dataKey="category"
          tick={{ fontSize: 12 }}
          width={48}
        />
        <Tooltip formatter={(v) => [`${v}회`, "인용"]} />
        <Bar dataKey="count" radius={[0, 4, 4, 0]} maxBarSize={28}>
          {data.map((d, i) => (
            <Cell key={i} fill={categoryStyle(d.category).hex} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}
