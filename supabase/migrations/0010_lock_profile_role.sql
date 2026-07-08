-- 0010_lock_profile_role.sql — profiles.role 자가 승격 차단
--
-- 문제: "own profile update" 정책(0003)이 본인 행의 모든 컬럼 수정을 허용해,
--       일반 사용자가 브라우저에서 update({role:'admin'}) 로 스스로 관리자 승격이 가능했다.
-- 해결: role 이 바뀌는데 호출자가 service_role(관리자 API)이 아니면 조용히 원복하는 트리거.
--       - current_user 는 PostgREST 가 요청마다 SET ROLE 로 전환한 실제 역할을 반영한다
--         (일반 사용자=authenticated, 관리자 API=service_role via lib/supabase/admin.ts).
--       - SECURITY DEFINER 를 쓰지 않는다: definer 면 current_user 가 함수 소유자로 바뀌어 검사가 무력화됨.
--       - change-password 의 must_change_password 등 role 외 컬럼 self-update 는 그대로 동작(트리거 no-op).
-- 재실행 안전.

create or replace function protect_profile_role()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and current_user <> 'service_role' then
    new.role := old.role;  -- 승격/강등 시도 무시(에러 대신 기존 값 유지)
  end if;
  return new;
end; $$;

drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function protect_profile_role();
