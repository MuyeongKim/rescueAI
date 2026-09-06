-- 편집한 PPT의 본문은 6~20장을 허용한다. 시간별 장수는 앱에서 권장으로 안내한다.
-- 출처·SOP·안전·평가·소유권·개정 번호 검증은 그대로 유지하며 기존 자료는 수정하지 않는다.

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
    if v_slide_count not between 6 and 20 then
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


revoke all on function public.generated_material_core_quality_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
