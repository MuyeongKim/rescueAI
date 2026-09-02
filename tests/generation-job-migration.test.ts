import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260902094825_durable_generation_jobs.sql"
  ),
  "utf8"
);

const PUBLIC_COLUMNS = [
  "id",
  "user_id",
  "status",
  "stage",
  "request",
  "result",
  "progress",
  "attempt",
  "revision",
  "estimated_seconds",
  "quality_passed",
  "workflow_run_id",
  "created_at",
  "updated_at",
  "started_at",
  "completed_at",
  "error_message",
];

describe("generation_jobs 마이그레이션 계약", () => {
  it("owner RLS와 private 열을 제외한 authenticated SELECT 권한만 선언한다", () => {
    expect(MIGRATION).toContain(
      "alter table public.generation_jobs enable row level security"
    );
    expect(MIGRATION).toMatch(
      /create policy generation_jobs_owner_select[\s\S]*?for select[\s\S]*?to authenticated[\s\S]*?auth\.uid\(\)\) = user_id/
    );
    expect(MIGRATION).toMatch(
      /revoke all on table public\.generation_jobs\s+from public, anon, authenticated, service_role;/
    );

    const grant = MIGRATION.match(
      /grant select \(([\s\S]*?)\) on table public\.generation_jobs\s+to authenticated;/
    );
    expect(grant).not.toBeNull();
    const grantedColumns = grant![1]
      .split(",")
      .map((column) => column.trim())
      .filter(Boolean);
    expect(grantedColumns).toEqual(PUBLIC_COLUMNS);
    expect(grantedColumns).not.toContain("checkpoint");
    expect(grantedColumns).not.toContain("run_token");
    expect(grantedColumns).not.toContain("last_progress_at");
    expect(grantedColumns).not.toContain("workflow_checked_at");
    expect(grantedColumns).not.toContain("workflow_missing_count");
    expect(grantedColumns).not.toContain("workflow_missing_since");
    expect(MIGRATION).not.toMatch(
      /grant (?:insert|update|delete|all privileges)[\s\S]{0,120}?to authenticated;/
    );
    expect(MIGRATION).toMatch(
      /grant all privileges on table public\.generation_jobs\s+to service_role;/
    );
  });

  it("완료 품질 게이트와 update별 revision 증가 trigger를 선언한다", () => {
    expect(MIGRATION).toMatch(
      /constraint generation_jobs_completed_quality check \([\s\S]*?status = 'completed'[\s\S]*?quality_passed[\s\S]*?result is not null[\s\S]*?status <> 'completed'[\s\S]*?not quality_passed/
    );
    expect(MIGRATION).toContain("new.updated_at := pg_catalog.statement_timestamp()");
    expect(MIGRATION).toMatch(
      /new\.checkpoint is distinct from old\.checkpoint[\s\S]*?new\.last_progress_at := pg_catalog\.statement_timestamp\(\)/
    );
    expect(MIGRATION).toMatch(
      /new\.last_progress_at := pg_catalog\.statement_timestamp\(\);[\s\S]*?new\.workflow_missing_count := 0;[\s\S]*?new\.workflow_missing_since := null;/
    );
    expect(MIGRATION).toMatch(
      /constraint generation_jobs_result_final_only check \([\s\S]*?status = 'completed' or result is null/
    );
    expect(MIGRATION).toContain("new.revision := old.revision + 1");
    expect(MIGRATION).toMatch(
      /create trigger set_generation_job_updated_at[\s\S]*?before update on public\.generation_jobs[\s\S]*?for each row execute function public\.set_generation_job_updated_at\(\)/
    );
    expect(MIGRATION).toMatch(
      /create unique index if not exists generation_jobs_one_active_per_user_idx[\s\S]*?on public\.generation_jobs \(user_id\)[\s\S]*?where status in \('queued', 'retrieving', 'drafting', 'reviewing', 'repairing'\)/
    );
  });

  it("실제 DB에서 RLS·열 권한·품질 게이트·단조 revision을 강제한다", async () => {
    const db = new PGlite();
    await db.waitReady;

    try {
      await db.exec(`
        create role anon nologin;
        create role authenticated nologin;
        create role service_role nologin bypassrls;
        create schema auth;
        create table auth.users (id uuid primary key);
        create function auth.uid()
        returns uuid
        language sql
        stable
        as $$
          select nullif(
            current_setting('request.jwt.claim.sub', true),
            ''
          )::uuid
        $$;
        grant usage on schema auth to authenticated, service_role;
        grant execute on function auth.uid() to authenticated, service_role;
      `);
      await db.exec(MIGRATION);

      const ownerId = "11111111-1111-4111-8111-111111111111";
      const otherId = "22222222-2222-4222-8222-222222222222";
      await db.exec(
        `insert into auth.users (id) values ('${ownerId}'), ('${otherId}')`
      );
      await db.exec("set role service_role");
      const concurrentCreates = await Promise.allSettled([
        db.exec(`
          insert into public.generation_jobs (
            user_id,
            request,
            checkpoint,
            run_token,
            client_request_id
          ) values (
            '${ownerId}',
            '{"type":"slides"}'::jsonb,
            '{"outline":["도입"],"completedBatches":[]}'::jsonb,
            '33333333-3333-4333-8333-333333333333',
            '44444444-4444-4444-8444-444444444444'
          )
        `),
        db.exec(`
          insert into public.generation_jobs (
            user_id,
            request,
            checkpoint,
            run_token,
            client_request_id
          ) values (
            '${ownerId}',
            '{"type":"slides"}'::jsonb,
            '{}'::jsonb,
            '55555555-5555-4555-8555-555555555555',
            '66666666-6666-4666-8666-666666666666'
          )
        `),
      ]);
      expect(concurrentCreates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejectedCreate = concurrentCreates.find((result) => result.status === "rejected");
      expect(rejectedCreate?.status).toBe("rejected");
      if (rejectedCreate?.status === "rejected") {
        expect(String(rejectedCreate.reason)).toMatch(
          /generation_jobs_one_active_per_user_idx|unique/i
        );
      }

      await db.exec(
        `reset role; set request.jwt.claim.sub = '${ownerId}'; set role authenticated`
      );
      const ownRows = await db.query(
        "select id, status, stage, progress, revision from public.generation_jobs"
      );
      expect(ownRows.rows).toHaveLength(1);
      await expect(
        db.query("select checkpoint, run_token from public.generation_jobs")
      ).rejects.toThrow(/permission denied/);
      await expect(
        db.exec(`
          insert into public.generation_jobs (user_id, request, client_request_id)
          values (
            '${ownerId}',
            '{}'::jsonb,
            '55555555-5555-4555-8555-555555555555'
          )
        `)
      ).rejects.toThrow(/permission denied/);

      await db.exec(`
        reset role;
        set request.jwt.claim.sub = '${otherId}';
        set role authenticated;
      `);
      const otherRows = await db.query(
        "select id, status from public.generation_jobs"
      );
      expect(otherRows.rows).toEqual([]);

      await db.exec("reset role; set role service_role");
      const firstMissing = await db.query<{
        workflow_missing_count: number;
        workflow_missing_since: string | null;
      }>(`
        update public.generation_jobs
        set workflow_missing_count = 1,
            workflow_missing_since = now(),
            workflow_checked_at = now()
        returning workflow_missing_count, workflow_missing_since
      `);
      expect(Number(firstMissing.rows[0].workflow_missing_count)).toBe(1);
      expect(firstMissing.rows[0].workflow_missing_since).not.toBeNull();

      const progressed = await db.query<{
        revision: number;
        workflow_missing_count: number;
        workflow_missing_since: string | null;
      }>(`
        update public.generation_jobs
        set checkpoint = '{"outline":["도입","전개"]}'::jsonb,
            progress = 20
        returning revision, workflow_missing_count, workflow_missing_since
      `);
      expect(Number(progressed.rows[0].workflow_missing_count)).toBe(0);
      expect(progressed.rows[0].workflow_missing_since).toBeNull();

      await expect(
        db.exec(`
          update public.generation_jobs
          set status = 'completed', result = '{"slides":[]}'::jsonb
        `)
      ).rejects.toThrow(/generation_jobs_completed_quality/);

      const completed = await db.query<{
        revision: number;
        quality_passed: boolean;
      }>(`
        update public.generation_jobs
        set status = 'completed',
            stage = 'finalized',
            progress = 100,
            result = '{"slides":[]}'::jsonb,
            quality_passed = true,
            completed_at = now(),
            revision = 999
        returning revision, quality_passed
      `);
      expect(completed.rows).toHaveLength(1);
      expect(Number(completed.rows[0].revision)).toBe(
        Number(progressed.rows[0].revision) + 1
      );
      expect(completed.rows[0].quality_passed).toBe(true);

      await expect(
        db.exec(`
          insert into public.generation_jobs (
            user_id,
            request,
            checkpoint,
            run_token,
            client_request_id
          ) values (
            '${ownerId}',
            '{"type":"slides"}'::jsonb,
            '{}'::jsonb,
            '77777777-7777-4777-8777-777777777777',
            '88888888-8888-4888-8888-888888888888'
          )
        `)
      ).resolves.toBeDefined();
    } finally {
      await db.close();
    }
  });
});
