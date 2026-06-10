import { CalendarCheck, Dumbbell, Flame, Medal, TrendingUp } from "lucide-react";

import { getUserAndProfile } from "@/lib/auth";
import { DAILY_POINT_CAP } from "@/lib/fitness";
import { getFitnessState } from "@/lib/fitness-server";
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
import { WorkoutForm } from "@/components/fitness/WorkoutForm";
import { WeeklyMileageChart } from "@/components/fitness/FitnessChart";

export const dynamic = "force-dynamic";

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Dumbbell;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          {label}
        </CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tabular-nums tracking-tight">{value}</div>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

export default async function FitnessPage() {
  const { user } = await getUserAndProfile();
  const state = await getFitnessState(user?.id ?? "");

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="text-xl font-semibold">체력단련</h1>
        <p className="text-sm text-muted-foreground">
          운동을 기록하면 1분당 1마일리지가 적립됩니다. (일일 상한 {DAILY_POINT_CAP}점)
        </p>
      </div>

      {/* 마일리지 현황 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Flame}
          label="이번 달 마일리지"
          value={`${state.monthPoints.toLocaleString()}점`}
        />
        <StatCard
          icon={TrendingUp}
          label="누적 마일리지"
          value={`${state.totalPoints.toLocaleString()}점`}
        />
        <StatCard
          icon={Medal}
          label="이번 달 랭킹"
          value={state.monthRank ? `${state.monthRank}위` : "-"}
          sub="월간 리더보드 기준"
        />
        <StatCard
          icon={CalendarCheck}
          label="연속 운동"
          value={`${state.streakDays}일`}
          sub={state.streakDays >= 3 ? "꾸준함이 무기입니다 🔥" : undefined}
        />
      </div>

      {/* 주간 추이 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">주간 마일리지 추이</CardTitle>
          <CardDescription>최근 8주, 월요일 시작 기준</CardDescription>
        </CardHeader>
        <CardContent>
          <WeeklyMileageChart data={state.weekly} />
        </CardContent>
      </Card>

      {/* 기록 입력 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">운동 기록하기</CardTitle>
          <CardDescription>오늘 수행한 체력단련을 기록하세요.</CardDescription>
        </CardHeader>
        <CardContent>
          <WorkoutForm />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 내 최근 기록 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">내 최근 기록</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>날짜</TableHead>
                  <TableHead>종목</TableHead>
                  <TableHead className="text-right">시간</TableHead>
                  <TableHead className="text-right">적립</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.recent.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                      아직 기록이 없습니다. 첫 운동을 기록해 보세요!
                    </TableCell>
                  </TableRow>
                ) : (
                  state.recent.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap text-muted-foreground">
                        {l.performed_on.slice(5)}
                      </TableCell>
                      <TableCell>
                        {l.activity}
                        {l.note && (
                          <span className="ml-1.5 text-xs text-muted-foreground">{l.note}</span>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{l.duration_min}분</TableCell>
                      <TableCell className="text-right tabular-nums font-medium">
                        +{l.points}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* 월간 리더보드 */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">이번 달 랭킹</CardTitle>
            <CardDescription>월간 적립 마일리지 상위 20명</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-12">순위</TableHead>
                  <TableHead>대원</TableHead>
                  <TableHead className="text-right">마일리지</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {state.leaderboard.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                      이번 달 기록이 아직 없습니다.
                    </TableCell>
                  </TableRow>
                ) : (
                  state.leaderboard.map((e, i) => {
                    const isMe = e.user_id === user?.id;
                    return (
                      <TableRow key={e.user_id} className={isMe ? "bg-primary/5" : undefined}>
                        <TableCell className="font-medium tabular-nums">
                          {i < 3 ? ["🥇", "🥈", "🥉"][i] : i + 1}
                        </TableCell>
                        <TableCell>
                          <span className="font-medium">{e.full_name ?? "이름 미등록"}</span>
                          {isMe && (
                            <Badge variant="secondary" className="ml-1.5">나</Badge>
                          )}
                          {e.division && (
                            <span className="ml-1.5 text-xs text-muted-foreground">
                              {e.division}
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums font-medium">
                          {e.total_points.toLocaleString()}점
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
