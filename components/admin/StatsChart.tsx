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

const chartGrid = "hsl(var(--border))";
const chartText = "hsl(var(--muted-foreground))";
const chartSurface = "hsl(var(--popover))";
const chartForeground = "hsl(var(--popover-foreground))";

function ChartEmptyState({ message }: { message: string }) {
  return (
    <div
      role="status"
      className="flex h-[260px] items-center justify-center text-sm text-muted-foreground"
    >
      {message}
    </div>
  );
}

export function DailyQuestionsChart({ data }: { data: DailyPoint[] }) {
  if (data.length === 0) {
    return <ChartEmptyState message="질문 데이터가 아직 없습니다." />;
  }

  const total = data.reduce((sum, point) => sum + point.count, 0);
  const peak = data.reduce((current, point) =>
    point.count > current.count ? point : current
  );
  const summary = `최근 ${data.length}일 동안 질문 ${total.toLocaleString("ko-KR")}건, 가장 많은 날은 ${peak.date} ${peak.count.toLocaleString("ko-KR")}건입니다.`;

  return (
    <figure className="space-y-3">
      <div className="h-[260px]" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
          >
            <CartesianGrid stroke={chartGrid} strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: chartText }}
              tickFormatter={(d: string) => d.slice(5)}
              interval="preserveStartEnd"
              minTickGap={20}
              axisLine={{ stroke: chartGrid }}
              tickLine={{ stroke: chartGrid }}
            />
            <YAxis
              tick={{ fontSize: 11, fill: chartText }}
              allowDecimals={false}
              width={36}
              axisLine={{ stroke: chartGrid }}
              tickLine={{ stroke: chartGrid }}
            />
            <Tooltip
              labelFormatter={(d) => `${d}`}
              formatter={(v) => [`${v}건`, "질문"]}
              cursor={{ fill: "hsl(var(--muted) / 0.6)" }}
              contentStyle={{
                backgroundColor: chartSurface,
                borderColor: chartGrid,
                color: chartForeground,
              }}
              labelStyle={{ color: chartForeground }}
            />
            <Bar
              dataKey="count"
              fill="hsl(var(--primary))"
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
      <details className="rounded-md border bg-muted/20">
        <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          일별 수치를 표로 보기
        </summary>
        <div className="max-h-72 overflow-auto border-t">
          <table className="w-full text-sm">
            <caption className="sr-only">최근 일별 질문수</caption>
            <thead className="sticky top-0 bg-card">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  날짜
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  질문수
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.date} className="border-t">
                  <td className="px-3 py-2">{point.date}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {point.count.toLocaleString("ko-KR")}건
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

export function CategoryCitationsChart({ data }: { data: CategoryPoint[] }) {
  if (data.length === 0) {
    return <ChartEmptyState message="인용 데이터가 아직 없습니다." />;
  }

  const top = data.reduce((current, point) =>
    point.count > current.count ? point : current
  );
  const total = data.reduce((sum, point) => sum + point.count, 0);
  const summary = `${data.length}개 분야에서 총 ${total.toLocaleString("ko-KR")}회 인용되었으며, 가장 많이 인용된 분야는 ${top.category} ${top.count.toLocaleString("ko-KR")}회입니다.`;

  return (
    <figure className="space-y-3">
      <div className="h-[260px]" aria-hidden="true">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 8, right: 16, left: 8, bottom: 0 }}
          >
            <CartesianGrid stroke={chartGrid} strokeDasharray="3 3" horizontal={false} />
            <XAxis
              type="number"
              tick={{ fontSize: 11, fill: chartText }}
              allowDecimals={false}
              axisLine={{ stroke: chartGrid }}
              tickLine={{ stroke: chartGrid }}
            />
            <YAxis
              type="category"
              dataKey="category"
              tick={{ fontSize: 12, fill: chartText }}
              width={64}
              axisLine={{ stroke: chartGrid }}
              tickLine={{ stroke: chartGrid }}
            />
            <Tooltip
              formatter={(v) => [`${v}회`, "인용"]}
              cursor={{ fill: "hsl(var(--muted) / 0.6)" }}
              contentStyle={{
                backgroundColor: chartSurface,
                borderColor: chartGrid,
                color: chartForeground,
              }}
              labelStyle={{ color: chartForeground }}
            />
            <Bar
              dataKey="count"
              radius={[0, 4, 4, 0]}
              maxBarSize={28}
              isAnimationActive={false}
            >
              {data.map((point) => (
                <Cell
                  key={point.category}
                  fill={categoryStyle(point.category).hex}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
      <details className="rounded-md border bg-muted/20">
        <summary className="min-h-11 cursor-pointer px-3 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          분야별 수치를 표로 보기
        </summary>
        <div className="overflow-auto border-t">
          <table className="w-full text-sm">
            <caption className="sr-only">분야별 자료 인용수</caption>
            <thead className="bg-card">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-semibold">
                  분야
                </th>
                <th scope="col" className="px-3 py-2 text-right font-semibold">
                  인용수
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.category} className="border-t">
                  <td className="px-3 py-2">{point.category}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {point.count.toLocaleString("ko-KR")}회
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}
