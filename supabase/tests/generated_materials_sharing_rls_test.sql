begin;
select plan(61);

insert into auth.users (id, email)
values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.com')
on conflict (id) do nothing;

insert into public.profiles (id, email, full_name)
values
  ('11111111-1111-1111-1111-111111111111', 'owner@example.com', '검증 대원'),
  ('22222222-2222-2222-2222-222222222222', 'other@example.com', '다른 대원')
on conflict (id) do update
set email = excluded.email,
    full_name = excluded.full_name;

insert into public.rag_rescue (id, content, metadata, is_active)
values
(
  '33333333-3333-3333-3333-333333333333',
  '공기호흡기 착용 전 면체와 용기 압력을 확인하고 착용 상태를 교차 점검한다.',
  jsonb_build_object(
    'source', '공기호흡기 현장활동지침.pdf',
    'Header 2', '공기호흡기 착용',
    'page_num', 3,
    'document_id', 333,
    'edu_category', '화재',
    'document_type', 'operational_guidance'
  ),
  true
),
(
  '44444444-4444-4444-4444-444444444444',
  '화학보호복 달의 순서를 확인하고 2차 오염을 방지한다.',
  jsonb_build_object(
    'source', '화학사고 실무가이드.pdf',
    'Header 2', 'VI-1 화학보호복 달의',
    'page_num', 58,
    'document_id', 16,
    'edu_category', '화학사고',
    'document_type', 'operational_guidance'
  ),
  true
),
(
  '55555555-5555-5555-5555-555555555555',
  '가스 농도 축정 장비로 축정 결과를 확인한다.',
  jsonb_build_object(
    'source', '가스농도 축정 지침.pdf',
    'Header 2', '가스농도 축정 장비',
    'page_num', 9,
    'document_id', 555,
    'edu_category', '화학사고',
    'document_type', 'operational_guidance'
  ),
  true
),
(
  '88888888-8888-8888-8888-888888888888',
  '산악 구조 장비 점검표와 원문 도해를 확인한다.',
  jsonb_build_object(
    'source', '산악구조 교범.pdf',
    'page_num', 12,
    'document_id', 77,
    'edu_category', '산악',
    'document_type', 'training_material'
  ),
  true
),
(
  '90909090-9090-9090-9090-909090909090',
  '페이지 번호가 없는 외부 산악구조 자료를 확인한다.',
  jsonb_build_object(
    'source', '페이지 없는 외부 교범.pdf',
    'document_id', 909,
    'edu_category', '산악',
    'document_type', 'training_material'
  ),
  true
),
(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '지휘보고 통신 절차에서는 현장 지휘관에게 상황과 대원 안전상태를 보고한다.',
  jsonb_build_object(
    'source', '전 분야 현장지휘 공통 SOP.pdf',
    'Header 2', '지휘보고 통신 절차',
    'page_num', 7,
    'document_id', 1717,
    'edu_category', '현장지휘·공통',
    'document_type', 'sop'
  ),
  true
),
(
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '지휘보고 통신 교육을 위한 일반 이론과 토의 방법을 설명한다.',
  jsonb_build_object(
    'source', '공통 교육자료.pdf',
    'Header 2', '지휘보고 통신 교육',
    'page_num', 8,
    'document_id', 1818,
    'edu_category', '현장지휘·공통',
    'document_type', 'training_material'
  ),
  true
),
(
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  '지휘보고 통신 절차에서는 수난 현장 지휘관에게 구조 진행 상황을 보고한다.',
  jsonb_build_object(
    'source', '수난 현장지침.pdf',
    'Header 2', '지휘보고 통신 절차',
    'page_num', 9,
    'document_id', 1919,
    'edu_category', '수난',
    'document_type', 'operational_guidance'
  ),
  true
)
on conflict (id) do update
set content = excluded.content,
    metadata = excluded.metadata,
    is_active = excluded.is_active;

insert into public.documents (id, title, source_type, category, status)
values
  (7001, '내부 산악구조 교범', 'pdf', '산악', 'processed'),
  (7002, '미처리 산악구조 교범', 'pdf', '산악', 'processing'),
  (7003, '페이지 없는 내부 교범', 'pdf', '산악', 'processed')
