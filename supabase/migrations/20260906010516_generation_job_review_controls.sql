-- Review projections are deliberately separate from private checkpoints and official results.
alter table public.generation_jobs
  add column if not exists review_outline jsonb,
  add column if not exists review_draft jsonb,
  add column if not exists quality_issues jsonb not null default '[]'::jsonb;

alter table public.generation_jobs drop constraint if exists generation_jobs_status_valid;
alter table public.generation_jobs add constraint generation_jobs_status_valid check (
  status in ('queued', 'retrieving', 'drafting', 'reviewing', 'repairing',
    'awaiting_review', 'cancelled', 'completed', 'needs_attention', 'failed')
);
alter table public.generation_jobs drop constraint if exists generation_jobs_review_projection_valid;
alter table public.generation_jobs add constraint generation_jobs_review_projection_valid check (
  (review_outline is null or (jsonb_typeof(review_outline) = 'object' and pg_column_size(review_outline) <= 65536))
  and (review_draft is null or (jsonb_typeof(review_draft) = 'object' and pg_column_size(review_draft) <= 1048576))
  and jsonb_typeof(quality_issues) = 'array' and pg_column_size(quality_issues) <= 131072
);
-- Awaiting user review uses no provider quota and does not occupy the running-job slot.
-- Starting a reviewed job still goes through the existing one-active-job unique index.
grant select (review_outline, review_draft, quality_issues) on public.generation_jobs to authenticated;
comment on column public.generation_jobs.review_outline is '사용자에게 공개하는 목차·시간·부족 근거 요약. 원문·실행 토큰은 제외한다.';
comment on column public.generation_jobs.review_draft is '미검증 초안의 검토·편집용 공개 사본. 공식 저장·공유·내보내기 품질 통과를 뜻하지 않는다.';
comment on column public.generation_jobs.quality_issues is '사용자가 보완할 부분과 권장 조치. worker 전용 상태는 제외한다.';
