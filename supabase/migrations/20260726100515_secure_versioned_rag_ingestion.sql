-- 외부 RAG 테이블 보안 강화 및 무중단 버전 교체.
-- rag7.py 는 신규 청크를 is_active=false 로 먼저 적재한 뒤
-- activate_rag_rescue_ingestion()으로 검증/활성화/이전 버전 삭제를 한 트랜잭션에서 수행한다.

create extension if not exists vector;

create table if not exists public.rag_rescue (
  id           uuid primary key default gen_random_uuid(),
  content      text,
  metadata     jsonb default '{}'::jsonb,
  embedding    vector(1024),
  ingestion_id uuid,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

alter table public.rag_rescue
  add column if not exists ingestion_id uuid,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

update public.rag_rescue
set is_active = true
where is_active is null;

alter table public.rag_rescue
  alter column is_active set default false;

create index if not exists rag_rescue_embedding_idx
  on public.rag_rescue using hnsw (embedding vector_cosine_ops);
create index if not exists rag_rescue_active_embedding_idx
  on public.rag_rescue using hnsw (embedding vector_cosine_ops)
  where is_active;
create index if not exists rag_rescue_content_fts_idx
  on public.rag_rescue using gin (to_tsvector('simple', content));
create index if not exists rag_rescue_active_content_fts_idx
  on public.rag_rescue using gin (to_tsvector('simple', content))
  where is_active;
create index if not exists rag_rescue_metadata_idx
  on public.rag_rescue using gin (metadata);
create index if not exists rag_rescue_active_source_idx
  on public.rag_rescue (
    is_active,
    (metadata ->> 'edu_category'),
    (metadata ->> 'year'),
    (metadata ->> 'source')
  );
create index if not exists rag_rescue_ingestion_idx
  on public.rag_rescue (ingestion_id);

-- 한 테이블 안에 서로 다른 임베딩 공간이 섞이지 않도록 계약을 명시한다.
create table if not exists public.rag_embedding_config (
  table_name  text primary key,
  provider    text not null,
  model       text not null,
  dimensions integer not null check (dimensions > 0),
  version     text not null,
  updated_at  timestamptz not null default now()
);

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
language sql
stable
set search_path = ''
as $$
  select
    r.id,
    r.content,
    r.metadata,
    1 - (r.embedding <=> query_embedding) as similarity
  from public.rag_rescue as r
  where r.is_active
    and r.metadata @> filter
    and 1 - (r.embedding <=> query_embedding) >= match_threshold
  order by r.embedding <=> query_embedding
  limit least(greatest(coalesce(match_count, 10), 0), 100);
$$;

create or replace function public.activate_rag_rescue_ingestion (
  p_ingestion_id uuid,
  p_category text,
  p_year text,
  p_source text,
  p_expected_count integer,
  p_replace_existing boolean default true
)
returns table (activated_count integer)
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
  v_total integer;
begin
  if p_ingestion_id is null
    or nullif(btrim(p_category), '') is null
    or nullif(btrim(p_year), '') is null
    or nullif(btrim(p_source), '') is null
    or p_expected_count <= 0 then
    raise exception 'invalid ingestion activation arguments';
  end if;

  -- 같은 문서의 동시 활성화를 직렬화한다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_category || E'\n' || p_year || E'\n' || p_source, 0)
  );

  select count(*)::integer
    into v_total
  from public.rag_rescue as r
  where r.ingestion_id = p_ingestion_id;

  if v_total <> p_expected_count then
    raise exception
      'staged total row count mismatch: expected %, found %',
      p_expected_count,
      v_total;
  end if;

  select count(*)::integer
    into v_count
  from public.rag_rescue as r
  where r.ingestion_id = p_ingestion_id
    and r.metadata ->> 'edu_category' = p_category
    and r.metadata ->> 'year' = p_year
    and r.metadata ->> 'source' = p_source;

  if v_count <> p_expected_count then
    raise exception
      'staged row count mismatch: expected %, found %',
      p_expected_count,
      v_count;
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.ingestion_id = p_ingestion_id
      and (
        nullif(btrim(r.content), '') is null
        or r.embedding is null
      )
  ) then
    raise exception 'staged rows contain empty content or embedding';
  end if;

  if not exists (
    select 1
    from public.rag_embedding_config as c
    where c.table_name = 'rag_rescue'
  ) then
    raise exception 'embedding contract for rag_rescue is not configured';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    join public.rag_embedding_config as c
      on c.table_name = 'rag_rescue'
    where r.ingestion_id = p_ingestion_id
      and (
        r.metadata ->> 'embedding_provider' is distinct from c.provider
        or r.metadata ->> 'embedding_model' is distinct from c.model
        or r.metadata ->> 'embedding_dimensions' is distinct from c.dimensions::text
        or r.metadata ->> 'embedding_version' is distinct from c.version
      )
  ) then
    raise exception 'staged rows do not match the rag_rescue embedding contract';
  end if;

  if p_replace_existing then
    delete from public.rag_rescue as r
    where r.ingestion_id is distinct from p_ingestion_id
      and r.metadata ->> 'edu_category' = p_category
      and r.metadata ->> 'year' = p_year
      and r.metadata ->> 'source' = p_source;
  end if;

  update public.rag_rescue as r
  set is_active = true
  where r.ingestion_id = p_ingestion_id
    and not r.is_active;

  return query select v_count;
end;
$$;

-- 로그인 사용자는 활성 자료만 읽고, 인덱서의 쓰기/활성화만 service role로 제한한다.
alter table public.rag_rescue enable row level security;
alter table public.rag_embedding_config enable row level security;

drop policy if exists rag_rescue_authenticated_read on public.rag_rescue;
create policy rag_rescue_authenticated_read
  on public.rag_rescue
  for select
  to authenticated
  using (is_active);

drop policy if exists rag_embedding_config_authenticated_read
  on public.rag_embedding_config;
create policy rag_embedding_config_authenticated_read
  on public.rag_embedding_config
  for select
  to authenticated
  using (true);

revoke all on table public.rag_rescue from public, anon, authenticated;
revoke all on table public.rag_embedding_config from public, anon, authenticated;
grant select on table public.rag_rescue to authenticated;
grant select on table public.rag_embedding_config to authenticated;
grant select, insert, update, delete on table public.rag_rescue to service_role;
grant select, insert, update, delete on table public.rag_embedding_config to service_role;

revoke all on function public.match_rag_rescue(vector, integer, double precision, jsonb)
  from public, anon, authenticated;
grant execute on function public.match_rag_rescue(vector, integer, double precision, jsonb)
  to authenticated, service_role;

revoke all on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) from public, anon, authenticated;
grant execute on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) to service_role;