on conflict (id) do update
set title = excluded.title,
    source_type = excluded.source_type,
    category = excluded.category,
    status = excluded.status;

insert into public.chunks (id, document_id, content, page_num)
values
  (7001, 7001, '내부 산악구조 장비 점검 절차', 21),
  (7002, 7002, '아직 처리 중인 산악구조 자료', 31),
  (7003, 7003, '페이지 번호가 없는 내부 자료', null)
on conflict (id) do update
set document_id = excluded.document_id,
    content = excluded.content,
    page_num = excluded.page_num;

select is(
  (
    select count(*)
    from pg_catalog.pg_trigger
    where tgrelid = 'public.generated_materials'::regclass
      and tgname = 'lock_generated_material_share_validation'
      and not tgisinternal
  ),
  1::bigint,
  'generated_materials statement trigger가 행 잠금 전에 공유 advisory lock을 획득한다'
);

-- 이미 공유된 행의 본문 변조와 비공개 행의 공유 전환을 각각 검증하기 위한 기준 행.
insert into public.generated_materials (
  id, user_id, kind, category, audience, duration, topic, title, content, shared
)
values
  (
    9000000001,
    '11111111-1111-1111-1111-111111111111',
    'plan',
    '산악',
    '일반 대원',
    '2시간',
    '산악사고 대비 훈련',
    '공유 안전 기준 행',
    jsonb_build_object(
      'sections', jsonb_build_array(jsonb_build_object(
        'heading', '훈련내용',
        'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
      )),
      'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
    ),
    true
  ),
  (
    9000000002,
    '11111111-1111-1111-1111-111111111111',
    'plan',
    '산악',
    '일반 대원',
    '2시간',
    '산악사고 대비 훈련',
    '비공개 미검증 행',
    jsonb_build_object(
      'sections', jsonb_build_array(jsonb_build_object(
        'heading', '훈련내용',
        'content', 'SOP 999에 따라 임의 절차를 수행한다.'
      ))
    ),
    false
  );

