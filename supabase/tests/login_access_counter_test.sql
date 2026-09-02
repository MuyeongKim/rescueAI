begin;
select plan(20);

truncate table visitor_private.login_session_days;

select ok(
  pg_catalog.to_regnamespace('visitor_private') is not null,
  '접속 원장은 전용 비노출 스키마에 둔다'
);

select ok(
  pg_catalog.to_regclass('public.login_session_days') is null,
  '접속 원장을 public 스키마에 노출하지 않는다'
);

select ok(
  (
    select relrowsecurity
    from pg_catalog.pg_class
    where oid = 'visitor_private.login_session_days'::pg_catalog.regclass
  ),
  '접속 원장에 RLS를 활성화한다'
);

select ok(
  not pg_catalog.has_table_privilege(
    'anon',
    'visitor_private.login_session_days',
    'SELECT'
  ),
  'anon은 원본 접속 원장을 읽을 수 없다'
);

select ok(
  not pg_catalog.has_table_privilege(
    'authenticated',
    'visitor_private.login_session_days',
    'SELECT'
  ),
  'authenticated도 원본 접속 원장을 읽을 수 없다'
);

select ok(
  not pg_catalog.has_function_privilege(
    'anon',
    'public.record_daily_login_access()',
    'EXECUTE'
  ),
  'anon은 접속 기록 RPC를 실행할 수 없다'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.record_daily_login_access()',
    'EXECUTE'
  ),
  'authenticated는 접속 기록 RPC를 실행할 수 있다'
);

select ok(
  pg_catalog.has_function_privilege(
    'anon',
    'public.get_login_access_stats()',
    'EXECUTE'
  ),
  'anon은 공개 집계 숫자를 조회할 수 있다'
);

select ok(
  pg_catalog.has_function_privilege(
    'authenticated',
    'public.get_login_access_stats()',
    'EXECUTE'
  ),
  'authenticated도 공개 집계 숫자를 조회할 수 있다'
);

set local role anon;

select is(
  (select today_access from public.get_login_access_stats()),
  0::bigint,
  '초기 오늘 접속은 0이다'
);

select is(
  (select total_access from public.get_login_access_stats()),
  0::bigint,
  '초기 누적 접속은 0이다'
);

reset role;
set local role authenticated;

select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.json_build_object(
    'sub', '11111111-1111-1111-1111-111111111111',
    'role', 'authenticated'
  )::text,
  true
);

select throws_ok(
  $sql$select public.record_daily_login_access()$sql$,
  '42501',
  'authenticated session required',
  '서명된 session_id가 없는 인증 요청은 기록하지 않는다'
);

select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.json_build_object(
    'sub', '11111111-1111-1111-1111-111111111111',
    'role', 'authenticated',
    'session_id', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  )::text,
  true
);

select is(
  public.record_daily_login_access(),
  true,
  '첫 인증 세션 접속을 기록한다'
);

select is(
  public.record_daily_login_access(),
  false,
  '같은 세션의 같은 날 재요청은 중복 기록하지 않는다'
);

reset role;

select is(
  (select count(*) from visitor_private.login_session_days),
  1::bigint,
  '동일 세션 중복 요청 뒤에도 원장은 한 행이다'
);

set local role authenticated;

select pg_catalog.set_config(
  'request.jwt.claims',
  pg_catalog.json_build_object(
    'sub', '11111111-1111-1111-1111-111111111111',
    'role', 'authenticated',
    'session_id', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
  )::text,
  true
);

select is(
  public.record_daily_login_access(),
  true,
  '공유 계정의 별도 인증 세션은 독립 접속으로 기록한다'
);

reset role;
set local role anon;

select is(
  (select today_access from public.get_login_access_stats()),
  2::bigint,
  '오늘 접속은 서로 다른 세션 두 개를 센다'
);

select is(
  (select total_access from public.get_login_access_stats()),
  2::bigint,
  '누적 접속은 세션-일 원장 전체를 센다'
);

reset role;

select ok(
  not exists (
    select 1
    from visitor_private.login_session_days
    where pg_catalog.octet_length(session_hash) <> 32
  ),
  '원본 session_id 대신 32바이트 SHA-256 해시만 저장한다'
);

select is(
  (
    select count(*)
    from information_schema.columns
    where table_schema = 'visitor_private'
      and table_name = 'login_session_days'
      and column_name in ('session_id', 'user_id', 'email', 'ip', 'user_agent')
  ),
  0::bigint,
  '원장에는 계정·IP·브라우저 원문 식별자를 두지 않는다'
);

select * from finish();
rollback;
