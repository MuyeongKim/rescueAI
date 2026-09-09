-- 기존 계정·비밀번호·세션은 보존한다. 새 계정만 관리자의 발급 완료를 기다린다.
-- ADD COLUMN의 true는 기존 행 보존용이며, 이후 신규 행의 기본값은 false다.
alter table public.profiles add column if not exists account_ready boolean not null default true;
alter table public.profiles alter column account_ready set default false;
alter table public.profiles alter column must_change_password set default true;
comment on column public.profiles.account_ready is
  '관리자가 계정 발급을 완료했는지 여부. 신규 기본 false, 기존 계정은 보존. 클라이언트 변경 금지.';

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, email, full_name, account_ready, must_change_password)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name', false, true)
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke all on function public.handle_new_user() from public, anon, authenticated, service_role;

create or replace function app_auth_private.protect_account_readiness()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.account_ready is distinct from old.account_ready
     and current_user not in ('postgres', 'service_role') then
    raise exception 'account_readiness_is_server_managed' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function app_auth_private.protect_account_readiness() from public, anon, authenticated, service_role;
drop trigger if exists profiles_protect_account_readiness on public.profiles;
create trigger profiles_protect_account_readiness
before update of account_ready on public.profiles
for each row execute function app_auth_private.protect_account_readiness();

-- auth.users는 브라우저에 공개하지 않는다. 인자 없는 private helper가 호출자 본인의
-- 현재 Auth/DB 상태만 확인하므로 삭제·차단 후 남은 JWT나 사용자 메타데이터로 우회할 수 없다.
create schema if not exists access_private;
revoke all on schema access_private from public, anon, authenticated, service_role;
grant usage on schema access_private to authenticated;

create or replace function access_private.is_registered_account()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u join public.profiles p on p.id = u.id
    where u.id = (select auth.uid())
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until <= pg_catalog.statement_timestamp())
      and p.account_ready is true
  );
$$;
create or replace function access_private.is_active_account()
returns boolean language sql stable security definer set search_path = '' as $$
  select access_private.is_registered_account() and exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.must_change_password is false
  );
$$;
create or replace function access_private.is_verified_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select access_private.is_active_account()
    and (select auth.jwt()->>'aal') = 'aal2'
    and exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.role = 'admin')
    and exists (select 1 from auth.mfa_factors f where f.user_id = (select auth.uid())
      and f.status = 'verified' and f.factor_type = 'totp');
$$;
revoke all on function access_private.is_registered_account() from public, anon, authenticated, service_role;
revoke all on function access_private.is_active_account() from public, anon, authenticated, service_role;
revoke all on function access_private.is_verified_admin() from public, anon, authenticated, service_role;
grant execute on function access_private.is_registered_account() to authenticated;
grant execute on function access_private.is_active_account() to authenticated;
grant execute on function access_private.is_verified_admin() to authenticated;

-- 기존의 소유자·공유·활성 자료 조건은 그대로 두고, 모든 허용 정책과 AND로 결합한다.
-- 서비스 역할의 인덱싱·내구성 worker는 기존 경계를 유지한다.
do $$
declare v_table text;
begin
  foreach v_table in array array[
    'documents', 'chunks', 'notices', 'news', 'rag_rescue', 'rag_embedding_config',
    'generated_materials', 'conversations', 'messages', 'generation_drafts',
    'generation_jobs', 'workout_logs'
  ] loop
    execute pg_catalog.format('drop policy if exists account_must_be_active on public.%I', v_table);
    execute pg_catalog.format(
      'create policy account_must_be_active on public.%I as restrictive for all to authenticated using ((select access_private.is_active_account())) with check ((select access_private.is_active_account()))', v_table);
  end loop;
end;
$$;

-- 초기 비밀번호 변경에 필요한 본인 프로필은 읽을 수 있어야 한다.
-- account_ready=false인 미완성 발급 계정은 비밀번호 변경 API로도 이용 준비를 끝낼 수 없다.
drop policy if exists profile_account_must_be_registered on public.profiles;
create policy profile_account_must_be_registered on public.profiles as restrictive
for all to authenticated
using ((select access_private.is_registered_account()))
with check ((select access_private.is_registered_account()));

drop policy if exists account_must_be_active on storage.objects;
create policy account_must_be_active on storage.objects as restrictive
for all to authenticated
using ((select access_private.is_active_account()))
with check ((select access_private.is_active_account()));

-- 관리자도 공통 자료·본인 대화는 AAL1로 사용한다. 타인 데이터의 관리자 예외에만 AAL2를 요구한다.
drop policy if exists "admin all messages" on public.messages;
create policy "admin all messages" on public.messages for select to authenticated
using ((select access_private.is_verified_admin()));
drop policy if exists "admin read workout_logs" on public.workout_logs;
create policy "admin read workout_logs" on public.workout_logs for select to authenticated
using ((select access_private.is_verified_admin()));

-- 이 함수는 SECURITY DEFINER이므로 RLS에 의존하지 않고 같은 계정 상태를 다시 검사한다.
create or replace function public.consume_ai_budget(p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_admin_only boolean;
begin
  if not access_private.is_active_account() then
    raise exception 'Ready account with changed password required' using errcode = '42501';
  end if;
  select admin_only into v_admin_only from security_private.ai_usage_policy
    where action = p_action and action <> 'news-cron';
  if not found or (v_admin_only and access_private.is_verified_admin() is not true) then
    raise exception 'AI action is not permitted' using errcode = '42501';
  end if;
  return security_private.consume_ai_usage(v_user, p_action);
end;
$$;
revoke all on function public.consume_ai_budget(text) from public, anon, authenticated;
grant execute on function public.consume_ai_budget(text) to authenticated;

-- 공개 접속 통계의 읽기는 그대로 두고, 원장 기록은 이용 가능한 계정으로 제한한다.
create or replace function visitor_private.record_daily_login_access()
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_session_id uuid;
  v_seen_at timestamptz := pg_catalog.statement_timestamp();
  v_visit_date date := (v_seen_at at time zone 'Asia/Seoul')::date;
  v_inserted boolean := false;
begin
  if not access_private.is_active_account()
     or v_claims->>'role' is distinct from 'authenticated'
     or nullif(pg_catalog.btrim(v_claims->>'session_id'), '') is null then
    raise exception 'authenticated session required' using errcode = '42501';
  end if;
  begin
    v_session_id := (v_claims->>'session_id')::uuid;
  exception when invalid_text_representation then
    raise exception 'authenticated session required' using errcode = '42501';
  end;
  insert into visitor_private.login_session_days (visit_date, session_hash, first_seen_at)
  values (v_visit_date, extensions.digest(
    pg_catalog.convert_to(v_visit_date::text || ':' || v_session_id::text, 'UTF8'), 'sha256'), v_seen_at)
  on conflict (visit_date, session_hash) do nothing returning true into v_inserted;
  return coalesce(v_inserted, false);
end;
$$;
revoke all on function visitor_private.record_daily_login_access() from public, anon, authenticated;
grant execute on function visitor_private.record_daily_login_access() to authenticated;
