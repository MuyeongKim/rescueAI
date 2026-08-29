-- 비공개 교범 원본을 인증된 사용자만 읽을 수 있게 한다.
-- 브라우저에는 service role 키를 노출하지 않고, 사용자 세션으로 짧은 서명 URL을 만든다.
insert into storage.buckets (id, name, public, allowed_mime_types)
values ('documents', 'documents', false, array['application/pdf'])
on conflict (id) do update
set public = false,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "authenticated read document files" on storage.objects;
create policy "authenticated read document files"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'documents'
  and storage.allow_any_operation(array[
    'storage.object.sign',
    'storage.object.get_authenticated'
  ])
  and exists (
    select 1
    from public.profiles as p
    where p.id = (select auth.uid())
      and p.must_change_password = false
  )
  and exists (
    select 1
    from public.documents as d
    where d.status = 'processed'
      and d.file_url = storage.objects.name
      and d.file_url !~* '^https?://'
  )
);

-- 저장 개수 검사는 API의 사전 안내와 별개로 DB에서 직렬화해 동시 삽입 우회를 막는다.
-- trigger 함수는 외부에서 직접 호출할 이유가 없으므로 PUBLIC 실행 권한을 제거한다.
create or replace function public.enforce_generated_materials_user_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.user_id is null then
    raise exception 'generated_materials_user_id_required' using errcode = '23502';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.user_id::text, 0)
  );

  if (
    select count(*)
    from public.generated_materials as gm
    where gm.user_id = new.user_id
  ) >= 200 then
    raise exception 'generated_materials_user_limit_exceeded' using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_generated_materials_user_limit() from public, anon, authenticated;

drop trigger if exists enforce_generated_materials_user_limit on public.generated_materials;
create trigger enforce_generated_materials_user_limit
before insert on public.generated_materials
for each row execute function public.enforce_generated_materials_user_limit();
