import Link from "next/link";
import { Award, BarChart3, ChevronRight, CircleUser, Dumbbell } from "lucide-react";

import { getUserAndProfile } from "@/lib/auth";
import { getLearningState } from "@/lib/learning";
import { getFitnessState } from "@/lib/fitness-server";
import { createClient } from "@/lib/supabase/server";
import { DEMO, demoQuizAttempts } from "@/lib/demo";
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
import { CategoryBadge } from "@/components/learning/CategoryBadge";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

export const dynamic = "force-dynamic";

type QuizAttempt = {
  id: number;
  category: string | null;
  score: number | null;
  total: number | null;
  passed: boolean;
  created_at: string;
};

async function loadQuizAttempts(userId: string): Promise<QuizAttempt[]> {
  if (DEMO) return demoQuizAttempts;
  const supabase = await createClient();
  const { data } = await supabase
    .from("quiz_attempts")
    .select("id, category, score, total, passed, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(10);
  return (data ?? []) as QuizAttempt[];
}

export default async function MePage() {
  const { user, profile } = await getUserAndProfile();
  const userId = user?.id ?? "";
  const [learning, fitness, quizzes] = await Promise.all([
    getLearningState(userId),
    getFitnessState(userId),
    loadQuizAttempts(userId),
  ]);

  const certified = learning.courses.filter((c) => c.certified);
  const name = profile?.full_name || user?.email?.split("@")[0] || "구조대원";

  return (
    <div className="mx-auto max-w-3xl space-y-5 px-3 py-5 sm:px-4">
      <div>
        <h1 className="text-xl font-semibold">마이페이지</h1>
        <p className="text-sm text-muted-foreground">
          내 정보·학습 현황·이수 기록을 확인합니다.
        </p>
      </div>

      {/* 프로필 */}
      <Card>
        <CardContent className="flex items-center gap-4 p-5">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-primary/10">
            <CircleUser className="h-7 w-7 text-primary" />
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-lg font-semibold">{name}</span>
              {profile?.role === "admin" && <Badge variant="secondary">관리자</Badge>}
            </div>
            <p className="truncate text-sm text-muted-foreground">{user?.email}</p>
            {profile?.division && (
              <p className="text-sm text-muted-foreground">{profile.division}</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 이수 기록 — 진도 상세는 홈·학습 탭이 담당, 여기는 증빙(이수·퀴즈 이력) 중심 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Award className="h-4 w-4 text-primary" /> 이수 기록
          </CardTitle>
          <CardDescription>
            전체 진도 {learning.totalCompleted}/{learning.totalLessons} 레슨 ·{" "}
            {learning.overallProgress}% —{" "}
            <Link href="/courses" className="text-primary hover:underline">
              학습 과정에서 이어가기
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-sm font-medium">이수한 과정 {certified.length}개</p>
          {certified.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              아직 이수한 과정이 없습니다. 레슨 학습 후 퀴즈에 합격하면 이수됩니다.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {certified.map((c) => (
                <CategoryBadge key={c.category} category={c.category} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 체력단련 요약 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Dumbbell className="h-4 w-4" /> 체력단련 마일리지
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-xl font-bold tabular-nums">
                {fitness.monthPoints.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">이번 달</div>
            </div>
            <div>
              <div className="text-xl font-bold tabular-nums">
                {fitness.totalPoints.toLocaleString()}
              </div>
              <div className="text-xs text-muted-foreground">누적</div>
            </div>
            <div>
              <div className="text-xl font-bold tabular-nums">
                {fitness.monthRank ? `${fitness.monthRank}위` : "-"}
              </div>
              <div className="text-xs text-muted-foreground">월간 랭킹</div>
            </div>
          </div>
          <Link
            href="/fitness"
            className="mt-3 block text-center text-sm text-primary hover:underline"
          >
            체력단련 바로가기
          </Link>
        </CardContent>
      </Card>

      {/* 퀴즈 기록 */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">최근 퀴즈 기록</CardTitle>
          <CardDescription>최근 10회 응시 기준</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>응시일</TableHead>
                <TableHead>분야</TableHead>
                <TableHead className="text-right">점수</TableHead>
                <TableHead className="text-right">결과</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {quizzes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    아직 퀴즈 응시 기록이 없습니다.
                  </TableCell>
                </TableRow>
              ) : (
                quizzes.map((q) => (
                  <TableRow key={q.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {q.created_at.slice(0, 10)}
                    </TableCell>
                    <TableCell>
                      {q.category ? <CategoryBadge category={q.category} /> : "-"}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {q.score ?? 0}/{q.total ?? 0}
                    </TableCell>
                    <TableCell className="text-right">
                      {q.passed ? (
                        <Badge>합격</Badge>
                      ) : (
                        <Badge variant="outline">불합격</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 화면 설정 — 모바일에는 사이드바가 없으므로 테마 전환을 여기에도 노출 */}
      <Card className="md:hidden">
        <CardContent className="p-2">
          <ThemeToggle />
        </CardContent>
      </Card>

      {/* 관리자 진입 — 모바일 탭바에 관리자 메뉴가 없어 여기가 유일한 동선 */}
      {profile?.role === "admin" && (
        <Card>
          <CardContent className="p-2">
            <Link
              href="/admin"
              className="flex h-12 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent/60"
            >
              <BarChart3 className="h-4 w-4 text-primary" />
              관리자 — 통계·이수 현황·자료·사용자·공지
              <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
