-- encrypted_password는 로그인 중 저장 암호화키 교체에도 바뀔 수 있으므로
-- 이 내부 컬럼의 변경만으로 사용자가 새 비밀번호를 설정했다고 판단하지 않는다.
-- /api/auth/change-password가 세션 Auth API의 변경 성공을 확인한 뒤,
-- 서버 전용 한 컬럼 writer로만 완료 상태를 기록한다.
drop trigger if exists on_auth_password_changed on auth.users;
drop function if exists app_auth_private.complete_password_change();

-- profiles_protect_password_change는 유지한다. 브라우저/REST의 직접 해제는 계속 차단하며
-- 기존 계정, 비밀번호, 프로필 상태, 동시 세션에는 데이터 변경을 가하지 않는다.
