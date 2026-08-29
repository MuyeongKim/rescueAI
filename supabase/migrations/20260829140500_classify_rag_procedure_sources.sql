-- 생성 결과에서 일반 교재를 SOP 근거로 오인하지 않도록 RAG 문서 유형을 분리한다.
-- 현재 자료실에서 관리자가 확인한 공식 현장활동 지침·대응 매뉴얼·훈련교범만
-- operational_guidance로 백필한다. 제목 추정이 아니라 현재 documents.id 허용목록을 사용한다.

update public.rag_rescue
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{document_type}',
  '"operational_guidance"'::jsonb,
  true
)
where metadata ->> 'document_id' in ('4', '6', '7', '9', '10', '11', '13', '16');

-- 나머지 기존 문서는 일반 교육자료로 명시한다. 이후 적재분은 rag7.py가 관리자가
-- 선택한 document_type을 처음부터 기록한다.
update public.rag_rescue
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{document_type}',
  '"training_material"'::jsonb,
  true
)
where not (metadata ? 'document_type');

create index if not exists rag_rescue_active_document_type_idx
  on public.rag_rescue (is_active, (metadata ->> 'document_type'));

-- SOP 검색과 공유 DB 계약이 모두 페이지 제목(Header 2)+본문을 같은 후보 범위로 보게 한다.
-- Supabase JS는 여러 열을 한 번에 FTS할 수 없으므로 저장 생성 열로 합치고 GIN 인덱스를 둔다.
alter table public.rag_rescue
  add column if not exists sop_search_vector tsvector
  generated always as (
    pg_catalog.to_tsvector(
      'simple'::regconfig,
      public.generated_material_normalize_ocr(
        coalesce(metadata ->> 'Header 2', '') || ' ' || coalesce(content, ''),
        coalesce(metadata ->> 'source', '') || ' ' ||
          coalesce(metadata ->> 'Header 2', '')
      )
    )
  ) stored;

create index if not exists rag_rescue_sop_search_vector_idx
  on public.rag_rescue using gin (sop_search_vector)
  where is_active
    and metadata ->> 'document_type' in ('sop', 'operational_guidance');

-- stored generated column은 RAG INSERT/UPDATE 실행자 권한으로 정규화 함수를 호출한다.
-- 인덱서가 쓰는 service_role에만 실행권을 주고 anon/authenticated에는 공개하지 않는다.
grant execute on function public.generated_material_normalize_ocr(text, text)
  to service_role;
