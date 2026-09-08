import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20260908042907_distributed_ai_usage_budget.sql", import.meta.url), "utf8");
const user = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const unknown = "33333333-3333-4333-8333-333333333333";
let db: PGlite;
type Result = { ok: boolean; limit_kind?: string; retry_after_seconds: number };
async function asUser(id = user) {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await db.exec("set role authenticated");
}
async function consume(action = "chat") {
  return (await db.query<{ result: Result }>("select public.consume_ai_budget($1) as result", [action])).rows[0].result;
}
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users(id uuid primary key); create function auth.uid() returns uuid language sql as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    insert into auth.users values ('${user}'), ('${other}');
    create table public.profiles(id uuid primary key, role text, must_change_password boolean);
    insert into public.profiles values ('${user}', 'user', false), ('${other}', 'admin', false);`);
  await db.exec(migration);
});
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.exec(`reset role; truncate security_private.ai_usage_counters;
    update security_private.ai_budget_settings set account_daily_units=2000, global_daily_units=4000;
    update public.profiles set must_change_password=false, role=case when id='${other}' then 'admin' else 'user' end;`);
  await asUser();
});

describe("분산 AI 사용량 DB 경계", () => {
  it("동시 요청과 다음 서버의 요청을 같은 계정 한도로 합산한다", async () => {
    const results = await Promise.all(Array.from({ length: 45 }, () => consume()));
    expect(results.filter(result => result.ok)).toHaveLength(30);
    expect(await consume()).toMatchObject({ ok: false, limit_kind: "minute" });
    await db.exec("reset role");
    expect((await db.query<{ used: number }>("select used from security_private.ai_usage_counters where bucket_key='day:global'")).rows[0].used).toBe(30);
  });
  it("minute 경계는 초기화되고 계정의 오늘 사용량은 유지된다", async () => {
    await consume();
    await db.exec("reset role; update security_private.ai_usage_counters set used=30, window_start=window_start-interval '1 minute' where bucket_key like 'minute:%'");
    await asUser();
    expect((await consume()).ok).toBe(true);
    await db.exec("reset role");
    expect((await db.query<{ used: number }>("select used from security_private.ai_usage_counters where bucket_key='day:global'")).rows[0].used).toBe(2);
  });
  it("API 종류를 바꿔도 계정 일일 예산을 우회하지 못한다", async () => {
    await db.exec("reset role; update security_private.ai_budget_settings set account_daily_units=40");
    await asUser();
    expect((await consume("generate")).ok).toBe(true);
    expect((await consume("generate")).ok).toBe(true);
    expect(await consume()).toMatchObject({ ok: false, limit_kind: "account_daily" });
    await asUser(other);
    expect((await consume()).ok).toBe(true);
  });
  it("두 공용 계정과 Cron이 서비스 전체 예산을 공유한다", async () => {
    await db.exec("reset role; update security_private.ai_budget_settings set global_daily_units=40");
    await asUser(); await consume("generate");
    await asUser(other); await consume("generate");
    expect(await consume()).toMatchObject({ ok: false, limit_kind: "global_daily" });
    await db.exec("reset role; set role service_role");
    expect((await db.query<{ result: Result }>("select public.consume_news_cron_budget() result")).rows[0].result)
      .toMatchObject({ ok: false, limit_kind: "global_daily" });
  });
  it("인증 사용자는 limit·사용자ID·Cron action·private카운터·정책을 조작할 수 없다", async () => {
    await expect(db.query("select public.consume_ai_budget('chat', 999999)")).rejects.toMatchObject({ code: "42883" });
    await expect(consume("news-cron")).rejects.toMatchObject({ code: "42501" });
    await expect(consume("news-summary")).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("select public.consume_news_cron_budget()")).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("select security_private.consume_ai_usage($1, 'chat')", [other])).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("delete from security_private.ai_usage_counters")).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("update security_private.ai_usage_policy set minute_limit=999")).rejects.toMatchObject({ code: "42501" });
    await asUser(other); expect((await consume("news-summary")).ok).toBe(true);
  });
  it("익명·미등록·비밀번호 미변경 계정은 소비할 수 없다", async () => {
    await db.exec("reset role; set role anon");
    await expect(consume()).rejects.toMatchObject({ code: "42501" });
    await asUser(unknown); await expect(consume()).rejects.toMatchObject({ code: "42501" });
    await db.exec(`reset role; update public.profiles set must_change_password=true where id='${user}'`);
    await asUser(); await expect(consume()).rejects.toMatchObject({ code: "42501" });
  });
  it("역할이 NULL인 기존 프로필도 관리자 작업 한도를 사용할 수 없다", async () => {
    await db.exec(`reset role; update public.profiles set role=null where id='${other}'`);
    await asUser(other);
    await expect(consume("news-summary")).rejects.toMatchObject({ code: "42501" });
    expect((await consume()).ok).toBe(true);
  });
  it("KST 날짜가 바뀌면 하루 한도가 초기화되고 재실행은 관리자 설정·카운터를 보존한다", async () => {
    await consume();
    await db.exec(`reset role; update security_private.ai_budget_settings set account_daily_units=1234;
      update security_private.ai_usage_counters set used=9999, window_start=window_start-interval '1 day' where bucket_key like 'day:%'`);
    await db.exec(migration);
    expect((await db.query<{ account_daily_units: number }>("select account_daily_units from security_private.ai_budget_settings")).rows[0].account_daily_units).toBe(1234);
    await asUser(); expect((await consume()).ok).toBe(true);
    await db.exec("reset role");
    expect((await db.query<{ used: number; local_hour: number }>("select used, extract(hour from window_start at time zone 'Asia/Seoul')::integer local_hour from security_private.ai_usage_counters where bucket_key='day:global'")).rows[0])
      .toEqual({ used: 1, local_hour: 0 });
  });
  it("계정 삭제는 그 계정 카운터만 정리하고 다른 계정과 전체 사용량은 보존한다", async () => {
    await consume(); await asUser(other); await consume();
    await db.exec(`reset role; delete from auth.users where id='${user}'`);
    const rows = (await db.query<{ bucket_key: string; used: number }>("select bucket_key, used from security_private.ai_usage_counters order by bucket_key")).rows;
    expect(rows.some(row => row.bucket_key.includes(user))).toBe(false);
    expect(rows.filter(row => row.bucket_key.includes(other))).toHaveLength(2);
    expect(rows.find(row => row.bucket_key === "day:global")?.used).toBe(2);
  });
});
