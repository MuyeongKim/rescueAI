import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260904222055_private_generation_drafts.sql"), "utf8");
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
describe("개인 편집 초안 DB 보호", () => {
  it("실제 Postgres에서 본인 CRUD, 타인 차단, CAS, 불변 식별자, 크기 상한을 강제한다", async () => {
    const db = new PGlite(); await db.waitReady;
    try {
      await db.exec(`create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
        create schema auth; create table auth.users(id uuid primary key);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        grant usage on schema auth to authenticated, service_role; grant execute on function auth.uid() to authenticated, service_role;
        insert into auth.users values ('${owner}'), ('${other}');`);
      await db.exec(sql);
      await db.exec(`set request.jwt.claim.sub='${owner}'; set role authenticated;`);
      const created = await db.query<{ id: string; revision: number; updated_at: string }>(`insert into generation_drafts(user_id,draft_key,snapshot,revision) values ($1,'local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','{"saved":false,"text":"미완성"}',99) returning id,revision,updated_at::text`, [owner]);
      expect(created.rows[0].revision).toBe(1);
      const id = created.rows[0].id;
      const updated = await db.query<{ revision: number }>(`update generation_drafts set snapshot='{"saved":false,"text":"수정"}', revision=999 where id=$1 and revision=1 returning revision`, [id]);
      expect(updated.rows).toEqual([{ revision: 2 }]);
      expect((await db.query(`delete from generation_drafts where id=$1 and updated_at=$2 returning id`, [id, created.rows[0].updated_at])).rows).toHaveLength(0);
      expect((await db.query(`update generation_drafts set snapshot='{"text":"오래된 탭"}' where id=$1 and revision=1 returning id`, [id])).rows).toHaveLength(0);
      await expect(db.query(`update generation_drafts set draft_key='material:4' where id=$1`, [id])).rejects.toThrow(/identity_immutable/);
      await expect(db.query(`update generation_drafts set user_id=$1 where id=$2`, [other, id])).rejects.toThrow(/identity_immutable/);
      await expect(db.query(`update generation_drafts set id=gen_random_uuid() where id=$1`, [id])).rejects.toThrow(/identity_immutable/);
      await expect(db.query(`insert into generation_drafts(user_id,draft_key,snapshot) values ($1,'material:2','{}')`, [other])).rejects.toThrow(/row-level security/);
      await expect(db.query(`update generation_drafts set snapshot='[]' where id=$1`, [id])).rejects.toThrow(/check constraint/);
      await expect(db.query(`update generation_drafts set snapshot=jsonb_build_object('text', repeat('가',400000)) where id=$1`, [id])).rejects.toThrow(/check constraint/);
      await db.exec(`reset role; set request.jwt.claim.sub='${other}'; set role authenticated;`);
      expect((await db.query(`select id from generation_drafts where id=$1`, [id])).rows).toHaveLength(0);
      expect((await db.query(`update generation_drafts set snapshot='{}' where id=$1 returning id`, [id])).rows).toHaveLength(0);
      expect((await db.query(`delete from generation_drafts where id=$1 returning id`, [id])).rows).toHaveLength(0);
      await db.exec(`reset role; set role anon;`);
      await expect(db.query("select * from generation_drafts")).rejects.toThrow(/permission denied/);
      await db.exec(`reset role; set request.jwt.claim.sub='${owner}'; set role authenticated;`);
      expect((await db.query(`delete from generation_drafts where id=$1 and revision=2 returning id`, [id])).rows).toHaveLength(1);
    } finally { await db.close(); }
  }, 20_000);
});
