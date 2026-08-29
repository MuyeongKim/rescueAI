-- 생성물 공유는 Next.js API의 사전 검사만 믿지 않는다.
-- 인증 사용자는 Supabase Data API를 직접 호출할 수 있으므로, shared=true가 되는 모든
-- INSERT/UPDATE와 이미 공유된 행의 본문 수정에 동일한 SOP 계약을 DB 트리거로 강제한다.

create or replace function public.generated_material_normalize_ocr(
  p_value text,
  p_context_hint text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_normalized text := coalesce(p_value, '');
begin
  -- lib/rag-external.ts normalizeKnownOcrErrors와 같은, 실제 코퍼스에서 확인된
  -- 최소 교정 집합이다. 문맥 의존 오인식은 일반 문장의 정상 표현을 바꾸지 않는다.
  v_normalized := pg_catalog.replace(v_normalized, '헬넷', '헬멧');
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '지위관((에게|은|는|이|가|을|를|의|으로|에서)?([[:space:]]|[,.]|$))',
    '지휘관\1',
    'g'
  );
  v_normalized := pg_catalog.replace(v_normalized, '재세적', '재세척');
  v_normalized := pg_catalog.replace(v_normalized, '제독렌트', '제독텐트');
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '((오염도|시간|압력|농도)[[:space:]]*)축정',
    '\1측정',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '축정([[:space:]]*(장비|기|값|결과))',
    '측정\1',
    'g'
  );
  v_normalized := pg_catalog.replace(v_normalized, '인체사위', '인체샤워');
  v_normalized := pg_catalog.replace(v_normalized, '사위실', '샤워실');

  if (v_normalized || ' ' || coalesce(p_context_hint, ''))
    !~ '((화학[[:space:]]*)?보호(복|의)|착탈의|제독)' then
    return v_normalized;
  end if;

  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '2인[[:space:]]*7조([^.\n]{0,100}(화학[[:space:]]*)?보호(복|의)[^.\n]{0,40}달의)',
    '2인 1조\1',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '\([[:space:]]*2인[[:space:]]*7조[[:space:]]*\)([^.\n]{0,100}(상의|하의)[[:space:]]*[>→])',
    '(2인 1조)\1',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '2인[[:space:]]*7조([[:space:]]*(상의|하의)[[:space:]]*[>→])',
    '2인 1조\1',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '((화학[[:space:]]*)?보호(복|의)[[:space:]]*)달의',
    '\1탈의',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '(순으로[[:space:]]*)달의',
    '\1탈의',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '(^|[[:space:](])달의([[:space:]]*(순서|절차|단계|후|전|시|\)))',
    '\1탈의\2',
    'g'
  );
  return v_normalized;
end;
$$;

create or replace function public.generated_material_compact_text(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.lower(coalesce(p_value, '')),
    '[^0-9a-z가-힣]+',
    '',
    'g'
  );
$$;

