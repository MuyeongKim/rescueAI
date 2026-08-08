import Link from "next/link";
import {
  ArrowRight,
  BarChart3,
  ChevronRight,
  FileText,
  MessageCircle,
  MessageSquare,
  Megaphone,
  Newspaper,
  Pin,
  ShieldCheck,
  Target,
  Wand2,
} from "lucide-react";

import { requireUserAndProfile } from "@/lib/auth";
import { FITNESS_MONTH_GOAL } from "@/lib/fitness";
import { getFitnessState } from "@/lib/fitness-server";
import { createClient } from "@/lib/supabase/server";
import { isNewNotice } from "@/lib/notices";
import { getRecentNews } from "@/lib/news";
import { kstDate } from "@/lib/kst";
import { DEMO, demoNotices, demoConversations } from "@/lib/demo";
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
  {
    code: "근거 질의",
    href: "/chat",
    icon: MessageSquare,
    title: "AI 튜터",
    desc: "매뉴얼 근거와 페이지를 확인하며 질문합니다.",
    action: "질문 시작",
    rail: "border-t-primary dark:border-t-primary",
  },
  {
    code: "자료 제작",
    href: "/generate",
    icon: Wand2,
    title: "AI 자료제작",
    desc: "훈련계획·교안·슬라이드를 표준 양식으로 만듭니다.",
    action: "자료 만들기",
    rail: "border-t-slate-800 dark:border-t-slate-200",
  },
  {
    code: "원본 열람",
    href: "/docs",
    icon: FileText,
    title: "자료실",
    desc: "현재 등록된 SOP와 원본 교육자료를 열람합니다.",
    action: "자료 열기",
    rail: "border-t-emerald-700 dark:border-t-emerald-500",
  },
];

function SectionHeading({ title, href, action }: { title: string; href?: string; action?: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between border-b border-slate-200 dark:border-slate-800">
      <h2 className="text-sm font-extrabold text-slate-950 dark:text-slate-50">{title}</h2>
      {href && action && (
        <Link
          href={href}
          className="flex min-h-10 items-center gap-1 text-xs font-semibold text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {action} <ChevronRight className="h-4 w-4" />
        </Link>
      )}
    </div>
  );
}

