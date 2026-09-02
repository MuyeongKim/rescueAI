-- 품질 우선 AI 자료제작을 요청-응답 수명과 분리해 추적하는 내구성 작업 원장.
--
-- 인증 사용자는 자신의 작업에서 공개 컬럼만 조회할 수 있다.
-- 생성과 모든 변경은 인증 API가 위임한 서버 작업자(service_role)만 수행한다.

create table if not exists public.generation_jobs (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  status             text not null default 'queued',
  stage              text not null default 'queued',
  request            jsonb not null,
  result             jsonb,
  checkpoint         jsonb not null default '{}'::jsonb,
  progress           integer not null default 0,
  attempt            integer not null default 0,
  revision           bigint not null default 0,
  estimated_seconds  integer not null default 300,
  quality_passed     boolean not null default false,
  workflow_run_id    text,
  run_token           uuid,
  client_request_id  uuid not null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  last_progress_at   timestamptz not null default now(),
  workflow_checked_at timestamptz,
  workflow_missing_count integer not null default 0,
  workflow_missing_since timestamptz,
  started_at         timestamptz,
  completed_at       timestamptz,
  error_message      text,

  constraint generation_jobs_status_valid check (
    status in (
      'queued',
      'retrieving',
      'drafting',
      'reviewing',
      'repairing',
      'completed',
      'needs_attention',
      'failed'
    )
  ),
  constraint generation_jobs_stage_length check (
    pg_catalog.char_length(stage) between 1 and 100
  ),
  constraint generation_jobs_request_object check (
    pg_catalog.jsonb_typeof(request) = 'object'
  ),
  constraint generation_jobs_request_size check (
    pg_catalog.pg_column_size(request) <= 32768
  ),
  constraint generation_jobs_result_object check (
    result is null or pg_catalog.jsonb_typeof(result) = 'object'
  ),
  constraint generation_jobs_result_final_only check (
    status = 'completed' or result is null
  ),
  constraint generation_jobs_result_size check (
    result is null or pg_catalog.pg_column_size(result) <= 1048576
  ),
  constraint generation_jobs_checkpoint_object check (
    pg_catalog.jsonb_typeof(checkpoint) = 'object'
  ),
  constraint generation_jobs_checkpoint_size check (
    pg_catalog.pg_column_size(checkpoint) <= 1048576
  ),
  constraint generation_jobs_progress_range check (progress between 0 and 100),
  constraint generation_jobs_attempt_nonnegative check (attempt >= 0),
  constraint generation_jobs_revision_nonnegative check (revision >= 0),
  constraint generation_jobs_workflow_missing_count_range check (
    workflow_missing_count between 0 and 100
  ),
  constraint generation_jobs_estimated_seconds_range check (
    estimated_seconds between 1 and 86400
  ),
  constraint generation_jobs_completed_quality check (
    (
      status = 'completed'
      and quality_passed
      and result is not null
    )
    or (
      status <> 'completed'
      and not quality_passed
    )
  ),
  constraint generation_jobs_workflow_run_id_length check (
    workflow_run_id is null or pg_catalog.char_length(workflow_run_id) <= 200
  ),
  constraint generation_jobs_error_message_length check (
    error_message is null or pg_catalog.char_length(error_message) <= 2000
  ),
  constraint generation_jobs_user_client_request_unique unique (
    user_id,
    client_request_id
  )
);

comment on table public.generation_jobs is
  '품질 우선 AI 자료제작의 단계, 재시도 및 최종 결과를 보존하는 사용자별 작업 원장';
comment on column public.generation_jobs.stage is
  '상태 안에서 사용자에게 표시할 세부 작업 단계. 서버 작업자만 변경한다.';
comment on column public.generation_jobs.request is
  '서버가 다시 검증할 자료제작 요청 스냅샷. 비밀값이나 원문 파일 데이터는 저장하지 않는다.';
comment on column public.generation_jobs.result is
  '검증을 마친 생성 결과. 작업 완료 전 중간 결과는 사용자에게 완성본으로 취급하지 않는다.';
