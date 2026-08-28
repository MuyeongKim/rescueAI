-- 출동 마일리지·체력단련 기능 제거 후 관리자 통계에서 체력 집계를 중단한다.
-- 기존 workout_logs 데이터와 스키마는 복구 가능성을 위해 보존한다.

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
  user_count as (
    select count(*)::bigint as c from profiles
  ),
  question_count as (
    select count(*)::bigint as c from messages where role = 'user'
  ),
  answer_stats as (
    select
      avg(latency_ms) filter (where latency_ms is not null) as avg_latency,
      count(*) filter (where feedback = 1)::bigint          as up,
      count(*) filter (where feedback = -1)::bigint         as down
    from messages
    where role = 'assistant'
  ),
  cited_docs as (
    select
      case
        when e.elem ->> 'document_id' ~ '^[0-9]+$' then (e.elem ->> 'document_id')::bigint
        else null
      end as document_id
    from messages m
    cross join lateral jsonb_array_elements(m.sources) as e(elem)
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
  )
select jsonb_build_object(
  'totalUsers',     (select c from user_count),
  'totalQuestions', (select c from question_count),
  'avgLatencyMs',   coalesce((select round(avg_latency)::int from answer_stats), 0),
  'up',             coalesce((select up from answer_stats), 0),
  'down',           coalesce((select down from answer_stats), 0),
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
  ), '[]'::jsonb)
);
$$;

revoke all on function admin_dashboard_stats(int, int) from public, anon, authenticated;
grant execute on function admin_dashboard_stats(int, int) to service_role;
