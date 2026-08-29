-- 요청 분야의 절차 자료와 전 분야 공통 SOP를 같은 생성·저장·공유 계약으로 검증한다.
-- 일반 교육자료는 요청 분야가 정확히 일치할 때만 허용하고, 현장지휘·공통 범위에서는
-- 관리자가 SOP 또는 현장지침으로 분류한 활성 RAG 행만 허용한다.

create or replace function public.generated_material_rag_scope_valid(
  p_metadata jsonb,
  p_category text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    p_metadata ->> 'edu_category' = p_category
    or (
      p_metadata ->> 'edu_category' = '현장지휘·공통'
      and p_metadata ->> 'document_type' in ('sop', 'operational_guidance')
    );
$$;

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
        and public.generated_material_rag_scope_valid(rag.metadata, p_category)
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
  v_quoted_named_capture text;
  v_quoted_named_capture_after text;
  v_claim_value text;
  v_claim_supported boolean;
  v_label_match text[];
  v_claim_number text;
  v_label_number text;
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
  v_quoted_named_capture := '[「『“"]{1}([^」』”"\n]{2,80})[」』”"]{1}[[:space:]]*' || v_cue_nocapture;
  v_quoted_named_capture_after := v_cue_nocapture || '[[:space:]]*(?:[:：][[:space:]]*)?[「『“"]{1}([^」』”"\n]{2,80})[」』”"]{1}';

  v_terms := public.generated_material_focus_terms(p_topic, p_content ->> 'focus');
  select coalesce(
    pg_catalog.array_agg(distinct public.generated_material_source_label(rag.metadata)),
    '{}'::text[]
  )
  into v_matching_labels
  from public.rag_rescue as rag
  where rag.is_active
    and public.generated_material_rag_scope_valid(rag.metadata, p_category)
    and rag.metadata ->> 'document_type' in ('sop', 'operational_guidance')
    and public.generated_material_rag_row_supports(rag.content, rag.metadata, v_terms);

  if v_status = 'found' then
    if coalesce(pg_catalog.array_length(v_labels, 1), 0) = 0 then
      return false;
    end if;
    if coalesce(pg_catalog.array_length(v_matching_labels, 1), 0) = 0 then
      return false;
    end if;

    -- 클라이언트가 적은 모든 SOP 라벨은 요청 분야 또는 현장지휘·공통 범위의 활성
    -- SOP/현장지침 페이지와 정확히 일치하고, 그 페이지 제목/본문에서 주제가 확인돼야 한다.
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
        v_claim_number := coalesce(
          nullif(pg_catalog.ltrim(v_match[1], '0'), ''),
          '0'
        );
        v_claim_supported := false;
        foreach v_label in array v_labels loop
          for v_label_match in
            select pg_catalog.regexp_matches(v_label, v_number_capture, 'gi')
          loop
            v_label_number := coalesce(
              nullif(pg_catalog.ltrim(v_label_match[1], '0'), ''),
              '0'
            );
            if v_label_number = v_claim_number then
              v_claim_supported := true;
              exit;
            end if;
          end loop;
          exit when v_claim_supported;
        end loop;
        if not v_claim_supported then
          return false;
        end if;
      end loop;

      -- 콜론 뒤 일반 설명문은 고유명으로 보지 않는다. 따옴표로 명시한 명칭만
      -- 양방향(`“명칭” SOP`, `SOP: “명칭”`)으로 추출해 라벨과 비교한다.
      for v_match in
        select pg_catalog.regexp_matches(v_claim_text, v_quoted_named_capture, 'gi')
        union all
        select pg_catalog.regexp_matches(v_claim_text, v_quoted_named_capture_after, 'gi')
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

revoke all on function public.generated_material_rag_scope_valid(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_source_provenance_valid(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_share_contract_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;

-- 공통 SOP가 이미 존재하는 상태에서 과거의 분야 일치 전용 계약으로 공유된 자료는
-- 새 계약상 not_found/found 판단이 달라질 수 있다. 본문은 보존하고 공유 상태만 내려
-- 사용자가 현재 근거로 다시 저장·검증한 뒤 공유하게 한다.
-- 기존 공유 DML의 shared advisory lock과 같은 키를 exclusive로 획득한다. 진행 중인
-- 구형 계약 공유가 끝난 뒤 아래 UPDATE가 보게 하고, 커밋 전에는 새 공유가 들어오지 못하게 한다.
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
);

update public.generated_materials
set shared = false,
    author_name = null
where shared
  and kind <> 'notebooklm';
