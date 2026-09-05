-- 훈련계획·교안의 본문 출처를 말미 목록으로 모으는 앱 계약에 DB 검사를 맞춘다.
-- 기존 문서 내용·공유 상태·소유권·revision·트리거는 바꾸지 않는다.
-- 실제 원본 provenance, 출처 목록 일치, SOP 활성/분야/주제 및 번호/명칭,
-- 시간·안전·평가·분량 검사와 슬라이드의 같은 장 출처 연결은 그대로 유지한다.
-- 두 함수는 기존 내부 트리거용 SECURITY DEFINER/빈 search_path를 유지하고,
-- 공개·익명·인증 사용자의 직접 실행 권한도 다시 차단한다.

create or replace function public.generated_material_core_quality_valid(
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
  v_expected_minutes integer;
  v_sections jsonb;
  v_slides jsonb;
  v_item jsonb;
  v_heading text;
  v_required_headings text[];
  v_designated_heading text;
  v_safety_heading text;
  v_evaluation_heading text;
  v_minimum_length integer;
  v_text text;
  v_safety_text text := '';
  v_evaluation_text text := '';
  v_designated_text text := '';
  v_all_text text := '';
  v_minutes integer;
  v_time_count integer := 0;
  v_time_total integer := 0;
  v_section_time_count integer;
  v_source_labels text[] := '{}'::text[];
  v_derived_labels text[] := '{}'::text[];
  v_sop_labels text[] := '{}'::text[];
  v_status text;
  v_reference text;
  v_reference_match text[];
  v_slide_count integer;
  v_slide_text text;
  v_visual jsonb;
  v_visual_mode text;
  v_has_safety boolean := false;
  v_has_evaluation boolean := false;
  v_disclosure text;
  v_cue text := '(SOP|표준[[:space:]]*(작전)?[[:space:]]*절차|현장[[:space:]]*(활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
begin
  if p_kind not in ('plan', 'lesson', 'slides', 'notebooklm')
    or pg_catalog.jsonb_typeof(p_content) is distinct from 'object'
    or nullif(pg_catalog.btrim(p_title), '') is null
    or pg_catalog.char_length(p_title) > 200
    or pg_catalog.pg_column_size(p_content) > 262144
    or pg_catalog.octet_length(p_content::text) > 131072
    or coalesce(pg_catalog.char_length(p_category), 0) > 100
    or coalesce(pg_catalog.char_length(p_audience), 0) > 50
    or coalesce(pg_catalog.char_length(p_duration), 0) > 20
    or coalesce(pg_catalog.char_length(p_topic), 0) > 100 then
    return false;
  end if;

  if p_kind = 'notebooklm' then
    return pg_catalog.jsonb_typeof(p_content -> 'prompt') = 'string'
      and coalesce(pg_catalog.char_length(pg_catalog.btrim(p_content ->> 'prompt')), 0)
        between 1 and 100000;
  end if;

  if nullif(pg_catalog.btrim(p_category), '') is null
    or nullif(pg_catalog.btrim(p_audience), '') is null
    or p_duration not in ('1시간', '2시간', '4시간')
    or nullif(pg_catalog.btrim(p_topic), '') is null then
    return false;
  end if;
  v_expected_minutes := case p_duration
    when '1시간' then 60
    when '2시간' then 120
    else 240
  end;

  -- 출처 라벨은 클라이언트가 임의로 적은 값이 아니라, 실제 같은 분야 원본에서
  -- 재구성한 sources의 정확한 라벨 집합과 일치해야 한다.
  if pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_content -> 'sources') not between 1 and 80
    or pg_catalog.jsonb_typeof(p_content -> 'sourceLabels') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_content -> 'sourceLabels') not between 1 and 80 then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
    where pg_catalog.jsonb_typeof(source.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(source.value -> 'document_id') is distinct from 'number'
      or pg_catalog.jsonb_typeof(source.value -> 'doc') is distinct from 'string'
      or not (source.value ? 'page')
      or not public.generated_material_source_provenance_valid(source.value, p_category)
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_content -> 'sourceLabels') as label(value)
    where pg_catalog.jsonb_typeof(label.value) is distinct from 'string'
      or pg_catalog.char_length(pg_catalog.btrim(label.value #>> '{}')) not between 2 and 300
  ) then
    return false;
  end if;
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.btrim(value)), '{}'::text[])
  into v_source_labels
  from pg_catalog.jsonb_array_elements_text(p_content -> 'sourceLabels') as label(value);
  select coalesce(
    pg_catalog.array_agg(
      distinct '[' || pg_catalog.btrim(source.value ->> 'doc') ||
        case when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
          then ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text
          else '' end || ']'
    ),
    '{}'::text[]
  )
  into v_derived_labels
  from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value);
  if not (v_source_labels @> v_derived_labels and v_source_labels <@ v_derived_labels) then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_content -> 'sopEvidence') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_content #> '{sopEvidence,sourceLabels}') is distinct from 'array' then
    return false;
  end if;
  v_status := p_content #>> '{sopEvidence,status}';
  if v_status not in ('found', 'not_found', 'degraded')
    or pg_catalog.jsonb_array_length(p_content #> '{sopEvidence,sourceLabels}') > 20
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_content #> '{sopEvidence,sourceLabels}') as label(value)
      where pg_catalog.jsonb_typeof(label.value) is distinct from 'string'
    ) then
    return false;
  end if;
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.btrim(value)), '{}'::text[])
  into v_sop_labels
  from pg_catalog.jsonb_array_elements_text(
    p_content #> '{sopEvidence,sourceLabels}'
  ) as label(value)
  where nullif(pg_catalog.btrim(value), '') is not null;
  if not (v_sop_labels <@ v_source_labels)
    or (v_status = 'found' and coalesce(pg_catalog.array_length(v_sop_labels, 1), 0) = 0)
    or (v_status in ('not_found', 'degraded') and coalesce(pg_catalog.array_length(v_sop_labels, 1), 0) <> 0) then
    return false;
  end if;

  if p_kind in ('plan', 'lesson') then
    v_sections := p_content -> 'sections';
    if pg_catalog.jsonb_typeof(v_sections) is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_sections) not between 1 and 8 then
      return false;
    end if;

    if p_kind = 'plan' then
      v_required_headings := array['훈련목표', '훈련내용', '필요장비', '안전관리', '훈련평가'];
      v_designated_heading := '훈련내용';
      v_safety_heading := '안전관리';
      v_evaluation_heading := '훈련평가';
    else
      v_required_headings := array['학습목표', '도입', '핵심이론', '교관시범', '대원실습', '안전유의사항', '정리·평가'];
      v_designated_heading := '핵심이론';
      v_safety_heading := '안전유의사항';
      v_evaluation_heading := '정리·평가';
    end if;

    foreach v_heading in array v_required_headings loop
      if (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(v_sections) as section(value)
        where pg_catalog.btrim(section.value ->> 'heading') = v_heading
      ) <> 1 then
        return false;
      end if;
      select section.value ->> 'content'
      into v_text
      from pg_catalog.jsonb_array_elements(v_sections) as section(value)
      where pg_catalog.btrim(section.value ->> 'heading') = v_heading
      limit 1;
      v_minimum_length := case v_heading
        when '훈련목표' then 50 when '훈련내용' then 220 when '필요장비' then 40
        when '안전관리' then 100 when '훈련평가' then 90 when '학습목표' then 70
        when '도입' then 120 when '핵심이론' then 260 when '교관시범' then 200
        when '대원실습' then 200 when '안전유의사항' then 120 when '정리·평가' then 180
        else 1 end;
      if v_text is null or public.generated_material_visible_length(v_text) < v_minimum_length then
        return false;
      end if;
      v_all_text := v_all_text || E'\n' || v_heading || E'\n' || v_text;
      if v_heading = v_designated_heading then
        v_designated_text := v_text;
      end if;
      if v_heading = v_safety_heading then
        v_safety_text := v_text;
      end if;
      if v_heading = v_evaluation_heading then
        v_evaluation_text := v_text;
      end if;

      -- 계획은 훈련내용, 교안은 학습목표를 제외한 여섯 섹션마다 시간 표식이 필요하다.
      if (p_kind = 'plan' and v_heading = '훈련내용')
        or (p_kind = 'lesson' and v_heading <> '학습목표') then
        select pg_catalog.count(*), coalesce(pg_catalog.sum(minutes), 0)
        into v_section_time_count, v_minutes
        from public.generated_material_bracketed_minutes(v_text);
        if v_section_time_count = 0 then
          return false;
        end if;
        v_time_count := v_time_count + v_section_time_count;
        v_time_total := v_time_total + v_minutes;
      end if;
    end loop;

    if v_time_count = 0 or v_time_total <> v_expected_minutes then
      return false;
    end if;
    if not (
      v_safety_text ~ '(안전|위험|보호|예방|통제|점검|감시|대피)'
      and v_safety_text ~ '(중단|보고|철수|대피|비상|이상|사고)'
    ) or not (
      v_evaluation_text ~ '(평가|확인|관찰|체크|수행|시연|질문|강평)'
      and v_evaluation_text ~ '(기준|통과|정확|누락|횟수|시간|모범답안|체크리스트)'
    ) then
      return false;
    end if;

    -- 모든 필수 섹션의 대괄호를 확인하며, 시간·SOP 적용 제어 표식만 예외로 둔다.
    for v_item in select value from pg_catalog.jsonb_array_elements(v_sections) as section(value)
    loop
      v_heading := pg_catalog.btrim(v_item ->> 'heading');
      if not (v_heading = any(v_required_headings)) then
        continue;
      end if;
      v_text := coalesce(v_item ->> 'content', '');
      -- 문서는 본문 인라인 출처 대신 말미 목록을 사용한다. 위에서 실제 원본과
      -- sources/sourceLabels의 정확한 일치를 이미 확인했다. 본문에 남은 출처는
      -- 아래 검사로 계속 허용 목록과 대조하므로 임의 라벨은 통과하지 못한다.
      for v_reference_match in
        select pg_catalog.regexp_matches(v_text, '(\[[^]\n]{2,}\])', 'g')
      loop
        v_reference := v_reference_match[1];
        if public.generated_material_is_control_marker(v_reference) then
          continue;
        end if;
        if not (v_reference = any(v_source_labels)) then
          return false;
        end if;
      end loop;
    end loop;
  else
    v_slides := p_content -> 'slides';
    if pg_catalog.jsonb_typeof(v_slides) is distinct from 'array' then
      return false;
    end if;
    v_slide_count := pg_catalog.jsonb_array_length(v_slides);
    if (p_duration = '1시간' and v_slide_count not between 10 and 12)
      or (p_duration = '2시간' and v_slide_count not between 14 and 18)
      or (p_duration = '4시간' and v_slide_count not between 18 and 20) then
      return false;
    end if;
    for v_item in select value from pg_catalog.jsonb_array_elements(v_slides) as slide(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object'
        or pg_catalog.jsonb_typeof(v_item -> 'title') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_item -> 'bullets') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_item -> 'bullets') not between 2 and 4
        or pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_item -> 'sourceRefs') not between 1 and 4 then
        return false;
      end if;
      select coalesce(pg_catalog.string_agg(value, ' '), '')
      into v_text
      from pg_catalog.jsonb_array_elements_text(v_item -> 'bullets') as bullet(value);
      if public.generated_material_visible_length(v_text) < 45 then
        return false;
      end if;
      v_slide_text := coalesce(v_item ->> 'title', '') || ' ' || v_text || ' ' || coalesce(v_item ->> 'notes', '');
      v_all_text := v_all_text || E'\n' || v_slide_text;
      if v_slide_text ~ '(안전|위험|보호|예방|통제|점검|감시|대피)'
        and v_slide_text ~ '(중단|보고|철수|대피|비상|이상|사고)' then
        v_has_safety := true;
      end if;
      if v_slide_text ~ '(평가|확인|관찰|체크|수행|시연|질문|강평)'
        and v_slide_text ~ '(기준|통과|정확|누락|횟수|시간|모범답안|체크리스트)' then
        v_has_evaluation := true;
      end if;
      for v_reference in
        select pg_catalog.btrim(value)
        from pg_catalog.jsonb_array_elements_text(v_item -> 'sourceRefs') as ref(value)
      loop
        if not (v_reference = any(v_source_labels)) then
          return false;
        end if;
      end loop;

      if v_item ? 'visual' then
        v_visual := v_item -> 'visual';
        v_visual_mode := v_visual ->> 'mode';
        if pg_catalog.jsonb_typeof(v_visual) is distinct from 'object'
          or v_visual_mode not in ('source-page', 'source-crop', 'native-diagram', 'none') then
          return false;
        end if;
        if v_visual ? 'sourceRef'
          and not (pg_catalog.btrim(v_visual ->> 'sourceRef') = any(v_source_labels)) then
          return false;
        end if;
        if v_visual_mode in ('source-page', 'source-crop') then
          if nullif(pg_catalog.btrim(v_visual ->> 'sourceRef'), '') is null
            or nullif(pg_catalog.btrim(v_visual ->> 'altText'), '') is null
            or v_item ->> 'composition' <> 'visual-explanation' then
            return false;
          end if;
        elsif v_item ->> 'composition' = 'visual-explanation' then
          return false;
        end if;
      end if;
    end loop;
    if not v_has_safety or not v_has_evaluation then
      return false;
    end if;
  end if;

  -- 정상 조회 상태는 기존 DB SOP·출처 계약을 그대로 재사용한다. 검색 장애 상태는
  -- 개인 저장만 허용하되 고정 안내문과 무단 SOP 단정 금지를 DB에서도 확인한다.
  if v_status in ('found', 'not_found') then
    if not public.generated_material_share_contract_valid(
      p_kind, p_category, p_audience, p_duration, p_topic, p_title, p_content
    ) then
      return false;
    end if;
  else
    v_disclosure := 'SOP 자료 검색 상태를 확인할 수 없습니다. SOP 번호·절차를 추정하지 말고 시행 전 다시 확인해야 합니다.';
    if (p_kind in ('plan', 'lesson') and position(v_disclosure in v_designated_text) = 0)
      or (p_kind = 'slides' and position(v_disclosure in v_all_text) = 0) then
      return false;
    end if;
    v_text := pg_catalog.replace(v_all_text, v_disclosure, ' ');
    v_text := pg_catalog.replace(v_text, '[관련 SOP 적용]', ' ');
    v_text := pg_catalog.regexp_replace(v_text, '\[[^]]+\]', ' ', 'g');
    if v_text ~* (v_cue || '[[:space:]]*(제[[:space:]]*)?[-–—:#]?[[:space:]]*[0-9]{1,4}([[:space:]]*호)?')
      or v_text ~* (v_cue || '[[:space:]]*[:：][[:space:]]*[^[:space:].,;!?][^\n.!?]{1,80}')
      or v_text ~* ('[「『“"]{1}[^」』”"\n]{2,80}[」』”"]{1}[[:space:]]*' || v_cue)
      or v_text ~* (v_cue || '(에|에서는|상|를|을)?[[:space:]]*(따라|따르면|근거로|기준으로|규정상|반드시|우선|금지|허용|실시|시행|수행|해야|한다)') then
      return false;
    end if;
  end if;

  return true;
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
      -- 문서의 SOP 출처는 본문 각주가 아니라 말미 목록으로 연결한다. 이 목록은
      -- 아래에서 활성·분야·주제 일치 SOP/현장지침과 전부 대조한 뒤 주장 검토에 쓴다.
      v_refs_by_chunk := pg_catalog.array_append(
        v_refs_by_chunk, pg_catalog.array_to_string(v_labels, E'\n')
      );
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
      -- 지정 섹션의 적용 표식과 DB가 실제 원본으로 검증한 말미 SOP 목록을 연결한다.
      -- 슬라이드는 아래에서 같은 장의 표식·출처 연결을 그대로 검사한다.
      v_grounded_application := position('[관련 SOP 적용]' in v_designated) > 0
        and coalesce(pg_catalog.array_length(v_labels, 1), 0) > 0;
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
    -- 확인된 상태에서도 SOP 절차·번호·명칭 주장은 검증된 출처 연결이 필요하다.
    -- 문서는 위에서 연결한 말미 SOP 목록, 슬라이드는 같은 장의 출처만 인정한다.
    -- 연결 뒤에도 아래 SOP 번호·명칭 대조를 생략하지 않는다.
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

revoke all on function public.generated_material_core_quality_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.generated_material_share_contract_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
