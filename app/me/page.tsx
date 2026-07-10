import Link from "next/link";
import {
  BarChart3,
  ChevronRight,
  CircleUser,
  Dumbbell,
  FolderOpen,
  LogOut,
  NotebookPen,
  Siren,
  Target,
} from "lucide-react";

import { getUserAndProfile } from "@/lib/auth";
import { FITNESS_MONTH_GOAL } from "@/lib/fitness";
import { getFitnessState } from "@/lib/fitness-server";
import { countMyMaterials } from "@/lib/generated-materials";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { OperationalHeader } from "@/components/layout/OperationalHeader";
import { ProgressBar } from "@/components/learning/ProgressBar";

export const dynamic = "force-dynamic";

export default async function MePage() {
  const { user, profile } = await getUserAndProfile();
  const userId = user?.id ?? "";
  const fitness = await getFitnessState(userId);
  const savedCount = await countMyMaterials();

  const name = profile?.full_name || user?.email?.split("@")[0] || "구조대원";

  return (
    <div className="mx-auto max-w-4xl space-y-5 px-4 py-6 sm:px-6">
      <OperationalHeader
        eyebrow="대원 정보 · 개인 현황"
        title="마이페이지"
        description="내 정보와 체력 마일리지, 출동 기록을 확인합니다."
        icon={CircleUser}
        status={profile?.role === "admin" ? "관리자 계정" : "대원 계정"}
      />

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

      {/* AI 자료제작 — 저장한 자료 바로가기 */}
      <Card>
        <CardContent className="p-2">
          <Link
            href="/generate/saved"
            className="flex h-12 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors hover:bg-accent/60"
          >
            <FolderOpen className="h-4 w-4 text-primary" />
            저장한 자료
            {savedCount > 0 && (
              <Badge variant="secondary" className="font-normal">
                {savedCount}
              </Badge>
            )}
            <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
          </Link>
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
          {/* 체력 목표 달성제 (TF 구성안: 자발적 자기계발 동기 부여) */}
          <div className="mt-4 space-y-1.5 border-t border-slate-200 pt-4 dark:border-slate-800">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 font-medium">
                <Target className="h-4 w-4 text-primary" /> 이번 달 목표
              </span>
              <span className="text-muted-foreground">
                {fitness.monthPoints}/{FITNESS_MONTH_GOAL}점
                {fitness.monthPoints >= FITNESS_MONTH_GOAL && " · 달성"}
              </span>
            </div>
            <ProgressBar
              value={Math.min(
                100,
                Math.round((fitness.monthPoints / FITNESS_MONTH_GOAL) * 100)
              )}
            />
            <p className="text-xs text-muted-foreground">
              목표 개인 설정은 준비 중입니다 (기본 {FITNESS_MONTH_GOAL}점).
            </p>
          </div>
          <Link
            href="/fitness"
            className="mt-3 block text-center text-sm text-primary hover:underline"
          >
            체력단련 바로가기
          </Link>
        </CardContent>
      </Card>

      {/* 출동 기록 — 구조활동일지 연동 + 개인 사례 메모 (TF 구성안) */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Siren className="h-4 w-4 text-primary" /> 내 출동 기록
          </CardTitle>
          <CardDescription>
            구조활동일지에서 자동 집계됩니다 — 연동 예정
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Link
            href="/dispatch"
            className="block text-center text-sm text-primary hover:underline"
          >
            출동 마일리지·랭킹 보기
          </Link>
          <div className="rounded-lg border border-dashed p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <NotebookPen className="h-4 w-4 text-muted-foreground" /> 출동 사례
              메모
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              출동에서 배운 점을 기록하는 개인 메모장(자동저장)이 준비
              중입니다. DB 연동 후 제공됩니다.
            </p>
          </div>
        </CardContent>
      </Card>

      {/* 화면 설정 — 모바일에는 사이드바가 없으므로 테마 전환을 여기에도 노출 */}
      <Card className="md:hidden">
        <CardContent className="p-2">
          <ThemeToggle />
        </CardContent>
      </Card>

      {/* 로그아웃 — 모바일 탭바·사이드바가 없어 여기가 유일한 로그아웃 동선(데스크톱은 사이드바) */}
      <Card className="md:hidden">
        <CardContent className="p-2">
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              className="flex h-12 w-full items-center gap-2 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent/60"
            >
              <LogOut className="h-4 w-4 shrink-0" />
              로그아웃
            </button>
          </form>
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
              관리자 · 통계·자료·사용자·공지
              <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
