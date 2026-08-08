import { redirect } from "next/navigation";
import {
  Users,
  BarChart3,
  MessageSquare,
  Clock,
  ThumbsUp,
  Dumbbell,
  Flame,
  ListChecks,
} from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { requireUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO, getDemoAdminStats } from "@/lib/demo";
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
import {
  DailyQuestionsChart,
  CategoryCitationsChart,
} from "@/components/admin/StatsChart";
import { StatCard } from "@/components/StatCard";
import { OperationalHeader } from "@/components/layout/OperationalHeader";

export const dynamic = "force-dynamic";

// 관리자 대시보드 통계 타입 — admin_dashboard_stats RPC 반환 jsonb 와 1:1.
type AdminStats = {
  totalUsers: number;
  totalQuestions: number;
  avgLatencyMs: number;
  up: number;
  down: number;
  categories: { category: string; count: number }[];
  daily: { date: string; count: number }[];
  faq: { q: string; count: number }[];
  fitnessActiveUsers: number;
  fitnessMonthPoints: number;
  fitnessTotalLogs: number;
};

const EMPTY_STATS: AdminStats = {
  totalUsers: 0,
  totalQuestions: 0,
  avgLatencyMs: 0,
  up: 0,
  down: 0,
  categories: [],
  daily: [],
  faq: [],
  fitnessActiveUsers: 0,
  fitnessMonthPoints: 0,
  fitnessTotalLogs: 0,
};

// 실데이터 집계 (service-role). DEMO 모드에서는 호출되지 않는다.
// 집계는 admin_dashboard_stats RPC 가 Postgres 안에서 수행한다 — 예전처럼 messages 수천 행을
// 앱으로 끌어와 접지 않는다(행 상한 때문에 수치가 부정확해지는 문제도 함께 해결).
async function loadAdminStats(): Promise<AdminStats> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_dashboard_stats", {
    p_days: 30,
    p_faq_limit: 20,
  });

  if (error || !data) {
    console.error("[admin] 통계 집계 실패:", error?.message);
    return EMPTY_STATS;
  }
  return { ...EMPTY_STATS, ...(data as unknown as AdminStats) };
}

export default async function AdminPage() {
  // 레이아웃에서 이미 막지만 한 번 더 검증
  const { profile } = await requireUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const {
    totalUsers,
    totalQuestions,
    avgLatencyMs,
    up,
    down,
    categories,
    daily,
    faq,
    fitnessActiveUsers,
    fitnessMonthPoints,
    fitnessTotalLogs,
  } = DEMO ? getDemoAdminStats() : await loadAdminStats();
  const satisfaction = up + down > 0 ? Math.round((up / (up + down)) * 100) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <OperationalHeader
        eyebrow="관리 업무 · 운영 통계"
        title="관리자 대시보드"
        description="이용 현황과 답변 품질을 한눈에 확인합니다."
        icon={BarChart3}
        status={DEMO ? "PoC 통계" : "실데이터 집계"}
        statusTone={DEMO ? "warning" : "success"}
      />

      {/* 통계 카드 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label="총 사용자" value={`${totalUsers}명`} />
        <StatCard
          icon={MessageSquare}
          label="총 질문수"
          value={`${totalQuestions}건`}
        />
        <StatCard
          icon={Clock}
          label="평균 응답시간"
          value={avgLatencyMs ? `${(avgLatencyMs / 1000).toFixed(1)}초` : "-"}
          sub="assistant 응답 기준"
        />
        <StatCard
          icon={ThumbsUp}
          label="답변 만족도"
          value={satisfaction !== null ? `${satisfaction}%` : "-"}
          sub={`긍정 ${up} · 부정 ${down}`}
        />
      </div>

      {/* 체력단련 현황 */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          체력단련 현황
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={Dumbbell}
            label="이번 달 참여 대원"
            value={`${fitnessActiveUsers}명`}
          />
          <StatCard
            icon={Flame}
            label="이번 달 적립 마일리지"
            value={`${fitnessMonthPoints.toLocaleString()}점`}
          />
          <StatCard
            icon={ListChecks}
            label="누적 운동 기록"
            value={`${fitnessTotalLogs.toLocaleString()}건`}
          />
          <StatCard
            icon={Users}
            label="참여율"
            value={
              totalUsers > 0
                ? `${Math.round((fitnessActiveUsers / totalUsers) * 100)}%`
                : "-"
            }
            sub="이번 달, 전체 사용자 대비"
          />
        </div>
      </div>

      {/* 차트 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">일별 질문수 (최근 30일)</CardTitle>
          </CardHeader>
          <CardContent>
            <DailyQuestionsChart data={daily} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">카테고리별 자료 인용</CardTitle>
            <CardDescription>답변에 인용된 자료의 분야 분포</CardDescription>
          </CardHeader>
          <CardContent>
            <CategoryCitationsChart data={categories} />
          </CardContent>
        </Card>
      </div>

      {/* FAQ TOP 20 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">자주 묻는 질문 TOP 20</CardTitle>
          <CardDescription>최근 질문 기준 빈도순</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>질문</TableHead>
                <TableHead className="w-20 text-right">횟수</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {faq.length === 0 ? (
                <TableRow>
                  <TableCell
                    colSpan={3}
                    className="py-8 text-center text-muted-foreground"
                  >
                    아직 질문이 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                faq.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="max-w-0 truncate">{row.q}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.count}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
