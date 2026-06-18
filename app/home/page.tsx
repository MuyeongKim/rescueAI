import Link from "next/link";
import {
  MessageSquare,
  Dumbbell,
  Megaphone,
  Pin,
  Wand2,
} from "lucide-react";

import { getUserAndProfile } from "@/lib/auth";
import { getFitnessState } from "@/lib/fitness-server";
import { createClient } from "@/lib/supabase/server";
import { isNewNotice } from "@/lib/notices";
import { DEMO, demoNotices } from "@/lib/demo";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

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
  const name = profile?.full_name || user?.email?.split("@")[0] || "구조대원";

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
          전북소방 구조 교육훈련 플랫폼 — AI 튜터에게 묻고, 훈련계획·교안을
          만들어 보세요.
        </p>

        <div className="mt-4">
          <Link
            href="/fitness"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary"
          >
            <Dumbbell className="h-4 w-4" />
            이번 달 마일리지 {fitness.monthPoints.toLocaleString()}점
            {fitness.streakDays > 0 && ` · 연속 ${fitness.streakDays}일 🔥`}
          </Link>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <Link href="/chat">
            <Button className="h-11 gap-2">
              <MessageSquare className="h-4 w-4" /> AI 튜터에게 질문
            </Button>
          </Link>
          <Link href="/generate">
            <Button variant="outline" className="h-11 gap-2">
              <Wand2 className="h-4 w-4" /> 훈련계획·교안 생성
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
    </div>
  );
}
