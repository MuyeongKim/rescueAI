import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  demo: false,
  session: null as unknown,
  admin: null as unknown,
  requests: [] as Array<{ url: URL; admin: boolean }>,
  rows: [] as Array<Record<string, unknown>>,
  failure: false,
}));
vi.mock("@/lib/demo", () => ({ get DEMO() { return mocks.demo; } }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => mocks.session }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.admin }));

import { getRecentNews, listAllNews, listVisibleNews } from "@/lib/news";

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 1, title: "구조 훈련 소식", summary: null, source: "등록 자료", url: null,
  region: "전국", category: "수난", published_on: "2026-09-05", pinned: false,
  hidden: false, auto: false, created_at: "2026-09-04T15:00:00Z", ...overrides,
});

// 실제 Supabase SDK가 생성한 PostgREST 요청을 확인한다. 네트워크/DB 응답만 대체한다.
function testClient(admin: boolean) {
  return createSupabaseClient("https://news-test.supabase.co", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      mocks.requests.push({ url, admin });
      return new Response(JSON.stringify(mocks.failure ? { message: "unavailable" } : mocks.rows), {
        status: mocks.failure ? 400 : 200,
        headers: { "Content-Type": "application/json" },
      });
    } },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-05T03:00:00Z"));
  mocks.demo = false;
  mocks.failure = false;
  mocks.requests = [];
  mocks.rows = [row()];
  mocks.session = testClient(false);
  mocks.admin = testClient(true);
});
afterEach(() => vi.useRealTimers());

describe("구조 동향 일반 조회 날짜 경계", () => {
  it.each([getRecentNews, listVisibleNews])("기간과 숨김 필터를 상위 개수와 함께 DB에 전송한다", async (read) => {
    await read(1);
    expect(mocks.requests).toHaveLength(1);
    const { url, admin } = mocks.requests[0];
    expect(admin).toBe(false);
    expect(url.pathname).toBe("/rest/v1/news");
    expect(url.searchParams.get("hidden")).toBe("eq.false");
    expect(url.searchParams.get("or")).toBe(
      "(and(published_on.gte.2026-08-07,published_on.lte.2026-09-05)," +
      "and(published_on.is.null,auto.eq.false,created_at.gte.2026-08-06T15:00:00.000Z,created_at.lt.2026-09-05T15:00:00.000Z))"
    );
    expect(url.searchParams.get("limit")).toBe("1");
    expect(url.searchParams.get("order")).toBe("pinned.desc,published_on.desc.nullslast,created_at.desc");
    // 고정글 예외 OR가 없으므로 7월 고정글·내일 기사는 limit 대상에 들지 않는다.
    expect(url.searchParams.get("or")).not.toContain("pinned");
  });

  it("한국시간 자정 이후 수동 등록글의 날짜를 UTC 전날로 표시하지 않는다", async () => {
    mocks.rows = [row({ published_on: null, created_at: "2026-09-04T15:00:00Z" })];
    expect((await getRecentNews())[0].date).toBe("2026-09-05");
    mocks.rows = [row({ published_on: null, created_at: "2026-09-04T14:59:59.999Z" })];
    expect((await listVisibleNews())[0].date).toBe("2026-09-04");
    mocks.rows = [row({ published_on: "2026-08-07", created_at: "2026-09-05T03:00:00Z" })];
    expect((await getRecentNews())[0].date).toBe("2026-08-07");
  });

  it("KST 날짜가 바뀌면 다음 조회에 새 기간을 적용한다", async () => {
    vi.setSystemTime(new Date("2026-09-05T15:00:00Z"));
    await getRecentNews();
    expect(mocks.requests[0].url.searchParams.get("or")).toBe(
      "(and(published_on.gte.2026-08-08,published_on.lte.2026-09-06)," +
      "and(published_on.is.null,auto.eq.false,created_at.gte.2026-08-07T15:00:00.000Z,created_at.lt.2026-09-06T15:00:00.000Z))"
    );
  });

  it("관리자 전체 목록에는 날짜·숨김 제한을 추가하지 않는다", async () => {
    mocks.rows = [row({ published_on: "2026-07-01", pinned: true, hidden: true })];
    expect(await listAllNews()).toEqual([expect.objectContaining({ date: "2026-07-01", pinned: true, hidden: true })]);
    const { url, admin } = mocks.requests[0];
    expect(admin).toBe(true);
    expect(url.searchParams.has("or")).toBe(false);
    expect(url.searchParams.has("hidden")).toBe(false);
    expect(url.searchParams.get("limit")).toBe("200");
  });

  it("실제 데이터 조회가 실패해도 가상 최신 기사를 대신 표시하지 않는다", async () => {
    mocks.failure = true;
    expect(await getRecentNews()).toEqual([]);
    expect(await listVisibleNews()).toEqual([]);
  });

  it("오래된 데모 예시를 현재 뉴스처럼 날짜를 바꾸지 않는다", async () => {
    mocks.demo = true;
    expect(await getRecentNews()).toEqual([]);
    expect(await listVisibleNews()).toEqual([]);
    const examples = await listAllNews();
    expect(examples).toHaveLength(3);
    expect(examples.every((item) => item.title.startsWith("[데모 예시]") && item.source === "가상 자료 · 실제 보도 아님")).toBe(true);
    expect(examples.map((item) => item.date)).toEqual(["2026-06-11", "2026-06-11", "2026-06-10"]);
    expect(mocks.requests).toHaveLength(0);
  });

  it("데모에도 미래 날짜 제외와 동일한 상위 개수 제한을 적용한다", async () => {
    mocks.demo = true;
    vi.setSystemTime(new Date("2026-06-10T12:00:00+09:00"));
    expect((await listVisibleNews()).map((item) => item.date)).toEqual(["2026-06-10"]);
    vi.setSystemTime(new Date("2026-06-11T12:00:00+09:00"));
    expect(await getRecentNews(1)).toHaveLength(1);
    expect(await listVisibleNews(1)).toHaveLength(1);
  });
});
