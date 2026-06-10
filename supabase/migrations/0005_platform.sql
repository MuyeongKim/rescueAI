-- 0005_platform.sql — LMS형 플랫폼 확장: 공지사항 + 체력단련 마일리지
-- 0001~0004 적용 후 실행하세요.

-- 공지사항 (작성/수정/삭제는 관리자 검증 후 service role로 수행 — RLS는 읽기만 허용)
create table if not exists notices (
  id         bigserial primary key,
  title      text not null,
  content    text not null,
  pinned     boolean default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz default now()
);
create index if not exists notices_created_idx on notices(pinned desc, created_at desc);

-- 체력단련 운동 기록 (마일리지는 서버에서 계산해 저장 — 클라이언트 값 신뢰 금지)
create table if not exists workout_logs (
  id           bigserial primary key,
  user_id      uuid references auth.users(id) on delete cascade,
  activity     text not null,            -- 달리기 | 근력운동 | 등산 | 수영 | 자전거 | 기타
  duration_min int not null check (duration_min between 1 and 360),
  note         text,
  points       int not null default 0,   -- 적립 마일리지(서버 계산)
  performed_on date not null default current_date,
  created_at   timestamptz default now()
);
create index if not exists workout_logs_user_idx on workout_logs(user_id, performed_on desc);
create index if not exists workout_logs_performed_idx on workout_logs(performed_on desc);

-- RLS
alter table notices      enable row level security;
alter table workout_logs enable row level security;

drop policy if exists "authenticated read notices" on notices;
create policy "authenticated read notices" on notices
  for select to authenticated using (true);

drop policy if exists "own workout_logs" on workout_logs;
create policy "own workout_logs" on workout_logs for all using (auth.uid() = user_id);

drop policy if exists "admin read workout_logs" on workout_logs;
create policy "admin read workout_logs" on workout_logs for select using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);

-- 마일리지 리더보드 (모든 인증 사용자가 조회 — 이름·소속·합계만 노출)
create or replace function fitness_leaderboard(since date default null)
returns table (user_id uuid, full_name text, division text, total_points bigint)
language sql security definer stable
set search_path = public
as $$
  select w.user_id, p.full_name, p.division, sum(w.points)::bigint as total_points
  from workout_logs w
  join profiles p on p.id = w.user_id
  where since is null or w.performed_on >= since
  group by w.user_id, p.full_name, p.division
  order by total_points desc
  limit 20;
$$;

revoke all on function fitness_leaderboard(date) from public;
grant execute on function fitness_leaderboard(date) to authenticated;
