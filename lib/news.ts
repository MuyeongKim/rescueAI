// 구조 동향(뉴스) 읽기 — Supabase `news` 테이블 기반.
// 수동 큐레이션(A) + 자동수집(B) 공용. 홈 대시보드·/news 가 사용.
// 테이블 미생성(마이그레이션 0008 전)/오류 시 빈 배열로 우아하게 강등.
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { DEMO } from "@/lib/demo";
import { getNewsDateWindow, toKstDate } from "@/lib/news-window";

export type NewsItem = {
  id: number;
  title: string;
  summary: string | null;
  source: string | null;
  url: string | null;
  region: string | null;
  category: string | null;
  date: string;
  pinned: boolean;
  hidden: boolean;
  auto: boolean;
};

type Row = {
  id: number;
  title: string;
  summary: string | null;
  source: string | null;
  url: string | null;
  region: string | null;
  category: string | null;
  published_on: string | null;
  pinned: boolean;
  hidden: boolean;
  auto: boolean;
  created_at: string | null;
};

function toItem(r: Row): NewsItem {
  const createdAt = r.created_at ? new Date(r.created_at) : null;
  return {
    id: r.id,
    title: r.title,
    summary: r.summary,
    source: r.source,
    url: r.url,
    region: r.region,
    category: r.category,
    date: r.published_on ?? (createdAt && Number.isFinite(createdAt.getTime()) ? toKstDate(createdAt) : ""),
    pinned: r.pinned,
    hidden: r.hidden,
    auto: r.auto,
  };
}

// 데모 전용 가상 예시. 실제 기사로 표시하거나 날짜를 현재로 바꾸지 않는다.
const DEMO_NEWS: NewsItem[] = [
  { id: 1, title: "○○소방본부, 급류 구조 신형 수상드론 도입", summary: "급류 사고 현장에서 구조대원 진입 전 요구조자에게 구명환을 신속 투하할 수 있는 수상드론을 도입했다.", source: "소방청 보도자료", url: null, region: "전국", category: "수난", date: "2026-06-11", pinned: false, hidden: false, auto: false },
  { id: 2, title: "독일 THW, 붕괴 현장 AI 음향 탐지 시스템 실전 배치", summary: "잔해 속 생존자의 미세한 소리를 AI가 분류해 탐지 시간을 평균 40% 단축했다.", source: "해외 소방·구조 동향", url: null, region: "해외", category: "붕괴·매몰", date: "2026-06-11", pinned: false, hidden: false, auto: false },
  { id: 3, title: "여름철 물놀이 사고 대비 전국 수난구조 합동훈련 실시", summary: "휴가철을 앞두고 하천·계곡 중심 합동훈련이 전국에서 실시된다.", source: "소방 뉴스", url: null, region: "전국", category: "수난", date: "2026-06-10", pinned: false, hidden: false, auto: false },
].map((item) => ({ ...item, title: `[데모 예시] ${item.title}`, source: "가상 자료 · 실제 보도 아님" }));

const COLS =
  "id, title, summary, source, url, region, category, published_on, pinned, hidden, auto, created_at";

// 숨김·오래된 고정글·미래글을 SQL에서 제외한 다음 상위 N개를 읽는다.
async function readVisibleNews(limit: number): Promise<NewsItem[]> {
  const { from, to } = getNewsDateWindow();
  if (DEMO) return DEMO_NEWS.filter((item) => item.date >= from && item.date <= to).slice(0, limit);
  const createdFrom = new Date(`${from}T00:00:00+09:00`).toISOString();
  const createdBefore = new Date(new Date(`${to}T00:00:00+09:00`).getTime() + 24 * 60 * 60 * 1000).toISOString();
  try {
    const sb = await createClient();
    const { data, error } = await sb
      .from("news")
      .select(COLS)
      .eq("hidden", false)
      .or(`and(published_on.gte.${from},published_on.lte.${to}),and(published_on.is.null,auto.eq.false,created_at.gte.${createdFrom},created_at.lt.${createdBefore})`)
      .order("pinned", { ascending: false })
      .order("published_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return ((data ?? []) as Row[]).map(toItem);
  } catch {
    return [];
  }
}

// 홈 대시보드용 — 최근 30일 중 고정·최신 우선 상위 N
export async function getRecentNews(limit = 3): Promise<NewsItem[]> {
  return readVisibleNews(limit);
}

// /news 목록 — 홈과 같은 최근 30일 정책
export async function listVisibleNews(limit = 60): Promise<NewsItem[]> {
  return readVisibleNews(limit);
}

// 관리자 큐레이션용 — 숨김 포함 전체 (service role)
export async function listAllNews(limit = 200): Promise<NewsItem[]> {
  if (DEMO) return DEMO_NEWS;
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("news")
      .select(COLS)
      .order("pinned", { ascending: false })
      .order("published_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) return [];
    return (data as Row[]).map(toItem);
  } catch {
    return [];
  }
}
