-- 0003_triggers_rls.sql — 트리거 + RLS (PRD §6.3)
-- 재실행 가능하도록 drop if exists 가드를 추가했다.

-- 회원가입 시 profiles 자동 생성
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name')
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- updated_at 자동 갱신
create or replace function bump_conversation_updated_at()
returns trigger language plpgsql as $$
begin
  update conversations set updated_at = now() where id = new.conversation_id;
  return new;
end; $$;

drop trigger if exists messages_bump_conversation on messages;
create trigger messages_bump_conversation
  after insert on messages for each row execute function bump_conversation_updated_at();

-- RLS 활성화
alter table profiles      enable row level security;
alter table conversations enable row level security;
alter table messages      enable row level security;
alter table documents     enable row level security;
alter table chunks        enable row level security;

-- 본인 프로필
drop policy if exists "own profile select" on profiles;
create policy "own profile select" on profiles for select using (auth.uid() = id);
drop policy if exists "own profile update" on profiles;
create policy "own profile update" on profiles for update using (auth.uid() = id);

-- 본인 대화
drop policy if exists "own conversations" on conversations;
create policy "own conversations" on conversations for all using (auth.uid() = user_id);

-- 본인 메시지 (대화 소유자만)
drop policy if exists "own messages" on messages;
create policy "own messages" on messages for all using (
  exists (select 1 from conversations c where c.id = messages.conversation_id and c.user_id = auth.uid())
);

-- 인증 사용자는 자료/청크 읽기 가능
drop policy if exists "authenticated read documents" on documents;
create policy "authenticated read documents" on documents for select to authenticated using (true);
drop policy if exists "authenticated read chunks" on chunks;
create policy "authenticated read chunks" on chunks for select to authenticated using (true);

-- 관리자는 모든 메시지 조회 가능 (통계용). profiles 하위쿼리는 "own profile select"로 해결되어 재귀하지 않음.
drop policy if exists "admin all messages" on messages;
create policy "admin all messages" on messages for select using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);

-- 참고: 관리자 대시보드의 전체 집계(사용자 수 등)는 service-role 클라이언트(RLS 우회)로 수행한다.
-- profiles 에 self-referential admin 정책을 추가하면 RLS 무한 재귀가 발생하므로 추가하지 않는다.
