-- 20260808091000_admin_dashboard_stats.sql — 관리자 대시보드 집계를 DB 로 내린다.
--
-- 문제: 페이지가 messages 5,000행(assistant) · 2,000행(user) · 20,000행(30일) 을 매 요청마다
--       앱 메모리로 끌어와 접었다. force-dynamic 이라 캐시도 없어 자료·이용량이 늘수록
--       관리자 페이지만 계속 느려지고, 상한(limit) 때문에 수치도 슬금슬금 부정확해진다.
-- 해결: 한 번의 RPC 로 Postgres 가 집계해 jsonb 로 돌려준다.
--
-- 날짜는 전부 KST 기준(앱의 lib/kst.ts 와 일치).
-- 권한: service_role 전용. 앱은 role='admin' 검증 후 lib/supabase/admin.ts 로만 호출한다.

create or replace function admin_dashboard_stats(
  p_days      int default 30,
  p_faq_limit int default 20
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
  kst_today as (
    select (now() at time zone 'Asia/Seoul')::date as d
  ),
  month_start as (
    select date_trunc('month', (select d from kst_today))::date as d
  ),
  user_count as (
    select count(*)::bigint as c from profiles
  ),
  question_count as (
    select count(*)::bigint as c from messages where role = 'user'
  ),
  answer_stats as (
    select
      avg(latency_ms) filter (where latency_ms is not null)      as avg_latency,
      count(*) filter (where feedback = 1)::bigint               as up,
      count(*) filter (where feedback = -1)::bigint              as down
    from messages
    where role = 'assistant'
  ),
  -- 답변에 인용된 출처의 분야 분포. sources 는 [{document_id, doc, page, content}] jsonb 배열.
  -- document_id 는 외부 RAG(rag_rescue) 청크면 0 이라 documents 와 매칭되지 않는다(기존 동작 유지).
  -- CASE 로 감싸 숫자가 아닌 값이 들어와도 캐스팅 에러가 나지 않게 한다.
  cited_docs as (
    select
      case
        when e.elem ->> 'document_id' ~ '^[0-9]+$' then (e.elem ->> 'document_id')::bigint
        else null
      end as document_id
    from messages m
    cross join lateral jsonb_array_elements(m.sources) as e(elem)
    -- role/jsonb_typeof 는 messages 스캔 단계의 제약이라 lateral 함수 호출 전에 걸러진다
    -- (sources 가 배열이 아닌 행에서 jsonb_array_elements 가 에러 내는 것을 막는다).
    where m.role = 'assistant'
      and jsonb_typeof(m.sources) = 'array'
  ),
  categories as (
    select d.category, count(*)::bigint as cnt
    from cited_docs c
    join documents d on d.id = c.document_id
    where d.category is not null
    group by d.category
  ),
  daily as (
    select
      g.day::date as day,
      coalesce(hits.c, 0)::bigint as cnt
    from generate_series(
      (select d from kst_today) - (p_days - 1),
      (select d from kst_today),
      interval '1 day'
    ) as g(day)
    left join (
      select (created_at at time zone 'Asia/Seoul')::date as day, count(*)::bigint as c
      from messages
      where role = 'user'
        and created_at >= (
          ((select d from kst_today) - (p_days - 1))::timestamp at time zone 'Asia/Seoul'
        )
      group by 1
    ) as hits on hits.day = g.day::date
  ),
  faq as (
    select btrim(content) as question, count(*)::bigint as cnt
    from messages
    where role = 'user'
      and btrim(content) <> ''
    group by btrim(content)
    order by cnt desc, question
    limit greatest(p_faq_limit, 0)
  ),
  fitness_month as (
    select
      count(distinct user_id)::bigint      as active_users,
      coalesce(sum(points), 0)::bigint     as month_points
    from workout_logs
    where performed_on >= (select d from month_start)
  ),
  fitness_total as (
    select count(*)::bigint as c from workout_logs
  )
select jsonb_build_object(
  'totalUsers',         (select c from user_count),
  'totalQuestions',     (select c from question_count),
  'avgLatencyMs',       coalesce((select round(avg_latency)::int from answer_stats), 0),
  'up',                 coalesce((select up from answer_stats), 0),
  'down',               coalesce((select down from answer_stats), 0),
  'categories', coalesce((
    select jsonb_agg(jsonb_build_object('category', category, 'count', cnt) order by cnt desc, category)
    from categories
  ), '[]'::jsonb),
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'count', cnt) order by day)
    from daily
  ), '[]'::jsonb),
  'faq', coalesce((
    select jsonb_agg(jsonb_build_object('q', question, 'count', cnt) order by cnt desc, question)
    from faq
  ), '[]'::jsonb),
  'fitnessActiveUsers', (select active_users from fitness_month),
  'fitnessMonthPoints', (select month_points from fitness_month),
  'fitnessTotalLogs',   (select c from fitness_total)
);
$$;

-- 전체 사용자 질문을 집계하므로 일반 사용자에게는 절대 노출하지 않는다.
revoke all on function admin_dashboard_stats(int, int) from public, anon, authenticated;
grant execute on function admin_dashboard_stats(int, int) to service_role;
