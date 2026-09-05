import { getNewsDateWindow, toKstDate } from "@/lib/news-window";

export type RawNews = { title: string; url: string; source: string; date: string };

const FEEDS = [
  { query: "소방 구조 신기술", locale: "ko", country: "KR", edition: "KR:ko" },
  { query: "수난구조 드론", locale: "ko", country: "KR", edition: "KR:ko" },
  { query: "산악구조", locale: "ko", country: "KR", edition: "KR:ko" },
  { query: "소방 구급 장비", locale: "ko", country: "KR", edition: "KR:ko" },
  { query: "fire rescue (equipment OR technology OR technique)", locale: "en-US", country: "US", edition: "US:en" },
];

function decode(value: string): string {
  return value.replace(/<!\[CDATA\[/g, "").replace(/\]\]>/g, "")
    .replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
}

export function parseNewsRss(xml: string): RawNews[] {
  const items: RawNews[] = [];
  for (const match of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const pick = (tag: string) => {
      const value = match[1].match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
      return value ? decode(value[1]) : "";
    };
    const source = pick("source");
    let title = pick("title");
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    // 소방 재단 기금 행사도 검색어에 걸릴 수 있으므로 구조 동향과 무관한 골프 대회는 제외한다.
    if (/\bgolf\s+tournament\b|골프\s*대회/iu.test(title)) continue;
    const url = pick("link");
    const published = new Date(pick("pubDate"));
    // 날짜가 없거나 잘못된 기사를 수집일로 바꿔 최신 기사처럼 게시하지 않는다.
    if (!title || !Number.isFinite(published.getTime())) continue;
    try {
      if (new URL(url).protocol !== "https:") continue;
    } catch { continue; }
    items.push({ title, url, source, date: toKstDate(published) });
  }
  return items;
}

export async function collectRecentNews(now = new Date()) {
  const period = getNewsDateWindow(now);
  // RSS 검색 결과는 관련도순일 수 있다. 전체 응답에 기간 필터·최신순을 적용한 뒤 자른다.
  const results = await Promise.allSettled(FEEDS.map(async (feed) => {
    const params = new URLSearchParams({ q: `${feed.query} when:30d`, hl: feed.locale, gl: feed.country, ceid: feed.edition });
    const res = await fetch(`https://news.google.com/rss/search?${params}`, {
      headers: { "User-Agent": "Mozilla/5.0" }, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
    const xml = await res.text();
    if (!/<rss(?:\s|>)/i.test(xml) || !/<channel(?:\s|>)/i.test(xml)) throw new Error("RSS 형식 오류");
    return parseNewsRss(xml).filter((item) => item.date >= period.from && item.date <= period.to)
      .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  }));
  const byUrl = new Map<string, RawNews>();
  let feedFailures = 0;
  for (const result of results) {
    if (result.status === "rejected") {
      feedFailures += 1;
      console.error("[news/refresh] RSS 실패:", result.reason);
    } else {
      for (const item of result.value) if (!byUrl.has(item.url)) byUrl.set(item.url, item);
    }
  }
  if (feedFailures === FEEDS.length) throw new Error("뉴스 제공처에 연결하지 못했습니다. 잠시 후 다시 수집하세요.");
  return { candidates: [...byUrl.values()].sort((a, b) => b.date.localeCompare(a.date)), feedFailures, period };
}