create or replace function public.generated_material_source_label(p_metadata jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_source text;
  v_header text;
  v_page text;
  v_label text;
begin
  v_source := pg_catalog.regexp_replace(
    coalesce(p_metadata ->> 'source', '자료'),
    '\.(pdf|hwpx?|pptx?|docx?)$',
    '',
    'i'
  );
  v_header := nullif(pg_catalog.btrim(p_metadata ->> 'Header 2'), '');
  v_page := p_metadata ->> 'page_num';

  -- 웹앱의 출처 라벨 정규화와 같은 OCR 교정 규칙을 사용한다.
  v_source := public.generated_material_normalize_ocr(v_source, v_source);
  v_source := pg_catalog.regexp_replace(v_source, '&lt;', '<', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&gt;', '>', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&amp;', '&', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&quot;', '"', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&#39;', '''', 'gi');
  v_source := pg_catalog.replace(pg_catalog.replace(v_source, '[', '('), ']', ')');
  v_source := pg_catalog.btrim(pg_catalog.regexp_replace(v_source, '[[:space:]]+', ' ', 'g'));

  if v_header is not null then
    v_header := public.generated_material_normalize_ocr(v_header, v_header);
    v_header := pg_catalog.regexp_replace(v_header, '&lt;', '<', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&gt;', '>', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&amp;', '&', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&quot;', '"', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&#39;', '''', 'gi');
    v_header := pg_catalog.replace(pg_catalog.replace(v_header, '[', '('), ']', ')');
    v_header := pg_catalog.btrim(pg_catalog.regexp_replace(v_header, '[[:space:]]+', ' ', 'g'));
  end if;

  v_label := case
    when v_header is not null and v_header is distinct from v_source
      then v_source || ' — ' || v_header
    else v_source
  end;
  if coalesce(v_page, '') ~ '^[0-9]+$' then
    v_label := v_label || ' p.' || coalesce(
      nullif(pg_catalog.ltrim(v_page, '0'), ''),
      '0'
    );
  end if;
  return '[' || v_label || ']';
end;
$$;

-- 계획서·교안·슬라이드의 출처 배지에 쓰이는 한 원소가 현재 신뢰 원본과 정확히
-- 일치하는지 공통 검사한다. 외부 RAG와 기본 documents/chunks 설치를 모두 지원한다.
create or replace function public.generated_material_source_provenance_valid(
  p_source jsonb,
  p_category text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.rag_rescue as rag
      where rag.is_active
        and rag.metadata ->> 'edu_category' = p_category
        and rag.metadata ->> 'document_id' ~ '^[0-9]+$'
        and coalesce(
          nullif(pg_catalog.ltrim(rag.metadata ->> 'document_id', '0'), ''),
          '0'
        ) = pg_catalog.trunc((p_source ->> 'document_id')::numeric)::text
        and (
          (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'null'
            and rag.metadata ->> 'page_num' is null
          )
          or (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
            and rag.metadata ->> 'page_num' ~ '^[0-9]+$'
            and coalesce(
              nullif(pg_catalog.ltrim(rag.metadata ->> 'page_num', '0'), ''),
              '0'
            ) = pg_catalog.trunc((p_source ->> 'page')::numeric)::text
          )
        )
        and public.generated_material_source_label(rag.metadata)
          = '[' || pg_catalog.btrim(p_source ->> 'doc') ||
            case when pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
              then ' p.' || pg_catalog.trunc((p_source ->> 'page')::numeric)::text
              else '' end || ']'
    )
    or exists (
      select 1
      from public.documents as document
      join public.chunks as chunk on chunk.document_id = document.id
      where document.id::numeric
          = pg_catalog.trunc((p_source ->> 'document_id')::numeric)
        and document.category = p_category
        and pg_catalog.btrim(document.title) = pg_catalog.btrim(p_source ->> 'doc')
        and document.status = 'processed'
        and (
          (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'null'
            and chunk.page_num is null
          )
          or (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
            and chunk.page_num::numeric = pg_catalog.trunc((p_source ->> 'page')::numeric)
          )
        )
    );
$$;

create or replace function public.generated_material_focus_terms(
  p_topic text,
  p_focus text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_token text;
  v_terms text[] := '{}'::text[];
  v_stop text[] := array[
    '개요', '관련', '교육', '구조', '매뉴얼', '방법', '분야', '사고', '안전',
    '운용', '자료', '작업', '장비', '절차', '점검', '준비물', '평가',
    '표준작전절차', '현장', '훈련', '대비', '대응', '상위', '주제', '산악',
    '수난', '화재', '구급', '산악사고', '수난사고', '화재사고', '구조활동',
    '현장활동'
  ]::text[];
begin
  for v_token in
    select value
    from pg_catalog.regexp_split_to_table(
      pg_catalog.regexp_replace(
        coalesce(p_focus, '') || ' ' || coalesce(p_topic, ''),
        '[^0-9a-zA-Z가-힣]+',
        ' ',
        'g'
      ),
      '[[:space:]]+'
    ) as token(value)
  loop
    v_token := pg_catalog.lower(pg_catalog.btrim(v_token));
    v_token := pg_catalog.regexp_replace(
      v_token,
      '(으로|에서|에게|부터|까지|과|와|을|를|은|는|이|가|의)$',
      ''
    );
    v_token := pg_catalog.regexp_replace(
      v_token,
      '(관련|대비|대응|교육|훈련|방법|절차)$',
      ''
    );
    if pg_catalog.char_length(v_token) >= 2
      and not (v_token = any(v_stop))
      and not (v_token = any(v_terms)) then
      v_terms := pg_catalog.array_append(v_terms, v_token);
      exit when coalesce(pg_catalog.array_length(v_terms, 1), 0) >= 12;
    end if;
  end loop;
  return v_terms;
end;
$$;

create or replace function public.generated_material_rag_row_supports(
  p_content text,
  p_metadata jsonb,
  p_terms text[]
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_term text;
  v_compact_term text;
  v_page_raw text;
  v_source_raw text;
  v_page_text text;
  v_source_text text;
  v_page_matches integer := 0;
  v_all_matches integer := 0;
  v_required integer;
begin
  if coalesce(pg_catalog.array_length(p_terms, 1), 0) = 0 then
    return false;
  end if;
  v_page_raw :=
    coalesce(p_metadata ->> 'Header 2', '') || ' ' ||
    coalesce(p_content, '');
  v_source_raw := coalesce(p_metadata ->> 'source', '');
  v_page_raw := public.generated_material_normalize_ocr(v_page_raw, '');
  v_source_raw := public.generated_material_normalize_ocr(v_source_raw, '');
  v_page_text := public.generated_material_compact_text(v_page_raw);
  v_source_text := public.generated_material_compact_text(v_source_raw);

  foreach v_term in array p_terms loop
    v_compact_term := public.generated_material_compact_text(v_term);
    if pg_catalog.char_length(v_compact_term) < 2 then
      continue;
    end if;
    if position(v_compact_term in v_page_text) > 0 then
      v_page_matches := v_page_matches + 1;
      v_all_matches := v_all_matches + 1;
    elsif position(v_compact_term in v_source_text) > 0 then
      v_all_matches := v_all_matches + 1;
    end if;
  end loop;

  v_required := least(2, pg_catalog.array_length(p_terms, 1));
  return v_page_matches >= 1 and v_all_matches >= v_required;
end;
$$;

create or replace function public.generated_material_share_contract_valid(
  p_kind text,
  p_category text,
  p_audience text,
  p_duration text,
  p_topic text,
  p_title text,
  p_content jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_labels text[] := '{}'::text[];
  v_terms text[];
  v_matching_labels text[] := '{}'::text[];
  v_target_heading text;
  v_target_count integer := 0;
  v_designated text := '';
  v_all_text text := '';
  v_chunks text[] := '{}'::text[];
  v_refs_by_chunk text[] := '{}'::text[];
  v_chunk text;
  v_chunk_index integer;
  v_item jsonb;
  v_bullets text;
  v_refs text;
  v_visual jsonb;
  v_visual_mode text;
  v_label text;
  v_ref text;
  v_match text[];
  v_has_label boolean;
  v_grounded_application boolean := false;
  v_disclosure text;
  v_claim_text text;
  v_cue text := '(SOP|표준[[:space:]]*(작전)?[[:space:]]*절차|현장[[:space:]]*(활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
  v_cue_nocapture text := '(?:SOP|표준[[:space:]]*(?:작전)?[[:space:]]*절차|현장[[:space:]]*(?:활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
  v_number_claim text;
  v_named_claim text;
  v_quoted_named_claim text;
  v_procedure_claim text;
  v_number_capture text;
  v_named_capture text;
  v_quoted_named_capture text;
  v_claim_value text;
  v_claim_supported boolean;
begin
  if p_kind not in ('plan', 'lesson', 'slides', 'notebooklm')
    or pg_catalog.jsonb_typeof(p_content) is distinct from 'object'
    or nullif(pg_catalog.btrim(p_title), '') is null
    or pg_catalog.char_length(p_title) > 200
    or pg_catalog.pg_column_size(p_content) > 262144
    or pg_catalog.octet_length(p_content::text) > 131072 then
    return false;
  end if;

  -- API 저장 계약과 같은 메타데이터 상한을 모든 공유 유형에 적용한다.
  -- NotebookLM도 선택 메타데이터를 저장할 수 있으므로 조기 반환 전에 검사한다.
  if coalesce(pg_catalog.char_length(p_category), 0) > 100
    or coalesce(pg_catalog.char_length(p_audience), 0) > 50
    or coalesce(pg_catalog.char_length(p_duration), 0) > 20
    or coalesce(pg_catalog.char_length(p_topic), 0) > 100 then
    return false;
  end if;

  -- 과거 NotebookLM 프롬프트는 공식 훈련 문서가 아니므로 기존 공유 호환만 유지한다.
  if p_kind = 'notebooklm' then
    return pg_catalog.jsonb_typeof(p_content -> 'prompt') = 'string'
      and coalesce(pg_catalog.char_length(pg_catalog.btrim(p_content ->> 'prompt')), 0)
      between 10 and 100000;
  end if;

  if nullif(pg_catalog.btrim(p_category), '') is null
    or nullif(pg_catalog.btrim(p_audience), '') is null
    or nullif(pg_catalog.btrim(p_duration), '') is null
    or nullif(pg_catalog.btrim(p_topic), '') is null
    or pg_catalog.jsonb_typeof(p_content -> 'sopEvidence') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_content #> '{sopEvidence,sourceLabels}') is distinct from 'array' then
    return false;
  end if;

  v_status := p_content #>> '{sopEvidence,status}';
  if v_status is null or v_status not in ('found', 'not_found', 'degraded') then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(p_content #> '{sopEvidence,sourceLabels}') > 20
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        p_content #> '{sopEvidence,sourceLabels}'
      ) as label(value)
      where pg_catalog.jsonb_typeof(label.value) is distinct from 'string'
    ) then
    return false;
  end if;
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.btrim(item.value)), '{}'::text[])
  into v_labels
  from pg_catalog.jsonb_array_elements_text(
    p_content #> '{sopEvidence,sourceLabels}'
  ) as item(value)
  where nullif(pg_catalog.btrim(item.value), '') is not null;
  if exists (
    select 1
    from pg_catalog.unnest(v_labels) as label(value)
    where pg_catalog.char_length(label.value) > 300
  ) then
    return false;
  end if;

  -- DB가 정상적으로 실행 중인 공유 트랜잭션에서는 검색 장애 상태를 클라이언트가
  -- 스스로 주장할 수 없다. 검색 장애 초안은 저장만 하고 재생성 후 공유한다.
  if v_status = 'degraded' then
    return false;
  end if;

  -- 계획서·교안은 구형 저장본 호환을 위해 sources 생략을 빈 배열로 보되, 값이 있으면
  -- 슬라이드와 같은 구조·분량·실제 원본 계약을 적용한다. 슬라이드는 API 계약상 배열이 필수다.
  if p_kind = 'slides'
    and pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array' then
    return false;
  end if;
  if p_content ? 'sources'
    and pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array' then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(
    case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
      then p_content -> 'sources' else '[]'::jsonb end
  ) > 80 then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
        then p_content -> 'sources' else '[]'::jsonb end
    ) as source(value)
    where pg_catalog.jsonb_typeof(source.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(source.value -> 'doc') is distinct from 'string'
      or pg_catalog.char_length(
        pg_catalog.btrim(coalesce(source.value ->> 'doc', ''))
      ) not between 1 and 300
      or case
        when pg_catalog.jsonb_typeof(source.value -> 'document_id') = 'number' then
          (source.value ->> 'document_id')::numeric
            <> pg_catalog.trunc((source.value ->> 'document_id')::numeric)
          or (source.value ->> 'document_id')::numeric
            not between 1 and 9007199254740991
        else true
      end
      or not (source.value ? 'page')
      or case
        when pg_catalog.jsonb_typeof(source.value -> 'page') = 'null' then false
        when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number' then
          (source.value ->> 'page')::numeric
            <> pg_catalog.trunc((source.value ->> 'page')::numeric)
          or (source.value ->> 'page')::numeric
            not between 1 and 9007199254740991
        else true
      end
  ) then
    return false;
  end if;

  -- 출처 배지·PPTX 근거자료 부록에는 visual에서 쓰지 않은 sources도 노출된다.
  -- 모든 원소를 공통 provenance 함수로 검사해 coordinated tamper도 차단한다.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
        then p_content -> 'sources' else '[]'::jsonb end
    ) as source(value)
    where not public.generated_material_source_provenance_valid(source.value, p_category)
  ) then
    return false;
  end if;

  if p_kind in ('plan', 'lesson') then
    if pg_catalog.jsonb_typeof(p_content -> 'sections') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_content -> 'sections') not between 1 and 8 then
      return false;
    end if;
    v_target_heading := case when p_kind = 'plan' then '훈련내용' else '핵심이론' end;
    for v_item in select value from pg_catalog.jsonb_array_elements(p_content -> 'sections') as section(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'heading') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_item -> 'content') is distinct from 'string'
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'heading', ''))) not between 1 and 200
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'content', ''))) not between 1 and 20000 then
        return false;
      end if;
      v_chunk := coalesce(v_item ->> 'heading', '') || E'\n' ||
        coalesce(v_item ->> 'content', '');
      v_chunks := pg_catalog.array_append(v_chunks, v_chunk);
      v_refs_by_chunk := pg_catalog.array_append(v_refs_by_chunk, '');
      v_all_text := v_all_text || E'\n' || v_chunk;
      if pg_catalog.btrim(v_item ->> 'heading') = v_target_heading then
        v_target_count := v_target_count + 1;
        if v_target_count = 1 then
          v_designated := coalesce(v_item ->> 'content', '');
        end if;
      end if;
    end loop;
    -- JS 계약은 첫 지정 섹션을 사용한다. 중복 제목을 허용하면 DB와 앱이 서로 다른
    -- 섹션을 검사할 수 있으므로 공식 공유본에서는 정확히 한 개만 인정한다.
    if v_target_count <> 1 or v_designated = '' then
      return false;
    end if;
  else
    if pg_catalog.jsonb_typeof(p_content -> 'slides') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_content -> 'slides') not between 1 and 20 then
      return false;
    end if;
    for v_item in select value from pg_catalog.jsonb_array_elements(p_content -> 'slides') as slide(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'title') is distinct from 'string'
        or (
          v_item ? 'notes'
          and pg_catalog.jsonb_typeof(v_item -> 'notes') is distinct from 'string'
        )
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'title', ''))) not between 1 and 200
        or pg_catalog.char_length(coalesce(v_item ->> 'notes', '')) > 30000
        or pg_catalog.jsonb_typeof(v_item -> 'bullets') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_item -> 'bullets') not between 1 and 4
        or (
          v_item ? 'steps'
          and (
            pg_catalog.jsonb_typeof(v_item -> 'steps') is distinct from 'array'
            or pg_catalog.jsonb_array_length(v_item -> 'steps') > 5
          )
        )
        or (
          v_item ? 'sourceRefs'
          and (
            pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') is distinct from 'array'
            or pg_catalog.jsonb_array_length(v_item -> 'sourceRefs') > 4
          )
        ) then
        return false;
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_item -> 'bullets') as bullet(value)
        where pg_catalog.jsonb_typeof(bullet.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(bullet.value #>> '{}')) not between 1 and 500
      ) or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(v_item -> 'steps') = 'array'
            then v_item -> 'steps' else '[]'::jsonb end
        ) as step(value)
        where pg_catalog.jsonb_typeof(step.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(step.value #>> '{}')) not between 1 and 100
      ) or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
            then v_item -> 'sourceRefs' else '[]'::jsonb end
        ) as ref(value)
        where pg_catalog.jsonb_typeof(ref.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(ref.value #>> '{}')) not between 1 and 300
      ) then
        return false;
      end if;

      if v_item ? 'visual' then
        v_visual := v_item -> 'visual';
        v_visual_mode := v_visual ->> 'mode';
        if pg_catalog.jsonb_typeof(v_visual) is distinct from 'object'
          or pg_catalog.jsonb_typeof(v_visual -> 'mode') is distinct from 'string'
          or v_visual_mode not in ('source-page', 'source-crop', 'native-diagram', 'none')
          or (
            v_visual ? 'documentId'
            and case
              when pg_catalog.jsonb_typeof(v_visual -> 'documentId') = 'number' then
                (v_visual ->> 'documentId')::numeric
                  <> pg_catalog.trunc((v_visual ->> 'documentId')::numeric)
                or (v_visual ->> 'documentId')::numeric
                  not between 1 and 9007199254740991
              else true
            end
          )
          or (
            v_visual ? 'page'
            and case
              when pg_catalog.jsonb_typeof(v_visual -> 'page') = 'number' then
                (v_visual ->> 'page')::numeric
                  <> pg_catalog.trunc((v_visual ->> 'page')::numeric)
                or (v_visual ->> 'page')::numeric
                  not between 1 and 9007199254740991
              else true
            end
          )
          or (
            v_visual ? 'sourceRef'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'sourceRef') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'sourceRef', ''))
              ) not between 1 and 300
            )
          )
          or (
            v_visual ? 'altText'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'altText') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'altText', ''))
              ) not between 1 and 300
            )
          )
          or (
            v_visual ? 'caption'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'caption') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'caption', ''))
              ) not between 1 and 200
            )
          )
          or (
            v_visual ? 'fit'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'fit') is distinct from 'string'
              or v_visual ->> 'fit' not in ('contain', 'cover')
            )
          ) then
          return false;
        end if;

        if v_visual_mode in ('source-page', 'source-crop') then
          if not (v_visual ? 'documentId')
            or not (v_visual ? 'page')
            or not (v_visual ? 'sourceRef') then
            return false;
          end if;
          if not exists (
            select 1
            from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
            where (source.value ->> 'document_id')::numeric
                = (v_visual ->> 'documentId')::numeric
              and pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
              and (source.value ->> 'page')::numeric
                = (v_visual ->> 'page')::numeric
              and '[' || pg_catalog.btrim(source.value ->> 'doc') ||
                ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text || ']'
                = pg_catalog.btrim(v_visual ->> 'sourceRef')
          ) then
            return false;
          end if;
        end if;
      else
        v_visual := null;
        v_visual_mode := null;
      end if;

      select coalesce(pg_catalog.string_agg(value, E'\n'), '')
      into v_bullets
      from pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(v_item -> 'bullets') = 'array'
          then v_item -> 'bullets' else '[]'::jsonb end
      ) as bullet(value);
      select coalesce(pg_catalog.string_agg(value, E'\n'), '')
      into v_refs
      from pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
          then v_item -> 'sourceRefs' else '[]'::jsonb end
      ) as ref(value);
      -- sourceRefs는 화면 본문이 아니라 인용 목록이다. JS와 같이 각 값을 별도로
      -- 검증한다. SOP 라벨은 확인된 SOP 목록, 그 외 라벨은 위에서 실제 RAG와
      -- 대조한 content.sources 중 하나와 정확히 일치해야 한다.
      for v_ref in
        select pg_catalog.btrim(value)
        from pg_catalog.jsonb_array_elements_text(
          case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
            then v_item -> 'sourceRefs' else '[]'::jsonb end
        ) as ref(value)
      loop
        if not (v_ref = any(v_labels))
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
            where '[' || pg_catalog.btrim(source.value ->> 'doc') ||
              case when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
                then ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text
                else '' end || ']'
                = v_ref
          ) then
          return false;
        end if;
      end loop;
      v_chunk := coalesce(v_item ->> 'title', '') || E'\n' ||
        v_bullets || E'\n' || coalesce(v_item ->> 'notes', '');
      v_chunks := pg_catalog.array_append(v_chunks, v_chunk);
      v_refs_by_chunk := pg_catalog.array_append(v_refs_by_chunk, v_refs);
      v_all_text := v_all_text || E'\n' || v_chunk;
    end loop;
    if coalesce(pg_catalog.array_length(v_chunks, 1), 0) = 0 then
      return false;
    end if;
  end if;

  v_number_claim := v_cue || '[[:space:]]*(제[[:space:]]*)?[-–—:#]?[[:space:]]*[0-9]{1,4}([[:space:]]*호)?';
  v_named_claim := v_cue || '[[:space:]]*[:：][[:space:]]*[^[:space:].,;!?][^\n.!?]{1,80}';
  v_quoted_named_claim := '[「『“"]{1}[^」』”"\n]{2,80}[」』”"]{1}[[:space:]]*' || v_cue;
  v_procedure_claim := v_cue || '(에|에서는|상|를|을)?[[:space:]]*(따라|따르면|근거로|기준으로|규정상|반드시|우선|금지|허용|실시|시행|수행|해야|한다)';
  v_number_capture := v_cue_nocapture || '[[:space:]]*(?:제[[:space:]]*)?[-–—:#]?[[:space:]]*([0-9]{1,4})(?:[[:space:]]*호)?';
  v_named_capture := v_cue_nocapture || '[[:space:]]*[:：][[:space:]]*([^\n.!?]{2,80})';
  v_quoted_named_capture := '[「『“"]{1}([^」』”"\n]{2,80})[」』”"]{1}[[:space:]]*' || v_cue_nocapture;

  v_terms := public.generated_material_focus_terms(p_topic, p_content ->> 'focus');
  select coalesce(
    pg_catalog.array_agg(distinct public.generated_material_source_label(rag.metadata)),
    '{}'::text[]
  )
  into v_matching_labels
  from public.rag_rescue as rag
  where rag.is_active
    and rag.metadata ->> 'edu_category' = p_category
    and rag.metadata ->> 'document_type' in ('sop', 'operational_guidance')
    and public.generated_material_rag_row_supports(rag.content, rag.metadata, v_terms);

  if v_status = 'found' then
    if coalesce(pg_catalog.array_length(v_labels, 1), 0) = 0 then
      return false;
    end if;
    if coalesce(pg_catalog.array_length(v_matching_labels, 1), 0) = 0 then
      return false;
    end if;

    -- 클라이언트가 적은 모든 SOP 라벨은 같은 분야의 활성 SOP/현장지침 페이지와 정확히
    -- 일치하고, 파일명뿐 아니라 그 페이지 제목/본문에서도 현재 주제가 확인되어야 한다.
    foreach v_label in array v_labels loop
      if not (v_label = any(v_matching_labels)) then
        return false;
      end if;
    end loop;

    if p_kind in ('plan', 'lesson') then
      if position('[관련 SOP 적용]' in v_designated) > 0 then
        foreach v_label in array v_labels loop
          if position(v_label in v_designated) > 0 then
            v_grounded_application := true;
            exit;
          end if;
        end loop;
      end if;
    else
      for v_chunk_index in 1..pg_catalog.array_length(v_chunks, 1) loop
        v_chunk := v_chunks[v_chunk_index];
        v_refs := coalesce(v_refs_by_chunk[v_chunk_index], '');
        if position('[관련 SOP 적용]' in v_chunk) = 0 then
          continue;
        end if;
        foreach v_label in array v_labels loop
          if position(v_label in v_chunk) > 0
            or position(v_label in v_refs) > 0 then
            v_grounded_application := true;
            exit;
          end if;
        end loop;
        exit when v_grounded_application;
      end loop;
    end if;
    if not v_grounded_application then
      return false;
    end if;
  else
    if coalesce(pg_catalog.array_length(v_labels, 1), 0) <> 0 then
      return false;
    end if;
    if coalesce(pg_catalog.array_length(v_matching_labels, 1), 0) <> 0 then
      return false;
    end if;
    v_disclosure :=
      '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.';
    if p_kind in ('plan', 'lesson') then
      if position(v_disclosure in v_designated) = 0 then
        return false;
      end if;
    elsif position(v_disclosure in v_all_text) = 0 then
      return false;
    end if;
  end if;

  -- 허용 목록에 없는 SOP/현장지침 대괄호 출처를 공유본에 넣지 못하게 한다.
  for v_match in
    select pg_catalog.regexp_matches(v_all_text, '(\[[^]]{2,}\])', 'g')
  loop
    v_ref := v_match[1];
    if v_ref = '[관련 SOP 적용]' then
      continue;
    end if;
    if v_ref ~* v_cue and not (v_ref = any(v_labels)) then
      return false;
    end if;
  end loop;

  if v_status in ('not_found', 'degraded') then
    v_claim_text := pg_catalog.replace(v_all_text, v_disclosure, ' ');
    v_claim_text := pg_catalog.replace(v_claim_text, '[관련 SOP 적용]', ' ');
    v_claim_text := pg_catalog.regexp_replace(v_claim_text, '\[[^]]+\]', ' ', 'g');
    if v_claim_text ~* v_number_claim
      or v_claim_text ~* v_named_claim
      or v_claim_text ~* v_quoted_named_claim
      or v_claim_text ~* v_procedure_claim then
      return false;
    end if;
  else
    -- 확인된 상태에서도 SOP 절차·번호·명칭을 단정한 섹션/슬라이드에는 같은 위치의
    -- 확인된 출처 라벨이 필요하다.
    for v_chunk_index in 1..pg_catalog.array_length(v_chunks, 1) loop
      v_chunk := v_chunks[v_chunk_index];
      v_refs := coalesce(v_refs_by_chunk[v_chunk_index], '');
      v_claim_text := pg_catalog.regexp_replace(v_chunk, '\[[^]]+\]', ' ', 'g');
      if not (
        v_claim_text ~* v_number_claim
        or v_claim_text ~* v_named_claim
        or v_claim_text ~* v_quoted_named_claim
        or v_claim_text ~* v_procedure_claim
      ) then
        continue;
      end if;
      v_has_label := false;
      foreach v_label in array v_labels loop
        if position(v_label in v_chunk) > 0
          or position(v_label in v_refs) > 0 then
          v_has_label := true;
          exit;
        end if;
      end loop;
      if not v_has_label then
        return false;
      end if;

      -- 같은 위치에 실제 라벨이 있어도 그 라벨에 없는 SOP 번호·명칭을 붙이면 거절한다.
      for v_match in select pg_catalog.regexp_matches(v_claim_text, v_number_capture, 'gi')
      loop
        v_claim_value := v_match[1];
        v_claim_supported := false;
        foreach v_label in array v_labels loop
          if position(public.generated_material_compact_text(v_claim_value)
            in public.generated_material_compact_text(v_label)) > 0 then
            v_claim_supported := true;
            exit;
          end if;
        end loop;
        if not v_claim_supported then
          return false;
        end if;
      end loop;

      for v_match in
        select pg_catalog.regexp_matches(v_claim_text, v_named_capture, 'gi')
        union all
        select pg_catalog.regexp_matches(v_claim_text, v_quoted_named_capture, 'gi')
      loop
        v_claim_value := v_match[1];
        if pg_catalog.char_length(public.generated_material_compact_text(v_claim_value)) < 2 then
          continue;
        end if;
        v_claim_supported := false;
        foreach v_label in array v_labels loop
          if position(public.generated_material_compact_text(v_claim_value)
            in public.generated_material_compact_text(v_label)) > 0 then
            v_claim_supported := true;
            exit;
          end if;
        end loop;
        if not v_claim_supported then
          return false;
        end if;
      end loop;
    end loop;
  end if;

  return true;
