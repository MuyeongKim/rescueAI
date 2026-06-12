import { redirect } from "next/navigation";
import { BarChart3, FileSpreadsheet, Lightbulb } from "lucide-react";

import { getUserAndProfile, isAdmin } from "@/lib/auth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const dynamic = "force-dynamic";

// 목 데이터 — 출동 로우데이터(엑셀) 업로드 → 자동 분석 연동 전 자리표시.
// TF 구성안 "기간/유형별 출동통계 자동 분석 → 시기·지역별 권장 훈련 근거 제공"
const BY_TYPE = [
  { type: "화재", count: 312 },
  { type: "교통사고", count: 287 },
  { type: "수난", count: 145 },
  { type: "산악", count: 132 },
  { type: "기타(동물 등)", count: 421 },
];

const BY_MONTH = [
  { month: "1월", count: 96 },
  { month: "2월", count: 88 },
  { month: "3월", count: 105 },
  { month: "4월", count: 118 },
  { month: "5월", count: 134 },
  { month: "6월", count: 152 },
  { month: "7월", count: 171 },
  { month: "8월", count: 168 },
  { month: "9월", count: 139 },
  { month: "10월", count: 127 },
  { month: "11월", count: 102 },
  { month: "12월", count: 97 },
];

const INSIGHTS = [
  "6~8월 수난 출동이 연평균 대비 2.3배 — 6월 중 수난(급류·스로백) 훈련 권장",
  "10~11월 산악 출동 증가(단풍철) — 9월 말 산악 로프구조 훈련 권장",
  "동절기(12~2월) 화재 출동 비중 41% — 11월 공기호흡기·내화 진입 훈련 권장",
];

function BarRow({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.max(4, Math.round((value / max) * 100));
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-sm">{label}</span>
      <div className="h-5 flex-1 overflow-hidden rounded bg-muted">
        <div
          className="h-full rounded bg-primary/70"
          style={{ width: `${pct}%` }}
          aria-hidden
        />
      </div>
      <span className="w-12 shrink-0 text-right text-sm tabular-nums">{value}</span>
    </div>
  );
}

export default async function AdminDispatchPage() {
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const maxType = Math.max(...BY_TYPE.map((d) => d.count));
  const maxMonth = Math.max(...BY_MONTH.map((d) => d.count));

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <BarChart3 className="h-5 w-5 text-primary" /> 출동통계 분석
        </h1>
        <p className="text-sm text-muted-foreground">
          출동 로우데이터를 업로드하면 기간·유형별로 자동 분석해 권장 훈련의
          과학적 근거를 제공합니다.
        </p>
      </div>

      <p className="rounded-lg border border-dashed bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        ⚠️ 예시 데이터입니다 — 엑셀 업로드·자동 분석 연동 예정입니다. 민감정보가
        포함된 원본은 내부망에서만 처리합니다.
      </p>

      {/* 업로드 (연동 예정) */}
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-6 text-center">
          <FileSpreadsheet className="h-8 w-8 text-muted-foreground" />
          <div>
            <p className="font-medium">출동 로우데이터 업로드</p>
            <p className="text-sm text-muted-foreground">
              분기별 엑셀 파일을 올리면 자동으로 분석·시각화됩니다.
            </p>
          </div>
          <Button className="h-11" disabled>
            엑셀 업로드 — 연동 예정
          </Button>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 유형별 분포 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">유형별 출동 (연간)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {BY_TYPE.map((d) => (
              <BarRow key={d.type} label={d.type} value={d.count} max={maxType} />
            ))}
          </CardContent>
        </Card>

        {/* 월별 추이 */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">월별 출동 추이</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1.5">
            {BY_MONTH.map((d) => (
              <BarRow key={d.month} label={d.month} value={d.count} max={maxMonth} />
            ))}
          </CardContent>
        </Card>
      </div>

      {/* 권장 훈련 코멘트 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb className="h-4 w-4 text-primary" /> 데이터 기반 권장 훈련
          </CardTitle>
          <CardDescription>
            &ldquo;이 시기·이 지역에 이 사고가 많다 → 이 훈련을 하라&rdquo;
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2">
            {INSIGHTS.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm leading-relaxed">
                <span className="mt-0.5 shrink-0 text-primary">→</span>
                {s}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
