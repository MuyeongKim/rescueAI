import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908042842_enforce_password_change_completion.sql"), "utf8");
const verifiedCompletionSql = readFileSync(resolve(process.cwd(), "supabase/migrations/20260908043629_use_verified_auth_password_completion.sql"), "utf8");
const owner = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

describe("비밀번호 변경 완료 상태의 DB 계약", () => {
  it("직접 해제·JWT 위장을 막고 서버 확인 뒤에만 완료하며 공용 계정 세션을 보존한다", async () => {
    const db = new PGlite(); await db.waitReady;
    try {
      await db.exec(`
        create role anon nologin; create role authenticated nologin;
        create role service_role nologin bypassrls; create role supabase_auth_admin nologin;
        create schema auth;
        create table auth.users(id uuid primary key, encrypted_password text, raw_user_meta_data jsonb default '{}');
        create table auth.sessions(id int primary key, user_id uuid references auth.users);
        create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
        create table public.profiles(id uuid primary key references auth.users, role text default 'user', full_name text, must_change_password boolean not null default false);
        alter table public.profiles enable row level security;
        create policy own_read on public.profiles for select to authenticated using (id=auth.uid());
        create policy own_update on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());
        grant usage on schema auth to authenticated, service_role, supabase_auth_admin;
        grant select, update on public.profiles to authenticated, service_role;
        grant select, update on auth.users to supabase_auth_admin;
        insert into auth.users(id,encrypted_password) values ('${owner}','synthetic-old-hash'),('${other}','synthetic-other-hash');
        insert into public.profiles(id,must_change_password) values ('${owner}',true),('${other}',true);
        insert into auth.sessions values (1,'${owner}'),(2,'${owner}'),(3,'${other}'),(4,'${other}');
      `);
      await db.exec(readFileSync(resolve(process.cwd(), "supabase/migrations/0010_lock_profile_role.sql"), "utf8"));
      await db.exec(sql); await db.exec(sql);
      await db.exec(verifiedCompletionSql); await db.exec(verifiedCompletionSql);
      expect((await db.query("select must_change_password from profiles order by id")).rows).toEqual([{ must_change_password: true }, { must_change_password: true }]);

      await db.exec(`set request.jwt.claim.sub='${owner}'; set role authenticated;`);
      await expect(db.exec(`update public.profiles set must_change_password=false where id='${owner}'`)).rejects.toThrow(/password_change_requirement_is_server_managed/);
      await db.exec(`set request.jwt.claim.role='service_role';`);
      await expect(db.exec(`update public.profiles set must_change_password=false where id='${owner}'`)).rejects.toThrow(/password_change_requirement_is_server_managed/);
      await db.exec(`update public.profiles set full_name='표시 이름', role='admin' where id='${owner}';`);
      expect((await db.query("select role,must_change_password from profiles")).rows).toEqual([{ role: "user", must_change_password: true }]);
      expect((await db.query(`update profiles set must_change_password=false where id='${other}' returning id`)).rows).toEqual([]);
      await expect(db.exec(`update auth.users set encrypted_password='attacker' where id='${owner}'`)).rejects.toThrow(/permission denied/);
      await expect(db.exec("select app_auth_private.protect_password_change_requirement()")).rejects.toThrow(/permission denied/);

      await db.exec(`reset role; set role supabase_auth_admin;
        update auth.users set raw_user_meta_data='{"must_change_password":false}' where id='${owner}';
        update auth.users set encrypted_password=encrypted_password where id='${owner}';
        reset role;`);
      expect((await db.query(`select must_change_password from profiles where id='${owner}'`)).rows).toEqual([{ must_change_password: true }]);
      await db.exec(`set role supabase_auth_admin; update auth.users set encrypted_password='' where id='${owner}'; reset role;`);
      expect((await db.query(`select must_change_password from profiles where id='${owner}'`)).rows).toEqual([{ must_change_password: true }]);
      await db.exec(`set role supabase_auth_admin; update auth.users set encrypted_password='synthetic-new-hash' where id='${owner}'; reset role;`);
      // 로그인 시 hash 재암호화나 직접 Auth 호출만으로는 완료로 오인하지 않는다.
      expect((await db.query("select must_change_password from profiles order by id")).rows).toEqual([{ must_change_password: true }, { must_change_password: true }]);

      await db.exec(`set role service_role; update public.profiles set must_change_password=false where id='${owner}'; reset role;`);
      expect((await db.query("select must_change_password from profiles order by id")).rows).toEqual([{ must_change_password: false }, { must_change_password: true }]);

      // 이전 UI가 비밀번호 변경 성공 후 보낸 동일한 false 업데이트는 계속 성공한다.
      await db.exec(`set role authenticated; update public.profiles set must_change_password=false where id='${owner}'; reset role;`);
      await db.exec(`set role service_role; update public.profiles set must_change_password=true where id='${owner}'; reset role;`);
      expect((await db.query(`select must_change_password from profiles where id='${owner}'`)).rows).toEqual([{ must_change_password: true }]);

      expect((await db.query("select user_id,count(*)::int as sessions from auth.sessions group by user_id order by user_id")).rows).toEqual([{ user_id: owner, sessions: 2 }, { user_id: other, sessions: 2 }]);
      const permissions = await db.query<{ role: string; allowed: boolean }>(`select role,has_function_privilege(role,'app_auth_private.protect_password_change_requirement()','EXECUTE') as allowed from (values ('anon'),('authenticated'),('service_role')) as roles(role)`);
      expect(permissions.rows.every((row) => !row.allowed)).toBe(true);
      expect((await db.query("select to_regprocedure('app_auth_private.complete_password_change()') as removed")).rows).toEqual([{ removed: null }]);
    } finally { await db.close(); }
  }, 20_000);
});
