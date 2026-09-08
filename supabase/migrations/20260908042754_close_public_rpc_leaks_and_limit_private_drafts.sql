-- 질문 원문은 계정 간에 공유하지 않는다. 기존 RPC 계약은 유지하되 RLS와 소유권을
-- 함께 적용하고, Supabase에 남아 있을 수 있는 역할별 명시적 EXECUTE도 회수한다.
begin;

create or replace function public.popular_questions(
  days integer default 30,
  min_count integer default 2,
  max_rows integer default 8
)
returns table (question text, cnt bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select pg_catalog.btrim(m.content) as question, count(*)::bigint as cnt
  from public.messages as m
  join public.conversations as c on c.id = m.conversation_id
  where c.user_id = (select auth.uid())
    and m.role = 'user'
    and m.created_at >= pg_catalog.now() - pg_catalog.make_interval(
      days => least(greatest(coalesce(days, 30), 1), 90)
    )
    and pg_catalog.char_length(pg_catalog.btrim(m.content)) between 4 and 100
  group by pg_catalog.btrim(m.content)
  having count(*) >= greatest(coalesce(min_count, 2), 2)
  order by cnt desc, question
  limit least(greatest(coalesce(max_rows, 8), 0), 8);
$$;

revoke all on function public.popular_questions(integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.popular_questions(integer, integer, integer)
  to authenticated;
comment on function public.popular_questions(integer, integer, integer) is
  '현재 계정의 반복 질문만 최근 90일·최대 8개 범위에서 반환한다. 다른 계정의 질문은 공개하지 않는다.';

-- 제거된 체력 기능의 데이터는 보존하되 이름·소속을 반환하는 RPC는 더 이상 공개하지 않는다.
revoke all on function public.fitness_leaderboard(date)
  from public, anon, authenticated;

-- 동시 탭·공용 계정 세션의 합산 사용량은 한 행의 원자적 UPDATE로 검사한다.
-- 앱의 사전 count와 관계없이 INSERT/UPDATE/DELETE 및 직접 Data API 호출에 적용된다.
create schema if not exists generation_private;
revoke all on schema generation_private from public, anon, authenticated;

create table if not exists generation_private.draft_storage_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  unsaved_count bigint not null default 0 check (unsaved_count >= 0),
  saved_count bigint not null default 0 check (saved_count >= 0),
  snapshot_bytes bigint not null default 0 check (snapshot_bytes >= 0)
);
alter table generation_private.draft_storage_usage enable row level security;
revoke all on table generation_private.draft_storage_usage
  from public, anon, authenticated, service_role;

-- 기존 행을 지우거나 수정하지 않고 사용량만 집계한다. 이 잠금은 백필부터 트리거
-- 설치까지 다른 쓰기가 틈으로 빠져나가지 않게 하며 트랜잭션 종료 시 풀린다.
lock table public.generation_drafts in share row exclusive mode;
insert into generation_private.draft_storage_usage (
  user_id, unsaved_count, saved_count, snapshot_bytes
)
select user_id,
  count(*) filter (where not coalesce(snapshot -> 'saved' = 'true'::jsonb, false)),
  count(*) filter (where coalesce(snapshot -> 'saved' = 'true'::jsonb, false)),
  coalesce(sum(pg_catalog.octet_length(snapshot::text)), 0)
from public.generation_drafts
group by user_id
on conflict (user_id) do update set
  unsaved_count = excluded.unsaved_count,
  saved_count = excluded.saved_count,
  snapshot_bytes = excluded.snapshot_bytes;
update generation_private.draft_storage_usage as usage
set unsaved_count = 0, saved_count = 0, snapshot_bytes = 0
where not exists (
  select 1 from public.generation_drafts as draft where draft.user_id = usage.user_id
);

create or replace function public.enforce_generation_draft_storage_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_unsaved_delta bigint := 0;
  v_saved_delta bigint := 0;
  v_bytes_delta bigint := 0;
  v_applied boolean := false;
begin
  if tg_op <> 'INSERT' then
    v_user_id := old.user_id;
    if coalesce(old.snapshot -> 'saved' = 'true'::jsonb, false) then
      v_saved_delta := -1;
    else
      v_unsaved_delta := -1;
    end if;
    v_bytes_delta := -pg_catalog.octet_length(old.snapshot::text);
  end if;
  if tg_op <> 'DELETE' then
    if tg_op = 'UPDATE' and new.user_id is distinct from old.user_id then
      raise exception 'generation_draft_identity_immutable' using errcode = '23514';
    end if;
    v_user_id := new.user_id;
    if coalesce(new.snapshot -> 'saved' = 'true'::jsonb, false) then
      v_saved_delta := v_saved_delta + 1;
    else
      v_unsaved_delta := v_unsaved_delta + 1;
    end if;
    v_bytes_delta := v_bytes_delta + pg_catalog.octet_length(new.snapshot::text);
    insert into generation_private.draft_storage_usage (user_id)
      values (v_user_id) on conflict (user_id) do nothing;
  end if;

  -- 저장 완료 사본까지 합계 200 MiB, 미저장·저장 완료 초안은 각각 200개다.
  -- 기존 데이터가 초과해도 삭제·축소는 허용하고 새 증가분만 차단한다.
  update generation_private.draft_storage_usage as usage
  set unsaved_count = usage.unsaved_count + v_unsaved_delta,
      saved_count = usage.saved_count + v_saved_delta,
      snapshot_bytes = usage.snapshot_bytes + v_bytes_delta
  where usage.user_id = v_user_id
    and (v_unsaved_delta <= 0 or usage.unsaved_count + v_unsaved_delta <= 200)
    and (v_saved_delta <= 0 or usage.saved_count + v_saved_delta <= 200)
    and (v_bytes_delta <= 0 or usage.snapshot_bytes + v_bytes_delta <= 209715200)
  returning true into v_applied;

  if not coalesce(v_applied, false) and tg_op <> 'DELETE' then
    raise exception 'generation_drafts_storage_limit_exceeded'
      using errcode = 'P0001',
            hint = 'Remove old private drafts, including saved copies, before retrying.';
  end if;
  return null;
end;
$$;
revoke all on function public.enforce_generation_draft_storage_limit()
  from public, anon, authenticated, service_role;
drop trigger if exists enforce_generation_draft_storage_limit on public.generation_drafts;
create trigger enforce_generation_draft_storage_limit
after insert or update or delete on public.generation_drafts
for each row execute function public.enforce_generation_draft_storage_limit();

commit;
