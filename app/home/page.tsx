import Link from "next/link";
import {
  MessageSquare,
  Dumbbell,
  Megaphone,
  Pin,
  Wand2,
  FileText,
  Target,
  MessageCircle,
  Newspaper,
  BarChart3,
  ChevronRight,
} from "lucide-react";

import { getUserAndProfile } from "@/lib/auth";
import { FITNESS_MONTH_GOAL } from "@/lib/fitness";
import { getFitnessState } from "@/lib/fitness-server";
import { createClient } from "@/lib/supabase/server";
import { isNewNotice } from "@/lib/notices";
import { getRecentNews } from "@/lib/news";
import { kstDate } from "@/lib/kst";
import { DEMO, demoNotices, demoConversations } from "@/lib/demo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/learning/ProgressBar";

export const dynamic = "force-dynamic";

type NoticePreview = { id: number; title: string; pinned: boolean; created_at: string };
type ConvPreview = { id: string; title: string | null; updated_at: string };

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

async function loadRecentConversations(): Promise<ConvPreview[]> {
  if (DEMO) return demoConversations.slice(0, 4);
  const supabase = await createClient();
  const { data } = await supabase
    .from("conversations")
    .select("id, title, updated_at")
    .order("updated_at", { ascending: false })
    .limit(4);
  return (data ?? []) as ConvPreview[];
}

const QUICK_ACTIONS = [
  { href: "/chat", icon: MessageSquare, title: "AI 튜터", desc: "현장 질문에 근거·출처와 함께 답변" },
  { href: "/generate", icon: Wand2, title: "AI 자료제작", desc: "훈련계획·교안·슬라이드 생성" },
  { href: "/docs", icon: FileText, title: "자료실", desc: "원본 SOP·매뉴얼 열람" },
];

export default async function HomePage() {
  const { user, profile } = await getUserAndProfile();
  const userId = user?.id ?? "";
  const name = profile?.full_name || user?.email?.split("@")[0] || "구조대원";
  const meta = [profile?.division, profile?.rank, profile?.team].filter(Boolean).join(" · ");

  // KST 기준(서버가 UTC 여도 한국 날짜·요일이 나오게)
  const now = kstDate();
  const dateStr = `${now.getUTCFullYear()}년 ${now.getUTCMonth() + 1}월 ${now.getUTCDate()}일 (${
    ["일", "월", "화", "수", "목", "금", "토"][now.getUTCDay()]
  })`;

  const [notices, fitness, conversations, news] = await Promise.all([
    loadRecentNotices(),
    getFitnessState(userId),
    loadRecentConversations(),
    getRecentNews(3),
  ]);
  const goalPct = Math.min(
    100,
    Math.round((fitness.monthPoints / FITNESS_MONTH_GOAL) * 100)
  );

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-3 py-5 sm:px-4">
      {/* 인사 바 */}
      <section className="rounded-xl border bg-linear-to-br from-primary/10 to-transparent p-5">
        <h1 className="text-xl font-bold sm:text-2xl">{name}님, 환영합니다 👋</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {meta ? `${meta} · ` : ""}
          {dateStr}
        </p>
      </section>

      {/* 빠른 실행 */}
      <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {QUICK_ACTIONS.map((a) => {
          const Icon = a.icon;
          return (
            <Link key={a.href} href={a.href}>
              <Card className="h-full transition-colors hover:border-primary/50 hover:bg-accent/40">
                <CardContent className="flex items-start gap-3 p-4">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <Icon className="h-5 w-5 text-primary" />
                  </span>
                  <div className="min-w-0">
                    <div className="font-semibold">{a.title}</div>
                    <p className="text-xs text-muted-foreground">{a.desc}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* 공지사항 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <Megaphone className="h-4 w-4" /> 공지사항
            </CardTitle>
            <Link href="/notices" className="text-sm text-primary hover:underline">
              전체
            </Link>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {notices.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
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
                    <span className="shrink-0 text-[10px] font-bold text-primary">NEW</span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {n.created_at.slice(0, 10)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {/* 체력단련 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <Dumbbell className="h-4 w-4" /> 체력단련
            </CardTitle>
            <Link href="/fitness" className="text-sm text-primary hover:underline">
              기록하기
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-2 text-center">
              <div>
                <div className="text-lg font-bold tabular-nums">
                  {fitness.monthPoints.toLocaleString()}
                </div>
                <div className="text-xs text-muted-foreground">이번 달</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums">
                  {fitness.monthRank ? `${fitness.monthRank}위` : "-"}
                </div>
                <div className="text-xs text-muted-foreground">월간 랭킹</div>
              </div>
              <div>
                <div className="text-lg font-bold tabular-nums">
                  {fitness.streakDays > 0 ? `${fitness.streakDays}일🔥` : "-"}
                </div>
                <div className="text-xs text-muted-foreground">연속</div>
              </div>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="flex items-center gap-1 text-muted-foreground">
                  <Target className="h-3.5 w-3.5" /> 이번 달 목표
                </span>
                <span className="text-muted-foreground">
                  {fitness.monthPoints}/{FITNESS_MONTH_GOAL}점
                  {fitness.monthPoints >= FITNESS_MONTH_GOAL && " 🎉"}
                </span>
              </div>
              <ProgressBar value={goalPct} />
            </div>
          </CardContent>
        </Card>

        {/* 최근 AI 대화 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <MessageCircle className="h-4 w-4" /> 최근 AI 대화
            </CardTitle>
            <Link href="/chat" className="text-sm text-primary hover:underline">
              새 질문
            </Link>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {conversations.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                아직 대화가 없습니다. AI 튜터에게 물어보세요.
              </p>
            ) : (
              conversations.map((c) => (
                <Link
                  key={c.id}
                  href={`/chat/${c.id}`}
                  className="flex items-center gap-2 px-4 py-3 transition-colors hover:bg-accent/40"
                >
                  <MessageCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {c.title || "(제목 없음)"}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {c.updated_at.slice(0, 10)}
                  </span>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {/* 최신 구조 동향 */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
            <CardTitle className="flex items-center gap-1.5 text-base">
              <Newspaper className="h-4 w-4" /> 최신 구조 동향
            </CardTitle>
            <Link href="/news" className="text-sm text-primary hover:underline">
              전체
            </Link>
          </CardHeader>
          <CardContent className="divide-y p-0">
            {news.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                아직 등록된 동향이 없습니다.
              </p>
            ) : (
              news.map((n) => (
                <Link
                  key={n.id}
                  href="/news"
                  className="block px-4 py-3 transition-colors hover:bg-accent/40"
                >
                  <div className="flex items-center gap-1.5">
                    {n.region && (
                      <Badge
                        variant={n.region === "해외" ? "default" : "secondary"}
                        className="shrink-0"
                      >
                        {n.region}
                      </Badge>
                    )}
                    {n.category && (
                      <Badge variant="outline" className="shrink-0 font-normal">
                        {n.category}
                      </Badge>
                    )}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                      {n.date}
                    </span>
                  </div>
                  <p className="mt-1 line-clamp-1 text-sm font-medium">{n.title}</p>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* 관리자 바로가기 */}
      {profile?.role === "admin" && (
        <Link
          href="/admin"
          className="flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium transition-colors hover:bg-accent/60"
        >
          <BarChart3 className="h-4 w-4 text-primary" />
          관리자 — 통계·자료·사용자·공지
          <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
        </Link>
      )}
    </div>
  );
}