set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '직접 공유 삽입 우회',
      '{"sections":[{"heading":"훈련내용","content":"SOP 999에 따라 수행한다."}]}'::jsonb,
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '미검증 shared=true 직접 INSERT를 DB가 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '화재', '일반 대원', '2시간', '공기호흡기 착용 방법',
      '실제 SOP를 미확인으로 숨긴 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '관련 활성 SOP가 있으면 not_found 상태로 속여 공유할 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '화재', '일반 대원', '2시간', '공기호흡기 착용 방법',
      '허위 SOP 번호를 섞은 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '[관련 SOP 적용]' || E'\n' || 'SOP 999에 따라 수행한다. [공기호흡기 현장활동지침 — 공기호흡기 착용 p.3]'
        )),
        'sopEvidence', jsonb_build_object(
          'status', 'found',
          'sourceLabels', jsonb_build_array('[공기호흡기 현장활동지침 — 공기호흡기 착용 p.3]')
        )
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '실제 출처를 붙여도 그 라벨에 없는 SOP 번호를 섞으면 공유할 수 없다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '화재', '일반 대원', '2시간', '공기호흡기 착용 방법',
      '정상 확인 근거 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '[관련 SOP 적용]' || E'\n' || '공기호흡기 착용 상태를 점검한다. [공기호흡기 현장활동지침 — 공기호흡기 착용 p.3]'
        )),
        'sopEvidence', jsonb_build_object(
          'status', 'found',
          'sourceLabels', jsonb_build_array('[공기호흡기 현장활동지침 — 공기호흡기 착용 p.3]')
        )
      ),
      true
    )
  $sql$,
  '확인된 RAG 근거와 적용 표식이 정확한 공유 자료는 허용한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '지휘보고 통신 절차',
      '전 분야 공통 SOP 정상 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '[관련 SOP 적용]' || E'\n' ||
            '지휘보고 통신 절차를 훈련한다. [전 분야 현장지휘 공통 SOP — 지휘보고 통신 절차 p.7]'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 1717,
          'doc', '전 분야 현장지휘 공통 SOP — 지휘보고 통신 절차',
          'page', 7
        )),
        'sopEvidence', jsonb_build_object(
          'status', 'found',
          'sourceLabels', jsonb_build_array('[전 분야 현장지휘 공통 SOP — 지휘보고 통신 절차 p.7]')
        )
      ),
      true
    )
  $sql$,
  '현장지휘·공통의 SOP 분류 원문은 산악 자료의 출처와 SOP 근거로 공유할 수 있다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '지휘보고 통신 절차',
      '공통 SOP를 근거 없음으로 숨긴 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '관련된 전 분야 공통 SOP가 있으면 요청 분야에서 not_found로 숨길 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '지휘보고 통신 절차',
      '공통 일반 교육자료 출처 우회',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '[관련 SOP 적용]' || E'\n' ||
            '지휘보고 통신 절차를 훈련한다. [전 분야 현장지휘 공통 SOP — 지휘보고 통신 절차 p.7]'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 1818,
          'doc', '공통 교육자료 — 지휘보고 통신 교육',
          'page', 8
        )),
        'sopEvidence', jsonb_build_object(
          'status', 'found',
          'sourceLabels', jsonb_build_array('[전 분야 현장지휘 공통 SOP — 지휘보고 통신 절차 p.7]')
        )
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '현장지휘·공통의 training_material은 다른 분야 content.sources로 공유할 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '지휘보고 통신 절차',
      '타 분야 SOP 출처 우회',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '[관련 SOP 적용]' || E'\n' ||
            '지휘보고 통신 절차를 훈련한다. [수난 현장지침 — 지휘보고 통신 절차 p.9]'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 1919,
          'doc', '수난 현장지침 — 지휘보고 통신 절차',
          'page', 9
        )),
        'sopEvidence', jsonb_build_object(
          'status', 'found',
          'sourceLabels', jsonb_build_array('[수난 현장지침 — 지휘보고 통신 절차 p.9]')
        )
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '현장지휘·공통이 아닌 타 분야 SOP는 요청 분야 근거로 공유할 수 없다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '화학사고', '일반 대원', '2시간', '화학보호복 탈의',
      'OCR 교정 출처 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '[관련 SOP 적용]' || E'\n' || '보호복 탈의 순서를 점검한다. [화학사고 실무가이드 — VI-1 화학보호복 탈의 p.58]'
        )),
        'sopEvidence', jsonb_build_object(
          'status', 'found',
          'sourceLabels', jsonb_build_array('[화학사고 실무가이드 — VI-1 화학보호복 탈의 p.58]')
        )
      ),
      true
    )
  $sql$,
  '앱과 같은 달의→탈의 OCR 교정 라벨도 정상 공유된다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '화학사고', '일반 대원', '2시간', '가스농도 측정 장비',
      '측정 OCR 교정 출처 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '[관련 SOP 적용]' || E'\n' || '가스농도 측정 결과를 확인한다. [가스농도 측정 지침 — 가스농도 측정 장비 p.9]'
        )),
        'sopEvidence', jsonb_build_object(
          'status', 'found',
          'sourceLabels', jsonb_build_array('[가스농도 측정 지침 — 가스농도 측정 장비 p.9]')
        )
      ),
      true
    )
  $sql$,
  '축정→측정 OCR 교정이 출처 라벨과 RAG 주제 확인에 똑같이 적용된다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '중복 지정 섹션 우회',
      jsonb_build_object(
        'sections', jsonb_build_array(
          jsonb_build_object('heading', '훈련내용', 'content', '첫 섹션에는 필수 안내문이 없다.'),
          jsonb_build_object(
            'heading', '훈련내용',
            'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
          )
        ),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '중복 지정 섹션의 마지막 값으로 첫 섹션 검사를 우회할 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '참조 배열 안내문 우회',
      jsonb_build_object(
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '산악 안전 훈련',
          'bullets', jsonb_build_array('대원 간 안전거리를 유지한다.'),
          'notes', '교관 설명',
          'sourceRefs', jsonb_build_array(
            '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
          )
        )),
        'sources', '[]'::jsonb,
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '슬라이드 sourceRefs에만 둔 SOP 안내문은 화면 본문으로 인정하지 않는다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '비괄호 허위 출처 우회',
      jsonb_build_object(
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '산악 안전 훈련',
          'bullets', jsonb_build_array('대원 간 안전거리를 유지한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('가짜 SOP 교범')
        )),
        'sources', '[]'::jsonb,
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '대괄호가 없는 허위 SOP sourceRefs도 정확한 허용 라벨이 아니면 거절한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '검증된 원문 시각자료 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 77, 'doc', '산악구조 교범', 'page', 12
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '산악 안전 훈련',
          'bullets', jsonb_build_array('대원 간 안전거리를 유지한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[산악구조 교범 p.12]'),
          'visual', jsonb_build_object(
            'mode', 'source-page',
            'documentId', 77,
            'page', 12,
            'sourceRef', '[산악구조 교범 p.12]',
            'altText', '산악 구조 장비 점검표'
          )
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  'source-page의 ID·페이지·계산 라벨과 분야가 active RAG 원문과 같으면 공유한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '내부 산악구조 장비 점검',
      '검증된 내부 원문 시각자료 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', 21
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '산악 구조 장비 점검',
          'bullets', jsonb_build_array('내부 교범의 장비 점검 절차를 확인한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[내부 산악구조 교범 p.21]'),
          'visual', jsonb_build_object(
            'mode', 'source-page',
            'documentId', 7001,
            'page', 21,
            'sourceRef', '[내부 산악구조 교범 p.21]',
            'altText', '내부 산악구조 장비 점검표'
          )
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  'processed documents 제목·분야와 chunks 페이지가 정확한 내부 출처는 공유한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '화재', '일반 대원', '2시간', '내부 교범 점검',
      '내부 출처 분야 위조 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', 21
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '내부 교범 점검',
          'bullets', jsonb_build_array('장비 점검 절차를 확인한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[내부 산악구조 교범 p.21]')
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '내부 documents의 실제 분야와 생성물 분야가 다르면 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '내부 교범 점검',
      '내부 출처 제목 위조 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '조작한 내부 교범', 'page', 21
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '내부 교범 점검',
          'bullets', jsonb_build_array('장비 점검 절차를 확인한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[조작한 내부 교범 p.21]')
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '내부 sources 제목이 documents.title과 다르면 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '내부 교범 점검',
      '내부 출처 페이지 위조 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', 22
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '내부 교범 점검',
          'bullets', jsonb_build_array('장비 점검 절차를 확인한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[내부 산악구조 교범 p.22]')
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '내부 sources 페이지가 실제 chunks.page_num과 다르면 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '미처리 내부 교범 점검',
      '미처리 내부 출처 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7002, 'doc', '미처리 산악구조 교범', 'page', 31
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '미처리 내부 교범 점검',
          'bullets', jsonb_build_array('아직 처리 중인 문서를 확인한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[미처리 산악구조 교범 p.31]')
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'processed 상태가 아닌 내부 documents 출처는 공유를 차단한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '내부 산악구조 장비 점검',
      '내부 출처 계획서 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', 21
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  'plan의 내부 processed 문서·청크 exact 출처도 공유한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'lesson', '산악', '일반 대원', '2시간', '내부 산악구조 장비 점검',
      '내부 출처 교안 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '핵심이론',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', 21
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  'lesson의 내부 processed 문서·청크 exact 출처도 공유한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '내부 교범 점검',
      '위조 출처 계획서 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '조작한 내부 교범', 'page', 21
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'plan sources의 위조 제목도 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'lesson', '산악', '일반 대원', '2시간', '내부 교범 점검',
      '위조 출처 교안 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '핵심이론',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', 22
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'lesson sources의 위조 페이지도 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '화재', '일반 대원', '2시간', '내부 교범 점검',
      '교차 분야 출처 계획서 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', 21
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'plan sources의 교차 분야 내부 문서도 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'lesson', '산악', '일반 대원', '2시간', '미처리 내부 교범 점검',
      '미처리 출처 교안 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '핵심이론',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7002, 'doc', '미처리 산악구조 교범', 'page', 31
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'lesson sources의 미처리 내부 문서도 공유를 차단한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '페이지 없는 내부 자료',
      'NULL 페이지 exact 출처 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7003, 'doc', '페이지 없는 내부 교범', 'page', null
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '실제 chunks.page_num이 NULL인 출처의 page:null은 공유한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'lesson', '산악', '일반 대원', '2시간', '페이지 없는 외부 자료',
      '외부 NULL 페이지 exact 출처 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '핵심이론',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 909, 'doc', '페이지 없는 외부 교범', 'page', null
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '실제 rag_rescue page_num이 NULL인 출처의 page:null도 공유한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'lesson', '산악', '일반 대원', '2시간', '존재하지 않는 NULL 페이지',
      'NULL 페이지 위조 출처 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '핵심이론',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 7001, 'doc', '내부 산악구조 교범', 'page', null
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '실제 NULL 페이지 청크가 없는 sources page:null은 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '위조 원문 시각자료 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 77, 'doc', '산악구조 교범', 'page', 12
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '산악 안전 훈련',
          'bullets', jsonb_build_array('대원 간 안전거리를 유지한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[가짜 교범 p.99]'),
          'visual', jsonb_build_object(
            'mode', 'source-crop',
            'documentId', 999,
            'page', 99,
            'sourceRef', '[가짜 교범 p.99]',
            'altText', '산악 구조 장비 점검표'
          )
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'content.sources와 visual을 함께 위조해도 active RAG 원문과 다르면 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '미사용 위조 출처가 있는 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(
          jsonb_build_object('document_id', 77, 'doc', '산악구조 교범', 'page', 12),
          jsonb_build_object('document_id', 999, 'doc', '가짜 부록 교범', 'page', 99)
        ),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '산악 안전 훈련',
          'bullets', jsonb_build_array('대원 간 안전거리를 유지한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[산악구조 교범 p.12]'),
          'visual', jsonb_build_object(
            'mode', 'source-page',
            'documentId', 77,
            'page', 12,
            'sourceRef', '[산악구조 교범 p.12]',
            'altText', '산악 구조 장비 점검표'
          )
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'visual에 쓰지 않은 content.sources도 active RAG 원문이 아니면 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '화재', '일반 대원', '2시간', '산악 장비 도해',
      '교차 분야 원문 출처 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 77, 'doc', '산악구조 교범', 'page', 12
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '장비 도해 확인',
          'bullets', jsonb_build_array('원문 도해를 확인한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[산악구조 교범 p.12]'),
          'visual', jsonb_build_object(
            'mode', 'source-page',
            'documentId', 77,
            'page', 12,
            'sourceRef', '[산악구조 교범 p.12]',
            'altText', '산악 구조 장비 점검표'
          )
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '다른 분야의 실제 active RAG 페이지도 생성물 분야와 다르면 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'slides', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '위조 일반 출처 참조 공유',
      jsonb_build_object(
        'sources', jsonb_build_array(jsonb_build_object(
          'document_id', 77, 'doc', '산악구조 교범', 'page', 12
        )),
        'slides', jsonb_build_array(jsonb_build_object(
          'title', '산악 안전 훈련',
          'bullets', jsonb_build_array('대원 간 안전거리를 유지한다.'),
          'notes', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.',
          'sourceRefs', jsonb_build_array('[가짜 일반 교범 p.99]')
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '일반 sourceRefs도 검증된 content.sources 라벨과 다르면 공유를 차단한다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '비문자 섹션 우회',
      jsonb_build_object(
        'sections', jsonb_build_array(
          jsonb_build_object(
            'heading', '훈련내용',
            'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
          ),
          jsonb_build_object('heading', '부록', 'content', jsonb_build_object('forged', true))
        ),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '공유 UI를 깨뜨리는 비문자 섹션 본문을 문자열로 강제 변환해 받지 않는다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', repeat('가', 101),
      '과대 메타데이터 우회',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '앱 상한보다 긴 topic으로 정규식 검사와 공유 목록을 소진할 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'notebooklm', repeat('가', 101), '과대 NotebookLM 분야',
      jsonb_build_object('prompt', repeat('정상 프롬프트 ', 10)),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'NotebookLM 조기 반환으로 앱 상한보다 긴 category를 우회할 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', repeat('가', 51), '2시간', '산악사고 대비 훈련',
      '과대 교육 대상 우회',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '앱 상한보다 긴 audience를 공유 목록에 저장할 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', repeat('가', 21), '산악사고 대비 훈련',
      '과대 교육 시간 우회',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '앱 상한보다 긴 duration을 공유 목록에 저장할 수 없다'
);

select throws_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, title, content, shared
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'notebooklm',
      '비문자 NotebookLM 우회',
      jsonb_build_object('prompt', jsonb_build_object('forged', repeat('가', 20))),
      true
    )
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  'NotebookLM prompt도 JSON 객체가 아니라 문자열이어야 한다'
);

select lives_ok(
  $sql$
    insert into public.generated_materials (
      user_id, kind, category, audience, duration, topic, title, content, shared,
      author_name
    ) values (
      '11111111-1111-1111-1111-111111111111',
      'plan', '산악', '일반 대원', '2시간', '산악사고 대비 훈련',
      '검증된 직접 공유',
      jsonb_build_object(
        'sections', jsonb_build_array(jsonb_build_object(
          'heading', '훈련내용',
          'content', '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.'
        )),
        'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
      ),
      true,
      '위조 이름'
    )
  $sql$,
  '정확한 미확인 안내문이 있는 공유 자료는 허용한다'
);

select is(
  (
    select author_name
    from public.generated_materials
    where title = '검증된 직접 공유'
      and user_id = '11111111-1111-1111-1111-111111111111'
  ),
  '검증 대원',
  '공유 작성자 이름은 클라이언트 값이 아니라 프로필로 고정한다'
);

select throws_ok(
  $sql$
    update public.generated_materials
    set shared = true,
        author_name = '위조 이름'
    where id = 9000000002
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '미검증 비공개 행의 shared/author_name 직접 UPDATE를 차단한다'
);

select throws_ok(
  $sql$
    update public.generated_materials
    set content = jsonb_build_object(
      'sections', jsonb_build_array(jsonb_build_object(
        'heading', '훈련내용',
        'content', 'SOP 999에 따라 임의 절차를 수행한다.'
      )),
      'sopEvidence', jsonb_build_object('status', 'not_found', 'sourceLabels', '[]'::jsonb)
    )
    where id = 9000000001
  $sql$,
  '23514',
  'generated_material_share_contract_invalid',
  '이미 공유된 행의 본문을 미검증 내용으로 바꾸는 UPDATE를 차단한다'
);

select set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', true);
select results_eq(
  $sql$
    update public.generated_materials
    set shared = false
    where id = 9000000001
    returning id
  $sql$,
  array[]::bigint[],
  '다른 사용자는 공유 행을 읽어도 수정할 수 없다'
);

reset role;

insert into public.generated_materials (
  user_id, kind, title, content, shared
) values (
  '11111111-1111-1111-1111-111111111111',
  'notebooklm',
  '코퍼스 변경 무관 NotebookLM',
  jsonb_build_object('prompt', repeat('검증된 NotebookLM 프롬프트 ', 4)),
  true
);

-- 세 행을 한 문장으로 전환해 transition-table statement trigger의 bulk 동작을 검증한다.
update public.rag_rescue
set is_active = false
where id in (
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  '55555555-5555-5555-5555-555555555555',
  '88888888-8888-8888-8888-888888888888'
);

select results_eq(
  $sql$
    select
      shared,
      author_name is null,
      content #>> '{sections,0,content}' =
        '[관련 SOP 적용]' || E'\n' ||
        '공기호흡기 착용 상태를 점검한다. [공기호흡기 현장활동지침 — 공기호흡기 착용 p.3]'
    from public.generated_materials
    where title = '정상 확인 근거 공유'
  $sql$,
  $expected$ values (false, true, true) $expected$,
  '활성 RAG bulk 전환은 기존 공식 공유를 한 문장으로 해제하고 본문을 보존한다'
);

select is(
  (select shared from public.generated_materials where title = '코퍼스 변경 무관 NotebookLM'),
  true,
  '활성 RAG 변경은 NotebookLM 공유에는 영향을 주지 않는다'
);

update public.generated_materials
set shared = true
where id = 9000000001;

insert into public.rag_rescue (id, content, metadata, is_active)
values (
  '66666666-6666-6666-6666-666666666666',
  '비활성 준비 자료',
  jsonb_build_object(
    'source', '비활성 준비 자료.pdf',
    'edu_category', '화재',
    'document_type', 'operational_guidance'
  ),
  false
);

select is(
  (select shared from public.generated_materials where id = 9000000001),
  true,
  '비활성 RAG 행을 준비 적재할 때는 기존 공유를 해제하지 않는다'
);

insert into public.rag_rescue (id, content, metadata, is_active)
values (
  '77777777-7777-7777-7777-777777777777',
  '활성 신규 현장지침',
  jsonb_build_object(
    'source', '활성 신규 현장지침.pdf',
    'edu_category', '화재',
    'document_type', 'operational_guidance'
  ),
  true
);

select is(
  (select shared from public.generated_materials where id = 9000000001),
  false,
  '활성 RAG 행 INSERT는 기존 공식 공유를 즉시 해제한다'
);

update public.generated_materials
set shared = true
where id = 9000000001;

delete from public.rag_rescue
where id = '77777777-7777-7777-7777-777777777777';

select is(
  (select shared from public.generated_materials where id = 9000000001),
  false,
  '활성 RAG 행 DELETE도 기존 공식 공유를 즉시 해제한다'
);

insert into public.rag_rescue (id, content, metadata, is_active)
values (
  '99999999-9999-9999-9999-999999999999',
  'TRUNCATE 전 활성 현장지침',
  jsonb_build_object(
    'source', 'TRUNCATE 전 활성 현장지침.pdf',
    'edu_category', '화재',
    'document_type', 'operational_guidance'
  ),
  true
);

update public.generated_materials
set shared = true
where id = 9000000001;

truncate table public.rag_rescue;

select is(
  (select shared from public.generated_materials where id = 9000000001),
  false,
  '활성 RAG 전체 TRUNCATE도 기존 공식 공유를 즉시 해제한다'
);

update public.generated_materials
set shared = true
where id = 9000000001;

insert into public.documents (id, title, source_type, category, status)
values (7010, '신규 내부 교범', 'pdf', '산악', 'processed');
insert into public.chunks (id, document_id, content, page_num)
values (7010, 7010, '새로 적재된 내부 교범 청크', 1);

select is(
  (select shared from public.generated_materials where id = 9000000001),
  true,
  'native documents/chunks INSERT는 기존 exact 공유를 자동 해제하지 않는다'
);

update public.documents
set title = '변경된 내부 산악구조 교범'
where id = 7001;

select results_eq(
  $sql$
    select shared, author_name is null
    from public.generated_materials
    where id = 9000000001
  $sql$,
  $expected$ values (false, true) $expected$,
  'native document 제목 UPDATE는 기존 공식 공유를 비공개로 전환한다'
);

update public.documents
set title = '내부 산악구조 교범'
where id = 7001;
update public.generated_materials
set shared = true
where id = 9000000001;
update public.documents
set status = 'failed'
where id = 7001;

select results_eq(
  $sql$
    select shared, author_name is null
    from public.generated_materials
    where id = 9000000001
  $sql$,
  $expected$ values (false, true) $expected$,
  'native document 상태 UPDATE도 기존 공식 공유를 비공개로 전환한다'
);

update public.documents
set status = 'processed'
where id = 7001;
update public.generated_materials
set shared = true
where id = 9000000001;
update public.chunks
set page_num = 22
where id = 7001;

select results_eq(
  $sql$
    select shared, author_name is null
    from public.generated_materials
    where id = 9000000001
  $sql$,
  $expected$ values (false, true) $expected$,
  'native chunk 페이지 UPDATE는 기존 공식 공유를 비공개로 전환한다'
);

update public.chunks
set page_num = 21
where id = 7001;
update public.generated_materials
set shared = true
where id = 9000000001;
delete from public.chunks
where id = 7001;

select results_eq(
  $sql$
    select shared, author_name is null
    from public.generated_materials
    where id = 9000000001
  $sql$,
  $expected$ values (false, true) $expected$,
  'native chunk DELETE는 기존 공식 공유를 비공개로 전환한다'
);

insert into public.chunks (id, document_id, content, page_num)
values (7001, 7001, '복구한 내부 산악구조 장비 점검 절차', 21);
update public.generated_materials
set shared = true
where id = 9000000001;
truncate table public.chunks;

select results_eq(
  $sql$
    select shared, author_name is null
    from public.generated_materials
    where id = 9000000001
  $sql$,
  $expected$ values (false, true) $expected$,
  'native chunks TRUNCATE는 기존 공식 공유를 비공개로 전환한다'
);

update public.generated_materials
set shared = true
where id = 9000000001;
truncate table public.documents cascade;

select results_eq(
  $sql$
    select shared, author_name is null
    from public.generated_materials
    where id = 9000000001
  $sql$,
  $expected$ values (false, true) $expected$,
  'native documents TRUNCATE는 기존 공식 공유를 비공개로 전환한다'
);

select results_eq(
  $sql$
    select
      has_function_privilege(
        'service_role',
        'public.generated_material_normalize_ocr(text,text)',
        'EXECUTE'
      ),
      has_function_privilege(
        'authenticated',
        'public.generated_material_normalize_ocr(text,text)',
        'EXECUTE'
      ),
      has_function_privilege(
        'anon',
        'public.generated_material_normalize_ocr(text,text)',
        'EXECUTE'
      ),
      has_function_privilege(
        'authenticated',
        'public.generated_material_rag_scope_valid(jsonb,text)',
        'EXECUTE'
      ),
      has_function_privilege(
        'anon',
        'public.generated_material_rag_scope_valid(jsonb,text)',
        'EXECUTE'
      )
  $sql$,
  $expected$ values (true, false, false, false, false) $expected$,
  'generated FTS 열의 OCR 함수는 service_role에만 실행권을 주고 공통 SOP 범위 함수는 공개하지 않는다'
);

set local role service_role;

select lives_ok(
  $sql$
    insert into public.rag_rescue (id, content, metadata, is_active)
    values (
      '12121212-1212-1212-1212-121212121212',
      '오염도 축정 결과를 확인한다.',
      jsonb_build_object(
        'source', '측정 지침.pdf',
        'Header 2', '오염도 축정',
        'document_id', 1212,
        'page_num', 1,
        'edu_category', '화학사고',
        'document_type', 'operational_guidance'
      ),
      true
    )
  $sql$,
  'service_role RAG INSERT는 generated OCR 함수 권한 오류 없이 성공한다'
);

select lives_ok(
  $sql$
    update public.rag_rescue
    set content = '압력 축정 결과를 확인한다.'
    where id = '12121212-1212-1212-1212-121212121212'
  $sql$,
  'service_role RAG UPDATE도 generated OCR 함수 권한 오류 없이 성공한다'
);

select is(
  (
    select count(*)
    from public.rag_rescue
    where is_active
      and metadata ->> 'document_type' in ('sop', 'operational_guidance')
      and sop_search_vector @@ websearch_to_tsquery('simple', '측정')
  ),
  1::bigint,
  'service_role 적재의 OCR 축정을 정규화한 FTS 열이 측정 검색에 잡힌다'
);

reset role;

select * from finish();
rollback;