end;
$$;

-- 행 잠금을 얻은 뒤 advisory lock을 기다리면, 코퍼스 전환 트랜잭션의
-- exclusive advisory lock → generated_materials UPDATE 순서와 교착될 수 있다.
-- statement trigger에서 먼저 shared lock을 잡아 모든 생성물 DML의 잠금 순서를 고정한다.
create or replace function public.lock_generated_material_share_validation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );
  return null;
end;
$$;

create or replace function public.enforce_generated_material_share_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shared then
    if not public.generated_material_share_contract_valid(
      new.kind,
      new.category,
      new.audience,
      new.duration,
      new.topic,
      new.title,
      new.content
    ) then
      raise exception 'generated_material_share_contract_invalid'
        using errcode = '23514',
              hint = 'Regenerate or repair the SOP evidence contract before sharing.';
    end if;

    -- 작성자 표시는 클라이언트 입력을 신뢰하지 않고 본인 프로필에서 다시 계산한다.
    select coalesce(
      nullif(pg_catalog.btrim(profile.full_name), ''),
      nullif(pg_catalog.split_part(profile.email, '@', 1), ''),
      '구조대원'
    )
    into new.author_name
    from public.profiles as profile
    where profile.id = new.user_id;
    new.author_name := coalesce(new.author_name, '구조대원');
  else
    new.author_name := null;
  end if;
  return new;
