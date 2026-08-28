-- 전체 RAG 코퍼스를 한 트랜잭션에서 교체하고 이전 임베딩 공간을 롤백용으로 보존한다.
-- 문서별 activate_rag_rescue_ingestion()만으로 제공자를 바꾸면 전환 중 서로 다른
-- 벡터 공간이 섞이므로, 제공자 변경은 이 릴리스 단위 RPC만 사용한다.

create table if not exists public.rag_corpus_releases (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  provider       text not null,
  model          text not null,
  dimensions     integer not null check (dimensions = 1024),
  version        text not null,
  manifest       jsonb not null check (jsonb_typeof(manifest) = 'array'),
  expected_rows  integer not null check (expected_rows > 0),
  state          text not null default 'staged'
                 check (state in ('staged', 'active', 'inactive', 'failed')),
  created_at     timestamptz not null default now(),
  activated_at   timestamptz
);

create unique index if not exists rag_corpus_releases_one_active_idx
  on public.rag_corpus_releases ((state))
  where state = 'active';

create index if not exists rag_corpus_releases_created_idx
  on public.rag_corpus_releases (created_at desc);

alter table public.rag_corpus_releases enable row level security;
revoke all on table public.rag_corpus_releases from public, anon, authenticated;
grant select, insert, update, delete on table public.rag_corpus_releases to service_role;

-- 마이그레이션 적용 시 현재 활성 BGE 코퍼스를 하나의 롤백 릴리스로 등록한다.
-- 이미 활성 릴리스가 있으면 재실행해도 중복 생성하지 않는다.
do $$
declare
  v_provider text;
  v_model text;
  v_dimensions integer;
  v_version text;
  v_manifest jsonb;
  v_expected_rows integer;
begin
  -- 기존 단건 활성화가 기준선 캡처 사이에 커밋하지 못하게 쓰기를 잠시 막는다.
  lock table public.rag_rescue in share mode;
  lock table public.rag_embedding_config in share mode;

  if exists (select 1 from public.rag_corpus_releases where state = 'active')
     or not exists (select 1 from public.rag_rescue where is_active) then
    return;
  end if;

  select c.provider, c.model, c.dimensions, c.version
    into v_provider, v_model, v_dimensions, v_version
  from public.rag_embedding_config as c
  where c.table_name = 'rag_rescue';

  if v_provider is null then
    raise exception 'cannot capture baseline: rag_rescue embedding contract is missing';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.is_active
      and (
        r.ingestion_id is null
        or nullif(btrim(r.metadata ->> 'category'), '') is null
        or nullif(btrim(r.metadata ->> 'edu_category'), '') is null
        or r.metadata ->> 'category' is distinct from r.metadata ->> 'edu_category'
        or nullif(btrim(r.metadata ->> 'year'), '') is null
        or nullif(btrim(r.metadata ->> 'source'), '') is null
        or coalesce(r.metadata ->> 'document_id', '') !~ '^[0-9]+$'
        or coalesce(r.metadata ->> 'file_hash', '') !~ '^[0-9a-fA-F]{64}$'
      )
  ) then
    raise exception 'cannot capture baseline: active row metadata is incomplete';
  end if;

  with grouped as (
    select
      r.ingestion_id,
      r.metadata ->> 'edu_category' as category,
      r.metadata ->> 'year' as year,
      r.metadata ->> 'source' as source,
      (r.metadata ->> 'document_id')::bigint as document_id,
      lower(r.metadata ->> 'file_hash') as file_hash,
      count(*)::integer as expected_count
    from public.rag_rescue as r
    where r.is_active
    group by
      r.ingestion_id,
      r.metadata ->> 'edu_category',
      r.metadata ->> 'year',
      r.metadata ->> 'source',
      (r.metadata ->> 'document_id')::bigint,
      lower(r.metadata ->> 'file_hash')
  )
  select
    jsonb_agg(
      jsonb_build_object(
        'ingestion_id', ingestion_id,
        'category', category,
        'year', year,
        'source', source,
        'document_id', document_id,
        'file_hash', file_hash,
        'expected_count', expected_count
      )
      order by source, ingestion_id
    ),
    sum(expected_count)::integer
    into v_manifest, v_expected_rows
  from grouped;

  if v_manifest is null or v_expected_rows <= 0 then
    raise exception 'cannot capture baseline: active corpus manifest is empty';
  end if;

  insert into public.rag_corpus_releases (
    label,
    provider,
    model,
    dimensions,
    version,
    manifest,
    expected_rows,
    state,
    activated_at
  ) values (
    'Gemini 전환 전 기준선',
    v_provider,
    v_model,
    v_dimensions,
    v_version,
    v_manifest,
    v_expected_rows,
    'active',
    now()
  );
