import { redirect } from "next/navigation";
import {
  Users,
  MessageSquare,
  Clock,
  ThumbsUp,
  BookOpenCheck,
  ClipboardList,
  Award,
  Percent,
  Dumbbell,
  Flame,
  ListChecks,
} from "lucide-react";

import { createAdminClient } from "@/lib/supabase/admin";
import { getUserAndProfile, isAdmin } from "@/lib/auth";
import { DEMO, getDemoAdminStats } from "@/lib/demo";
import type { DocSource } from "@/lib/database.types";
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

export const dynamic = "force-dynamic";

const DAY_MS = 86_400_000;

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: typeof Users;
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

// 실데이터 집계 (service-role). DEMO 모드에서는 호출되지 않는다.
async function loadAdminStats() {
  const admin = createAdminClient();
  const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString();

  const [usersRes, questionsRes, assistantRes, userMsgsRes, dailyRes, docsRes] =
    await Promise.all([
      admin.from("profiles").select("id", { count: "exact", head: true }),
      admin
        .from("messages")
        .select("id", { count: "exact", head: true })
        .eq("role", "user"),
      admin
        .from("messages")
        .select("latency_ms, feedback, sources")
        .eq("role", "assistant")
        .order("created_at", { ascending: false })
        .limit(5000),
      admin
        .from("messages")
        .select("content")
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(2000),
      admin
        .from("messages")
        .select("created_at")
        .eq("role", "user")
        .gte("created_at", since30)
        .limit(20000),
      admin.from("documents").select("id, category"),
    ]);

  const monthStartStr = `${new Date().toISOString().slice(0, 7)}-01`;
  const [progressRes, quizRowsRes, fitnessMonthRes, fitnessCountRes] =
    await Promise.all([
      admin.from("lesson_progress").select("id", { count: "exact", head: true }),
      admin.from("quiz_attempts").select("score, total, passed").limit(5000),
      admin
        .from("workout_logs")
        .select("user_id, points")
        .gte("performed_on", monthStartStr)
        .limit(20000),
      admin.from("workout_logs").select("id", { count: "exact", head: true }),
    ]);
  const fitnessMonth = fitnessMonthRes.data ?? [];
  const fitnessActiveUsers = new Set(
    fitnessMonth.map((w) => w.user_id).filter(Boolean)
  ).size;
  const fitnessMonthPoints = fitnessMonth.reduce((s, w) => s + (w.points ?? 0), 0);
  const fitnessTotalLogs = fitnessCountRes.count ?? 0;
  const lessonCompletions = progressRes.count ?? 0;
  const quizRows = quizRowsRes.data ?? [];
  const quizAttempts = quizRows.length;
  const quizPassed = quizRows.filter((q) => q.passed).length;
  const quizPassRate =
    quizAttempts > 0 ? Math.round((quizPassed / quizAttempts) * 100) : null;
  const quizAvg =
    quizAttempts > 0
      ? Math.round(
          (quizRows.reduce(
            (s, q) => s + (q.total ? (q.score ?? 0) / q.total : 0),
            0
          ) /
            quizAttempts) *
            100
        )
      : null;

  const totalUsers = usersRes.count ?? 0;
  const totalQuestions = questionsRes.count ?? 0;

  const assistant = assistantRes.data ?? [];
  const latencies = assistant
    .map((a) => a.latency_ms)
    .filter((x): x is number => typeof x === "number");
  const avgLatencyMs = latencies.length
    ? Math.round(latencies.reduce((s, x) => s + x, 0) / latencies.length)
    : 0;
  const up = assistant.filter((a) => a.feedback === 1).length;
  const down = assistant.filter((a) => a.feedback === -1).length;
  const satisfaction = up + down > 0 ? Math.round((up / (up + down)) * 100) : null;

  const catOf = new Map<number, string>();
  for (const d of docsRes.data ?? []) if (d.category) catOf.set(d.id, d.category);
  const catCount = new Map<string, number>();
  for (const a of assistant) {
    const sources = (a.sources ?? []) as DocSource[];
    for (const s of sources) {
      const cat = catOf.get(s.document_id);
      if (cat) catCount.set(cat, (catCount.get(cat) ?? 0) + 1);
    }
  }
  const categories = Array.from(catCount.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);

  const dayCount = new Map<string, number>();
  for (const r of dailyRes.data ?? []) {
    const day = (r.created_at ?? "").slice(0, 10);
    if (day) dayCount.set(day, (dayCount.get(day) ?? 0) + 1);
  }
  const daily: { date: string; count: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10);
    daily.push({ date: d, count: dayCount.get(d) ?? 0 });
  }

  const faqMap = new Map<string, number>();
  for (const r of userMsgsRes.data ?? []) {
    const q = (r.content ?? "").trim();
    if (q) faqMap.set(q, (faqMap.get(q) ?? 0) + 1);
  }
  const faq = Array.from(faqMap.entries())
    .map(([q, count]) => ({ q, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  return {
    totalUsers,
    totalQuestions,
    avgLatencyMs,
    satisfaction,
    up,
    down,
    categories,
    daily,
    faq,
    lessonCompletions,
    quizAttempts,
    quizPassed,
    quizPassRate,
    quizAvg,
    fitnessActiveUsers,
    fitnessMonthPoints,
    fitnessTotalLogs,
  };
}

export default async function AdminPage() {
  // 레이아웃에서 이미 막지만 한 번 더 검증
  const { profile } = await getUserAndProfile();
  if (!isAdmin(profile)) redirect("/chat");

  const {
    totalUsers,
    totalQuestions,
    avgLatencyMs,
    satisfaction,
    up,
    down,
    categories,
    daily,
    faq,
    lessonCompletions,
    quizAttempts,
    quizPassed,
    quizPassRate,
    quizAvg,
    fitnessActiveUsers,
    fitnessMonthPoints,
    fitnessTotalLogs,
  } = DEMO ? getDemoAdminStats() : await loadAdminStats();

  return (
    <div className="mx-auto max-w-5xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="text-xl font-semibold">관리자 대시보드</h1>
        <p className="text-sm text-muted-foreground">
          이용 현황과 답변 품질을 한눈에 봅니다.
        </p>
      </div>

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
          sub={`👍 ${up} · 👎 ${down}`}
        />
      </div>

      {/* 학습 현황 */}
      <div>
        <h2 className="mb-2 text-sm font-semibold text-muted-foreground">
          학습 현황
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            icon={BookOpenCheck}
            label="레슨 완료"
            value={`${lessonCompletions}건`}
          />
          <StatCard
            icon={ClipboardList}
            label="퀴즈 응시"
            value={`${quizAttempts}건`}
          />
          <StatCard
            icon={Award}
            label="퀴즈 합격률"
            value={quizPassRate !== null ? `${quizPassRate}%` : "-"}
            sub={`합격 ${quizPassed}건`}
          />
          <StatCard
            icon={Percent}
            label="퀴즈 평균점수"
            value={quizAvg !== null ? `${quizAvg}%` : "-"}
          />
        </div>
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