end;
$$;

-- 외부·기본 코퍼스 변경은 같은 exclusive advisory lock과 공유 해제 경로를 사용한다.
create or replace function public.invalidate_generated_material_shares_for_corpus_change()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );
  update public.generated_materials
  set shared = false,
      author_name = null
  where shared
    and kind <> 'notebooklm';
end;
$$;

-- 활성 RAG 집합이 바뀌면 기존 found뿐 아니라 not_found 판단도 더 이상 최신이 아니다.
-- transition table을 쓰는 statement trigger로 bulk 전환 한 번당 공유 해제 UPDATE도 한 번만 실행한다.
create or replace function public.unshare_generated_materials_on_rag_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_corpus_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    select exists (
      select 1 from new_rag_rows where is_active
    ) into v_active_corpus_changed;
  elsif tg_op = 'DELETE' then
    select exists (
      select 1 from old_rag_rows where is_active
    ) into v_active_corpus_changed;
  elsif tg_op = 'TRUNCATE' then
    -- BEFORE TRUNCATE에서는 transition table을 쓸 수 없으므로 삭제 전 활성 행을 확인한다.
    select exists (
      select 1 from public.rag_rescue where is_active
    ) into v_active_corpus_changed;
  elsif tg_op = 'UPDATE' then
    select exists (
      select 1
      from old_rag_rows as old_row
      full join new_rag_rows as new_row on new_row.id = old_row.id
      where (
        coalesce(old_row.is_active, false)
        or coalesce(new_row.is_active, false)
      )
        and (
          old_row.id is null
          or new_row.id is null
          or old_row.is_active is distinct from new_row.is_active
          or old_row.content is distinct from new_row.content
          or old_row.metadata is distinct from new_row.metadata
        )
    ) into v_active_corpus_changed;
  end if;

  if v_active_corpus_changed then
    perform public.invalidate_generated_material_shares_for_corpus_change();
  end if;
  return null;
