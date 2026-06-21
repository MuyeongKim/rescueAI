-- 0009_generated_materials.sql — AI 자료제작 생성물 저장·이력 (개인 비공개)
-- 0001~0008 적용 후 실행하세요.
--
-- 사용자가 /generate 에서 만든 훈련계획·교안·슬라이드·NotebookLM 프롬프트를 저장한다.
-- content(jsonb)에 결과 전체(sections|slides|prompt + sources)를 담아 복원·재다운로드가 가능하게 한다.
-- 본인 것만 조회·저장·삭제(RLS). 관리자 열람 없음(순수 개인 비공개).

create table if not exists generated_materials (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  kind       text not null,        -- plan | lesson | slides | notebooklm
  category   text,
  audience   text,
  duration   text,
  topic      text,
  title      text not null,
  content    jsonb not null,       -- {sections|slides|prompt, sources} 통째로 저장
  created_at timestamptz default now()
);
create index if not exists generated_materials_user_idx
  on generated_materials(user_id, created_at desc);

-- RLS: 본인 행만 전부(조회·삽입·수정·삭제). with check 로 타 user_id 위조 삽입 차단.
alter table generated_materials enable row level security;

drop policy if exists "own generated_materials" on generated_materials;
create policy "own generated_materials" on generated_materials
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
