-- 완성본과 분리된 개인 편집 초안. 품질 미통과 내용도 보존하지만 공유하지 않는다.
create table if not exists public.generation_drafts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  draft_key text not null check (length(draft_key) between 1 and 200),
  snapshot jsonb not null check (
    jsonb_typeof(snapshot) = 'object' and octet_length(snapshot::text) <= 1048576
  ),
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generation_drafts_owner_key unique (user_id, draft_key)
);
create index if not exists generation_drafts_owner_updated_idx
  on public.generation_drafts (user_id, updated_at desc);

alter table public.generation_drafts enable row level security;
revoke all on table public.generation_drafts from public, anon, authenticated;
grant select, insert, update, delete on table public.generation_drafts to authenticated;
grant all privileges on table public.generation_drafts to service_role;

drop policy if exists generation_drafts_owner_select on public.generation_drafts;
create policy generation_drafts_owner_select on public.generation_drafts
  for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists generation_drafts_owner_insert on public.generation_drafts;
create policy generation_drafts_owner_insert on public.generation_drafts
  for insert to authenticated with check ((select auth.uid()) = user_id);
drop policy if exists generation_drafts_owner_update on public.generation_drafts;
create policy generation_drafts_owner_update on public.generation_drafts
  for update to authenticated using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
drop policy if exists generation_drafts_owner_delete on public.generation_drafts;
create policy generation_drafts_owner_delete on public.generation_drafts
  for delete to authenticated using ((select auth.uid()) = user_id);

create or replace function public.set_generation_draft_revision()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.revision := 1;
    new.created_at := pg_catalog.statement_timestamp();
  else
    if new.user_id is distinct from old.user_id
       or new.draft_key is distinct from old.draft_key
       or new.id is distinct from old.id then
      raise exception 'generation_draft_identity_immutable' using errcode = '23514';
    end if;
    new.created_at := old.created_at;
    new.revision := old.revision + 1;
  end if;
  new.updated_at := pg_catalog.statement_timestamp();
  return new;
end;
$$;
revoke all on function public.set_generation_draft_revision() from public, anon, authenticated;
drop trigger if exists set_generation_draft_revision on public.generation_drafts;
create trigger set_generation_draft_revision
  before insert or update on public.generation_drafts
  for each row execute function public.set_generation_draft_revision();
