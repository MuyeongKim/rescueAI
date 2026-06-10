-- 0002_hybrid_search.sql — 하이브리드 검색 RPC (PRD §6.2)
-- 벡터(코사인 거리) + 키워드(tsvector) 결과를 RRF(k=60)로 결합한다.

create or replace function hybrid_search(
  query_text       text,
  query_embedding  vector(1024),
  match_count      int default 5,
  filter_category  text default null
)
returns table (
  chunk_id bigint, document_id bigint, doc_title text,
  content text, page_num int, rrf_score float
)
language sql as $$
  with vector_search as (
    select c.id, row_number() over (order by c.embedding <-> query_embedding) as rank
    from chunks c join documents d on d.id = c.document_id
    where filter_category is null or d.category = filter_category
    order by c.embedding <-> query_embedding
    limit 30
  ),
  keyword_search as (
    select c.id, row_number() over (order by ts_rank(c.tsv, plainto_tsquery('simple', query_text)) desc) as rank
    from chunks c join documents d on d.id = c.document_id
    where c.tsv @@ plainto_tsquery('simple', query_text)
      and (filter_category is null or d.category = filter_category)
    limit 30
  ),
  combined as (
    select id, sum(1.0 / (60 + rank)) as rrf_score
    from (select id, rank from vector_search
          union all
          select id, rank from keyword_search) u
    group by id
  )
  select c.id, c.document_id, d.title, c.content, c.page_num, cb.rrf_score
  from combined cb
  join chunks c on c.id = cb.id
  join documents d on d.id = c.document_id
  order by cb.rrf_score desc
  limit match_count;
$$;
