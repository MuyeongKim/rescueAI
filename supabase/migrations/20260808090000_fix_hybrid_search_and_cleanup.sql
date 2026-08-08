-- 20260808090000_fix_hybrid_search_and_cleanup.sql
-- ① hybrid_search 의 거리 연산자를 인덱스와 맞춘다.
-- ② 미사용 테이블(lesson_progress) 정리.
--
-- 파일명 규칙: 이 마이그레이션부터 `YYYYMMDDHHMMSS_설명.sql`(Supabase CLI 표준)을 쓴다.
-- 기존 0001~0012 는 이미 적용된 이력이라 이름을 바꾸지 않는다.

-- ── ① 벡터 거리 연산자 불일치 ──────────────────────────────────────────────
-- 문제: 0001 의 인덱스는 `ivfflat (embedding vector_cosine_ops)` 인데 0002 의 hybrid_search 는
--       `<->`(L2 거리)로 정렬했다. 연산자 클래스가 달라 플래너가 인덱스를 쓸 수 없고,
--       chunks 전건 스캔 + 정렬이 돌았다(자료가 늘수록 급격히 느려짐).
-- 해결: 코사인 거리 연산자 `<=>` 로 통일한다. 앱의 다른 경로(match_rag_rescue)도 `<=>` 를 쓴다.
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
language sql
stable
as $$
  with vector_search as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c join documents d on d.id = c.document_id
    where filter_category is null or d.category = filter_category
    order by c.embedding <=> query_embedding
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

-- ivfflat 은 리스트 수를 데이터 규모에 맞춰야 의미가 있고, 소규모에서는 hnsw 가 튜닝 없이도
-- 안정적이다. rag_rescue 와 동일하게 hnsw + cosine 으로 맞춘다.
drop index if exists chunks_embedding_idx;
create index if not exists chunks_embedding_hnsw_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- ── ② 미사용 테이블 정리 ──────────────────────────────────────────────────
-- 학습/진도/이수(레슨) 기능은 2026-06-18 제거됐고 lesson_progress 를 읽는 코드가 없다.
-- 남겨두면 "쓰는 줄 알고" 참조하는 코드가 다시 생긴다.
drop table if exists lesson_progress;