end;
$$;

create or replace function public.switch_rag_rescue_corpus (
  p_release_id uuid
)
returns table (
  release_id uuid,
  activated_count integer,
  deactivated_count integer,
  provider text,
  model text,
  version text
)
language plpgsql
set search_path = ''
as $$
declare
  v_release public.rag_corpus_releases%rowtype;
  v_ingestion_ids uuid[];
  v_manifest_rows integer;
  v_distinct_ingestions integer;
  v_distinct_documents integer;
  v_manifest_expected integer;
  v_release_document_ids bigint[];
  v_active_document_ids bigint[];
  v_actual_count integer;
  v_activated_count integer;
  v_deactivated_count integer;
begin
  if p_release_id is null then
    raise exception 'release id is required';
  end if;

  -- 문서별 활성화 RPC와 동일한 전역 잠금을 사용해 코퍼스 변경을 직렬화한다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );

  select *
    into v_release
  from public.rag_corpus_releases
  where id = p_release_id
  for update;

  if not found then
    raise exception 'rag corpus release not found: %', p_release_id;
  end if;
  if v_release.state not in ('staged', 'active', 'inactive') then
    raise exception 'rag corpus release is not switchable: %', v_release.state;
  end if;
  if jsonb_array_length(v_release.manifest) = 0 then
    raise exception 'rag corpus release manifest is empty';
  end if;

  select
    array_agg(m.ingestion_id order by m.ingestion_id),
    count(*)::integer,
    count(distinct m.ingestion_id)::integer,
    count(distinct m.document_id)::integer,
    array_agg(m.document_id order by m.document_id),
    sum(m.expected_count)::integer
    into
      v_ingestion_ids,
      v_manifest_rows,
      v_distinct_ingestions,
      v_distinct_documents,
      v_release_document_ids,
      v_manifest_expected
  from jsonb_to_recordset(v_release.manifest) as m(
    ingestion_id uuid,
    category text,
    year text,
    source text,
    document_id bigint,
    file_hash text,
    expected_count integer
  );

  if v_manifest_rows <> v_distinct_ingestions
     or v_manifest_rows <> v_distinct_documents
     or v_release.dimensions <> 1024
     or v_manifest_expected is null
     or v_manifest_expected <> v_release.expected_rows
     or exists (
       select 1
       from jsonb_to_recordset(v_release.manifest) as m(
         ingestion_id uuid,
         category text,
         year text,
         source text,
         document_id bigint,
         file_hash text,
         expected_count integer
       )
       where m.ingestion_id is null
          or nullif(btrim(m.category), '') is null
          or nullif(btrim(m.year), '') is null
          or nullif(btrim(m.source), '') is null
          or m.document_id is null
          or coalesce(m.file_hash, '') !~ '^[0-9a-fA-F]{64}$'
          or m.expected_count is null
          or m.expected_count <= 0
     ) then
    raise exception 'invalid or duplicate rag corpus release manifest';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.is_active
      and coalesce(r.metadata ->> 'document_id', '') !~ '^[0-9]+$'
  ) then
    raise exception 'current active corpus contains an invalid document_id';
  end if;

  select array_agg(document_id order by document_id)
    into v_active_document_ids
  from (
    select distinct (r.metadata ->> 'document_id')::bigint as document_id
    from public.rag_rescue as r
    where r.is_active
  ) as active_documents;

  if v_active_document_ids is null
     or v_release_document_ids is distinct from v_active_document_ids then
    raise exception
      'release document set does not match the current active corpus: target %, current %',
      v_release_document_ids,
      v_active_document_ids;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_release.manifest) as m(
      ingestion_id uuid,
      category text,
      year text,
      source text,
      document_id bigint,
      file_hash text,
      expected_count integer
    )
    left join public.documents as d on d.id = m.document_id
    where d.id is null
       or d.original_filename is distinct from m.source
       or d.category is distinct from m.category
       or d.file_url is distinct from (
         'rag/' || left(lower(m.file_hash), 2) || '/' || lower(m.file_hash) || '.pdf'
       )
  ) then
    raise exception 'release manifest does not match documents or Storage paths';
  end if;

  select count(*)::integer
    into v_actual_count
  from public.rag_rescue as r
  where r.ingestion_id = any(v_ingestion_ids);

  if v_actual_count <> v_release.expected_rows then
    raise exception
      'release row count mismatch: expected %, found %',
      v_release.expected_rows,
      v_actual_count;
  end if;

  -- manifest의 문서별 행 수와 실제 category/year/source가 완전히 같은지 검증한다.
  if exists (
    with manifest_rows as (
      select *
      from jsonb_to_recordset(v_release.manifest) as m(
        ingestion_id uuid,
        category text,
        year text,
        source text,
        document_id bigint,
        file_hash text,
        expected_count integer
      )
    ),
    actual_rows as (
      select
        r.ingestion_id,
        r.metadata ->> 'edu_category' as category,
        r.metadata ->> 'year' as year,
        r.metadata ->> 'source' as source,
        (r.metadata ->> 'document_id')::bigint as document_id,
        lower(r.metadata ->> 'file_hash') as file_hash,
        count(*)::integer as actual_count
      from public.rag_rescue as r
      where r.ingestion_id = any(v_ingestion_ids)
      group by
        r.ingestion_id,
        r.metadata ->> 'edu_category',
        r.metadata ->> 'year',
        r.metadata ->> 'source',
        (r.metadata ->> 'document_id')::bigint,
        lower(r.metadata ->> 'file_hash')
    )
    select 1
    from manifest_rows as m
    full join actual_rows as a
      on a.ingestion_id = m.ingestion_id
     and a.category = m.category
     and a.year = m.year
     and a.source = m.source
     and a.document_id = m.document_id
     and a.file_hash = lower(m.file_hash)
    where m.ingestion_id is null
       or a.ingestion_id is null
       or m.expected_count <> a.actual_count
  ) then
    raise exception 'release document manifest does not match staged rows';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.ingestion_id = any(v_ingestion_ids)
      and (
        nullif(btrim(r.content), '') is null
        or r.embedding is null
        or r.metadata ->> 'embedding_provider' is distinct from v_release.provider
        or r.metadata ->> 'embedding_model' is distinct from v_release.model
        or r.metadata ->> 'embedding_dimensions' is distinct from v_release.dimensions::text
        or r.metadata ->> 'embedding_version' is distinct from v_release.version
        or r.metadata ->> 'category' is distinct from r.metadata ->> 'edu_category'
      )
  ) then
    raise exception 'release rows contain invalid content, embedding, or contract metadata';
  end if;

  -- 한 트랜잭션 안에서 계약과 활성 코퍼스를 함께 바꾼다. 외부 쿼리는 중간 상태를 보지 않는다.
  update public.rag_corpus_releases
  set state = 'inactive'
  where state = 'active'
    and id <> p_release_id;

  with changed as (
    update public.rag_rescue as r
    set is_active = false
    where r.is_active
      and (
        r.ingestion_id is null
        or not (r.ingestion_id = any(v_ingestion_ids))
      )
    returning 1
  )
  select count(*)::integer into v_deactivated_count from changed;

  with changed as (
    update public.rag_rescue as r
    set is_active = true
    where r.ingestion_id = any(v_ingestion_ids)
      and not r.is_active
    returning 1
  )
  select count(*)::integer into v_activated_count from changed;

  insert into public.rag_embedding_config (
    table_name, provider, model, dimensions, version, updated_at
  ) values (
    'rag_rescue',
    v_release.provider,
    v_release.model,
    v_release.dimensions,
    v_release.version,
    now()
  )
  on conflict (table_name) do update
  set provider = excluded.provider,
      model = excluded.model,
      dimensions = excluded.dimensions,
      version = excluded.version,
      updated_at = excluded.updated_at;

  update public.rag_corpus_releases
  set state = 'active', activated_at = now()
  where id = p_release_id;

  select count(*)::integer
    into v_actual_count
  from public.rag_rescue as r
  where r.is_active
    and r.ingestion_id = any(v_ingestion_ids);

  if v_actual_count <> v_release.expected_rows
     or exists (
       select 1
       from public.rag_rescue as r
       where r.is_active
         and (
           r.ingestion_id is null
           or not (r.ingestion_id = any(v_ingestion_ids))
         )
     ) then
    raise exception 'post-switch active corpus verification failed';
  end if;

  return query
  select
    v_release.id,
    v_actual_count,
    coalesce(v_deactivated_count, 0),
    v_release.provider,
    v_release.model,
    v_release.version;
end;
$$;

revoke all on function public.switch_rag_rescue_corpus(uuid)
  from public, anon, authenticated;
grant execute on function public.switch_rag_rescue_corpus(uuid)
  to service_role;

-- 단건 갱신도 전역 코퍼스 전환과 동시에 실행되지 않게 하고, inactive 롤백 행은
-- 삭제하지 않는다. 제공자 변경 자체는 switch_rag_rescue_corpus()만 사용한다.
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

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );
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
      and r.is_active
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

revoke all on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) from public, anon, authenticated;
grant execute on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) to service_role;