export default async function HomePage() {
  const { user, profile } = await requireUserAndProfile();
  const userId = user?.id ?? "";
  const name = profile?.full_name || user?.email?.split("@")[0] || "구조대원";
  const greeting = name.endsWith("대원") ? `${name}님` : `${name} 대원님`;
  const meta = [profile?.division, profile?.rank, profile?.team].filter(Boolean).join(" · ");

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
  const goalPct = Math.min(100, Math.round((fitness.monthPoints / FITNESS_MONTH_GOAL) * 100));
  const primaryNotice = notices[0];

  return (
    <div className="mx-auto max-w-6xl space-y-7 px-4 py-6 sm:px-6 lg:px-8">
      <header className="border-b border-slate-300 pb-6 dark:border-slate-700">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="flex items-center gap-2 text-[11px] font-bold text-primary">
              <span className="h-0.5 w-7 bg-primary" aria-hidden />
              오늘의 준비 브리핑
            </p>
            <h1 className="mt-2 text-2xl font-black leading-tight text-slate-950 sm:text-3xl dark:text-slate-50">
              {greeting}, 오늘도 안전하게
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              {meta ? `${meta} · ` : ""}
              {dateStr}
            </p>
          </div>
          <div className="flex min-h-11 shrink-0 items-center gap-2 self-start border border-slate-300 bg-white px-3 text-xs font-semibold text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden />
            교육자료 기반 응답
          </div>
        </div>
      </header>

      {primaryNotice && (
        <Link
          href="/notices"
          className="group flex min-h-[72px] border border-slate-300 bg-white transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          <span className="w-2 shrink-0 bg-primary" aria-hidden />
          <span className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 sm:px-5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center bg-primary/10 text-primary">
              {primaryNotice.pinned ? <Pin className="h-4 w-4" /> : <Megaphone className="h-4 w-4" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-bold text-primary">
                {primaryNotice.pinned ? "중요 공지" : "최근 공지"}
              </span>
              <span className="mt-0.5 block truncate text-sm font-bold text-slate-950 dark:text-slate-50">
                {primaryNotice.title}
              </span>
            </span>
            <time className="hidden shrink-0 text-xs text-muted-foreground sm:block">
              {primaryNotice.created_at.slice(0, 10)}
            </time>
            <ChevronRight className="h-5 w-5 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
      )}

      <section aria-labelledby="core-actions">
        <div className="mb-3 flex items-center gap-3">
          <h2 id="core-actions" className="text-sm font-extrabold text-slate-950 dark:text-slate-50">
            핵심 작업
          </h2>
          <span className="h-px flex-1 bg-slate-300 dark:bg-slate-700" aria-hidden />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {QUICK_ACTIONS.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`group relative min-h-[88px] border border-slate-300 border-t-4 bg-white px-4 py-3 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[172px] sm:p-5 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800 ${item.rail}`}
              >
                <div className="flex items-center gap-3 sm:block">
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-slate-300 text-primary sm:hidden dark:border-slate-700">
                    <Icon className="h-5 w-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-3">
                      <span className="text-xs font-bold text-primary">{item.code}</span>
                      <Icon className="hidden h-5 w-5 text-slate-400 transition-colors group-hover:text-primary sm:block" />
                    </div>
                    <h3 className="mt-1 truncate text-base font-extrabold text-slate-950 sm:mt-5 sm:text-lg dark:text-slate-50">
                      {item.title}
                    </h3>
                  </div>
                  <ArrowRight className="h-5 w-5 shrink-0 text-slate-400 sm:hidden" />
                </div>
                <p className="mt-2 hidden pr-6 text-sm leading-6 text-muted-foreground sm:block">{item.desc}</p>
                <span className="mt-4 hidden items-center gap-1 text-xs font-bold text-primary sm:flex">
                  {item.action} <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                </span>
              </Link>
            );
          })}
        </div>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="border-t-2 border-t-slate-900 dark:border-t-slate-200">
          <SectionHeading title="최근 AI 업무" href="/chat" action="새 질문" />
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {conversations.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">
                아직 대화가 없습니다. AI 튜터에게 첫 질문을 남겨보세요.
              </p>
            ) : (
              conversations.map((conversation) => (
                <Link
                  key={conversation.id}
                  href={`/chat/${conversation.id}`}
                  className="grid min-h-13 grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 px-1 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-slate-900"
                >
                  <span className="flex h-8 w-8 items-center justify-center border border-slate-300 text-primary dark:border-slate-700">
                    <MessageCircle className="h-4 w-4" />
                  </span>
                  <span className="truncate text-sm font-medium">
                    {conversation.title || "제목 없는 대화"}
                  </span>
                  <time className="text-xs text-muted-foreground">
                    {conversation.updated_at.slice(0, 10)}
                  </time>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="border-t-2 border-t-primary">
          <SectionHeading title="대원 준비도" href="/fitness" action="운동 기록" />
          <div className="py-4">
            <div className="grid grid-cols-3 divide-x divide-slate-200 text-center dark:divide-slate-800">
              <div className="px-2">
                <strong className="block text-xl font-black tabular-nums">
                  {fitness.monthPoints.toLocaleString()}
                </strong>
                <span className="text-[11px] text-muted-foreground">이번 달</span>
              </div>
              <div className="px-2">
                <strong className="block text-xl font-black tabular-nums">
                  {fitness.monthRank ? `${fitness.monthRank}위` : "-"}
                </strong>
                <span className="text-[11px] text-muted-foreground">월간 순위</span>
              </div>
              <div className="px-2">
                <strong className="block text-xl font-black tabular-nums">
                  {fitness.streakDays > 0 ? `${fitness.streakDays}일` : "-"}
                </strong>
                <span className="text-[11px] text-muted-foreground">연속 운동</span>
              </div>
            </div>
            <div className="mt-5 space-y-2 border-t border-slate-200 pt-4 dark:border-slate-800">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="flex items-center gap-1.5 font-semibold text-slate-700 dark:text-slate-200">
                  <Target className="h-4 w-4 text-primary" /> 이번 달 목표
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {fitness.monthPoints}/{FITNESS_MONTH_GOAL}점
                </span>
              </div>
              <ProgressBar value={goalPct} />
            </div>
          </div>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="border-t-2 border-t-slate-900 dark:border-t-slate-200">
          <SectionHeading title="공지 목록" href="/notices" action="전체 보기" />
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {notices.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">등록된 공지사항이 없습니다.</p>
            ) : (
              notices.map((notice) => (
                <Link
                  key={notice.id}
                  href="/notices"
                  className="flex min-h-12 items-center gap-2 px-1 text-sm transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-slate-900"
                >
                  {notice.pinned && <Pin className="h-3.5 w-3.5 shrink-0 text-primary" />}
                  <span className="min-w-0 flex-1 truncate font-medium">{notice.title}</span>
                  {isNewNotice(notice.created_at) && (
                    <span className="shrink-0 text-[10px] font-black text-primary">NEW</span>
                  )}
                  <time className="shrink-0 text-xs text-muted-foreground">
                    {notice.created_at.slice(0, 10)}
                  </time>
                </Link>
              ))
            )}
          </div>
        </section>

        <section className="border-t-2 border-t-slate-900 dark:border-t-slate-200">
          <SectionHeading title="최신 구조 동향" href="/news" action="전체 보기" />
          <div className="divide-y divide-slate-200 dark:divide-slate-800">
            {news.length === 0 ? (
              <p className="py-8 text-center text-sm text-muted-foreground">등록된 구조 동향이 없습니다.</p>
            ) : (
              news.map((item) => (
                <Link
                  key={item.id}
                  href="/news"
                  className="block min-h-14 px-1 py-3 transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-slate-900"
                >
                  <div className="flex items-center gap-2">
                    <Newspaper className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
                    <time className="shrink-0 text-xs text-muted-foreground">{item.date}</time>
                  </div>
                  {(item.region || item.category) && (
                    <p className="mt-1 pl-6 text-[11px] text-muted-foreground">
                      {[item.region, item.category].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </Link>
              ))
            )}
          </div>
        </section>
      </div>

      <section className="flex flex-col gap-4 border-l-4 border-l-primary bg-slate-100 px-4 py-4 sm:flex-row sm:items-center dark:bg-slate-900">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center border border-slate-300 bg-white text-emerald-700 dark:border-slate-700 dark:bg-slate-950 dark:text-emerald-400">
          <ShieldCheck className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-extrabold">근거 확인 원칙</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            AI 답변에는 출처와 페이지를 표시하며, 교육자료에서 확인할 수 없는 내용은 확인되지 않았다고 안내합니다.
          </p>
        </div>
        <Link
          href="/docs"
          className="flex min-h-11 shrink-0 items-center justify-center gap-2 border border-slate-300 bg-white px-4 text-sm font-semibold transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-slate-700 dark:bg-slate-950 dark:hover:bg-slate-800"
        >
          <FileText className="h-4 w-4 text-primary" /> 원본 자료 확인
        </Link>
      </section>

      {profile?.role === "admin" && (
        <Link
          href="/admin"
          className="flex min-h-12 items-center gap-3 border border-slate-300 bg-white px-4 text-sm font-semibold transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800"
        >
          <BarChart3 className="h-4 w-4 text-primary" />
          관리자 통계·자료·사용자·공지
          <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
        </Link>
      )}
    </div>
  );
}
