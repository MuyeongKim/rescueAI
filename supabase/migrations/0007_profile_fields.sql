-- 0007_profile_fields.sql — profiles 직원 정보 확장 (일괄 등록용)
-- 0001~0006 적용 후 실행하세요. 재실행 안전(if not exists).
--
-- 일괄 등록(scripts/import-users.mjs)에서 받는 직원 데이터를 저장한다:
--   계급(rank) · 팀(team) · 디지털식별번호(digital_id)
-- (이름=full_name, 소속=division, 공직자이메일=auth.users.email 은 기존 컬럼 사용)

alter table profiles add column if not exists rank       text;  -- 계급
alter table profiles add column if not exists team       text;  -- 팀
alter table profiles add column if not exists digital_id text;  -- 디지털식별번호

-- 첫 로그인 비번 변경 강제 플래그. 일괄 등록(초기 비번=디지털식별번호) 계정은 true 로 넣고,
-- 사용자가 비번을 바꾸면 false 로 내린다. 미들웨어가 true 면 /change-password 로 보낸다.
alter table profiles add column if not exists must_change_password boolean not null default false;

-- 디지털식별번호로 직원 조회가 잦으면 인덱스 도움 (중복 허용 — 유니크 강제는 명단 정합성 확인 후)
create index if not exists profiles_digital_id_idx on profiles(digital_id);
