import { Info, Siren, Trophy } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

// 목 데이터 — 구조활동일지(엑셀) 업로드 → 이름·출동시각·유형 추출 연동 전 자리표시.
// TF 구성안 "대원 출동 실적에 따른 마일리지 자동 체크 및 계산"
const MY_SUMMARY = {
  monthCount: 14,
  monthPoints: 140,
  totalPoints: 820,
  monthRank: 2,
};

const MY_RECENT = [
  { id: 6, type: "화재", at: "2026-06-10 22:41", place: "완주군 봉동읍", points: 10 },
  { id: 5, type: "교통사고", at: "2026-06-09 08:15", place: "호남고속도로", points: 10 },
  { id: 4, type: "수난", at: "2026-06-07 15:02", place: "만경강", points: 10 },
  { id: 3, type: "산악", at: "2026-06-04 11:30", place: "모악산", points: 10 },
  { id: 2, type: "화재", at: "2026-06-02 03:18", place: "완주군 삼례읍", points: 10 },
  { id: 1, type: "기타(동물)", at: "2026-06-01 09:47", place: "완주군 이서면", points: 10 },
];

const LEADERBOARD = [
  { rank: 1, name: "김구조", division: "전주 119구조대", count: 18, points: 180 },
  { rank: 2, name: "김무영", division: "완주 119구조대", count: 14, points: 140 },
  { rank: 3, name: "이수난", division: "군산 119구조대", count: 12, points: 120 },
  { rank: 4, name: "박산악", division: "남원 119구조대", count: 9, points: 90 },
  { rank: 5, name: "최화재", division: "익산 119구조대", count: 7, points: 70 },
];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="border-t-2 border-t-slate-800 dark:border-t-slate-200">
      <CardContent className="p-4 text-center">
        <div className="text-2xl font-black tabular-nums">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
        {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
      </CardContent>
    </Card>
  );
}

export default function DispatchPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <OperationalHeader
        eyebrow="운영 지표 · 출동"
        title="출동 마일리지"
        description="구조활동일지를 기준으로 출동 실적과 마일리지를 집계합니다."
        icon={Siren}
        status="PoC 예시 데이터"
        statusTone="warning"
      />

      <div className="flex items-start gap-3 border border-slate-300 border-l-4 border-l-amber-500 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950 dark:border-slate-700 dark:border-l-amber-500 dark:bg-amber-950/20 dark:text-amber-100">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <p>현재 예시 데이터이며 구조활동일지 엑셀 자동 추출·집계 연동을 준비하고 있습니다.</p>
      </div>

      {/* 이번 달 요약 */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="이번 달 출동" value={`${MY_SUMMARY.monthCount}건`} />
        <Stat label="이번 달 마일리지" value={`${MY_SUMMARY.monthPoints}점`} />
        <Stat label="누적 마일리지" value={MY_SUMMARY.totalPoints.toLocaleString()} />
        <Stat label="월간 랭킹" value={`${MY_SUMMARY.monthRank}위`} />
      </div>

      {/* 최근 출동 내역 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">내 최근 출동</CardTitle>
          <CardDescription>구조활동일지에서 자동 추출 (이름·출동시각·유형)</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>출동시각</TableHead>
                <TableHead>유형</TableHead>
                <TableHead className="hidden sm:table-cell">장소</TableHead>
                <TableHead className="text-right">마일리지</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {MY_RECENT.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">
                    {d.at}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="font-normal">
                      {d.type}
                    </Badge>
                  </TableCell>
                  <TableCell className="hidden sm:table-cell text-muted-foreground">
                    {d.place}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">+{d.points}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 월간 랭킹 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy className="h-4 w-4 text-primary" /> 이번 달 출동 랭킹
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y">
            {LEADERBOARD.map((r) => (
              <li key={r.rank} className="flex items-center gap-3 py-2.5">
                <span className="w-7 text-center text-base font-bold tabular-nums">
                  {r.rank}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{r.division}</p>
                </div>
                <span className="text-sm tabular-nums text-muted-foreground">
                  {r.count}건
                </span>
                <span className="w-16 text-right text-sm font-semibold tabular-nums">
                  {r.points}점
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
