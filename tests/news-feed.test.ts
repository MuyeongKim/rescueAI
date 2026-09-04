import { afterEach, describe, expect, it, vi } from "vitest";
import { collectRecentNews, parseNewsRss } from "@/lib/news-feed";

const item = (title: string, date: string, url = `https://example.com/${title}`) =>
  `<item><title>${title} - 출처</title><link>${url}</link><source url="https://example.com">출처</source><pubDate>${date}</pubDate></item>`;
const rss = (body: string) => `<rss version="2.0"><channel>${body}</channel></rss>`;
const now = new Date("2026-09-04T23:00:00Z");
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("최근 30일 뉴스 수집", () => {
  it("RSS 원 게시일을 KST로 읽고 출처 접미만 제거한다", () => {
    expect(parseNewsRss(rss(item("수난 &amp; 구조", "Fri, 04 Sep 2026 16:00:00 GMT")))).toEqual([
      { title: "수난 & 구조", source: "출처", date: "2026-09-05", url: "https://example.com/수난 & 구조" },
    ]);
  });
  it("날짜 미상·잘못된 날짜·실행 가능한 링크를 최신 기사로 수집하지 않는다", () => {
    expect(parseNewsRss(rss(item("없음", "") + item("잘못된 날짜", "wrong") + item("링크", now.toUTCString(), "javascript:alert(1)")))).toEqual([]);
  });
  it("관련도순 상단이 오래된 기사여도 날짜를 먼저 걸러 최신 기사를 선택한다", async () => {
    const body = Array.from({ length: 25 }, (_, index) => item(`오래된${index}`, "Wed, 01 Jul 2026 00:00:00 GMT")).join("")
      + item("오늘", "Sat, 05 Sep 2026 00:00:00 GMT") + item("경계", "Thu, 06 Aug 2026 15:00:00 GMT")
      + item("제외", "Thu, 06 Aug 2026 14:59:59 GMT") + item("미래", "Sun, 06 Sep 2026 00:00:00 GMT");
    const fetcher = vi.fn().mockResolvedValue(new Response(rss(body)));
    // 실제 fetch처럼 호출마다 독립 응답 스트림을 제공한다.
    fetcher.mockImplementation(async () => new Response(rss(body)));
    vi.stubGlobal("fetch", fetcher);
    const result = await collectRecentNews(now);
    expect(result.period).toEqual({ from: "2026-08-07", to: "2026-09-05" });
    expect(result.candidates.map((entry) => entry.title)).toEqual(["오늘", "경계"]);
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const [url, options] of fetcher.mock.calls) {
      expect(new URL(url).searchParams.get("q")).toContain("when:30d");
      expect(options).toMatchObject({ cache: "no-store", signal: expect.any(AbortSignal) });
    }
  });
  it("한 제공처 장애는 경고로 남기고 다른 제공처의 기사는 유지한다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("timeout"))
      .mockImplementation(async () => new Response(rss(item("정상", now.toUTCString()))));
    vi.stubGlobal("fetch", fetcher);
    expect(await collectRecentNews(now)).toMatchObject({ feedFailures: 1, candidates: [{ title: "정상" }] });
  });
  it.each([503, 200])("전부 HTTP 실패나 비RSS 응답이면 0건 정상 수집으로 표시하지 않는다 (%i)", async (status) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>unavailable</html>", { status })));
    await expect(collectRecentNews(now)).rejects.toThrow("뉴스 제공처에 연결하지 못했습니다");
  });
});