end;
$$;

-- 기본 documents/chunks의 INSERT는 기존 exact provenance를 바꾸지 않으므로 공유를
-- 유지한다. UPDATE/DELETE/TRUNCATE는 제목·분야·상태·페이지·본문 등 근거가 달라질 수
-- 있어 statement당 한 번 보수적으로 모든 공식 공유를 해제한다.
create or replace function public.unshare_generated_materials_on_native_source_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_native_corpus_changed boolean := false;
begin
  if tg_op = 'UPDATE' then
    select exists (select 1 from new_native_rows)
    into v_native_corpus_changed;
  elsif tg_op = 'DELETE' then
    select exists (select 1 from old_native_rows)
    into v_native_corpus_changed;
  elsif tg_op = 'TRUNCATE' then
    if tg_table_name = 'documents' then
      select exists (select 1 from public.documents)
      into v_native_corpus_changed;
    elsif tg_table_name = 'chunks' then
      select exists (select 1 from public.chunks)
      into v_native_corpus_changed;
    end if;
  end if;

  if v_native_corpus_changed then
    perform public.invalidate_generated_material_shares_for_corpus_change();
  end if;
  return null;
end;
$$;

revoke all on function public.generated_material_normalize_ocr(text, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_compact_text(text)
  from public, anon, authenticated;
revoke all on function public.generated_material_source_label(jsonb)
  from public, anon, authenticated;
revoke all on function public.generated_material_source_provenance_valid(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_focus_terms(text, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_rag_row_supports(text, jsonb, text[])
  from public, anon, authenticated;
revoke all on function public.generated_material_share_contract_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.lock_generated_material_share_validation()
  from public, anon, authenticated;
revoke all on function public.enforce_generated_material_share_contract()
  from public, anon, authenticated;
revoke all on function public.invalidate_generated_material_shares_for_corpus_change()
  from public, anon, authenticated;
revoke all on function public.unshare_generated_materials_on_rag_change()
  from public, anon, authenticated;
revoke all on function public.unshare_generated_materials_on_native_source_change()
  from public, anon, authenticated;

-- 구형 공식 자료는 새 트리거 이전에 모두 비공개로 되돌린다. 분류 마이그레이션보다
-- 먼저 적용되는 환경에서도 fabricated/stale evidence가 공개 상태로 남지 않게 하는 보수적 조치다.
-- 본문은 삭제하지 않으며 사용자가 재생성·검증한 뒤 다시 공유할 수 있다.
update public.generated_materials
set shared = false,
    author_name = null
where shared
  and kind <> 'notebooklm';

-- NotebookLM은 기존 공유 호환을 유지하되, Data API로 넣은 비문자·과대 프롬프트까지
-- 공개 상태로 남기지는 않는다.
update public.generated_materials
set shared = false,
    author_name = null
where shared
  and kind = 'notebooklm'
  and (
    pg_catalog.jsonb_typeof(content) is distinct from 'object'
    or pg_catalog.jsonb_typeof(content -> 'prompt') is distinct from 'string'
    or coalesce(pg_catalog.char_length(pg_catalog.btrim(content ->> 'prompt')), 0)
      not between 10 and 100000
    or pg_catalog.char_length(title) > 200
    or coalesce(pg_catalog.char_length(category), 0) > 100
    or coalesce(pg_catalog.char_length(audience), 0) > 50
    or coalesce(pg_catalog.char_length(duration), 0) > 20
    or coalesce(pg_catalog.char_length(topic), 0) > 100
    or pg_catalog.pg_column_size(content) > 262144
    or pg_catalog.octet_length(content::text) > 131072
  );

drop trigger if exists lock_generated_material_share_validation
  on public.generated_materials;
create trigger lock_generated_material_share_validation
before insert or update of
  kind, category, audience, duration, topic, title, content, shared, author_name
on public.generated_materials
for each statement execute function public.lock_generated_material_share_validation();

drop trigger if exists enforce_generated_material_share_contract
  on public.generated_materials;
create trigger enforce_generated_material_share_contract
before insert or update of
  kind, category, audience, duration, topic, title, content, shared, author_name
on public.generated_materials
for each row execute function public.enforce_generated_material_share_contract();

drop trigger if exists unshare_generated_materials_on_rag_insert
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_insert
after insert on public.rag_rescue
referencing new table as new_rag_rows
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_rag_delete
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_delete
after delete on public.rag_rescue
referencing old table as old_rag_rows
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_rag_truncate
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_truncate
before truncate on public.rag_rescue
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_rag_update
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_update
after update on public.rag_rescue
referencing old table as old_rag_rows new table as new_rag_rows
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_documents_update
  on public.documents;
create trigger unshare_generated_materials_on_documents_update
after update on public.documents
referencing old table as old_native_rows new table as new_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_documents_delete
  on public.documents;
create trigger unshare_generated_materials_on_documents_delete
after delete on public.documents
referencing old table as old_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_documents_truncate
  on public.documents;
create trigger unshare_generated_materials_on_documents_truncate
before truncate on public.documents
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_chunks_update
  on public.chunks;
create trigger unshare_generated_materials_on_chunks_update
after update on public.chunks
referencing old table as old_native_rows new table as new_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_chunks_delete
  on public.chunks;
create trigger unshare_generated_materials_on_chunks_delete
after delete on public.chunks
referencing old table as old_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_chunks_truncate
  on public.chunks;
create trigger unshare_generated_materials_on_chunks_truncate
before truncate on public.chunks
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

-- 기존 FOR ALL 정책을 작업별 정책으로 나눠 쓰기 의도를 명시한다. 소유권은 RLS가,
-- shared=true 본문의 안전 계약은 위 트리거가 모든 Data API 경로에서 함께 강제한다.
drop policy if exists "own generated_materials" on public.generated_materials;
drop policy if exists generated_materials_owner_select on public.generated_materials;
drop policy if exists generated_materials_owner_insert on public.generated_materials;
drop policy if exists generated_materials_owner_update on public.generated_materials;
drop policy if exists generated_materials_owner_delete on public.generated_materials;

create policy generated_materials_owner_select
on public.generated_materials
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy generated_materials_owner_insert
on public.generated_materials
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy generated_materials_owner_update
on public.generated_materials
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy generated_materials_owner_delete
on public.generated_materials
for delete
to authenticated
using ((select auth.uid()) = user_id);
