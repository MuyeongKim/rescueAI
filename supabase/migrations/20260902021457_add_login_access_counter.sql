-- 로그인 후 실제 서비스 화면에 진입한 접속을 KST 날짜별로 한 번만 기록한다.
--
-- 공유 계정을 여러 대원이 함께 쓰는 시범운영 특성상 user_id 기준 집계는 실제 이용량을
-- 보여주지 못한다. Supabase가 서명한 JWT의 session_id를 SHA-256 해시한 뒤
-- (KST 날짜, 세션 해시)를 원장으로 남긴다. 앱의 HttpOnly 일일 쿠키가 같은 브라우저의
-- 중복 RPC를 줄이고, DB PK가 동시 요청을 최종 차단한다. IP·이메일·User-Agent는 저장하지 않는다.
--
-- 원장은 비노출 스키마에 두고 RLS와 권한 회수를 함께 적용한다. Data API에 공개되는
-- public 함수는 인자가 없는 SECURITY INVOKER 래퍼뿐이며, private SECURITY DEFINER
-- 함수는 호출자의 인증 상태를 다시 확인하고 search_path를 비운다.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists visitor_private;

revoke all on schema visitor_private from public, anon, authenticated;
grant usage on schema visitor_private to anon, authenticated;

create table if not exists visitor_private.login_session_days (
  visit_date    date        not null,
  session_hash bytea       not null,
  first_seen_at timestamptz not null default now(),
  constraint login_session_days_pkey primary key (visit_date, session_hash),
  constraint login_session_days_hash_length check (
    pg_catalog.octet_length(session_hash) = 32
  )
);

comment on table visitor_private.login_session_days is
  'KST 날짜별 고유 인증 세션 접속 원장. 원본 session_id와 개인정보는 저장하지 않는다.';
comment on column visitor_private.login_session_days.session_hash is
  'KST 날짜와 Supabase JWT session_id를 합친 SHA-256 해시(32바이트)';

alter table visitor_private.login_session_days enable row level security;
revoke all on table visitor_private.login_session_days
  from public, anon, authenticated, service_role;

create or replace function visitor_private.record_daily_login_access()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_session_id uuid;
  v_seen_at timestamptz;
  v_visit_date date;
  v_inserted boolean := false;
begin
  if v_claims ->> 'role' is distinct from 'authenticated'
     or (select auth.uid()) is null
     or nullif(pg_catalog.btrim(v_claims ->> 'session_id'), '') is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated session required';
  end if;

  begin
    v_session_id := (v_claims ->> 'session_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception using
        errcode = '42501',
        message = 'authenticated session required';
  end;

  v_seen_at := pg_catalog.statement_timestamp();
  v_visit_date := (v_seen_at at time zone 'Asia/Seoul')::date;

  insert into visitor_private.login_session_days (
    visit_date,
    session_hash,
    first_seen_at
  )
  values (
    v_visit_date,
    extensions.digest(
      pg_catalog.convert_to(v_visit_date::text || ':' || v_session_id::text, 'UTF8'),
      'sha256'
    ),
    v_seen_at
  )
  on conflict (visit_date, session_hash) do nothing
  returning true into v_inserted;

  return coalesce(v_inserted, false);
end;
$function$;

create or replace function visitor_private.get_login_access_stats()
returns table (
  today_access bigint,
  total_access bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    count(*) filter (
      where visit_date = (
        pg_catalog.statement_timestamp() at time zone 'Asia/Seoul'
      )::date
    )::bigint as today_access,
    count(*)::bigint as total_access
  from visitor_private.login_session_days;
$function$;

-- PostgREST에 노출되는 래퍼에는 클라이언트 입력값이 없다. 기록용 함수는 인증 사용자만,
-- 집계 조회는 로그인 화면의 anon과 로그인 사용자에게 숫자 두 개만 허용한다.
create or replace function public.record_daily_login_access()
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $function$
  select visitor_private.record_daily_login_access();
$function$;

create or replace function public.get_login_access_stats()
returns table (
  today_access bigint,
  total_access bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from visitor_private.get_login_access_stats();
$function$;

revoke all on function visitor_private.record_daily_login_access()
  from public, anon, authenticated;
revoke all on function visitor_private.get_login_access_stats()
  from public, anon, authenticated;
grant execute on function visitor_private.record_daily_login_access()
  to authenticated;
grant execute on function visitor_private.get_login_access_stats()
  to anon, authenticated;

revoke all on function public.record_daily_login_access()
  from public, anon, authenticated;
revoke all on function public.get_login_access_stats()
  from public, anon, authenticated;
grant execute on function public.record_daily_login_access()
  to authenticated;
grant execute on function public.get_login_access_stats()
  to anon, authenticated;
