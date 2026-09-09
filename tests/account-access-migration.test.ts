import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(new URL("../supabase/migrations/20260909112954_require_ready_accounts_for_data_access.sql", import.meta.url), "utf8");
const load = (name: string) => readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";
const next = "33333333-3333-4333-8333-333333333333";
const tables = ["documents", "chunks", "notices", "news", "rag_rescue", "rag_embedding_config", "generated_materials", "conversations", "messages", "generation_drafts", "generation_jobs", "workout_logs"];
let db: PGlite;

async function asUser(id = owner, aal = "aal1") {
  await db.exec("reset role");
  await db.query("select set_config('request.jwt.claim.sub', $1, false), set_config('request.jwt.claims', $2, false)", [id, JSON.stringify({ sub: id, role: "authenticated", aal, session_id: id })]);
  await db.exec("set role authenticated");
}
const ids = async (table: string) => (await db.query(`select id from ${table} order by id`)).rows;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}', encrypted_password text default 'synthetic', deleted_at timestamptz, banned_until timestamptz);
    create table auth.sessions(id integer primary key, user_id uuid);
    create table auth.mfa_factors(id integer primary key, user_id uuid, factor_type text, status text);
    create table profiles(id uuid primary key, email text, full_name text, role text default 'user', must_change_password boolean not null default false);
    create table documents(id integer primary key, status text default 'processed', file_url text);
    create table chunks(id integer primary key, content text);
    create table conversations(id uuid primary key, user_id uuid, updated_at timestamptz default now());
    create table messages(id integer primary key, conversation_id uuid, content text);
    create table rag_rescue(id uuid primary key, content text, metadata jsonb default '{}', is_active boolean default true);
    create table storage.objects(id integer primary key, bucket_id text, name text);
    create table rag_embedding_config(id integer primary key);
    create table notices(id integer primary key);
    create table news(id integer primary key, hidden boolean default false);
    create table generated_materials(id integer primary key, user_id uuid, shared boolean default false);
    create table generation_drafts(id integer primary key, user_id uuid);
    create table generation_jobs(id integer primary key, user_id uuid);
    create table workout_logs(id integer primary key, user_id uuid);
  `);
  await db.exec(load("0003_triggers_rls.sql"));
  for (const table of tables) await db.exec(`alter table public.${table} enable row level security`);
  await db.exec(`
    insert into auth.users(id, email) values ('${owner}', 'a@example.invalid'), ('${other}', 'b@example.invalid');
    update profiles set role='admin' where id='${other}';
    insert into auth.sessions values (1,'${owner}'),(2,'${owner}'),(3,'${other}'),(4,'${other}');
    insert into documents(id,file_url) values (1,'synthetic.pdf');
    insert into chunks values (1,'synthetic content');
    insert into conversations(id,user_id) values ('${owner}','${owner}'),('${other}','${other}');
    insert into messages values (1,'${owner}','synthetic owner'),(2,'${other}','synthetic other');
    insert into rag_rescue(id,content) values ('${owner}','로프 하강');
    insert into rag_embedding_config values (1); insert into notices values (1); insert into news(id) values (1);
    insert into generated_materials values (1,'${owner}',false),(2,'${other}',true),(3,'${other}',false);
    insert into generation_drafts values (1,'${owner}'),(2,'${other}');
    insert into generation_jobs values (1,'${owner}'),(2,'${other}');
    insert into workout_logs values (1,'${owner}'),(2,'${other}');
    insert into storage.objects values (1,'documents','synthetic.pdf');
    create policy rag_read on rag_rescue for select to authenticated using(is_active);
    create policy config_read on rag_embedding_config for select to authenticated using(true);
    create policy notices_read on notices for select to authenticated using(true);
    create policy news_read on news for select to authenticated using(not hidden);
    create policy materials_own on generated_materials for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy materials_shared on generated_materials for select to authenticated using(shared);
    create policy drafts_own on generation_drafts for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    create policy jobs_own on generation_jobs for select to authenticated using(user_id=auth.uid());
    create policy workout_own on workout_logs for all to authenticated using(user_id=auth.uid()) with check(user_id=auth.uid());
    alter table storage.objects enable row level security;
    create policy document_read on storage.objects for select to authenticated using(bucket_id='documents' and exists(select 1 from documents where file_url=storage.objects.name));
    grant usage on schema public, auth, storage to anon, authenticated, service_role;
    grant all on all tables in schema public to authenticated, service_role;
    grant select on storage.objects to authenticated; grant all on storage.objects to service_role;
    grant select on profiles,documents,chunks to anon;
  `);
  await db.exec(load("20260908042842_enforce_password_change_completion.sql"));
  await db.exec(load("20260908043629_use_verified_auth_password_completion.sql"));
  await db.exec(load("20260908042907_distributed_ai_usage_budget.sql"));
  await db.exec(load("20260902021457_add_login_access_counter.sql"));
  await db.exec(load("20260905124809_rank_rag_keyword_candidates.sql"));
  await db.exec(migration);
});
beforeEach(async () => { await db.exec("reset role; begin"); });
afterEach(async () => { await db.exec("reset role; rollback"); });
afterAll(async () => { await db.close(); });

describe("현재 계정 상태를 강제하는 DB 경계", () => {
  it("반복 적용해도 기존 두 계정·비밀번호·동시 세션을 유지한다", async () => {
    await db.exec(migration);
    expect((await db.query("select account_ready,must_change_password from profiles order by id")).rows)
      .toEqual([{ account_ready: true, must_change_password: false }, { account_ready: true, must_change_password: false }]);
    expect((await db.query("select encrypted_password from auth.users")).rows).toEqual([{ encrypted_password: "synthetic" }, { encrypted_password: "synthetic" }]);
    expect(await ids("auth.sessions")).toHaveLength(4);
    await asUser();
    for (const table of tables) expect((await ids(table)).length, table).toBeGreaterThan(0);
    expect(await ids("generated_materials")).toEqual([{ id: 1 }, { id: 2 }]);
    expect(await ids("messages")).toEqual([{ id: 1 }]);
    expect(await ids("generation_jobs")).toEqual([{ id: 1 }]);
    expect(await ids("storage.objects")).toHaveLength(1);
    expect((await db.query("select * from search_rag_rescue_keywords('로프')")).rows).toHaveLength(1);
  });

  it.each([
    ["초기 비밀번호 미변경", `update profiles set must_change_password=true where id='${owner}'`],
    ["발급 미완료", `update profiles set account_ready=false where id='${owner}'`],
    ["프로필 없음", `delete from profiles where id='${owner}'`],
    ["Auth 삭제 후 남은 JWT와 고아 프로필", `delete from auth.users where id='${owner}'`],
    ["Auth 소프트 삭제", `update auth.users set deleted_at=now() where id='${owner}'`],
    ["Auth 차단", `update auth.users set banned_until=now()+interval '1 day' where id='${owner}'`],
  ])("%s이면 채워진 공용·개인 테이블·Storage·검색·definer RPC를 차단한다", async (_, mutate) => {
    await db.exec(mutate);
    await asUser();
    for (const table of tables) expect(await ids(table), table).toEqual([]);
    expect(await ids("storage.objects")).toEqual([]);
    expect((await db.query("select * from search_rag_rescue_keywords('로프')")).rows).toEqual([]);
    // 에러 하나가 트랜잭션 전체를 중단하지 않도록 각 공격은 savepoint로 격리한다.
    for (const sql of ["select consume_ai_budget('chat')", "select record_daily_login_access()", `insert into generation_drafts values(3,'${owner}')`]) {
      await db.exec("savepoint attack");
      await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
      await db.exec("rollback to savepoint attack");
    }
  });

  it("최초 비번 변경용 프로필 접근을 유지하지만 준비 상태·비번 완료를 직접 바꾸지 못한다", async () => {
    await db.exec(`update profiles set must_change_password=true where id='${owner}'`);
    await asUser();
    expect(await ids("profiles")).toEqual([{ id: owner }]);
    for (const patch of ["account_ready=false", "must_change_password=false"]) {
      await db.exec("savepoint attack");
      await expect(db.exec(`update profiles set ${patch} where id='${owner}'`)).rejects.toMatchObject({ code: "42501" });
      await db.exec("rollback to savepoint attack");
    }
    await db.exec(`reset role; set role service_role; update profiles set must_change_password=false where id='${owner}'`);
    await asUser(); expect(await ids("documents")).toHaveLength(1);
  });

  it("신규 계정은 사용자 메타데이터와 무관하게 차단되고 관리 발급·비번 변경 뒤에만 사용할 수 있다", async () => {
    await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)", [next, "new@example.invalid", { account_ready: true, must_change_password: false, role: "admin" }]);
    expect((await db.query("select role,account_ready,must_change_password from profiles where id=$1", [next])).rows)
      .toEqual([{ role: "user", account_ready: false, must_change_password: true }]);
    await asUser(next); expect(await ids("profiles")).toEqual([]); expect(await ids("documents")).toEqual([]);
    await db.exec(`reset role; set role service_role; update profiles set account_ready=true where id='${next}'`);
    await asUser(next); expect(await ids("profiles")).toHaveLength(1); expect(await ids("documents")).toEqual([]);
    await db.exec(`reset role; set role service_role; update profiles set must_change_password=false where id='${next}'`);
    await asUser(next); expect(await ids("documents")).toHaveLength(1);
    expect(await ids("generation_drafts")).toEqual([]);
  });

  it("사용자 데이터 변경은 계속 본인만 가능하고 private Auth·helper 권한은 노출하지 않는다", async () => {
    await asUser();
    expect((await db.query("update generation_drafts set id=9 where id=2 returning id")).rows).toEqual([]);
    expect((await db.query("delete from conversations where id=$1 returning id", [other])).rows).toEqual([]);
    for (const sql of ["select * from auth.users", "select * from auth.mfa_factors", "select app_auth_private.protect_account_readiness()", `insert into generation_drafts values (3,'${other}')`]) {
      await db.exec("savepoint attack"); await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" }); await db.exec("rollback to savepoint attack");
    }
    await db.exec("reset role; set role anon; savepoint attack");
    await expect(db.query("select access_private.is_registered_account()")).rejects.toMatchObject({ code: "42501" });
    await db.exec("rollback to savepoint attack");
    expect(await ids("documents")).toEqual([]);
  });

  it("계정 이용 제한은 서비스 역할의 적재·worker 경계를 바꾸지 않는다", async () => {
    await db.exec(`update profiles set account_ready=false where id='${owner}'`);
    await asUser(); expect(await ids("rag_rescue")).toEqual([]);
    await db.exec("reset role; set role service_role");
    expect(await ids("rag_rescue")).toHaveLength(1);
    expect(await ids("generation_jobs")).toHaveLength(2);
    expect((await db.query("update generation_jobs set id=3 where id=1 returning id")).rows).toEqual([{ id: 3 }]);
    expect((await db.query("select * from search_rag_rescue_keywords('로프')")).rows).toHaveLength(1);
  });

  it("관리자는 일반 사용을 AAL1로 유지하고 타인 조회·관리 AI 작업만 현재 TOTP+AAL2를 요구한다", async () => {
    await asUser(other);
    expect(await ids("messages")).toEqual([{ id: 2 }]);
    expect((await db.query<{ result: { ok: boolean } }>("select consume_ai_budget('chat') result")).rows[0].result.ok).toBe(true);
    await db.exec("savepoint attack"); await expect(db.query("select consume_ai_budget('news-summary')")).rejects.toMatchObject({ code: "42501" }); await db.exec("rollback to savepoint attack");
    await asUser(other, "aal2"); expect(await ids("messages")).toEqual([{ id: 2 }]);
    await db.exec(`reset role; insert into auth.mfa_factors values (1,'${other}','totp','verified')`);
    await asUser(other, "aal2"); expect(await ids("messages")).toHaveLength(2);
    expect(await ids("workout_logs")).toHaveLength(2);
    expect((await db.query<{ result: { ok: boolean } }>("select consume_ai_budget('news-summary') result")).rows[0].result.ok).toBe(true);
    await db.exec("reset role; delete from auth.mfa_factors");
    await asUser(other, "aal2"); expect(await ids("messages")).toEqual([{ id: 2 }]);
    await asUser(owner, "aal2"); expect(await ids("messages")).toEqual([{ id: 1 }]);
  });
});
