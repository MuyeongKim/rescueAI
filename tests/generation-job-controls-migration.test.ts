import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
const migration = (file: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", file), "utf8");
const owner = "10000000-0000-4000-8000-000000000001";
const other = "20000000-0000-4000-8000-000000000002";
const job = "30000000-0000-4000-8000-000000000003";
const oldToken = "40000000-0000-4000-8000-000000000004";
const newToken = "50000000-0000-4000-8000-000000000005";
describe("목차 검토·중단·검토 초안 DB 보호", () => {
  it("반복 적용·소유자 공개컬럼·공식 결과 가드·stale worker CAS를 실제 DB로 검증한다", async () => {
    const db = new PGlite();
    await db.waitReady;
    try {
      await db.exec(`
        create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        create schema auth; create table auth.users (id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
        grant usage on schema auth to authenticated, service_role;
        grant execute on function auth.uid() to authenticated, service_role;
      `);
      await db.exec(migration("20260902094825_durable_generation_jobs.sql"));
      const controls = migration("20260906010516_generation_job_review_controls.sql");
      await db.exec(controls); await db.exec(controls);
      await db.exec(`insert into auth.users values ('${owner}'), ('${other}'); set role service_role;
        insert into public.generation_jobs (id,user_id,status,request,checkpoint,review_outline,review_draft,quality_issues,run_token,client_request_id)
        values ('${job}','${owner}','awaiting_review','{"type":"plan"}','{"private":"worker-only"}',
          '{"title":"검토 목차"}','{"title":"검토 초안"}','[{"code":"missing_safety"}]','${oldToken}',gen_random_uuid());
      `);
      await db.exec(`reset role; set request.jwt.claim.sub = '${owner}'; set role authenticated;`);
      expect((await db.query("select review_outline,review_draft,quality_issues from public.generation_jobs")).rows).toHaveLength(1);
      await expect(db.query("select checkpoint, run_token from public.generation_jobs")).rejects.toThrow(/permission denied/);
      await expect(db.exec("update public.generation_jobs set status='completed',quality_passed=true,result='{}'")).rejects.toThrow(/permission denied/);
      await db.exec(`reset role; set request.jwt.claim.sub='${other}'; set role authenticated;`);
      expect((await db.query("select review_outline,review_draft from public.generation_jobs")).rows).toHaveLength(0);
      await db.exec("reset role; set role anon;");
      await expect(db.query("select review_outline from public.generation_jobs")).rejects.toThrow(/permission denied/);
      await db.exec("reset role; set role service_role;");
      await expect(db.exec(`update public.generation_jobs set result='{"title":"unsafe"}' where id='${job}'`)).rejects.toThrow(/generation_jobs_result_final_only/);
      await expect(db.exec(`update public.generation_jobs set quality_passed=true where id='${job}'`)).rejects.toThrow(/generation_jobs_completed_quality/);
      await expect(db.exec(`update public.generation_jobs set review_draft='[]' where id='${job}'`)).rejects.toThrow(/generation_jobs_review_projection_valid/);
      // Review waits use no active slot. Approval must still obey the one-provider-job constraint.
      await db.exec(`insert into public.generation_jobs (user_id,request,client_request_id) values ('${owner}','{}',gen_random_uuid());`);
      await expect(db.exec(`update public.generation_jobs set status='queued' where id='${job}'`)).rejects.toThrow(/generation_jobs_one_active_per_user_idx/);
      await db.exec(`update public.generation_jobs set status='cancelled',run_token=gen_random_uuid() where id <> '${job}';
        update public.generation_jobs set status='drafting',run_token='${oldToken}' where id='${job}';`);
      const before = (await db.query<{ revision: number }>(`select revision from public.generation_jobs where id='${job}'`)).rows[0];
      await db.exec(`update public.generation_jobs set status='cancelled',run_token='${newToken}' where id='${job}' and revision=${Number(before.revision)};`);
      const late = await db.query(`update public.generation_jobs set status='completed',quality_passed=true,result='{}'
        where id='${job}' and run_token='${oldToken}' and revision=${Number(before.revision)} and status in ('queued','retrieving','drafting','reviewing','repairing') returning id;`);
      expect(late.rows).toEqual([]);
      const after = (await db.query<{ status: string; checkpoint: unknown; result: unknown; quality_passed: boolean; revision: number }>(`select status,checkpoint,result,quality_passed,revision from public.generation_jobs where id='${job}'`)).rows[0];
      expect(after).toMatchObject({ status: "cancelled", checkpoint: { private: "worker-only" }, result: null, quality_passed: false });
      expect(Number(after.revision)).toBe(Number(before.revision) + 1);
      await expect(db.exec(`insert into public.generation_jobs (user_id,request,client_request_id) values ('${owner}','{}',gen_random_uuid());`)).resolves.toBeDefined();
    } finally { await db.close(); }
  });
});
