-- 0012_share_materials.sql — AI 자료제작 생성물 공유(동료가 만든 자료 열람).
--
-- 기본은 비공개(0009). 사용자가 명시적으로 공유(shared=true)한 자료만 다른 인증 사용자가 조회.
-- 작성자 이름은 profiles RLS(본인만) 때문에 조회할 수 없어 공유 시점에 비정규화 저장한다.

alter table generated_materials add column if not exists shared boolean not null default false;
alter table generated_materials add column if not exists author_name text;

-- 공유 목록 정렬 가속(공유된 행만 부분 인덱스)
create index if not exists generated_materials_shared_idx
  on generated_materials(created_at desc) where shared;

-- 읽기 정책 추가: 공유된 행은 인증 사용자 누구나 조회(기존 "본인 전체" 정책과 OR).
-- 쓰기/수정/삭제는 여전히 본인만("own generated_materials" for all with check).
drop policy if exists "shared materials read" on generated_materials;
create policy "shared materials read" on generated_materials
  for select to authenticated using (shared = true);
