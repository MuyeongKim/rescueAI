-- 키워드 후보를 먼저 제한하면 관련성이 높은 청크가 후보군 밖에서 누락될 수 있다.
-- 기존 simple 본문 GIN 색인을 사용해 검색한 뒤 관련성순으로 정렬하고 LIMIT을 적용한다.
-- 기존 벡터 RPC·적재 계약·RLS·색인은 변경하지 않는다.

create or replace function public.search_rag_rescue_keywords (
  query_text text,
  match_count integer default 48,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  keyword_rank real
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  bounded_count integer := least(greatest(coalesce(match_count, 48), 0), 100);
  normalized_query text := pg_catalog.btrim(coalesce(query_text, ''));
  metadata_filter jsonb := coalesce(filter, '{}'::jsonb);
  search_query pg_catalog.tsquery;
begin
  -- 잘린 구문으로 다른 검색을 실행하지 않고 잘못된 입력을 명시적으로 거절한다.
  if pg_catalog.length(normalized_query) > 2048 then
    raise exception using errcode = '22023', message = 'keyword query exceeds 2048 characters';
  end if;
  if pg_catalog.jsonb_typeof(metadata_filter) <> 'object'
    or pg_catalog.length(metadata_filter::text) > 4096 then
    raise exception using errcode = '22023', message = 'keyword filter must be an object within 4096 characters';
  end if;
  if bounded_count = 0 or normalized_query = '' then
    return;
  end if;

  search_query := pg_catalog.websearch_to_tsquery('simple'::pg_catalog.regconfig, normalized_query);
  -- 구두점만 있거나 제외어만 있는 요청은 GIN으로 좁힐 양의 검색어가 없다.
  if pg_catalog.numnode(search_query) = 0 or pg_catalog.querytree(search_query) = 'T' then
    return;
  end if;

  -- 분야 자동 검색에서는 무의미한 metadata @> '{}' 조건을 제거한다.
  if metadata_filter = '{}'::jsonb then
    return query
    select r.id, r.content, r.metadata,
      pg_catalog.ts_rank_cd(
        pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, r.content), search_query
      ) as keyword_rank
    from public.rag_rescue as r
    where r.is_active
      and pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, r.content) @@ search_query
    order by keyword_rank desc, r.id asc
    limit bounded_count;
    return;
  end if;

  return query
  select r.id, r.content, r.metadata,
    pg_catalog.ts_rank_cd(
      pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, r.content), search_query
    ) as keyword_rank
  from public.rag_rescue as r
  where r.is_active
    and r.metadata @> metadata_filter
    and pg_catalog.to_tsvector('simple'::pg_catalog.regconfig, r.content) @@ search_query
  order by keyword_rank desc, r.id asc
  limit bounded_count;
end;
$$;

revoke all on function public.search_rag_rescue_keywords(text, integer, jsonb)
  from public, anon, authenticated;
grant execute on function public.search_rag_rescue_keywords(text, integer, jsonb)
  to authenticated, service_role;

comment on function public.search_rag_rescue_keywords(text, integer, jsonb) is
  'Active, RLS-scoped simple FTS candidates ordered by ts_rank_cd before bounded LIMIT; no vectors returned.';
