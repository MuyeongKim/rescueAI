-- 분야 자동 모드의 filter={} 검색이 metadata @> '{}' 조건 때문에 HNSW 순서 검색을
-- 안정적으로 선택하지 못하고 statement_timeout에 걸리는 문제를 분리한다.
-- 빈 필터와 실제 metadata 필터를 PL/pgSQL 분기로 나눠 각 쿼리 계획을 단순하게 유지하고,
-- 거리순 상위 N개를 먼저 뽑은 뒤 임계값을 적용한다.

create or replace function public.match_rag_rescue (
  query_embedding vector(1024),
  match_count integer default 10,
  match_threshold double precision default 0.0,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity double precision
)
language plpgsql
stable
set search_path = ''
as $$
declare
  bounded_count integer := least(greatest(coalesce(match_count, 10), 0), 100);
  bounded_threshold double precision := coalesce(match_threshold, 0.0);
begin
  if coalesce(filter, '{}'::jsonb) = '{}'::jsonb then
    return query
    select ranked.id, ranked.content, ranked.metadata, ranked.similarity
    from (
      select
        r.id,
        r.content,
        r.metadata,
        1 - (r.embedding operator(public.<=>) query_embedding) as similarity
      from public.rag_rescue as r
      where r.is_active
      order by r.embedding operator(public.<=>) query_embedding
      limit bounded_count
    ) as ranked
    where ranked.similarity >= bounded_threshold
    order by ranked.similarity desc;
    return;
  end if;

  return query
  select ranked.id, ranked.content, ranked.metadata, ranked.similarity
  from (
    select
      r.id,
      r.content,
      r.metadata,
      1 - (r.embedding operator(public.<=>) query_embedding) as similarity
    from public.rag_rescue as r
    where r.is_active
      and r.metadata @> filter
    order by r.embedding operator(public.<=>) query_embedding
    limit bounded_count
  ) as ranked
  where ranked.similarity >= bounded_threshold
  order by ranked.similarity desc;
end;
$$;

revoke all on function public.match_rag_rescue(vector, integer, double precision, jsonb)
  from public, anon, authenticated;
grant execute on function public.match_rag_rescue(vector, integer, double precision, jsonb)
  to authenticated, service_role;
