-- 초기 비밀번호 변경 완료는 Auth의 실제 비밀번호 변경과 같은 트랜잭션에서만 기록한다.
-- 기존 계정·비밀번호·세션은 변경하지 않는다. 기존 UI의 완료 후 같은 false 재전송도 허용한다.
create schema if not exists app_auth_private;
revoke all on schema app_auth_private from public, anon, authenticated, service_role;

create or replace function app_auth_private.protect_password_change_requirement()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- JWT/user_metadata 또는 재귀 깊이를 신뢰하지 않고 실제 PostgreSQL 호출 역할을 확인한다.
  -- postgres는 아래 Auth 트리거 및 DB 운영자, service_role은 관리자 일괄 계정 발급용이다.
  if new.must_change_password is distinct from old.must_change_password
     and current_user not in ('postgres', 'service_role') then
    raise exception 'password_change_requirement_is_server_managed' using errcode = '42501';
  end if;
  return new;
end;
$$;
alter function app_auth_private.protect_password_change_requirement() owner to postgres;
revoke all on function app_auth_private.protect_password_change_requirement() from public, anon, authenticated, service_role;

drop trigger if exists profiles_protect_password_change on public.profiles;
create trigger profiles_protect_password_change
before update of must_change_password on public.profiles
for each row execute function app_auth_private.protect_password_change_requirement();

create or replace function app_auth_private.complete_password_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- 인자 없는 비공개 trigger 함수이며 다른 테이블에 붙여 호출해도 작동하지 않는다.
  if tg_table_schema <> 'auth' or tg_table_name <> 'users' or tg_op <> 'UPDATE' then
    raise exception 'password_change_trigger_context_invalid' using errcode = '42501';
  end if;
  if new.encrypted_password is distinct from old.encrypted_password
     and coalesce(new.encrypted_password, '') <> '' then
    update public.profiles
    set must_change_password = false
    where id = new.id and must_change_password = true;
  end if;
  return new;
end;
$$;
alter function app_auth_private.complete_password_change() owner to postgres;
revoke all on function app_auth_private.complete_password_change() from public, anon, authenticated, service_role;

drop trigger if exists on_auth_password_changed on auth.users;
create trigger on_auth_password_changed
after update of encrypted_password on auth.users
for each row execute function app_auth_private.complete_password_change();
