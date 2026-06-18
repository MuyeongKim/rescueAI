-- rag_rescue 벡터DB 스키마 — 새(빈) Supabase 프로젝트 초기화용.
--
-- rag7.py(LangChain SupabaseVectorStore)는 데이터 적재만 하고 테이블/함수/확장을
-- 만들지 않는다. 빈 프로젝트에서는 이 SQL을 먼저 Supabase SQL Editor 에서 실행한 뒤
-- 키를 교체하고 rag7.py 로 인덱싱한다.
--
-- 차원은 bge-m3 = 1024 고정(웹앱 EMBEDDING_DIM·인덱서와 일치해야 함).
-- 검색 함수 시그니처는 lib/rag2026.ts 의 호출과 정확히 일치한다:
--   match_rag_rescue(query_embedding, match_count, match_threshold, filter)

-- 1) 확장
create extension if not exists vector;

-- 2) 테이블 (LangChain SupabaseVectorStore 형식: id/content/metadata/embedding)
create table if not exists public.rag_rescue (
  id        uuid primary key default gen_random_uuid(),
  content   text,
  metadata  jsonb,
  embedding vector(1024)
);

-- 3) 인덱스
--    - 벡터 근사검색(HNSW, 코사인). 데이터 적재 후 자동 사용된다.
create index if not exists rag_rescue_embedding_idx
  on public.rag_rescue using hnsw (embedding vector_cosine_ops);
--    - 키워드 full-text(simple). 앱의 textSearch(content, ..., {config:'simple'}) 가속용.
create index if not exists rag_rescue_content_fts_idx
  on public.rag_rescue using gin (to_tsvector('simple', content));
--    - 분야 필터(metadata->>edu_category) 가속용.
create index if not exists rag_rescue_metadata_idx
  on public.rag_rescue using gin (metadata);

-- 4) 검색 RPC — 앱(lib/rag2026.ts) 이 호출하는 시그니처와 동일하게.
--    유사도 = 1 - 코사인거리. match_threshold 이상만, filter(jsonb) 부분일치(@>) 적용.
create or replace function public.match_rag_rescue (
  query_embedding vector(1024),
  match_count     int default 10,
  match_threshold float default 0.0,
  filter          jsonb default '{}'
)
returns table (
  id         uuid,
  content    text,
  metadata   jsonb,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    r.id,
    r.content,
    r.metadata,
    1 - (r.embedding <=> query_embedding) as similarity
  from public.rag_rescue r
  where r.metadata @> filter
    and 1 - (r.embedding <=> query_embedding) >= match_threshold
  order by r.embedding <=> query_embedding
  limit match_count;
end;
$$;
