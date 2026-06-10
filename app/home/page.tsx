import Link from "next/link";
import {
  MessageSquare,
  GraduationCap,
  PlayCircle,
  Award,
  Dumbbell,
  Megaphone,
  Pin,
} from "lucide-react";

import { getUserAndProfile } from "@/lib/auth";
import { getLearningState } from "@/lib/learning";
import { getFitnessState } from "@/lib/fitness-server";
import { createClient } from "@/lib/supabase/server";
import { isNewNotice } from "@/lib/notices";
import { DEMO, demoNotices } from "@/lib/demo";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/learning/ProgressBar";
import { CourseCard } from "@/components/learning/CourseCard";

export const dynamic = "force-dynamic";

type NoticePreview = { id: number; title: string; pinned: boolean; created_at: string };

async function loadRecentNotices(): Promise<NoticePreview[]> {
  if (DEMO) return demoNotices.slice(0, 3);
  const supabase = await createClient();
  const { data } = await supabase
    .from("notices")
    .select("id, title, pinned, created_at")
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(3);
  return (data ?? []) as NoticePreview[];
}

export default async function HomePage() {
  const { user, profile } = await getUserAndProfile();
  const userId = user?.id ?? "";
  const state = userId
    ? await getLearningState(userId)
    : {
        courses: [],
        completedIds: new Set<number>(),
        passedCategories: new Set<string>(),
        totalLessons: 0,
        totalCompleted: 0,
        overallProgress: 0,
      };

  const name = profile?.full_name || user?.email?.split("@")[0] || "구조대원";

  // 이어서 학습할 다음 레슨
  let nextLesson: { id: number; title: string; category: string } | null = null;
  for (const c of state.courses) {
    const l = c.lessons.find((x) => !x.completed);
    if (l) {
      nextLesson = { id: l.id, title: l.title, category: c.category };
      break;
    }
  }
  const certifiedCount = state.courses.filter((c) => c.certified).length;
  const [notices, fitness] = await Promise.all([
    loadRecentNotices(),
    getFitnessState(userId),
  ]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-3 py-5 sm:px-4">
      {/* 히어로 */}
      <section className="rounded-xl border bg-linear-to-br from-primary/10 to-transparent p-5">
        <h1 className="text-xl font-bold sm:text-2xl">
          {name}님, 환영합니다 👋
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          전북소방 구조 교육훈련 플랫폼 — 자료로 학습하고, AI 튜터에게
          물어보세요.
        </p>

        <div className="mt-4 max-w-md">
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="font-medium">전체 학습 진도</span>
            <span className="text-muted-foreground">
              {state.totalCompleted}/{state.totalLessons} 레슨 ·{" "}
              {state.overallProgress}%
            </span>
          </div>
          <ProgressBar value={state.overallProgress} />
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            {certifiedCount > 0 && (
              <span className="flex items-center gap-1 text-primary">
                <Award className="h-4 w-4" /> 이수한 과정 {certifiedCount}개
              </span>
            )}
            <Link
              href="/fitness"
              className="flex items-center gap-1 text-muted-foreground hover:text-primary"
            >
              <Dumbbell className="h-4 w-4" />
              이번 달 마일리지 {fitness.monthPoints.toLocaleString()}점
              {fitness.streakDays > 0 && ` · 연속 ${fitness.streakDays}일 🔥`}
            </Link>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {nextLesson ? (
            <Link href={`/docs/${nextLesson.id}`}>
              <Button className="h-11 gap-2">
                <PlayCircle className="h-4 w-4" />
                이어서 학습: {nextLesson.title.slice(0, 18)}
              </Button>
            </Link>
          ) : state.totalLessons > 0 ? (
            <Link href="/courses">
              <Button className="h-11 gap-2">
                <GraduationCap className="h-4 w-4" /> 학습 과정 보기
              </Button>
            </Link>
          ) : null}
          <Link href="/chat">
            <Button variant="outline" className="h-11 gap-2">
              <MessageSquare className="h-4 w-4" /> AI 튜터에게 질문
            </Button>
          </Link>
        </div>
      </section>

      {/* 공지사항 — 메뉴에서 빠진 화면이라 홈 상단 노출이 유일한 진입점 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-lg font-semibold">
            <Megaphone className="h-5 w-5" /> 공지사항
          </h2>
          <Link href="/notices" className="text-sm text-primary hover:underline">
            전체 보기
          </Link>
        </div>
        <Card>
          <CardContent className="divide-y p-0">
            {notices.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                등록된 공지사항이 없습니다.
              </p>
            ) : (
              notices.map((n) => (
                <Link
                  key={n.id}
                  href="/notices"
                  className="flex items-center gap-2 px-4 py-3 transition-colors hover:bg-accent/40"
                >
                  {n.pinned && (
                    <Badge variant="secondary" className="shrink-0 gap-1">
                      <Pin className="h-3 w-3" /> 고정
                    </Badge>
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {n.title}
                  </span>
                  {isNewNotice(n.created_at) && (
                    <span className="shrink-0 text-[10px] font-bold text-primary">
                      NEW
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {n.created_at.slice(0, 10)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </section>

      {/* 학습 과정 */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">학습 과정</h2>
          <Link href="/courses" className="text-sm text-primary hover:underline">
            전체 보기
          </Link>
        </div>
        {state.courses.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              아직 인덱싱된 자료가 없습니다. <br className="sm:hidden" />
              <code className="rounded bg-muted px-1">indexing/</code> 로 자료를
              올리면 과정이 자동 생성됩니다.
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {state.courses.map((c) => (
              <CourseCard key={c.category} course={c} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
