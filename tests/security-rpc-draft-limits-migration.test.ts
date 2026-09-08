import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const readMigration = (name: string) => readFileSync(resolve(process.cwd(), "supabase/migrations", name), "utf8");
const migration = readMigration("20260908042754_close_public_rpc_leaks_and_limit_private_drafts.sql");

async function setup() {
  const db = new PGlite(); await db.waitReady;
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    create table public.profiles(id uuid primary key, full_name text, division text);
    create table public.workout_logs(user_id uuid, points integer, performed_on date);
    create table public.conversations(id uuid primary key, user_id uuid);
    create table public.messages(id serial primary key, conversation_id uuid, role text, content text, created_at timestamptz default now());
    alter table public.messages enable row level security;
    alter table public.conversations enable row level security;
    create policy own_conversations on public.conversations for select to authenticated using(user_id = auth.uid());
    create policy own_messages on public.messages for select to authenticated using(exists(
      select 1 from public.conversations c where c.id = messages.conversation_id and c.user_id = auth.uid()
    ));
    grant select on public.messages, public.conversations to authenticated;
    alter default privileges in schema public grant execute on functions to anon;
    insert into auth.users values ('${owner}'), ('${other}');
    insert into public.conversations values ('${owner}', '${owner}'), ('${other}', '${other}');
  `);
  await db.exec(readMigration("0011_popular_questions.sql"));
  const legacy = readMigration("0005_platform.sql");
  await db.exec(legacy.slice(legacy.indexOf("create or replace function fitness_leaderboard")));
  await db.exec(readMigration("20260904222055_private_generation_drafts.sql"));
  return db;
}

async function asOwner(db: PGlite, id = owner) {
  await db.exec(`reset role; set request.jwt.claim.sub='${id}'; set role authenticated;`);
}

async function quota(db: PGlite) {
  await db.exec("reset role");
  return (await db.query<{ unsaved: number; saved: number; bytes: number }>(`
    select unsaved_count::int as unsaved, saved_count::int as saved, snapshot_bytes::int as bytes
    from generation_private.draft_storage_usage where user_id=$1`, [owner])).rows[0];
}

describe("공개 RPC 개인정보 및 개인 초안 저장량 보호", () => {
  it("남아 있던 anon EXECUTE를 제거하고 관리자도 다른 계정 질문을 받지 못한다", async () => {
    const db = await setup();
    try {
      await db.query("insert into public.messages(conversation_id,role,content) values ($1,'user','타인 개인 질문'),($1,'user','타인 개인 질문')", [other]);
      await db.exec(`insert into public.messages(conversation_id,role,content)
        select '${owner}', 'user', '이 계정 반복 질문 ' || g from generate_series(1,12) g cross join generate_series(1,2) repeats;
        insert into public.messages(conversation_id,role,content) values ('${owner}','user','한 번만 한 질문');
        insert into public.messages(conversation_id,role,content,created_at)
        values ('${owner}','user','오래된 질문',now()-interval '91 days'), ('${owner}','user','오래된 질문',now()-interval '91 days');
        set role anon;`);
      expect((await db.query("select count(*)::int as n from public.popular_questions(3650,1,null)")).rows[0]).toEqual({ n: 15 });
      await db.exec("reset role");
      await db.exec(migration);
      await db.exec(migration);
      await db.exec("set role anon");
      await expect(db.query("select * from public.popular_questions(3650,1,null)")).rejects.toThrow(/permission denied/);
      await expect(db.query("select * from public.fitness_leaderboard(null)")).rejects.toThrow(/permission denied/);
      await asOwner(db);
      const questions = (await db.query<{ question: string; cnt: number }>("select * from public.popular_questions(3650,1,null)")).rows;
      expect(questions).toHaveLength(8);
      expect(questions.every((row) => row.question.startsWith("이 계정 반복 질문 "))).toBe(true);
      await expect(db.query("select * from public.fitness_leaderboard(null)")).rejects.toThrow(/permission denied/);
      await db.exec("reset role; create policy admin_messages on public.messages for select to authenticated using(true); create policy admin_conversations on public.conversations for select to authenticated using(true);");
      await asOwner(db);
      expect((await db.query<{ question: string }>("select * from public.popular_questions(3650,1,2147483647)")).rows).toEqual(questions);
      await asOwner(db, other);
      expect((await db.query("select question from public.popular_questions() ")).rows).toEqual([{ question: "타인 개인 질문" }]);
      await db.exec("reset role");
      expect((await db.query("select prosecdef from pg_proc where oid='public.popular_questions(integer,integer,integer)'::regprocedure")).rows[0]).toEqual({ prosecdef: false });
    } finally { await db.close(); }
  }, 20_000);

  it("기존 초안을 보존해 사용량을 채우고 반복 적용·직접 삽입·여러 요청에서도 200개 상한을 유지한다", async () => {
    const db = await setup();
    try {
      await asOwner(db);
      await db.query(`insert into public.generation_drafts(user_id,draft_key,snapshot)
        select $1::uuid,'legacy:'||g,'{"saved":false}'::jsonb from generate_series(1,201)g`, [owner]);
      await db.exec("reset role");
      await db.exec(migration);
      expect((await quota(db)).unsaved).toBe(201);
      await asOwner(db);
      await expect(db.query("insert into public.generation_drafts(user_id,draft_key,snapshot) values ($1,'blocked','{\"saved\":false}')", [owner])).rejects.toThrow(/storage_limit_exceeded/);
      await db.exec("delete from public.generation_drafts where draft_key in ('legacy:1','legacy:2','legacy:3','legacy:4','legacy:5','legacy:6')");
      // PGlite queues these statements on one PostgreSQL connection. Production serialization
      // is the guarded UPDATE of one usage row, not this JavaScript scheduling mechanism.
      const attempts = await Promise.allSettled(Array.from({ length: 20 }, (_, n) => db.query(
        "insert into public.generation_drafts(user_id,draft_key,snapshot) values ($1,$2,'{\"saved\":false}')", [owner, `new:${n}`]
      )));
      expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(5);
      expect((await quota(db)).unsaved).toBe(200);
      await db.exec(migration);
      expect((await quota(db)).unsaved).toBe(200);
      await asOwner(db, other);
      await db.query("insert into public.generation_drafts(user_id,draft_key,snapshot) values ($1,'other-account','{\"saved\":false}')", [other]);
      await expect(db.query("select * from generation_private.draft_storage_usage")).rejects.toThrow(/permission denied/);
      await expect(db.query("select public.enforce_generation_draft_storage_limit()")).rejects.toThrow(/permission denied/);
    } finally { await db.close(); }
  }, 20_000);

  it("저장 완료 사본에도 별도 상한을 적용하고 상태변경·삭제·CAS를 정확히 반영한다", async () => {
    const db = await setup();
    try {
      await db.exec(migration);
      await asOwner(db);
      await db.query(`insert into public.generation_drafts(user_id,draft_key,snapshot)
        select $1::uuid,'unsaved:'||g,'{"saved":false}'::jsonb from generate_series(1,200)g`, [owner]);
      await db.query(`insert into public.generation_drafts(user_id,draft_key,snapshot)
        select $1::uuid,'saved:'||g,'{"saved":true}'::jsonb from generate_series(1,200)g`, [owner]);
      await expect(db.query("update public.generation_drafts set snapshot='{\"saved\":true}' where draft_key='unsaved:1' and revision=1")).rejects.toThrow(/storage_limit_exceeded/);
      await db.exec("delete from public.generation_drafts where draft_key='saved:1'");
      expect((await db.query("update public.generation_drafts set snapshot='{\"saved\":true}' where draft_key='unsaved:1' and revision=1 returning revision")).rows).toEqual([{ revision: 2 }]);
      expect((await db.query("update public.generation_drafts set snapshot='{\"saved\":false}' where draft_key='unsaved:1' and revision=1 returning id")).rows).toHaveLength(0);
      expect(await quota(db)).toMatchObject({ unsaved: 199, saved: 200 });
      const exact = (await db.query<{ bytes: number }>("select sum(octet_length(snapshot::text))::int as bytes from public.generation_drafts where user_id=$1", [owner])).rows[0].bytes;
      expect((await quota(db)).bytes).toBe(exact);
      // Auth deletion cascades through both tables without leaving an accounting row behind.
      await db.query("delete from auth.users where id=$1", [owner]);
      expect((await db.query("select * from generation_private.draft_storage_usage where user_id=$1", [owner])).rows).toHaveLength(0);
    } finally { await db.close(); }
  }, 20_000);

  it("총량 경계에서 증가를 차단하고 감소를 허용하며 실패 시 원본과 사용량을 함께 롤백한다", async () => {
    const db = await setup();
    try {
      await db.exec(migration);
      await asOwner(db);
      await db.query("insert into public.generation_drafts(user_id,draft_key,snapshot) values ($1,'existing','{\"saved\":false,\"text\":\"before\"}')", [owner]);
      await db.exec("reset role");
      // Place only the private counter at the production boundary instead of allocating
      // 200 MiB of dummy JSON. Backfill and exact byte accounting are tested above.
      await db.query("update generation_private.draft_storage_usage set snapshot_bytes=209715200 where user_id=$1", [owner]);
      await asOwner(db);
      await expect(db.exec("update public.generation_drafts set snapshot='{\"saved\":false,\"text\":\"more than before\"}' where draft_key='existing'")).rejects.toThrow(/storage_limit_exceeded/);
      expect((await db.query("select snapshot->>'text' as text,revision from public.generation_drafts where draft_key='existing'")).rows).toEqual([{ text: "before", revision: 1 }]);
      expect((await quota(db)).bytes).toBe(209715200);
      await asOwner(db);
      await db.exec("update public.generation_drafts set snapshot='{\"saved\":false,\"text\":\"a\"}' where draft_key='existing'");
      expect((await quota(db)).bytes).toBe(209715195);
    } finally { await db.close(); }
  }, 20_000);
});
