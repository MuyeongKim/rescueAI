import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { describe, expect, it } from "vitest";

const MIGRATION_PATH = resolve(
  process.cwd(),
  "supabase/migrations/20260902021457_add_login_access_counter.sql"
);
const MIGRATION = readFileSync(MIGRATION_PATH, "utf8");
const DB_TEST = readFileSync(
  resolve(process.cwd(), "supabase/tests/login_access_counter_test.sql"),
  "utf8"
);
const SETUP_SQL = readFileSync(
  resolve(process.cwd(), "supabase/setup_new_project.sql"),
  "utf8"
);

describe("로그인 접속 집계 DB 계약", () => {
  it("원장을 비노출 스키마에 두고 공개 RPC는 최소 권한 래퍼로 제한한다", () => {
    expect(MIGRATION).toContain("create schema if not exists visitor_private");
    expect(MIGRATION).toContain(
      "alter table visitor_private.login_session_days enable row level security"
    );
    expect(MIGRATION).toMatch(
      /revoke all on table visitor_private\.login_session_days\s+from public, anon, authenticated, service_role;/
    );
    expect(MIGRATION).toMatch(
      /function visitor_private\.record_daily_login_access\(\)[\s\S]*?security definer[\s\S]*?set search_path = ''/
    );
    expect(MIGRATION).toMatch(
      /function public\.record_daily_login_access\(\)[\s\S]*?security invoker[\s\S]*?set search_path = ''/
    );
    expect(MIGRATION).toMatch(
      /grant execute on function public\.record_daily_login_access\(\)\s+to authenticated;/
    );
    expect(MIGRATION).not.toMatch(
      /grant execute on function public\.record_daily_login_access\(\)\s+to anon/
    );
  });

  it("JWT session_id만 날짜별 해시해 원자적으로 중복을 제거한다", () => {
    expect(MIGRATION).toContain("v_claims ->> 'session_id'");
    expect(MIGRATION).toContain("extensions.digest(");
    expect(MIGRATION).toContain("v_visit_date::text || ':' || v_session_id::text");
    expect(MIGRATION).toContain("on conflict (visit_date, session_hash) do nothing");
    expect(MIGRATION).not.toMatch(/user_agent|ip_address|email\s+(text|varchar)/i);
    expect(DB_TEST).toContain("같은 세션의 같은 날 재요청은 중복 기록하지 않는다");
    expect(DB_TEST).toContain("공유 계정의 별도 인증 세션");
  });

  it("PGlite에서 실제 마이그레이션을 실행하고 동일 세션 중복·별도 세션을 검증한다", async () => {
    const db = new PGlite({ extensions: { pgcrypto } });
    await db.waitReady;

    try {
      await db.exec(`
        create role anon;
        create role authenticated;
        create role service_role;
        create schema auth;

        create function auth.jwt()
        returns jsonb
        language sql
        stable
        set search_path = ''
        as $$
          select coalesce(
            nullif(pg_catalog.current_setting('request.jwt.claims', true), ''),
            '{}'
          )::jsonb
        $$;

        create function auth.uid()
        returns uuid
        language sql
        stable
        set search_path = ''
        as $$
          select nullif(auth.jwt() ->> 'sub', '')::uuid
        $$;
      `);

      await db.exec(MIGRATION);
      await db.exec(`
        set role authenticated;
        select pg_catalog.set_config(
          'request.jwt.claims',
          '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}',
          false
        );
      `);

      const first = await db.query<{ inserted: boolean }>(
        "select public.record_daily_login_access() as inserted"
      );
      const duplicate = await db.query<{ inserted: boolean }>(
        "select public.record_daily_login_access() as inserted"
      );
      expect(first.rows).toEqual([{ inserted: true }]);
      expect(duplicate.rows).toEqual([{ inserted: false }]);

      await db.exec(`
        select pg_catalog.set_config(
          'request.jwt.claims',
          '{"sub":"11111111-1111-1111-1111-111111111111","role":"authenticated","session_id":"bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"}',
          false
        );
      `);
      const secondSession = await db.query<{ inserted: boolean }>(
        "select public.record_daily_login_access() as inserted"
      );
      expect(secondSession.rows).toEqual([{ inserted: true }]);

      await db.exec("reset role");
      const ledger = await db.query<{ rows: number; hash_bytes: number }>(`
        select count(*)::int as rows,
               min(pg_catalog.octet_length(session_hash))::int as hash_bytes
        from visitor_private.login_session_days
      `);
      expect(ledger.rows).toEqual([{ rows: 2, hash_bytes: 32 }]);

      const kstBoundary = await db.query<{
        before_midnight: string;
        after_midnight: string;
      }>(`
        select
          ('2026-09-02T14:59:59Z'::timestamptz at time zone 'Asia/Seoul')::date::text
            as before_midnight,
          ('2026-09-02T15:00:00Z'::timestamptz at time zone 'Asia/Seoul')::date::text
            as after_midnight
      `);
      expect(kstBoundary.rows).toEqual([
        { before_midnight: "2026-09-02", after_midnight: "2026-09-03" },
      ]);

      await db.exec(`
        insert into visitor_private.login_session_days (
          visit_date,
          session_hash
        ) values (
          (pg_catalog.statement_timestamp() at time zone 'Asia/Seoul')::date - 1,
          extensions.digest(pg_catalog.convert_to('previous-day', 'UTF8'), 'sha256')
        )
      `);

      await db.exec("set role anon");
      const stats = await db.query<{
        today_access: number;
        total_access: number;
      }>("select * from public.get_login_access_stats()");
      expect(stats.rows).toEqual([{ today_access: 2, total_access: 3 }]);
      await expect(
        db.query("select public.record_daily_login_access()")
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.query("select * from visitor_private.login_session_days")
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.close();
    }
  });

  it("통합 설치 SQL에도 접속 집계 마이그레이션이 포함된다", () => {
    expect(SETUP_SQL).toContain(
      "-- 20260902021457_add_login_access_counter.sql"
    );
  });
});
