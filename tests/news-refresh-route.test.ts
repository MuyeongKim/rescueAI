import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), collect: vi.fn(), summarize: vi.fn(), from: vi.fn(), insert: vi.fn(), read: vi.fn(), in: vi.fn() }));
vi.mock("@/lib/auth", () => ({ requireApiAdmin: mocks.auth }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/news-feed", () => ({ collectRecentNews: mocks.collect }));
vi.mock("@/lib/news-ai", () => ({ summarizeHeadlines: mocks.summarize }));
import { GET, POST } from "@/app/api/news/refresh/route";

const article = (id: string) => ({ title: `구조 ${id}`, url: `https://example.com/${id}`, source: "소방", date: "2026-09-04" });
const request = (secret = "test-cron-secret") => new Request("https://example.com/api/news/refresh", { headers: { authorization: `Bearer ${secret}` } });
beforeEach(() => {
  vi.clearAllMocks(); vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.auth.mockResolvedValue({ ok: false });
  mocks.collect.mockResolvedValue({ candidates: [article("a"), article("b")], feedFailures: 0, period: { from: "2026-08-07", to: "2026-09-05" } });
  mocks.summarize.mockResolvedValue([]);
  mocks.read.mockResolvedValue({ data: [], error: null });
  mocks.insert.mockResolvedValue({ data: [{ id: 1 }], error: null });
  const reader = { in: mocks.in, abortSignal: mocks.read };
  mocks.in.mockReturnValue(reader);
  mocks.from.mockImplementation(() => ({ select: () => reader, insert: (row: unknown) => ({ select: () => ({ abortSignal: () => mocks.insert(row) }) }) }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("뉴스 자동 수집 API", () => {
  it("잘못된 Cron 인증과 비관리자는 수집·DB 접근 전에 거절한다", async () => {
    expect((await GET(request("wrong"))).status).toBe(403);
    expect(mocks.collect).not.toHaveBeenCalled(); expect(mocks.from).not.toHaveBeenCalled();
  });
  it("관리자 POST를 허용하고 실제 저장수·요약 누락을 알린다", async () => {
    mocks.auth.mockResolvedValue({ ok: true });
    const response = await POST(request("wrong"));
    expect(await response.json()).toMatchObject({ ok: true, added: 2, scanned: 2, summariesMissing: 2 });
    expect(mocks.in).toHaveBeenCalledWith("url", [article("a").url, article("b").url]);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ published_on: "2026-09-04", summary: null }));
  });
  it("기존 기사 확인 실패는 신규 기사로 오인해 재삽입하지 않는다", async () => {
    mocks.read.mockResolvedValue({ data: null, error: { message: "unavailable" } });
    expect((await GET(request())).status).toBe(500);
    expect(mocks.insert).not.toHaveBeenCalled(); expect(mocks.summarize).not.toHaveBeenCalled();
  });
  it("이미 저장된 URL은 제외하고 동시 실행의 URL 충돌만 건너뛴다", async () => {
    mocks.read.mockResolvedValue({ data: [{ url: article("a").url }], error: null });
    mocks.insert.mockResolvedValue({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "news_url_uniq"' } });
    expect(await (await GET(request())).json()).toMatchObject({ ok: true, added: 0 });
    expect(mocks.insert).toHaveBeenCalledTimes(1);
  });
  it("상위 8개가 과거·발행일 없는 기존 기사여도 뒤의 신규 기사를 수집한다", async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => article(String(index)));
    mocks.collect.mockResolvedValue({ candidates, feedFailures: 0, period: { from: "2026-08-07", to: "2026-09-05" } });
    mocks.read.mockResolvedValue({ data: candidates.slice(0, 8).map(({ url }) => ({ url })), error: null });
    expect(await (await GET(request())).json()).toMatchObject({ ok: true, added: 1 });
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ url: candidates[8].url }));
    expect(mocks.summarize).toHaveBeenCalledWith([{ title: candidates[8].title, source: candidates[8].source }]);
    expect(mocks.in.mock.calls.every(([, urls]) => urls.length <= 8)).toBe(true);
  });
  it("URL 중복 이외 DB 오류는 성공으로 숨기지 않는다", async () => {
    mocks.insert.mockResolvedValue({ data: null, error: { code: "23505", message: 'duplicate key value violates unique constraint "news_pkey"' } });
    expect((await GET(request())).status).toBe(500);
  });
  it("RSS 전체 장애는 500이고 빈 정상 피드는 쓰기 없이 0건이다", async () => {
    mocks.collect.mockRejectedValueOnce(new Error("수집 실패"));
    expect((await GET(request())).status).toBe(500);
    mocks.collect.mockResolvedValueOnce({ candidates: [], feedFailures: 0, period: { from: "2026-08-07", to: "2026-09-05" } });
    expect(await (await GET(request())).json()).toMatchObject({ ok: true, added: 0, scanned: 0 });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("운영과 동일한 부분 유니크 인덱스에서 중복 기사가 있어도 후속 신규 기사를 저장한다", async () => {
    const db = new PGlite();
    try {
      await db.exec("create schema auth; create table auth.users(id uuid primary key); create role authenticated;");
      await db.exec(readFileSync(new URL("../supabase/migrations/0008_news.sql", import.meta.url), "utf8"));
      await expect(db.query("insert into news(title,url) values ('test','https://example.com/a') on conflict(url) do nothing")).rejects.toMatchObject({ code: "42P10" });
      await db.query("insert into news(title,url) values ('기존','https://example.com/a')");
      // 사전 조회 이후 다른 실행이 a를 저장한 경쟁 상태를 재현한다.
      mocks.insert.mockImplementation(async (row) => {
        try { return { data: (await db.query("insert into news(title,url,published_on) values ($1,$2,$3) returning id", [row.title, row.url, row.published_on])).rows, error: null }; }
        catch (error) { return { data: null, error }; }
      });
      expect(await (await GET(request())).json()).toMatchObject({ ok: true, added: 1 });
      expect((await db.query("select title from news order by id")).rows).toEqual([{ title: "기존" }, { title: "구조 b" }]);
    } finally { await db.close(); }
  });
});
