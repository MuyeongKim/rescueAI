-- 레거시 함수의 객체 탐색 경로를 고정하고, 트리거 전용 함수를 API 역할에서 닫는다.
-- 원본 테이블·벡터·검색 알고리즘·기존 로그인 세션은 변경하지 않는다.
alter function public.bump_conversation_updated_at() set search_path = public, pg_temp;
alter function public.protect_profile_role() set search_path = public, pg_temp;
alter function public.hybrid_search(text, public.vector, integer, text) set search_path = public, pg_temp;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.bump_conversation_updated_at() from public, anon, authenticated;
revoke all on function public.protect_profile_role() from public, anon, authenticated;

-- Supabase가 설치한 이벤트 트리거는 새 프로젝트 환경에 따라 없을 수도 있다.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
