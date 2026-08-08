import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireApiAdmin } from "@/lib/auth";
import { summarizeHeadlines } from "@/lib/news-ai";

// 구조 동향 자동 수집(B): Google News RSS(무료, 키 없음) → AI 요약/분류 → news 테이블 upsert.
// 호출 권한: Vercel Cron(Authorization: Bearer CRON_SECRET) 또는 관리자(수동 버튼).
// 헤드라인만 가져오므로 요약은 제목 기반(가벼움). 관리자가 검수(숨김/고정/삭제) 가능.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// 검색어(분야별). hl/gl/ceid 로 한국어·한국 기준. 해외 동향은 별도 쿼리로.
const QUERIES = [
  "소방 구조 신기술",
  "수난구조 드론",
  "산악구조",
  "소방 구급 장비",
  "rescue technique fire department", // 해외
];
const PER_QUERY = 4;
const MAX_NEW = 8;

type Raw = { title: string; url: string; source: string; date: string | null };

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, "")
    // &amp; 는 반드시 마지막에 — 먼저 풀면 "&amp;lt;" 가 "<" 로 이중 언이스케이프됨
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function parseRss(xml: string): Raw[] {
  const out: Raw[] = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const b = m[1];
    const pick = (tag: string) => {
      const mm = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return mm ? decode(mm[1]) : "";
    };
    let title = pick("title");
    const url = pick("link");
    const source = pick("source");
    // Google News 제목 끝의 " - 출처사" 중복 접미 제거(출처는 source 필드로 따로 표시)
    if (source && title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3)).trim();
    }
    const pub = pick("pubDate");
    let date: string | null = null;
    if (pub) {
      const d = new Date(pub);
      if (!isNaN(d.getTime())) date = d.toISOString().slice(0, 10);
    }
    if (title && url) out.push({ title, url, source, date });
  }
  return out;
}

// 길이 노출까지 막을 필요는 없지만, 바이트 단위 조기 종료로 비밀값을 유추당하지 않도록
// 상수 시간 비교를 쓴다. 길이가 다르면 비교 없이 false.
function secretMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function authorize(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && secretMatches(req.headers.get("authorization"), secret)) return true;
  const auth = await requireApiAdmin();
  return auth.ok;
}

async function refresh(): Promise<{ added: number; scanned: number }> {
  const admin = createAdminClient();

  // 1) RSS 수집
  const raw: Raw[] = [];
  for (const q of QUERIES) {
    const u = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=ko&gl=KR&ceid=KR:ko`;
    try {
      const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
      if (res.ok) raw.push(...parseRss(await res.text()).slice(0, PER_QUERY));
    } catch (e) {
      console.error("[news/refresh] RSS 실패:", q, e);
    }
  }

  // 2) 링크 기준 중복 제거(이번 수집 내 + DB 기존)
  const byUrl = new Map<string, Raw>();
  for (const r of raw) if (!byUrl.has(r.url)) byUrl.set(r.url, r);
  const candidates = Array.from(byUrl.values());
  const { data: existing } = await admin
    .from("news")
    .select("url")
    .in("url", candidates.map((c) => c.url));
  const seen = new Set((existing ?? []).map((e) => e.url));
  const fresh = candidates.filter((c) => !seen.has(c.url)).slice(0, MAX_NEW);
  if (fresh.length === 0) return { added: 0, scanned: candidates.length };

  // 3) AI 배치 요약/분류
  const sums = await summarizeHeadlines(fresh.map((f) => ({ title: f.title, source: f.source })));

  // 4) upsert (url 유니크 → 충돌 무시)
  const rows = fresh.map((f, i) => ({
    title: f.title,
    summary: sums[i]?.summary ?? null,
    source: f.source || "Google News",
    url: f.url,
    region: sums[i]?.region ?? null,
    category: sums[i]?.category ?? null,
    published_on: f.date,
    auto: true,
    hidden: false,
  }));
  // upsert(onConflict url, 중복 무시) — cron 과 관리자 수동 버튼이 겹쳐 url 유니크 충돌이 나도
  // 배치 전체가 500 으로 실패하지 않게 한다(신규 행은 저장, 중복은 조용히 건너뜀).
  // select() 로 실제 삽입된 행만 돌려받는다 — rows.length 를 그대로 쓰면 중복을 건너뛴 만큼
  // "N건 추가"가 거짓말이 된다(관리자 수동 버튼 결과가 실제와 어긋남).
  const { data: inserted, error } = await admin
    .from("news")
    .upsert(rows, { onConflict: "url", ignoreDuplicates: true })
    .select("id");
  if (error) {
    console.error("[news/refresh] upsert 실패:", error.message);
    throw new Error(error.message);
  }
  return { added: inserted?.length ?? 0, scanned: candidates.length };
}

export async function GET(req: Request) {
  if (!(await authorize(req))) return new Response("Forbidden", { status: 403 });
  try {
    const r = await refresh();
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "수집 실패", { status: 500 });
  }
}

// 관리자 수동 버튼은 POST로도 호출 가능
export async function POST(req: Request) {
  return GET(req);
}