comment on column public.generation_jobs.checkpoint is
  '워크플로 재시작용 전체 개요와 완료 batch. 사용자 상태 API 응답에는 포함하지 않는다.';
comment on column public.generation_jobs.revision is
  '폴링 응답 순서 판별용 단조 증가 버전. 행이 갱신될 때마다 서버 트리거가 1 증가시킨다.';
comment on column public.generation_jobs.quality_passed is
  '최종 품질 게이트 통과 여부. completed 상태 및 비어 있지 않은 result와 함께만 참이다.';
comment on column public.generation_jobs.run_token is
  '동일 작업의 오래된 실행이 최신 상태를 덮지 못하게 하는 서버 작업자 실행 토큰';
comment on column public.generation_jobs.last_progress_at is
  '상태·진행률·체크포인트가 실제로 전진한 마지막 시각. Workflow 상태 확인 시각과 분리한다.';
comment on column public.generation_jobs.workflow_checked_at is
  '멈춘 작업의 Workflow 상태 조회를 과도하게 반복하지 않기 위한 최근 확인 시각';
comment on column public.generation_jobs.workflow_missing_count is
  'Workflow run 404를 일시적 조회 지연과 구분하기 위한 연속 확인 횟수';
comment on column public.generation_jobs.workflow_missing_since is
  '현재 연속 Workflow run 404가 처음 확인된 시각';

create index if not exists generation_jobs_user_created_idx
  on public.generation_jobs (user_id, created_at desc);

create index if not exists generation_jobs_queued_idx
  on public.generation_jobs (created_at, id)
  where status = 'queued';

create index if not exists generation_jobs_workflow_run_idx
  on public.generation_jobs (workflow_run_id)
  where workflow_run_id is not null;

create unique index if not exists generation_jobs_run_token_idx
  on public.generation_jobs (run_token)
  where run_token is not null;

-- 한 사용자가 여러 탭에서 정밀 Workflow를 동시에 쏘아 provider quota를 고갈시키지 않게 한다.
-- 완료/실패/보완필요 상태가 되면 인덱스에서 빠져 다음 작업을 시작할 수 있다.
create unique index if not exists generation_jobs_one_active_per_user_idx
  on public.generation_jobs (user_id)
  where status in ('queued', 'retrieving', 'drafting', 'reviewing', 'repairing');

create or replace function public.set_generation_job_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.statement_timestamp();
  if new.status is distinct from old.status
     or new.stage is distinct from old.stage
     or new.progress is distinct from old.progress
     or new.checkpoint is distinct from old.checkpoint then
    new.last_progress_at := pg_catalog.statement_timestamp();
    -- 실제 작업이 다시 전진했다면 이전의 일시적 Workflow 404는 더 이상 연속 실패가 아니다.
    new.workflow_missing_count := 0;
    new.workflow_missing_since := null;
  end if;
  new.revision := old.revision + 1;
  return new;
end;
$$;

revoke all on function public.set_generation_job_updated_at()
  from public, anon, authenticated;
grant execute on function public.set_generation_job_updated_at()
  to service_role;

drop trigger if exists set_generation_job_updated_at
  on public.generation_jobs;
create trigger set_generation_job_updated_at
before update on public.generation_jobs
for each row execute function public.set_generation_job_updated_at();

alter table public.generation_jobs enable row level security;

drop policy if exists generation_jobs_owner_select
  on public.generation_jobs;
create policy generation_jobs_owner_select
on public.generation_jobs
for select
to authenticated
using ((select auth.uid()) = user_id);

-- Supabase 프로젝트별 기본 권한 설정과 무관하게 Data API 표면을 명시한다.
-- checkpoint와 run_token은 authenticated의 열 권한에서도 제외해 직접 조회를 막는다.
revoke all on table public.generation_jobs
  from public, anon, authenticated, service_role;
grant select (
  id,
  user_id,
  status,
  stage,
  request,
  result,
  progress,
  attempt,
  revision,
  estimated_seconds,
  quality_passed,
  workflow_run_id,
  created_at,
  updated_at,
  started_at,
  completed_at,
  error_message
) on table public.generation_jobs
  to authenticated;
grant all privileges on table public.generation_jobs
  to service_role;
