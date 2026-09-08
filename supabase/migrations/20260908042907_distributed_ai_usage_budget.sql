-- 공유 계정의 로그인/병렬 사용을 유지하면서 모든 서버 인스턴스가 같은 AI 호출량을 센다.
-- 단위는 실제 청구 금액이나 토큰 수가 아닌 가중 요청량이다. DB 관리자만 정책을 변경한다.
create schema if not exists security_private;
revoke all on schema security_private from public, anon, authenticated;

create table if not exists security_private.ai_usage_policy (
  action text primary key,
  minute_limit integer not null check (minute_limit between 1 and 1000),
  units integer not null check (units between 1 and 1000),
  admin_only boolean not null default false
);
insert into security_private.ai_usage_policy(action, minute_limit, units, admin_only) values
  ('chat', 30, 1, false),
  ('generate', 20, 20, false),
  ('generate-section', 30, 3, false),
  ('generate-focus', 20, 1, false),
  ('generate-category', 12, 1, false),
  ('generate-evidence', 20, 3, false),
  ('generate-job', 10, 40, false),
  ('generate-job-retry', 6, 40, false),
  ('generate-job-review', 10, 40, false),
  ('grounding-review', 30, 3, false),
  ('news-summary', 10, 5, true),
  ('news-refresh', 6, 5, true),
  ('news-cron', 1, 5, true)
on conflict (action) do nothing;

create table if not exists security_private.ai_budget_settings (
  singleton boolean primary key default true check (singleton),
  account_daily_units integer not null check (account_daily_units between 40 and 1000000),
  global_daily_units integer not null check (global_daily_units between 40 and 10000000)
);
insert into security_private.ai_budget_settings values (true, 2000, 4000) on conflict (singleton) do nothing;

-- 키마다 현재 시간대의 카운터만 보관하므로 요청 횟수에 비례해 행이 늘지 않는다.
create table if not exists security_private.ai_usage_counters (
  bucket_key text primary key,
  window_start timestamptz not null,
  used integer not null check (used >= 0)
);
alter table security_private.ai_usage_policy enable row level security;
alter table security_private.ai_budget_settings enable row level security;
alter table security_private.ai_usage_counters enable row level security;
revoke all on all tables in schema security_private from public, anon, authenticated;

create or replace function security_private.consume_ai_usage(p_subject uuid, p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_policy security_private.ai_usage_policy%rowtype;
  v_settings security_private.ai_budget_settings%rowtype;
  v_now timestamptz;
  v_minute timestamptz;
  v_day timestamptz;
  v_keys text[];
  v_starts timestamptz[];
  v_limits integer[];
  v_costs integer[];
  v_kinds text[] := array['minute', 'account_daily', 'global_daily'];
  v_used integer;
  v_index integer;
begin
  -- 대기 중 시간대가 바뀌어도 과거 카운터로 되돌리지 않도록 잠금 뒤 현재 시각을 읽는다.
  perform pg_catalog.pg_advisory_xact_lock(81190206);
  v_now := pg_catalog.clock_timestamp();
  v_minute := pg_catalog.date_trunc('minute', v_now);
  v_day := pg_catalog.date_trunc('day', v_now at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  select * into strict v_policy from security_private.ai_usage_policy where action = p_action;
  select * into strict v_settings from security_private.ai_budget_settings where singleton;
  v_keys := array['minute:' || p_subject::text || ':' || p_action, 'day:account:' || p_subject::text, 'day:global'];
  v_starts := array[v_minute, v_day, v_day];
  v_limits := array[v_policy.minute_limit, v_settings.account_daily_units, v_settings.global_daily_units];
  v_costs := array[1, v_policy.units, v_policy.units];
  -- 짧은 DB 트랜잭션만 직렬화하고 모델 실행이나 로그인을 잠그지 않는다.
  for v_index in 1..3 loop
    select used into v_used from security_private.ai_usage_counters
      where bucket_key = v_keys[v_index] and window_start = v_starts[v_index];
    if coalesce(v_used, 0) + v_costs[v_index] > v_limits[v_index] then
      return pg_catalog.jsonb_build_object('ok', false, 'limit_kind', v_kinds[v_index],
        'retry_after_seconds', greatest(1, ceil(extract(epoch from
          ((case when v_index = 1 then v_minute + interval '1 minute' else v_day + interval '1 day' end) - v_now)))::integer));
    end if;
  end loop;
  -- 세 한도가 모두 허용한 경우에만 함께 차감한다. 거절된 요청은 다른 예산을 소모하지 않는다.
  for v_index in 1..3 loop
    insert into security_private.ai_usage_counters(bucket_key, window_start, used)
      values (v_keys[v_index], v_starts[v_index], v_costs[v_index])
    on conflict (bucket_key) do update set
      used = case when ai_usage_counters.window_start = excluded.window_start
        then ai_usage_counters.used + excluded.used else excluded.used end,
      window_start = excluded.window_start;
  end loop;
  return pg_catalog.jsonb_build_object('ok', true, 'retry_after_seconds', 0);
end;
$$;
revoke all on function security_private.consume_ai_usage(uuid, text) from public, anon, authenticated;

create or replace function public.consume_ai_budget(p_action text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_admin boolean;
  v_admin_only boolean;
begin
  if v_user is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select role = 'admin' into v_admin from public.profiles
    where id = v_user and must_change_password is false;
  if not found then raise exception 'Registered account with changed password required' using errcode = '42501'; end if;
  select admin_only into v_admin_only from security_private.ai_usage_policy
    where action = p_action and action <> 'news-cron';
  if not found or (v_admin_only and v_admin is not true) then
    raise exception 'AI action is not permitted' using errcode = '42501';
  end if;
  return security_private.consume_ai_usage(v_user, p_action);
end;
$$;
revoke all on function public.consume_ai_budget(text) from public, anon, authenticated;
grant execute on function public.consume_ai_budget(text) to authenticated;

-- Cron은 쿠키 인증이나 subject/action 인자를 받지 않는다. 서버에서 Cron 비밀 검증 후 호출한다.
create or replace function public.consume_news_cron_budget()
returns jsonb language sql security definer set search_path = '' as $$
  select security_private.consume_ai_usage('00000000-0000-0000-0000-000000000000'::uuid, 'news-cron');
$$;
revoke all on function public.consume_news_cron_budget() from public, anon, authenticated;
grant execute on function public.consume_news_cron_budget() to service_role;

-- 삭제된 계정의 작은 카운터도 정리하되 오늘 전체 사용량은 되돌리지 않는다.
create or replace function security_private.cleanup_deleted_user_ai_usage()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_schema <> 'auth' or tg_table_name <> 'users' or tg_op <> 'DELETE' then
    raise exception 'Unexpected AI counter cleanup trigger' using errcode = '42501';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(81190206);
  delete from security_private.ai_usage_counters
    where bucket_key = 'day:account:' || old.id::text
       or bucket_key like 'minute:' || old.id::text || ':%';
  return old;
end;
$$;
revoke all on function security_private.cleanup_deleted_user_ai_usage() from public, anon, authenticated, service_role;
drop trigger if exists cleanup_deleted_user_ai_usage on auth.users;
create trigger cleanup_deleted_user_ai_usage after delete on auth.users
  for each row execute function security_private.cleanup_deleted_user_ai_usage();
