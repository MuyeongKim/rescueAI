-- ⚠️ 자동 생성 파일 — 직접 수정하지 마세요.
--    출처: supabase/migrations/*.sql  ·  재생성: npm run sql:setup
--
-- 새 Supabase 프로젝트를 세울 때 이 파일 전체를 SQL Editor 에 붙여 한 번에 실행하세요.
-- 마이그레이션을 순서대로 이어붙인 것이라, 기존 프로젝트에 개별 마이그레이션을 적용한 결과와
-- 동일한 스키마가 됩니다. (중간에 만들었다가 지우는 테이블이 보이는 것은 정상 — 이력 그대로입니다.)
--
-- 포함된 마이그레이션 24개:
--   · 0001_init.sql
--   · 0002_hybrid_search.sql
--   · 0003_triggers_rls.sql
--   · 0004_learning.sql
--   · 0005_platform.sql
--   · 0006_remove_quiz.sql
--   · 0007_profile_fields.sql
--   · 0008_news.sql
--   · 0009_generated_materials.sql
--   · 0010_lock_profile_role.sql
--   · 0011_popular_questions.sql
--   · 0012_share_materials.sql
--   · 20260726100515_secure_versioned_rag_ingestion.sql
--   · 20260808090000_fix_hybrid_search_and_cleanup.sql
--   · 20260808091000_admin_dashboard_stats.sql
--   · 20260827131016_remove_retired_mileage_stats.sql
--   · 20260828032304_add_rag_corpus_release_switch.sql
--   · 20260828115838_allow_authenticated_document_downloads.sql
--   · 20260829052407_protect_generated_material_sharing.sql
--   · 20260829140500_classify_rag_procedure_sources.sql
--   · 20260829160624_allow_common_sop_generation_evidence.sql
--   · 20260829163049_protect_generated_material_quality_and_revision.sql
--   · 20260902021457_add_login_access_counter.sql
--   · 20260902094825_durable_generation_jobs.sql

-- ============================================================================
-- 0001_init.sql
-- ============================================================================

-- 0001_init.sql — 확장 + 테이블 (PRD §6.1)
-- Supabase SQL Editor에서 0001 → 0002 → 0003 순서로 실행하세요.

create extension if not exists vector;
create extension if not exists pg_trgm;

-- 사용자 프로필 (auth.users 확장)
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  role       text default 'user',     -- user | admin
  division   text,                    -- 소속 구조대
  created_at timestamptz default now()
);

-- 자료 메타데이터
create table if not exists documents (
  id                bigserial primary key,
  title             text not null,
  source_type       text not null,      -- pdf | hwpx | pptx | video
  category          text,               -- 산악 | 수난 | 화재 | 구급
  equipment         text[],
  difficulty        text,               -- 초급 | 중급 | 고급
  original_filename text,
  file_url          text,               -- Supabase Storage URL
  publish_date      date,
  status            text default 'processed',  -- processing | processed | failed
  created_at        timestamptz default now()
);
create index if not exists documents_category_idx on documents(category);
create index if not exists documents_status_idx on documents(status);

-- 인덱싱된 청크 (RAG 두뇌)
create table if not exists chunks (
  id            bigserial primary key,
  document_id   bigint references documents(id) on delete cascade,
  content       text not null,
  embedding     vector(1024),
  page_num      int,
  section_title text,
  metadata      jsonb default '{}'::jsonb,
  tsv           tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at    timestamptz default now()
);
create index if not exists chunks_embedding_idx on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index if not exists chunks_tsv_idx on chunks using gin(tsv);
create index if not exists chunks_doc_idx on chunks(document_id);

-- 대화 세션
create table if not exists conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,
  title      text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index if not exists conversations_user_idx on conversations(user_id, updated_at desc);

-- 메시지 (질문·답변)
create table if not exists messages (
  id              bigserial primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  role            text not null,      -- user | assistant
  content         text not null,
  sources         jsonb,              -- [{document_id, doc, page, content}]
  feedback        smallint,           -- 1=👍, -1=👎, null=미평가
  latency_ms      int,
  created_at      timestamptz default now()
);
create index if not exists messages_conv_idx on messages(conversation_id, created_at);
create index if not exists messages_created_idx on messages(created_at desc);


-- ============================================================================
-- 0002_hybrid_search.sql
-- ============================================================================

-- 0002_hybrid_search.sql — 하이브리드 검색 RPC (PRD §6.2)
-- 벡터(코사인 거리) + 키워드(tsvector) 결과를 RRF(k=60)로 결합한다.

create or replace function hybrid_search(
  query_text       text,
  query_embedding  vector(1024),
  match_count      int default 5,
  filter_category  text default null
)
returns table (
  chunk_id bigint, document_id bigint, doc_title text,
  content text, page_num int, rrf_score float
)
language sql as $$
  with vector_search as (
    select c.id, row_number() over (order by c.embedding <-> query_embedding) as rank
    from chunks c join documents d on d.id = c.document_id
    where filter_category is null or d.category = filter_category
    order by c.embedding <-> query_embedding
    limit 30
  ),
  keyword_search as (
    select c.id, row_number() over (order by ts_rank(c.tsv, plainto_tsquery('simple', query_text)) desc) as rank
    from chunks c join documents d on d.id = c.document_id
    where c.tsv @@ plainto_tsquery('simple', query_text)
      and (filter_category is null or d.category = filter_category)
    limit 30
  ),
  combined as (
    select id, sum(1.0 / (60 + rank)) as rrf_score
    from (select id, rank from vector_search
          union all
          select id, rank from keyword_search) u
    group by id
  )
  select c.id, c.document_id, d.title, c.content, c.page_num, cb.rrf_score
  from combined cb
  join chunks c on c.id = cb.id
  join documents d on d.id = c.document_id
  order by cb.rrf_score desc
  limit match_count;
$$;


-- ============================================================================
-- 0003_triggers_rls.sql
-- ============================================================================

-- 0003_triggers_rls.sql — 트리거 + RLS (PRD §6.3)
-- 재실행 가능하도록 drop if exists 가드를 추가했다.

-- 회원가입 시 profiles 자동 생성
-- security definer + set search_path=public 필수: GoTrue(supabase_auth_admin 역할)가
-- 계정 생성 시 이 트리거를 실행하는데, search_path 미설정 + 미한정 테이블이면
-- profiles 를 못 찾아 "Database error creating new user" 로 롤백된다.
create or replace function handle_new_user()
returns trigger language plpgsql security definer
set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
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


-- ============================================================================
-- 0004_learning.sql
-- ============================================================================

-- 0004_learning.sql — 교육훈련 플랫폼: 학습 진도 + 퀴즈 이수
-- 과정(course) = 카테고리, 레슨(lesson) = 해당 카테고리의 documents (자료 자동 편성).
-- 0001~0003 적용 후 실행하세요.

-- 레슨(자료) 학습 완료 기록
create table if not exists lesson_progress (
  id          bigserial primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  document_id bigint references documents(id) on delete cascade,
  created_at  timestamptz default now(),
  unique (user_id, document_id)
);
create index if not exists lesson_progress_user_idx on lesson_progress(user_id);
create index if not exists lesson_progress_doc_idx on lesson_progress(document_id);

-- 퀴즈 응시/이수 기록 (questions: [{question, choices[], answerIndex, explanation, source, selected}])
create table if not exists quiz_attempts (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  category   text,
  score      int,
  total      int,
  passed     boolean default false,
  questions  jsonb,
  created_at timestamptz default now()
);
create index if not exists quiz_attempts_user_idx on quiz_attempts(user_id, created_at desc);
create index if not exists quiz_attempts_category_idx on quiz_attempts(category);

-- RLS
alter table lesson_progress enable row level security;
alter table quiz_attempts   enable row level security;

drop policy if exists "own lesson_progress" on lesson_progress;
create policy "own lesson_progress" on lesson_progress for all using (auth.uid() = user_id);

drop policy if exists "own quiz_attempts" on quiz_attempts;
create policy "own quiz_attempts" on quiz_attempts for all using (auth.uid() = user_id);

-- 관리자 통계용 (profiles 하위쿼리는 "own profile select"로 해결되어 재귀하지 않음)
drop policy if exists "admin read lesson_progress" on lesson_progress;
create policy "admin read lesson_progress" on lesson_progress for select using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
drop policy if exists "admin read quiz_attempts" on quiz_attempts;
create policy "admin read quiz_attempts" on quiz_attempts for select using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);


-- ============================================================================
-- 0005_platform.sql
-- ============================================================================

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


-- ============================================================================
-- 0006_remove_quiz.sql
-- ============================================================================

-- 0006_remove_quiz.sql — 퀴즈 기능 제거
-- 회의 결정(2026-06-11): 퀴즈 이수 대신 "분야의 모든 자료 학습 완료 = 이수"로 단순화.
-- 진도는 lesson_progress 가 계속 담당한다.

drop table if exists quiz_attempts;


-- ============================================================================
-- 0007_profile_fields.sql
-- ============================================================================

-- 0007_profile_fields.sql — profiles 직원 정보 확장 (일괄 등록용)
-- 0001~0006 적용 후 실행하세요. 재실행 안전(if not exists).
--
-- 일괄 등록(scripts/import-users.mjs)에서 받는 직원 데이터를 저장한다:
--   계급(rank) · 팀(team) · 디지털식별번호(digital_id)
-- (이름=full_name, 소속=division, 공직자이메일=auth.users.email 은 기존 컬럼 사용)

alter table profiles add column if not exists rank       text;  -- 계급
alter table profiles add column if not exists team       text;  -- 팀
alter table profiles add column if not exists digital_id text;  -- 디지털식별번호

-- 첫 로그인 비번 변경 강제 플래그. 일괄 등록(초기 비번=디지털식별번호) 계정은 true 로 넣고,
-- 사용자가 비번을 바꾸면 false 로 내린다. 미들웨어가 true 면 /change-password 로 보낸다.
alter table profiles add column if not exists must_change_password boolean not null default false;

-- 디지털식별번호로 직원 조회가 잦으면 인덱스 도움 (중복 허용 — 유니크 강제는 명단 정합성 확인 후)
create index if not exists profiles_digital_id_idx on profiles(digital_id);


-- ============================================================================
-- 0008_news.sql
-- ============================================================================

-- 0008_news.sql — 구조 동향(뉴스) 테이블. 수동 큐레이션(A) + 자동수집(B) 공용.
-- 0001~0007 적용 후 실행. 재실행 안전.

create table if not exists news (
  id           bigserial primary key,
  title        text not null,
  summary      text,
  source       text,                            -- 출처명 (예: 소방청 보도자료, Google News)
  url          text,                            -- 원문 링크
  region       text,                            -- 전국 | 해외
  category     text,                            -- 수난/화재/산악/구급/드론 등
  published_on date,                            -- 기사 날짜
  pinned       boolean not null default false,  -- 상단 고정
  hidden       boolean not null default false,  -- 검수: 숨김(목록에서 제외)
  auto         boolean not null default false,  -- 자동수집 여부(true=B로 수집됨)
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz default now()
);

-- 자동수집 중복 방지: url 이 있는 경우만 유니크(수동 등록은 url 없이도 가능)
create unique index if not exists news_url_uniq on news(url) where url is not null;
-- 피드 정렬 가속(고정 우선, 최신 우선)
create index if not exists news_feed_idx on news(hidden, pinned desc, published_on desc, created_at desc);

alter table news enable row level security;

-- 인증 사용자는 숨김 아닌 항목만 읽기. 작성/수정/삭제·자동수집은 관리자 검증 후 service role(RLS 우회).
drop policy if exists "authenticated read news" on news;
create policy "authenticated read news" on news
  for select to authenticated using (hidden = false);


-- ============================================================================
-- 0009_generated_materials.sql
-- ============================================================================

-- 0009_generated_materials.sql — AI 자료제작 생성물 저장·이력 (개인 비공개)
-- 0001~0008 적용 후 실행하세요.
--
-- 사용자가 /generate 에서 만든 훈련계획·교안·슬라이드·NotebookLM 프롬프트를 저장한다.
-- content(jsonb)에 결과 전체(sections|slides|prompt + sources)를 담아 복원·재다운로드가 가능하게 한다.
-- 본인 것만 조회·저장·삭제(RLS). 관리자 열람 없음(순수 개인 비공개).

create table if not exists generated_materials (
  id         bigserial primary key,
  user_id    uuid references auth.users(id) on delete cascade,
  kind       text not null,        -- plan | lesson | slides | notebooklm
  category   text,
  audience   text,
  duration   text,
  topic      text,
  title      text not null,
  content    jsonb not null,       -- {sections|slides|prompt, sources} 통째로 저장
  created_at timestamptz default now()
);
create index if not exists generated_materials_user_idx
  on generated_materials(user_id, created_at desc);

-- RLS: 본인 행만 전부(조회·삽입·수정·삭제). with check 로 타 user_id 위조 삽입 차단.
alter table generated_materials enable row level security;

drop policy if exists "own generated_materials" on generated_materials;
create policy "own generated_materials" on generated_materials
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);


-- ============================================================================
-- 0010_lock_profile_role.sql
-- ============================================================================

-- 0010_lock_profile_role.sql — profiles.role 자가 승격 차단
--
-- 문제: "own profile update" 정책(0003)이 본인 행의 모든 컬럼 수정을 허용해,
--       일반 사용자가 브라우저에서 update({role:'admin'}) 로 스스로 관리자 승격이 가능했다.
-- 해결: role 이 바뀌는데 호출자가 service_role(관리자 API)이 아니면 조용히 원복하는 트리거.
--       - current_user 는 PostgREST 가 요청마다 SET ROLE 로 전환한 실제 역할을 반영한다
--         (일반 사용자=authenticated, 관리자 API=service_role via lib/supabase/admin.ts).
--       - SECURITY DEFINER 를 쓰지 않는다: definer 면 current_user 가 함수 소유자로 바뀌어 검사가 무력화됨.
--       - change-password 의 must_change_password 등 role 외 컬럼 self-update 는 그대로 동작(트리거 no-op).
-- 재실행 안전.

create or replace function protect_profile_role()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and current_user <> 'service_role' then
    new.role := old.role;  -- 승격/강등 시도 무시(에러 대신 기존 값 유지)
  end if;
  return new;
end; $$;

drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function protect_profile_role();


-- ============================================================================
-- 0011_popular_questions.sql
-- ============================================================================

-- 0011_popular_questions.sql — 챗봇 인기 질문 집계 RPC.
--
-- messages 는 "본인 것만" RLS 라 일반 사용자가 남의 질문을 못 읽는다.
-- 이 함수는 SECURITY DEFINER 로 전체를 집계하되 **질문 문장 + 횟수만** 반환한다
-- (작성자·원본 메시지 미노출). min_count 임계값으로 1회성·개인적 질문은 제외한다.

create or replace function popular_questions(
  days      int default 30,
  min_count int default 2,
  max_rows  int default 8
)
returns table (question text, cnt bigint)
language sql security definer stable
set search_path = public
as $$
  select btrim(content) as question, count(*)::bigint as cnt
  from messages
  where role = 'user'
    and created_at >= now() - make_interval(days => days)
    and char_length(btrim(content)) between 4 and 100
  group by btrim(content)
  having count(*) >= min_count
  order by cnt desc, question
  limit max_rows;
$$;

revoke all on function popular_questions(int, int, int) from public;
grant execute on function popular_questions(int, int, int) to authenticated;


-- ============================================================================
-- 0012_share_materials.sql
-- ============================================================================

-- 0012_share_materials.sql — AI 자료제작 생성물 공유(동료가 만든 자료 열람).
--
-- 기본은 비공개(0009). 사용자가 명시적으로 공유(shared=true)한 자료만 다른 인증 사용자가 조회.
-- 작성자 이름은 profiles RLS(본인만) 때문에 조회할 수 없어 공유 시점에 비정규화 저장한다.

alter table generated_materials add column if not exists shared boolean not null default false;
alter table generated_materials add column if not exists author_name text;

-- 공유 목록 정렬 가속(공유된 행만 부분 인덱스)
create index if not exists generated_materials_shared_idx
  on generated_materials(created_at desc) where shared;

-- 읽기 정책 추가: 공유된 행은 인증 사용자 누구나 조회(기존 "본인 전체" 정책과 OR).
-- 쓰기/수정/삭제는 여전히 본인만("own generated_materials" for all with check).
drop policy if exists "shared materials read" on generated_materials;
create policy "shared materials read" on generated_materials
  for select to authenticated using (shared = true);


-- ============================================================================
-- 20260726100515_secure_versioned_rag_ingestion.sql
-- ============================================================================

-- 외부 RAG 테이블 보안 강화 및 무중단 버전 교체.
-- rag7.py 는 신규 청크를 is_active=false 로 먼저 적재한 뒤
-- activate_rag_rescue_ingestion()으로 검증/활성화/이전 버전 삭제를 한 트랜잭션에서 수행한다.

create extension if not exists vector;

create table if not exists public.rag_rescue (
  id           uuid primary key default gen_random_uuid(),
  content      text,
  metadata     jsonb default '{}'::jsonb,
  embedding    vector(1024),
  ingestion_id uuid,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

alter table public.rag_rescue
  add column if not exists ingestion_id uuid,
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

update public.rag_rescue
set is_active = true
where is_active is null;

alter table public.rag_rescue
  alter column is_active set default false;

create index if not exists rag_rescue_embedding_idx
  on public.rag_rescue using hnsw (embedding vector_cosine_ops);
create index if not exists rag_rescue_active_embedding_idx
  on public.rag_rescue using hnsw (embedding vector_cosine_ops)
  where is_active;
create index if not exists rag_rescue_content_fts_idx
  on public.rag_rescue using gin (to_tsvector('simple', content));
create index if not exists rag_rescue_active_content_fts_idx
  on public.rag_rescue using gin (to_tsvector('simple', content))
  where is_active;
create index if not exists rag_rescue_metadata_idx
  on public.rag_rescue using gin (metadata);
create index if not exists rag_rescue_active_source_idx
  on public.rag_rescue (
    is_active,
    (metadata ->> 'edu_category'),
    (metadata ->> 'year'),
    (metadata ->> 'source')
  );
create index if not exists rag_rescue_ingestion_idx
  on public.rag_rescue (ingestion_id);

-- 한 테이블 안에 서로 다른 임베딩 공간이 섞이지 않도록 계약을 명시한다.
create table if not exists public.rag_embedding_config (
  table_name  text primary key,
  provider    text not null,
  model       text not null,
  dimensions integer not null check (dimensions > 0),
  version     text not null,
  updated_at  timestamptz not null default now()
);

create or replace function public.match_rag_rescue (
  query_embedding vector(1024),
  match_count integer default 10,
  match_threshold double precision default 0.0,
  filter jsonb default '{}'::jsonb
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
set search_path = ''
as $$
  select
    r.id,
    r.content,
    r.metadata,
    1 - (r.embedding OPERATOR(public.<=>) query_embedding) as similarity
  from public.rag_rescue as r
  where r.is_active
    and r.metadata @> filter
    and 1 - (r.embedding OPERATOR(public.<=>) query_embedding) >= match_threshold
  order by r.embedding OPERATOR(public.<=>) query_embedding
  limit least(greatest(coalesce(match_count, 10), 0), 100);
$$;

create or replace function public.activate_rag_rescue_ingestion (
  p_ingestion_id uuid,
  p_category text,
  p_year text,
  p_source text,
  p_expected_count integer,
  p_replace_existing boolean default true
)
returns table (activated_count integer)
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
  v_total integer;
begin
  if p_ingestion_id is null
    or nullif(btrim(p_category), '') is null
    or nullif(btrim(p_year), '') is null
    or nullif(btrim(p_source), '') is null
    or p_expected_count <= 0 then
    raise exception 'invalid ingestion activation arguments';
  end if;

  -- 같은 문서의 동시 활성화를 직렬화한다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_category || E'\n' || p_year || E'\n' || p_source, 0)
  );

  select count(*)::integer
    into v_total
  from public.rag_rescue as r
  where r.ingestion_id = p_ingestion_id;

  if v_total <> p_expected_count then
    raise exception
      'staged total row count mismatch: expected %, found %',
      p_expected_count,
      v_total;
  end if;

  select count(*)::integer
    into v_count
  from public.rag_rescue as r
  where r.ingestion_id = p_ingestion_id
    and r.metadata ->> 'edu_category' = p_category
    and r.metadata ->> 'year' = p_year
    and r.metadata ->> 'source' = p_source;

  if v_count <> p_expected_count then
    raise exception
      'staged row count mismatch: expected %, found %',
      p_expected_count,
      v_count;
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.ingestion_id = p_ingestion_id
      and (
        nullif(btrim(r.content), '') is null
        or r.embedding is null
      )
  ) then
    raise exception 'staged rows contain empty content or embedding';
  end if;

  if not exists (
    select 1
    from public.rag_embedding_config as c
    where c.table_name = 'rag_rescue'
  ) then
    raise exception 'embedding contract for rag_rescue is not configured';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    join public.rag_embedding_config as c
      on c.table_name = 'rag_rescue'
    where r.ingestion_id = p_ingestion_id
      and (
        r.metadata ->> 'embedding_provider' is distinct from c.provider
        or r.metadata ->> 'embedding_model' is distinct from c.model
        or r.metadata ->> 'embedding_dimensions' is distinct from c.dimensions::text
        or r.metadata ->> 'embedding_version' is distinct from c.version
      )
  ) then
    raise exception 'staged rows do not match the rag_rescue embedding contract';
  end if;

  if p_replace_existing then
    delete from public.rag_rescue as r
    where r.ingestion_id is distinct from p_ingestion_id
      and r.metadata ->> 'edu_category' = p_category
      and r.metadata ->> 'year' = p_year
      and r.metadata ->> 'source' = p_source;
  end if;

  update public.rag_rescue as r
  set is_active = true
  where r.ingestion_id = p_ingestion_id
    and not r.is_active;

  return query select v_count;
end;
$$;

-- 로그인 사용자는 활성 자료만 읽고, 인덱서의 쓰기/활성화만 service role로 제한한다.
alter table public.rag_rescue enable row level security;
alter table public.rag_embedding_config enable row level security;

drop policy if exists rag_rescue_authenticated_read on public.rag_rescue;
create policy rag_rescue_authenticated_read
  on public.rag_rescue
  for select
  to authenticated
  using (is_active);

drop policy if exists rag_embedding_config_authenticated_read
  on public.rag_embedding_config;
create policy rag_embedding_config_authenticated_read
  on public.rag_embedding_config
  for select
  to authenticated
  using (true);

revoke all on table public.rag_rescue from public, anon, authenticated;
revoke all on table public.rag_embedding_config from public, anon, authenticated;
grant select on table public.rag_rescue to authenticated;
grant select on table public.rag_embedding_config to authenticated;
grant select, insert, update, delete on table public.rag_rescue to service_role;
grant select, insert, update, delete on table public.rag_embedding_config to service_role;

revoke all on function public.match_rag_rescue(vector, integer, double precision, jsonb)
  from public, anon, authenticated;
grant execute on function public.match_rag_rescue(vector, integer, double precision, jsonb)
  to authenticated, service_role;

revoke all on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) from public, anon, authenticated;
grant execute on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) to service_role;


-- ============================================================================
-- 20260808090000_fix_hybrid_search_and_cleanup.sql
-- ============================================================================

-- 20260808090000_fix_hybrid_search_and_cleanup.sql
-- ① hybrid_search 의 거리 연산자를 인덱스와 맞춘다.
-- ② 미사용 테이블(lesson_progress) 정리.
--
-- 파일명 규칙: 이 마이그레이션부터 `YYYYMMDDHHMMSS_설명.sql`(Supabase CLI 표준)을 쓴다.
-- 기존 0001~0012 는 이미 적용된 이력이라 이름을 바꾸지 않는다.

-- ── ① 벡터 거리 연산자 불일치 ──────────────────────────────────────────────
-- 문제: 0001 의 인덱스는 `ivfflat (embedding vector_cosine_ops)` 인데 0002 의 hybrid_search 는
--       `<->`(L2 거리)로 정렬했다. 연산자 클래스가 달라 플래너가 인덱스를 쓸 수 없고,
--       chunks 전건 스캔 + 정렬이 돌았다(자료가 늘수록 급격히 느려짐).
-- 해결: 코사인 거리 연산자 `<=>` 로 통일한다. 앱의 다른 경로(match_rag_rescue)도 `<=>` 를 쓴다.
create or replace function hybrid_search(
  query_text       text,
  query_embedding  vector(1024),
  match_count      int default 5,
  filter_category  text default null
)
returns table (
  chunk_id bigint, document_id bigint, doc_title text,
  content text, page_num int, rrf_score float
)
language sql
stable
as $$
  with vector_search as (
    select c.id, row_number() over (order by c.embedding <=> query_embedding) as rank
    from chunks c join documents d on d.id = c.document_id
    where filter_category is null or d.category = filter_category
    order by c.embedding <=> query_embedding
    limit 30
  ),
  keyword_search as (
    select c.id, row_number() over (order by ts_rank(c.tsv, plainto_tsquery('simple', query_text)) desc) as rank
    from chunks c join documents d on d.id = c.document_id
    where c.tsv @@ plainto_tsquery('simple', query_text)
      and (filter_category is null or d.category = filter_category)
    limit 30
  ),
  combined as (
    select id, sum(1.0 / (60 + rank)) as rrf_score
    from (select id, rank from vector_search
          union all
          select id, rank from keyword_search) u
    group by id
  )
  select c.id, c.document_id, d.title, c.content, c.page_num, cb.rrf_score
  from combined cb
  join chunks c on c.id = cb.id
  join documents d on d.id = c.document_id
  order by cb.rrf_score desc
  limit match_count;
$$;

-- ivfflat 은 리스트 수를 데이터 규모에 맞춰야 의미가 있고, 소규모에서는 hnsw 가 튜닝 없이도
-- 안정적이다. rag_rescue 와 동일하게 hnsw + cosine 으로 맞춘다.
drop index if exists chunks_embedding_idx;
create index if not exists chunks_embedding_hnsw_idx
  on chunks using hnsw (embedding vector_cosine_ops);

-- ── ② 미사용 테이블 정리 ──────────────────────────────────────────────────
-- 학습/진도/이수(레슨) 기능은 2026-06-18 제거됐고 lesson_progress 를 읽는 코드가 없다.
-- 남겨두면 "쓰는 줄 알고" 참조하는 코드가 다시 생긴다.
drop table if exists lesson_progress;


-- ============================================================================
-- 20260808091000_admin_dashboard_stats.sql
-- ============================================================================

-- 20260808091000_admin_dashboard_stats.sql — 관리자 대시보드 집계를 DB 로 내린다.
--
-- 문제: 페이지가 messages 5,000행(assistant) · 2,000행(user) · 20,000행(30일) 을 매 요청마다
--       앱 메모리로 끌어와 접었다. force-dynamic 이라 캐시도 없어 자료·이용량이 늘수록
--       관리자 페이지만 계속 느려지고, 상한(limit) 때문에 수치도 슬금슬금 부정확해진다.
-- 해결: 한 번의 RPC 로 Postgres 가 집계해 jsonb 로 돌려준다.
--
-- 날짜는 전부 KST 기준(앱의 lib/kst.ts 와 일치).
-- 권한: service_role 전용. 앱은 role='admin' 검증 후 lib/supabase/admin.ts 로만 호출한다.

create or replace function admin_dashboard_stats(
  p_days      int default 30,
  p_faq_limit int default 20
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
  kst_today as (
    select (now() at time zone 'Asia/Seoul')::date as d
  ),
  month_start as (
    select date_trunc('month', (select d from kst_today))::date as d
  ),
  user_count as (
    select count(*)::bigint as c from profiles
  ),
  question_count as (
    select count(*)::bigint as c from messages where role = 'user'
  ),
  answer_stats as (
    select
      avg(latency_ms) filter (where latency_ms is not null)      as avg_latency,
      count(*) filter (where feedback = 1)::bigint               as up,
      count(*) filter (where feedback = -1)::bigint              as down
    from messages
    where role = 'assistant'
  ),
  -- 답변에 인용된 출처의 분야 분포. sources 는 [{document_id, doc, page, content}] jsonb 배열.
  -- document_id 는 외부 RAG(rag_rescue) 청크면 0 이라 documents 와 매칭되지 않는다(기존 동작 유지).
  -- CASE 로 감싸 숫자가 아닌 값이 들어와도 캐스팅 에러가 나지 않게 한다.
  cited_docs as (
    select
      case
        when e.elem ->> 'document_id' ~ '^[0-9]+$' then (e.elem ->> 'document_id')::bigint
        else null
      end as document_id
    from messages m
    cross join lateral jsonb_array_elements(m.sources) as e(elem)
    -- role/jsonb_typeof 는 messages 스캔 단계의 제약이라 lateral 함수 호출 전에 걸러진다
    -- (sources 가 배열이 아닌 행에서 jsonb_array_elements 가 에러 내는 것을 막는다).
    where m.role = 'assistant'
      and jsonb_typeof(m.sources) = 'array'
  ),
  categories as (
    select d.category, count(*)::bigint as cnt
    from cited_docs c
    join documents d on d.id = c.document_id
    where d.category is not null
    group by d.category
  ),
  daily as (
    select
      g.day::date as day,
      coalesce(hits.c, 0)::bigint as cnt
    from generate_series(
      (select d from kst_today) - (p_days - 1),
      (select d from kst_today),
      interval '1 day'
    ) as g(day)
    left join (
      select (created_at at time zone 'Asia/Seoul')::date as day, count(*)::bigint as c
      from messages
      where role = 'user'
        and created_at >= (
          ((select d from kst_today) - (p_days - 1))::timestamp at time zone 'Asia/Seoul'
        )
      group by 1
    ) as hits on hits.day = g.day::date
  ),
  faq as (
    select btrim(content) as question, count(*)::bigint as cnt
    from messages
    where role = 'user'
      and btrim(content) <> ''
    group by btrim(content)
    order by cnt desc, question
    limit greatest(p_faq_limit, 0)
  ),
  fitness_month as (
    select
      count(distinct user_id)::bigint      as active_users,
      coalesce(sum(points), 0)::bigint     as month_points
    from workout_logs
    where performed_on >= (select d from month_start)
  ),
  fitness_total as (
    select count(*)::bigint as c from workout_logs
  )
select jsonb_build_object(
  'totalUsers',         (select c from user_count),
  'totalQuestions',     (select c from question_count),
  'avgLatencyMs',       coalesce((select round(avg_latency)::int from answer_stats), 0),
  'up',                 coalesce((select up from answer_stats), 0),
  'down',               coalesce((select down from answer_stats), 0),
  'categories', coalesce((
    select jsonb_agg(jsonb_build_object('category', category, 'count', cnt) order by cnt desc, category)
    from categories
  ), '[]'::jsonb),
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'count', cnt) order by day)
    from daily
  ), '[]'::jsonb),
  'faq', coalesce((
    select jsonb_agg(jsonb_build_object('q', question, 'count', cnt) order by cnt desc, question)
    from faq
  ), '[]'::jsonb),
  'fitnessActiveUsers', (select active_users from fitness_month),
  'fitnessMonthPoints', (select month_points from fitness_month),
  'fitnessTotalLogs',   (select c from fitness_total)
);
$$;

-- 전체 사용자 질문을 집계하므로 일반 사용자에게는 절대 노출하지 않는다.
revoke all on function admin_dashboard_stats(int, int) from public, anon, authenticated;
grant execute on function admin_dashboard_stats(int, int) to service_role;


-- ============================================================================
-- 20260827131016_remove_retired_mileage_stats.sql
-- ============================================================================

-- 출동 마일리지·체력단련 기능 제거 후 관리자 통계에서 체력 집계를 중단한다.
-- 기존 workout_logs 데이터와 스키마는 복구 가능성을 위해 보존한다.

create or replace function admin_dashboard_stats(
  p_days      int default 30,
  p_faq_limit int default 20
)
returns jsonb
language sql
security definer
stable
set search_path = public
as $$
with
  kst_today as (
    select (now() at time zone 'Asia/Seoul')::date as d
  ),
  user_count as (
    select count(*)::bigint as c from profiles
  ),
  question_count as (
    select count(*)::bigint as c from messages where role = 'user'
  ),
  answer_stats as (
    select
      avg(latency_ms) filter (where latency_ms is not null) as avg_latency,
      count(*) filter (where feedback = 1)::bigint          as up,
      count(*) filter (where feedback = -1)::bigint         as down
    from messages
    where role = 'assistant'
  ),
  cited_docs as (
    select
      case
        when e.elem ->> 'document_id' ~ '^[0-9]+$' then (e.elem ->> 'document_id')::bigint
        else null
      end as document_id
    from messages m
    cross join lateral jsonb_array_elements(m.sources) as e(elem)
    where m.role = 'assistant'
      and jsonb_typeof(m.sources) = 'array'
  ),
  categories as (
    select d.category, count(*)::bigint as cnt
    from cited_docs c
    join documents d on d.id = c.document_id
    where d.category is not null
    group by d.category
  ),
  daily as (
    select
      g.day::date as day,
      coalesce(hits.c, 0)::bigint as cnt
    from generate_series(
      (select d from kst_today) - (p_days - 1),
      (select d from kst_today),
      interval '1 day'
    ) as g(day)
    left join (
      select (created_at at time zone 'Asia/Seoul')::date as day, count(*)::bigint as c
      from messages
      where role = 'user'
        and created_at >= (
          ((select d from kst_today) - (p_days - 1))::timestamp at time zone 'Asia/Seoul'
        )
      group by 1
    ) as hits on hits.day = g.day::date
  ),
  faq as (
    select btrim(content) as question, count(*)::bigint as cnt
    from messages
    where role = 'user'
      and btrim(content) <> ''
    group by btrim(content)
    order by cnt desc, question
    limit greatest(p_faq_limit, 0)
  )
select jsonb_build_object(
  'totalUsers',     (select c from user_count),
  'totalQuestions', (select c from question_count),
  'avgLatencyMs',   coalesce((select round(avg_latency)::int from answer_stats), 0),
  'up',             coalesce((select up from answer_stats), 0),
  'down',           coalesce((select down from answer_stats), 0),
  'categories', coalesce((
    select jsonb_agg(jsonb_build_object('category', category, 'count', cnt) order by cnt desc, category)
    from categories
  ), '[]'::jsonb),
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'count', cnt) order by day)
    from daily
  ), '[]'::jsonb),
  'faq', coalesce((
    select jsonb_agg(jsonb_build_object('q', question, 'count', cnt) order by cnt desc, question)
    from faq
  ), '[]'::jsonb)
);
$$;

revoke all on function admin_dashboard_stats(int, int) from public, anon, authenticated;
grant execute on function admin_dashboard_stats(int, int) to service_role;


-- ============================================================================
-- 20260828032304_add_rag_corpus_release_switch.sql
-- ============================================================================

-- 전체 RAG 코퍼스를 한 트랜잭션에서 교체하고 이전 임베딩 공간을 롤백용으로 보존한다.
-- 문서별 activate_rag_rescue_ingestion()만으로 제공자를 바꾸면 전환 중 서로 다른
-- 벡터 공간이 섞이므로, 제공자 변경은 이 릴리스 단위 RPC만 사용한다.

create table if not exists public.rag_corpus_releases (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,
  provider       text not null,
  model          text not null,
  dimensions     integer not null check (dimensions = 1024),
  version        text not null,
  manifest       jsonb not null check (jsonb_typeof(manifest) = 'array'),
  expected_rows  integer not null check (expected_rows > 0),
  state          text not null default 'staged'
                 check (state in ('staged', 'active', 'inactive', 'failed')),
  created_at     timestamptz not null default now(),
  activated_at   timestamptz
);

create unique index if not exists rag_corpus_releases_one_active_idx
  on public.rag_corpus_releases ((state))
  where state = 'active';

create index if not exists rag_corpus_releases_created_idx
  on public.rag_corpus_releases (created_at desc);

alter table public.rag_corpus_releases enable row level security;
revoke all on table public.rag_corpus_releases from public, anon, authenticated;
grant select, insert, update, delete on table public.rag_corpus_releases to service_role;

-- 마이그레이션 적용 시 현재 활성 BGE 코퍼스를 하나의 롤백 릴리스로 등록한다.
-- 이미 활성 릴리스가 있으면 재실행해도 중복 생성하지 않는다.
do $$
declare
  v_provider text;
  v_model text;
  v_dimensions integer;
  v_version text;
  v_manifest jsonb;
  v_expected_rows integer;
begin
  -- 기존 단건 활성화가 기준선 캡처 사이에 커밋하지 못하게 쓰기를 잠시 막는다.
  lock table public.rag_rescue in share mode;
  lock table public.rag_embedding_config in share mode;

  if exists (select 1 from public.rag_corpus_releases where state = 'active')
     or not exists (select 1 from public.rag_rescue where is_active) then
    return;
  end if;

  select c.provider, c.model, c.dimensions, c.version
    into v_provider, v_model, v_dimensions, v_version
  from public.rag_embedding_config as c
  where c.table_name = 'rag_rescue';

  if v_provider is null then
    raise exception 'cannot capture baseline: rag_rescue embedding contract is missing';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.is_active
      and (
        r.ingestion_id is null
        or nullif(btrim(r.metadata ->> 'category'), '') is null
        or nullif(btrim(r.metadata ->> 'edu_category'), '') is null
        or r.metadata ->> 'category' is distinct from r.metadata ->> 'edu_category'
        or nullif(btrim(r.metadata ->> 'year'), '') is null
        or nullif(btrim(r.metadata ->> 'source'), '') is null
        or coalesce(r.metadata ->> 'document_id', '') !~ '^[0-9]+$'
        or coalesce(r.metadata ->> 'file_hash', '') !~ '^[0-9a-fA-F]{64}$'
      )
  ) then
    raise exception 'cannot capture baseline: active row metadata is incomplete';
  end if;

  with grouped as (
    select
      r.ingestion_id,
      r.metadata ->> 'edu_category' as category,
      r.metadata ->> 'year' as year,
      r.metadata ->> 'source' as source,
      (r.metadata ->> 'document_id')::bigint as document_id,
      lower(r.metadata ->> 'file_hash') as file_hash,
      count(*)::integer as expected_count
    from public.rag_rescue as r
    where r.is_active
    group by
      r.ingestion_id,
      r.metadata ->> 'edu_category',
      r.metadata ->> 'year',
      r.metadata ->> 'source',
      (r.metadata ->> 'document_id')::bigint,
      lower(r.metadata ->> 'file_hash')
  )
  select
    jsonb_agg(
      jsonb_build_object(
        'ingestion_id', ingestion_id,
        'category', category,
        'year', year,
        'source', source,
        'document_id', document_id,
        'file_hash', file_hash,
        'expected_count', expected_count
      )
      order by source, ingestion_id
    ),
    sum(expected_count)::integer
    into v_manifest, v_expected_rows
  from grouped;

  if v_manifest is null or v_expected_rows <= 0 then
    raise exception 'cannot capture baseline: active corpus manifest is empty';
  end if;

  insert into public.rag_corpus_releases (
    label,
    provider,
    model,
    dimensions,
    version,
    manifest,
    expected_rows,
    state,
    activated_at
  ) values (
    'Gemini 전환 전 기준선',
    v_provider,
    v_model,
    v_dimensions,
    v_version,
    v_manifest,
    v_expected_rows,
    'active',
    now()
  );
end;
$$;

create or replace function public.switch_rag_rescue_corpus (
  p_release_id uuid
)
returns table (
  release_id uuid,
  activated_count integer,
  deactivated_count integer,
  provider text,
  model text,
  version text
)
language plpgsql
set search_path = ''
as $$
declare
  v_release public.rag_corpus_releases%rowtype;
  v_ingestion_ids uuid[];
  v_manifest_rows integer;
  v_distinct_ingestions integer;
  v_distinct_documents integer;
  v_manifest_expected integer;
  v_release_document_ids bigint[];
  v_active_document_ids bigint[];
  v_actual_count integer;
  v_activated_count integer;
  v_deactivated_count integer;
begin
  if p_release_id is null then
    raise exception 'release id is required';
  end if;

  -- 문서별 활성화 RPC와 동일한 전역 잠금을 사용해 코퍼스 변경을 직렬화한다.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );

  select *
    into v_release
  from public.rag_corpus_releases
  where id = p_release_id
  for update;

  if not found then
    raise exception 'rag corpus release not found: %', p_release_id;
  end if;
  if v_release.state not in ('staged', 'active', 'inactive') then
    raise exception 'rag corpus release is not switchable: %', v_release.state;
  end if;
  if jsonb_array_length(v_release.manifest) = 0 then
    raise exception 'rag corpus release manifest is empty';
  end if;

  select
    array_agg(m.ingestion_id order by m.ingestion_id),
    count(*)::integer,
    count(distinct m.ingestion_id)::integer,
    count(distinct m.document_id)::integer,
    array_agg(m.document_id order by m.document_id),
    sum(m.expected_count)::integer
    into
      v_ingestion_ids,
      v_manifest_rows,
      v_distinct_ingestions,
      v_distinct_documents,
      v_release_document_ids,
      v_manifest_expected
  from jsonb_to_recordset(v_release.manifest) as m(
    ingestion_id uuid,
    category text,
    year text,
    source text,
    document_id bigint,
    file_hash text,
    expected_count integer
  );

  if v_manifest_rows <> v_distinct_ingestions
     or v_manifest_rows <> v_distinct_documents
     or v_release.dimensions <> 1024
     or v_manifest_expected is null
     or v_manifest_expected <> v_release.expected_rows
     or exists (
       select 1
       from jsonb_to_recordset(v_release.manifest) as m(
         ingestion_id uuid,
         category text,
         year text,
         source text,
         document_id bigint,
         file_hash text,
         expected_count integer
       )
       where m.ingestion_id is null
          or nullif(btrim(m.category), '') is null
          or nullif(btrim(m.year), '') is null
          or nullif(btrim(m.source), '') is null
          or m.document_id is null
          or coalesce(m.file_hash, '') !~ '^[0-9a-fA-F]{64}$'
          or m.expected_count is null
          or m.expected_count <= 0
     ) then
    raise exception 'invalid or duplicate rag corpus release manifest';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.is_active
      and coalesce(r.metadata ->> 'document_id', '') !~ '^[0-9]+$'
  ) then
    raise exception 'current active corpus contains an invalid document_id';
  end if;

  select array_agg(document_id order by document_id)
    into v_active_document_ids
  from (
    select distinct (r.metadata ->> 'document_id')::bigint as document_id
    from public.rag_rescue as r
    where r.is_active
  ) as active_documents;

  if v_active_document_ids is null
     or v_release_document_ids is distinct from v_active_document_ids then
    raise exception
      'release document set does not match the current active corpus: target %, current %',
      v_release_document_ids,
      v_active_document_ids;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(v_release.manifest) as m(
      ingestion_id uuid,
      category text,
      year text,
      source text,
      document_id bigint,
      file_hash text,
      expected_count integer
    )
    left join public.documents as d on d.id = m.document_id
    where d.id is null
       or d.original_filename is distinct from m.source
       or d.category is distinct from m.category
       or d.file_url is distinct from (
         'rag/' || left(lower(m.file_hash), 2) || '/' || lower(m.file_hash) || '.pdf'
       )
  ) then
    raise exception 'release manifest does not match documents or Storage paths';
  end if;

  select count(*)::integer
    into v_actual_count
  from public.rag_rescue as r
  where r.ingestion_id = any(v_ingestion_ids);

  if v_actual_count <> v_release.expected_rows then
    raise exception
      'release row count mismatch: expected %, found %',
      v_release.expected_rows,
      v_actual_count;
  end if;

  -- manifest의 문서별 행 수와 실제 category/year/source가 완전히 같은지 검증한다.
  if exists (
    with manifest_rows as (
      select *
      from jsonb_to_recordset(v_release.manifest) as m(
        ingestion_id uuid,
        category text,
        year text,
        source text,
        document_id bigint,
        file_hash text,
        expected_count integer
      )
    ),
    actual_rows as (
      select
        r.ingestion_id,
        r.metadata ->> 'edu_category' as category,
        r.metadata ->> 'year' as year,
        r.metadata ->> 'source' as source,
        (r.metadata ->> 'document_id')::bigint as document_id,
        lower(r.metadata ->> 'file_hash') as file_hash,
        count(*)::integer as actual_count
      from public.rag_rescue as r
      where r.ingestion_id = any(v_ingestion_ids)
      group by
        r.ingestion_id,
        r.metadata ->> 'edu_category',
        r.metadata ->> 'year',
        r.metadata ->> 'source',
        (r.metadata ->> 'document_id')::bigint,
        lower(r.metadata ->> 'file_hash')
    )
    select 1
    from manifest_rows as m
    full join actual_rows as a
      on a.ingestion_id = m.ingestion_id
     and a.category = m.category
     and a.year = m.year
     and a.source = m.source
     and a.document_id = m.document_id
     and a.file_hash = lower(m.file_hash)
    where m.ingestion_id is null
       or a.ingestion_id is null
       or m.expected_count <> a.actual_count
  ) then
    raise exception 'release document manifest does not match staged rows';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.ingestion_id = any(v_ingestion_ids)
      and (
        nullif(btrim(r.content), '') is null
        or r.embedding is null
        or r.metadata ->> 'embedding_provider' is distinct from v_release.provider
        or r.metadata ->> 'embedding_model' is distinct from v_release.model
        or r.metadata ->> 'embedding_dimensions' is distinct from v_release.dimensions::text
        or r.metadata ->> 'embedding_version' is distinct from v_release.version
        or r.metadata ->> 'category' is distinct from r.metadata ->> 'edu_category'
      )
  ) then
    raise exception 'release rows contain invalid content, embedding, or contract metadata';
  end if;

  -- 한 트랜잭션 안에서 계약과 활성 코퍼스를 함께 바꾼다. 외부 쿼리는 중간 상태를 보지 않는다.
  update public.rag_corpus_releases
  set state = 'inactive'
  where state = 'active'
    and id <> p_release_id;

  with changed as (
    update public.rag_rescue as r
    set is_active = false
    where r.is_active
      and (
        r.ingestion_id is null
        or not (r.ingestion_id = any(v_ingestion_ids))
      )
    returning 1
  )
  select count(*)::integer into v_deactivated_count from changed;

  with changed as (
    update public.rag_rescue as r
    set is_active = true
    where r.ingestion_id = any(v_ingestion_ids)
      and not r.is_active
    returning 1
  )
  select count(*)::integer into v_activated_count from changed;

  insert into public.rag_embedding_config (
    table_name, provider, model, dimensions, version, updated_at
  ) values (
    'rag_rescue',
    v_release.provider,
    v_release.model,
    v_release.dimensions,
    v_release.version,
    now()
  )
  on conflict (table_name) do update
  set provider = excluded.provider,
      model = excluded.model,
      dimensions = excluded.dimensions,
      version = excluded.version,
      updated_at = excluded.updated_at;

  update public.rag_corpus_releases
  set state = 'active', activated_at = now()
  where id = p_release_id;

  select count(*)::integer
    into v_actual_count
  from public.rag_rescue as r
  where r.is_active
    and r.ingestion_id = any(v_ingestion_ids);

  if v_actual_count <> v_release.expected_rows
     or exists (
       select 1
       from public.rag_rescue as r
       where r.is_active
         and (
           r.ingestion_id is null
           or not (r.ingestion_id = any(v_ingestion_ids))
         )
     ) then
    raise exception 'post-switch active corpus verification failed';
  end if;

  return query
  select
    v_release.id,
    v_actual_count,
    coalesce(v_deactivated_count, 0),
    v_release.provider,
    v_release.model,
    v_release.version;
end;
$$;

revoke all on function public.switch_rag_rescue_corpus(uuid)
  from public, anon, authenticated;
grant execute on function public.switch_rag_rescue_corpus(uuid)
  to service_role;

-- 단건 갱신도 전역 코퍼스 전환과 동시에 실행되지 않게 하고, inactive 롤백 행은
-- 삭제하지 않는다. 제공자 변경 자체는 switch_rag_rescue_corpus()만 사용한다.
create or replace function public.activate_rag_rescue_ingestion (
  p_ingestion_id uuid,
  p_category text,
  p_year text,
  p_source text,
  p_expected_count integer,
  p_replace_existing boolean default true
)
returns table (activated_count integer)
language plpgsql
set search_path = ''
as $$
declare
  v_count integer;
  v_total integer;
begin
  if p_ingestion_id is null
    or nullif(btrim(p_category), '') is null
    or nullif(btrim(p_year), '') is null
    or nullif(btrim(p_source), '') is null
    or p_expected_count <= 0 then
    raise exception 'invalid ingestion activation arguments';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_category || E'\n' || p_year || E'\n' || p_source, 0)
  );

  select count(*)::integer
    into v_total
  from public.rag_rescue as r
  where r.ingestion_id = p_ingestion_id;

  if v_total <> p_expected_count then
    raise exception
      'staged total row count mismatch: expected %, found %',
      p_expected_count,
      v_total;
  end if;

  select count(*)::integer
    into v_count
  from public.rag_rescue as r
  where r.ingestion_id = p_ingestion_id
    and r.metadata ->> 'edu_category' = p_category
    and r.metadata ->> 'year' = p_year
    and r.metadata ->> 'source' = p_source;

  if v_count <> p_expected_count then
    raise exception
      'staged row count mismatch: expected %, found %',
      p_expected_count,
      v_count;
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    where r.ingestion_id = p_ingestion_id
      and (
        nullif(btrim(r.content), '') is null
        or r.embedding is null
      )
  ) then
    raise exception 'staged rows contain empty content or embedding';
  end if;

  if not exists (
    select 1
    from public.rag_embedding_config as c
    where c.table_name = 'rag_rescue'
  ) then
    raise exception 'embedding contract for rag_rescue is not configured';
  end if;

  if exists (
    select 1
    from public.rag_rescue as r
    join public.rag_embedding_config as c
      on c.table_name = 'rag_rescue'
    where r.ingestion_id = p_ingestion_id
      and (
        r.metadata ->> 'embedding_provider' is distinct from c.provider
        or r.metadata ->> 'embedding_model' is distinct from c.model
        or r.metadata ->> 'embedding_dimensions' is distinct from c.dimensions::text
        or r.metadata ->> 'embedding_version' is distinct from c.version
      )
  ) then
    raise exception 'staged rows do not match the rag_rescue embedding contract';
  end if;

  if p_replace_existing then
    delete from public.rag_rescue as r
    where r.ingestion_id is distinct from p_ingestion_id
      and r.is_active
      and r.metadata ->> 'edu_category' = p_category
      and r.metadata ->> 'year' = p_year
      and r.metadata ->> 'source' = p_source;
  end if;

  update public.rag_rescue as r
  set is_active = true
  where r.ingestion_id = p_ingestion_id
    and not r.is_active;

  return query select v_count;
end;
$$;

revoke all on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) from public, anon, authenticated;
grant execute on function public.activate_rag_rescue_ingestion(
  uuid, text, text, text, integer, boolean
) to service_role;


-- ============================================================================
-- 20260828115838_allow_authenticated_document_downloads.sql
-- ============================================================================

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


-- ============================================================================
-- 20260829052407_protect_generated_material_sharing.sql
-- ============================================================================

-- 생성물 공유는 Next.js API의 사전 검사만 믿지 않는다.
-- 인증 사용자는 Supabase Data API를 직접 호출할 수 있으므로, shared=true가 되는 모든
-- INSERT/UPDATE와 이미 공유된 행의 본문 수정에 동일한 SOP 계약을 DB 트리거로 강제한다.

create or replace function public.generated_material_normalize_ocr(
  p_value text,
  p_context_hint text
)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_normalized text := coalesce(p_value, '');
begin
  -- lib/rag-external.ts normalizeKnownOcrErrors와 같은, 실제 코퍼스에서 확인된
  -- 최소 교정 집합이다. 문맥 의존 오인식은 일반 문장의 정상 표현을 바꾸지 않는다.
  v_normalized := pg_catalog.replace(v_normalized, '헬넷', '헬멧');
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '지위관((에게|은|는|이|가|을|를|의|으로|에서)?([[:space:]]|[,.]|$))',
    '지휘관\1',
    'g'
  );
  v_normalized := pg_catalog.replace(v_normalized, '재세적', '재세척');
  v_normalized := pg_catalog.replace(v_normalized, '제독렌트', '제독텐트');
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '((오염도|시간|압력|농도)[[:space:]]*)축정',
    '\1측정',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '축정([[:space:]]*(장비|기|값|결과))',
    '측정\1',
    'g'
  );
  v_normalized := pg_catalog.replace(v_normalized, '인체사위', '인체샤워');
  v_normalized := pg_catalog.replace(v_normalized, '사위실', '샤워실');

  if (v_normalized || ' ' || coalesce(p_context_hint, ''))
    !~ '((화학[[:space:]]*)?보호(복|의)|착탈의|제독)' then
    return v_normalized;
  end if;

  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '2인[[:space:]]*7조([^.\n]{0,100}(화학[[:space:]]*)?보호(복|의)[^.\n]{0,40}달의)',
    '2인 1조\1',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '\([[:space:]]*2인[[:space:]]*7조[[:space:]]*\)([^.\n]{0,100}(상의|하의)[[:space:]]*[>→])',
    '(2인 1조)\1',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '2인[[:space:]]*7조([[:space:]]*(상의|하의)[[:space:]]*[>→])',
    '2인 1조\1',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '((화학[[:space:]]*)?보호(복|의)[[:space:]]*)달의',
    '\1탈의',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '(순으로[[:space:]]*)달의',
    '\1탈의',
    'g'
  );
  v_normalized := pg_catalog.regexp_replace(
    v_normalized,
    '(^|[[:space:](])달의([[:space:]]*(순서|절차|단계|후|전|시|\)))',
    '\1탈의\2',
    'g'
  );
  return v_normalized;
end;
$$;

create or replace function public.generated_material_compact_text(p_value text)
returns text
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.lower(coalesce(p_value, '')),
    '[^0-9a-z가-힣]+',
    '',
    'g'
  );
$$;

create or replace function public.generated_material_source_label(p_metadata jsonb)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_source text;
  v_header text;
  v_page text;
  v_label text;
begin
  v_source := pg_catalog.regexp_replace(
    coalesce(p_metadata ->> 'source', '자료'),
    '\.(pdf|hwpx?|pptx?|docx?)$',
    '',
    'i'
  );
  v_header := nullif(pg_catalog.btrim(p_metadata ->> 'Header 2'), '');
  v_page := p_metadata ->> 'page_num';

  -- 웹앱의 출처 라벨 정규화와 같은 OCR 교정 규칙을 사용한다.
  v_source := public.generated_material_normalize_ocr(v_source, v_source);
  v_source := pg_catalog.regexp_replace(v_source, '&lt;', '<', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&gt;', '>', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&amp;', '&', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&quot;', '"', 'gi');
  v_source := pg_catalog.regexp_replace(v_source, '&#39;', '''', 'gi');
  v_source := pg_catalog.replace(pg_catalog.replace(v_source, '[', '('), ']', ')');
  v_source := pg_catalog.btrim(pg_catalog.regexp_replace(v_source, '[[:space:]]+', ' ', 'g'));

  if v_header is not null then
    v_header := public.generated_material_normalize_ocr(v_header, v_header);
    v_header := pg_catalog.regexp_replace(v_header, '&lt;', '<', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&gt;', '>', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&amp;', '&', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&quot;', '"', 'gi');
    v_header := pg_catalog.regexp_replace(v_header, '&#39;', '''', 'gi');
    v_header := pg_catalog.replace(pg_catalog.replace(v_header, '[', '('), ']', ')');
    v_header := pg_catalog.btrim(pg_catalog.regexp_replace(v_header, '[[:space:]]+', ' ', 'g'));
  end if;

  v_label := case
    when v_header is not null and v_header is distinct from v_source
      then v_source || ' — ' || v_header
    else v_source
  end;
  if coalesce(v_page, '') ~ '^[0-9]+$' then
    v_label := v_label || ' p.' || coalesce(
      nullif(pg_catalog.ltrim(v_page, '0'), ''),
      '0'
    );
  end if;
  return '[' || v_label || ']';
end;
$$;

-- 계획서·교안·슬라이드의 출처 배지에 쓰이는 한 원소가 현재 신뢰 원본과 정확히
-- 일치하는지 공통 검사한다. 외부 RAG와 기본 documents/chunks 설치를 모두 지원한다.
create or replace function public.generated_material_source_provenance_valid(
  p_source jsonb,
  p_category text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.rag_rescue as rag
      where rag.is_active
        and rag.metadata ->> 'edu_category' = p_category
        and rag.metadata ->> 'document_id' ~ '^[0-9]+$'
        and coalesce(
          nullif(pg_catalog.ltrim(rag.metadata ->> 'document_id', '0'), ''),
          '0'
        ) = pg_catalog.trunc((p_source ->> 'document_id')::numeric)::text
        and (
          (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'null'
            and rag.metadata ->> 'page_num' is null
          )
          or (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
            and rag.metadata ->> 'page_num' ~ '^[0-9]+$'
            and coalesce(
              nullif(pg_catalog.ltrim(rag.metadata ->> 'page_num', '0'), ''),
              '0'
            ) = pg_catalog.trunc((p_source ->> 'page')::numeric)::text
          )
        )
        and public.generated_material_source_label(rag.metadata)
          = '[' || pg_catalog.btrim(p_source ->> 'doc') ||
            case when pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
              then ' p.' || pg_catalog.trunc((p_source ->> 'page')::numeric)::text
              else '' end || ']'
    )
    or exists (
      select 1
      from public.documents as document
      join public.chunks as chunk on chunk.document_id = document.id
      where document.id::numeric
          = pg_catalog.trunc((p_source ->> 'document_id')::numeric)
        and document.category = p_category
        and pg_catalog.btrim(document.title) = pg_catalog.btrim(p_source ->> 'doc')
        and document.status = 'processed'
        and (
          (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'null'
            and chunk.page_num is null
          )
          or (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
            and chunk.page_num::numeric = pg_catalog.trunc((p_source ->> 'page')::numeric)
          )
        )
    );
$$;

create or replace function public.generated_material_focus_terms(
  p_topic text,
  p_focus text
)
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_token text;
  v_terms text[] := '{}'::text[];
  v_stop text[] := array[
    '개요', '관련', '교육', '구조', '매뉴얼', '방법', '분야', '사고', '안전',
    '운용', '자료', '작업', '장비', '절차', '점검', '준비물', '평가',
    '표준작전절차', '현장', '훈련', '대비', '대응', '상위', '주제', '산악',
    '수난', '화재', '구급', '산악사고', '수난사고', '화재사고', '구조활동',
    '현장활동'
  ]::text[];
begin
  for v_token in
    select value
    from pg_catalog.regexp_split_to_table(
      pg_catalog.regexp_replace(
        coalesce(p_focus, '') || ' ' || coalesce(p_topic, ''),
        '[^0-9a-zA-Z가-힣]+',
        ' ',
        'g'
      ),
      '[[:space:]]+'
    ) as token(value)
  loop
    v_token := pg_catalog.lower(pg_catalog.btrim(v_token));
    v_token := pg_catalog.regexp_replace(
      v_token,
      '(으로|에서|에게|부터|까지|과|와|을|를|은|는|이|가|의)$',
      ''
    );
    v_token := pg_catalog.regexp_replace(
      v_token,
      '(관련|대비|대응|교육|훈련|방법|절차)$',
      ''
    );
    if pg_catalog.char_length(v_token) >= 2
      and not (v_token = any(v_stop))
      and not (v_token = any(v_terms)) then
      v_terms := pg_catalog.array_append(v_terms, v_token);
      exit when coalesce(pg_catalog.array_length(v_terms, 1), 0) >= 12;
    end if;
  end loop;
  return v_terms;
end;
$$;

create or replace function public.generated_material_rag_row_supports(
  p_content text,
  p_metadata jsonb,
  p_terms text[]
)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_term text;
  v_compact_term text;
  v_page_raw text;
  v_source_raw text;
  v_page_text text;
  v_source_text text;
  v_page_matches integer := 0;
  v_all_matches integer := 0;
  v_required integer;
begin
  if coalesce(pg_catalog.array_length(p_terms, 1), 0) = 0 then
    return false;
  end if;
  v_page_raw :=
    coalesce(p_metadata ->> 'Header 2', '') || ' ' ||
    coalesce(p_content, '');
  v_source_raw := coalesce(p_metadata ->> 'source', '');
  v_page_raw := public.generated_material_normalize_ocr(v_page_raw, '');
  v_source_raw := public.generated_material_normalize_ocr(v_source_raw, '');
  v_page_text := public.generated_material_compact_text(v_page_raw);
  v_source_text := public.generated_material_compact_text(v_source_raw);

  foreach v_term in array p_terms loop
    v_compact_term := public.generated_material_compact_text(v_term);
    if pg_catalog.char_length(v_compact_term) < 2 then
      continue;
    end if;
    if position(v_compact_term in v_page_text) > 0 then
      v_page_matches := v_page_matches + 1;
      v_all_matches := v_all_matches + 1;
    elsif position(v_compact_term in v_source_text) > 0 then
      v_all_matches := v_all_matches + 1;
    end if;
  end loop;

  v_required := least(2, pg_catalog.array_length(p_terms, 1));
  return v_page_matches >= 1 and v_all_matches >= v_required;
end;
$$;

create or replace function public.generated_material_share_contract_valid(
  p_kind text,
  p_category text,
  p_audience text,
  p_duration text,
  p_topic text,
  p_title text,
  p_content jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_labels text[] := '{}'::text[];
  v_terms text[];
  v_matching_labels text[] := '{}'::text[];
  v_target_heading text;
  v_target_count integer := 0;
  v_designated text := '';
  v_all_text text := '';
  v_chunks text[] := '{}'::text[];
  v_refs_by_chunk text[] := '{}'::text[];
  v_chunk text;
  v_chunk_index integer;
  v_item jsonb;
  v_bullets text;
  v_refs text;
  v_visual jsonb;
  v_visual_mode text;
  v_label text;
  v_ref text;
  v_match text[];
  v_has_label boolean;
  v_grounded_application boolean := false;
  v_disclosure text;
  v_claim_text text;
  v_cue text := '(SOP|표준[[:space:]]*(작전)?[[:space:]]*절차|현장[[:space:]]*(활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
  v_cue_nocapture text := '(?:SOP|표준[[:space:]]*(?:작전)?[[:space:]]*절차|현장[[:space:]]*(?:활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
  v_number_claim text;
  v_named_claim text;
  v_quoted_named_claim text;
  v_procedure_claim text;
  v_number_capture text;
  v_named_capture text;
  v_quoted_named_capture text;
  v_claim_value text;
  v_claim_supported boolean;
begin
  if p_kind not in ('plan', 'lesson', 'slides', 'notebooklm')
    or pg_catalog.jsonb_typeof(p_content) is distinct from 'object'
    or nullif(pg_catalog.btrim(p_title), '') is null
    or pg_catalog.char_length(p_title) > 200
    or pg_catalog.pg_column_size(p_content) > 262144
    or pg_catalog.octet_length(p_content::text) > 131072 then
    return false;
  end if;

  -- API 저장 계약과 같은 메타데이터 상한을 모든 공유 유형에 적용한다.
  -- NotebookLM도 선택 메타데이터를 저장할 수 있으므로 조기 반환 전에 검사한다.
  if coalesce(pg_catalog.char_length(p_category), 0) > 100
    or coalesce(pg_catalog.char_length(p_audience), 0) > 50
    or coalesce(pg_catalog.char_length(p_duration), 0) > 20
    or coalesce(pg_catalog.char_length(p_topic), 0) > 100 then
    return false;
  end if;

  -- 과거 NotebookLM 프롬프트는 공식 훈련 문서가 아니므로 기존 공유 호환만 유지한다.
  if p_kind = 'notebooklm' then
    return pg_catalog.jsonb_typeof(p_content -> 'prompt') = 'string'
      and coalesce(pg_catalog.char_length(pg_catalog.btrim(p_content ->> 'prompt')), 0)
      between 10 and 100000;
  end if;

  if nullif(pg_catalog.btrim(p_category), '') is null
    or nullif(pg_catalog.btrim(p_audience), '') is null
    or nullif(pg_catalog.btrim(p_duration), '') is null
    or nullif(pg_catalog.btrim(p_topic), '') is null
    or pg_catalog.jsonb_typeof(p_content -> 'sopEvidence') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_content #> '{sopEvidence,sourceLabels}') is distinct from 'array' then
    return false;
  end if;

  v_status := p_content #>> '{sopEvidence,status}';
  if v_status is null or v_status not in ('found', 'not_found', 'degraded') then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(p_content #> '{sopEvidence,sourceLabels}') > 20
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        p_content #> '{sopEvidence,sourceLabels}'
      ) as label(value)
      where pg_catalog.jsonb_typeof(label.value) is distinct from 'string'
    ) then
    return false;
  end if;
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.btrim(item.value)), '{}'::text[])
  into v_labels
  from pg_catalog.jsonb_array_elements_text(
    p_content #> '{sopEvidence,sourceLabels}'
  ) as item(value)
  where nullif(pg_catalog.btrim(item.value), '') is not null;
  if exists (
    select 1
    from pg_catalog.unnest(v_labels) as label(value)
    where pg_catalog.char_length(label.value) > 300
  ) then
    return false;
  end if;

  -- DB가 정상적으로 실행 중인 공유 트랜잭션에서는 검색 장애 상태를 클라이언트가
  -- 스스로 주장할 수 없다. 검색 장애 초안은 저장만 하고 재생성 후 공유한다.
  if v_status = 'degraded' then
    return false;
  end if;

  -- 계획서·교안은 구형 저장본 호환을 위해 sources 생략을 빈 배열로 보되, 값이 있으면
  -- 슬라이드와 같은 구조·분량·실제 원본 계약을 적용한다. 슬라이드는 API 계약상 배열이 필수다.
  if p_kind = 'slides'
    and pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array' then
    return false;
  end if;
  if p_content ? 'sources'
    and pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array' then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(
    case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
      then p_content -> 'sources' else '[]'::jsonb end
  ) > 80 then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
        then p_content -> 'sources' else '[]'::jsonb end
    ) as source(value)
    where pg_catalog.jsonb_typeof(source.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(source.value -> 'doc') is distinct from 'string'
      or pg_catalog.char_length(
        pg_catalog.btrim(coalesce(source.value ->> 'doc', ''))
      ) not between 1 and 300
      or case
        when pg_catalog.jsonb_typeof(source.value -> 'document_id') = 'number' then
          (source.value ->> 'document_id')::numeric
            <> pg_catalog.trunc((source.value ->> 'document_id')::numeric)
          or (source.value ->> 'document_id')::numeric
            not between 1 and 9007199254740991
        else true
      end
      or not (source.value ? 'page')
      or case
        when pg_catalog.jsonb_typeof(source.value -> 'page') = 'null' then false
        when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number' then
          (source.value ->> 'page')::numeric
            <> pg_catalog.trunc((source.value ->> 'page')::numeric)
          or (source.value ->> 'page')::numeric
            not between 1 and 9007199254740991
        else true
      end
  ) then
    return false;
  end if;

  -- 출처 배지·PPTX 근거자료 부록에는 visual에서 쓰지 않은 sources도 노출된다.
  -- 모든 원소를 공통 provenance 함수로 검사해 coordinated tamper도 차단한다.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
        then p_content -> 'sources' else '[]'::jsonb end
    ) as source(value)
    where not public.generated_material_source_provenance_valid(source.value, p_category)
  ) then
    return false;
  end if;

  if p_kind in ('plan', 'lesson') then
    if pg_catalog.jsonb_typeof(p_content -> 'sections') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_content -> 'sections') not between 1 and 8 then
      return false;
    end if;
    v_target_heading := case when p_kind = 'plan' then '훈련내용' else '핵심이론' end;
    for v_item in select value from pg_catalog.jsonb_array_elements(p_content -> 'sections') as section(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'heading') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_item -> 'content') is distinct from 'string'
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'heading', ''))) not between 1 and 200
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'content', ''))) not between 1 and 20000 then
        return false;
      end if;
      v_chunk := coalesce(v_item ->> 'heading', '') || E'\n' ||
        coalesce(v_item ->> 'content', '');
      v_chunks := pg_catalog.array_append(v_chunks, v_chunk);
      v_refs_by_chunk := pg_catalog.array_append(v_refs_by_chunk, '');
      v_all_text := v_all_text || E'\n' || v_chunk;
      if pg_catalog.btrim(v_item ->> 'heading') = v_target_heading then
        v_target_count := v_target_count + 1;
        if v_target_count = 1 then
          v_designated := coalesce(v_item ->> 'content', '');
        end if;
      end if;
    end loop;
    -- JS 계약은 첫 지정 섹션을 사용한다. 중복 제목을 허용하면 DB와 앱이 서로 다른
    -- 섹션을 검사할 수 있으므로 공식 공유본에서는 정확히 한 개만 인정한다.
    if v_target_count <> 1 or v_designated = '' then
      return false;
    end if;
  else
    if pg_catalog.jsonb_typeof(p_content -> 'slides') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_content -> 'slides') not between 1 and 20 then
      return false;
    end if;
    for v_item in select value from pg_catalog.jsonb_array_elements(p_content -> 'slides') as slide(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'title') is distinct from 'string'
        or (
          v_item ? 'notes'
          and pg_catalog.jsonb_typeof(v_item -> 'notes') is distinct from 'string'
        )
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'title', ''))) not between 1 and 200
        or pg_catalog.char_length(coalesce(v_item ->> 'notes', '')) > 30000
        or pg_catalog.jsonb_typeof(v_item -> 'bullets') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_item -> 'bullets') not between 1 and 4
        or (
          v_item ? 'steps'
          and (
            pg_catalog.jsonb_typeof(v_item -> 'steps') is distinct from 'array'
            or pg_catalog.jsonb_array_length(v_item -> 'steps') > 5
          )
        )
        or (
          v_item ? 'sourceRefs'
          and (
            pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') is distinct from 'array'
            or pg_catalog.jsonb_array_length(v_item -> 'sourceRefs') > 4
          )
        ) then
        return false;
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_item -> 'bullets') as bullet(value)
        where pg_catalog.jsonb_typeof(bullet.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(bullet.value #>> '{}')) not between 1 and 500
      ) or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(v_item -> 'steps') = 'array'
            then v_item -> 'steps' else '[]'::jsonb end
        ) as step(value)
        where pg_catalog.jsonb_typeof(step.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(step.value #>> '{}')) not between 1 and 100
      ) or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
            then v_item -> 'sourceRefs' else '[]'::jsonb end
        ) as ref(value)
        where pg_catalog.jsonb_typeof(ref.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(ref.value #>> '{}')) not between 1 and 300
      ) then
        return false;
      end if;

      if v_item ? 'visual' then
        v_visual := v_item -> 'visual';
        v_visual_mode := v_visual ->> 'mode';
        if pg_catalog.jsonb_typeof(v_visual) is distinct from 'object'
          or pg_catalog.jsonb_typeof(v_visual -> 'mode') is distinct from 'string'
          or v_visual_mode not in ('source-page', 'source-crop', 'native-diagram', 'none')
          or (
            v_visual ? 'documentId'
            and case
              when pg_catalog.jsonb_typeof(v_visual -> 'documentId') = 'number' then
                (v_visual ->> 'documentId')::numeric
                  <> pg_catalog.trunc((v_visual ->> 'documentId')::numeric)
                or (v_visual ->> 'documentId')::numeric
                  not between 1 and 9007199254740991
              else true
            end
          )
          or (
            v_visual ? 'page'
            and case
              when pg_catalog.jsonb_typeof(v_visual -> 'page') = 'number' then
                (v_visual ->> 'page')::numeric
                  <> pg_catalog.trunc((v_visual ->> 'page')::numeric)
                or (v_visual ->> 'page')::numeric
                  not between 1 and 9007199254740991
              else true
            end
          )
          or (
            v_visual ? 'sourceRef'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'sourceRef') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'sourceRef', ''))
              ) not between 1 and 300
            )
          )
          or (
            v_visual ? 'altText'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'altText') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'altText', ''))
              ) not between 1 and 300
            )
          )
          or (
            v_visual ? 'caption'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'caption') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'caption', ''))
              ) not between 1 and 200
            )
          )
          or (
            v_visual ? 'fit'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'fit') is distinct from 'string'
              or v_visual ->> 'fit' not in ('contain', 'cover')
            )
          ) then
          return false;
        end if;

        if v_visual_mode in ('source-page', 'source-crop') then
          if not (v_visual ? 'documentId')
            or not (v_visual ? 'page')
            or not (v_visual ? 'sourceRef') then
            return false;
          end if;
          if not exists (
            select 1
            from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
            where (source.value ->> 'document_id')::numeric
                = (v_visual ->> 'documentId')::numeric
              and pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
              and (source.value ->> 'page')::numeric
                = (v_visual ->> 'page')::numeric
              and '[' || pg_catalog.btrim(source.value ->> 'doc') ||
                ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text || ']'
                = pg_catalog.btrim(v_visual ->> 'sourceRef')
          ) then
            return false;
          end if;
        end if;
      else
        v_visual := null;
        v_visual_mode := null;
      end if;

      select coalesce(pg_catalog.string_agg(value, E'\n'), '')
      into v_bullets
      from pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(v_item -> 'bullets') = 'array'
          then v_item -> 'bullets' else '[]'::jsonb end
      ) as bullet(value);
      select coalesce(pg_catalog.string_agg(value, E'\n'), '')
      into v_refs
      from pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
          then v_item -> 'sourceRefs' else '[]'::jsonb end
      ) as ref(value);
      -- sourceRefs는 화면 본문이 아니라 인용 목록이다. JS와 같이 각 값을 별도로
      -- 검증한다. SOP 라벨은 확인된 SOP 목록, 그 외 라벨은 위에서 실제 RAG와
      -- 대조한 content.sources 중 하나와 정확히 일치해야 한다.
      for v_ref in
        select pg_catalog.btrim(value)
        from pg_catalog.jsonb_array_elements_text(
          case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
            then v_item -> 'sourceRefs' else '[]'::jsonb end
        ) as ref(value)
      loop
        if not (v_ref = any(v_labels))
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
            where '[' || pg_catalog.btrim(source.value ->> 'doc') ||
              case when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
                then ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text
                else '' end || ']'
                = v_ref
          ) then
          return false;
        end if;
      end loop;
      v_chunk := coalesce(v_item ->> 'title', '') || E'\n' ||
        v_bullets || E'\n' || coalesce(v_item ->> 'notes', '');
      v_chunks := pg_catalog.array_append(v_chunks, v_chunk);
      v_refs_by_chunk := pg_catalog.array_append(v_refs_by_chunk, v_refs);
      v_all_text := v_all_text || E'\n' || v_chunk;
    end loop;
    if coalesce(pg_catalog.array_length(v_chunks, 1), 0) = 0 then
      return false;
    end if;
  end if;

  v_number_claim := v_cue || '[[:space:]]*(제[[:space:]]*)?[-–—:#]?[[:space:]]*[0-9]{1,4}([[:space:]]*호)?';
  v_named_claim := v_cue || '[[:space:]]*[:：][[:space:]]*[^[:space:].,;!?][^\n.!?]{1,80}';
  v_quoted_named_claim := '[「『“"]{1}[^」』”"\n]{2,80}[」』”"]{1}[[:space:]]*' || v_cue;
  v_procedure_claim := v_cue || '(에|에서는|상|를|을)?[[:space:]]*(따라|따르면|근거로|기준으로|규정상|반드시|우선|금지|허용|실시|시행|수행|해야|한다)';
  v_number_capture := v_cue_nocapture || '[[:space:]]*(?:제[[:space:]]*)?[-–—:#]?[[:space:]]*([0-9]{1,4})(?:[[:space:]]*호)?';
  v_named_capture := v_cue_nocapture || '[[:space:]]*[:：][[:space:]]*([^\n.!?]{2,80})';
  v_quoted_named_capture := '[「『“"]{1}([^」』”"\n]{2,80})[」』”"]{1}[[:space:]]*' || v_cue_nocapture;

  v_terms := public.generated_material_focus_terms(p_topic, p_content ->> 'focus');
  select coalesce(
    pg_catalog.array_agg(distinct public.generated_material_source_label(rag.metadata)),
    '{}'::text[]
  )
  into v_matching_labels
  from public.rag_rescue as rag
  where rag.is_active
    and rag.metadata ->> 'edu_category' = p_category
    and rag.metadata ->> 'document_type' in ('sop', 'operational_guidance')
    and public.generated_material_rag_row_supports(rag.content, rag.metadata, v_terms);

  if v_status = 'found' then
    if coalesce(pg_catalog.array_length(v_labels, 1), 0) = 0 then
      return false;
    end if;
    if coalesce(pg_catalog.array_length(v_matching_labels, 1), 0) = 0 then
      return false;
    end if;

    -- 클라이언트가 적은 모든 SOP 라벨은 같은 분야의 활성 SOP/현장지침 페이지와 정확히
    -- 일치하고, 파일명뿐 아니라 그 페이지 제목/본문에서도 현재 주제가 확인되어야 한다.
    foreach v_label in array v_labels loop
      if not (v_label = any(v_matching_labels)) then
        return false;
      end if;
    end loop;

    if p_kind in ('plan', 'lesson') then
      if position('[관련 SOP 적용]' in v_designated) > 0 then
        foreach v_label in array v_labels loop
          if position(v_label in v_designated) > 0 then
            v_grounded_application := true;
            exit;
          end if;
        end loop;
      end if;
    else
      for v_chunk_index in 1..pg_catalog.array_length(v_chunks, 1) loop
        v_chunk := v_chunks[v_chunk_index];
        v_refs := coalesce(v_refs_by_chunk[v_chunk_index], '');
        if position('[관련 SOP 적용]' in v_chunk) = 0 then
          continue;
        end if;
        foreach v_label in array v_labels loop
          if position(v_label in v_chunk) > 0
            or position(v_label in v_refs) > 0 then
            v_grounded_application := true;
            exit;
          end if;
        end loop;
        exit when v_grounded_application;
      end loop;
    end if;
    if not v_grounded_application then
      return false;
    end if;
  else
    if coalesce(pg_catalog.array_length(v_labels, 1), 0) <> 0 then
      return false;
    end if;
    if coalesce(pg_catalog.array_length(v_matching_labels, 1), 0) <> 0 then
      return false;
    end if;
    v_disclosure :=
      '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.';
    if p_kind in ('plan', 'lesson') then
      if position(v_disclosure in v_designated) = 0 then
        return false;
      end if;
    elsif position(v_disclosure in v_all_text) = 0 then
      return false;
    end if;
  end if;

  -- 허용 목록에 없는 SOP/현장지침 대괄호 출처를 공유본에 넣지 못하게 한다.
  for v_match in
    select pg_catalog.regexp_matches(v_all_text, '(\[[^]]{2,}\])', 'g')
  loop
    v_ref := v_match[1];
    if v_ref = '[관련 SOP 적용]' then
      continue;
    end if;
    if v_ref ~* v_cue and not (v_ref = any(v_labels)) then
      return false;
    end if;
  end loop;

  if v_status in ('not_found', 'degraded') then
    v_claim_text := pg_catalog.replace(v_all_text, v_disclosure, ' ');
    v_claim_text := pg_catalog.replace(v_claim_text, '[관련 SOP 적용]', ' ');
    v_claim_text := pg_catalog.regexp_replace(v_claim_text, '\[[^]]+\]', ' ', 'g');
    if v_claim_text ~* v_number_claim
      or v_claim_text ~* v_named_claim
      or v_claim_text ~* v_quoted_named_claim
      or v_claim_text ~* v_procedure_claim then
      return false;
    end if;
  else
    -- 확인된 상태에서도 SOP 절차·번호·명칭을 단정한 섹션/슬라이드에는 같은 위치의
    -- 확인된 출처 라벨이 필요하다.
    for v_chunk_index in 1..pg_catalog.array_length(v_chunks, 1) loop
      v_chunk := v_chunks[v_chunk_index];
      v_refs := coalesce(v_refs_by_chunk[v_chunk_index], '');
      v_claim_text := pg_catalog.regexp_replace(v_chunk, '\[[^]]+\]', ' ', 'g');
      if not (
        v_claim_text ~* v_number_claim
        or v_claim_text ~* v_named_claim
        or v_claim_text ~* v_quoted_named_claim
        or v_claim_text ~* v_procedure_claim
      ) then
        continue;
      end if;
      v_has_label := false;
      foreach v_label in array v_labels loop
        if position(v_label in v_chunk) > 0
          or position(v_label in v_refs) > 0 then
          v_has_label := true;
          exit;
        end if;
      end loop;
      if not v_has_label then
        return false;
      end if;

      -- 같은 위치에 실제 라벨이 있어도 그 라벨에 없는 SOP 번호·명칭을 붙이면 거절한다.
      for v_match in select pg_catalog.regexp_matches(v_claim_text, v_number_capture, 'gi')
      loop
        v_claim_value := v_match[1];
        v_claim_supported := false;
        foreach v_label in array v_labels loop
          if position(public.generated_material_compact_text(v_claim_value)
            in public.generated_material_compact_text(v_label)) > 0 then
            v_claim_supported := true;
            exit;
          end if;
        end loop;
        if not v_claim_supported then
          return false;
        end if;
      end loop;

      for v_match in
        select pg_catalog.regexp_matches(v_claim_text, v_named_capture, 'gi')
        union all
        select pg_catalog.regexp_matches(v_claim_text, v_quoted_named_capture, 'gi')
      loop
        v_claim_value := v_match[1];
        if pg_catalog.char_length(public.generated_material_compact_text(v_claim_value)) < 2 then
          continue;
        end if;
        v_claim_supported := false;
        foreach v_label in array v_labels loop
          if position(public.generated_material_compact_text(v_claim_value)
            in public.generated_material_compact_text(v_label)) > 0 then
            v_claim_supported := true;
            exit;
          end if;
        end loop;
        if not v_claim_supported then
          return false;
        end if;
      end loop;
    end loop;
  end if;

  return true;
end;
$$;

-- 행 잠금을 얻은 뒤 advisory lock을 기다리면, 코퍼스 전환 트랜잭션의
-- exclusive advisory lock → generated_materials UPDATE 순서와 교착될 수 있다.
-- statement trigger에서 먼저 shared lock을 잡아 모든 생성물 DML의 잠금 순서를 고정한다.
create or replace function public.lock_generated_material_share_validation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );
  return null;
end;
$$;

create or replace function public.enforce_generated_material_share_contract()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.shared then
    if not public.generated_material_share_contract_valid(
      new.kind,
      new.category,
      new.audience,
      new.duration,
      new.topic,
      new.title,
      new.content
    ) then
      raise exception 'generated_material_share_contract_invalid'
        using errcode = '23514',
              hint = 'Regenerate or repair the SOP evidence contract before sharing.';
    end if;

    -- 작성자 표시는 클라이언트 입력을 신뢰하지 않고 본인 프로필에서 다시 계산한다.
    select coalesce(
      nullif(pg_catalog.btrim(profile.full_name), ''),
      nullif(pg_catalog.split_part(profile.email, '@', 1), ''),
      '구조대원'
    )
    into new.author_name
    from public.profiles as profile
    where profile.id = new.user_id;
    new.author_name := coalesce(new.author_name, '구조대원');
  else
    new.author_name := null;
  end if;
  return new;
end;
$$;

-- 외부·기본 코퍼스 변경은 같은 exclusive advisory lock과 공유 해제 경로를 사용한다.
create or replace function public.invalidate_generated_material_shares_for_corpus_change()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
  );
  update public.generated_materials
  set shared = false,
      author_name = null
  where shared
    and kind <> 'notebooklm';
end;
$$;

-- 활성 RAG 집합이 바뀌면 기존 found뿐 아니라 not_found 판단도 더 이상 최신이 아니다.
-- transition table을 쓰는 statement trigger로 bulk 전환 한 번당 공유 해제 UPDATE도 한 번만 실행한다.
create or replace function public.unshare_generated_materials_on_rag_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_active_corpus_changed boolean := false;
begin
  if tg_op = 'INSERT' then
    select exists (
      select 1 from new_rag_rows where is_active
    ) into v_active_corpus_changed;
  elsif tg_op = 'DELETE' then
    select exists (
      select 1 from old_rag_rows where is_active
    ) into v_active_corpus_changed;
  elsif tg_op = 'TRUNCATE' then
    -- BEFORE TRUNCATE에서는 transition table을 쓸 수 없으므로 삭제 전 활성 행을 확인한다.
    select exists (
      select 1 from public.rag_rescue where is_active
    ) into v_active_corpus_changed;
  elsif tg_op = 'UPDATE' then
    select exists (
      select 1
      from old_rag_rows as old_row
      full join new_rag_rows as new_row on new_row.id = old_row.id
      where (
        coalesce(old_row.is_active, false)
        or coalesce(new_row.is_active, false)
      )
        and (
          old_row.id is null
          or new_row.id is null
          or old_row.is_active is distinct from new_row.is_active
          or old_row.content is distinct from new_row.content
          or old_row.metadata is distinct from new_row.metadata
        )
    ) into v_active_corpus_changed;
  end if;

  if v_active_corpus_changed then
    perform public.invalidate_generated_material_shares_for_corpus_change();
  end if;
  return null;
end;
$$;

-- 기본 documents/chunks의 INSERT는 기존 exact provenance를 바꾸지 않으므로 공유를
-- 유지한다. UPDATE/DELETE/TRUNCATE는 제목·분야·상태·페이지·본문 등 근거가 달라질 수
-- 있어 statement당 한 번 보수적으로 모든 공식 공유를 해제한다.
create or replace function public.unshare_generated_materials_on_native_source_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_native_corpus_changed boolean := false;
begin
  if tg_op = 'UPDATE' then
    select exists (select 1 from new_native_rows)
    into v_native_corpus_changed;
  elsif tg_op = 'DELETE' then
    select exists (select 1 from old_native_rows)
    into v_native_corpus_changed;
  elsif tg_op = 'TRUNCATE' then
    if tg_table_name = 'documents' then
      select exists (select 1 from public.documents)
      into v_native_corpus_changed;
    elsif tg_table_name = 'chunks' then
      select exists (select 1 from public.chunks)
      into v_native_corpus_changed;
    end if;
  end if;

  if v_native_corpus_changed then
    perform public.invalidate_generated_material_shares_for_corpus_change();
  end if;
  return null;
end;
$$;

revoke all on function public.generated_material_normalize_ocr(text, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_compact_text(text)
  from public, anon, authenticated;
revoke all on function public.generated_material_source_label(jsonb)
  from public, anon, authenticated;
revoke all on function public.generated_material_source_provenance_valid(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_focus_terms(text, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_rag_row_supports(text, jsonb, text[])
  from public, anon, authenticated;
revoke all on function public.generated_material_share_contract_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.lock_generated_material_share_validation()
  from public, anon, authenticated;
revoke all on function public.enforce_generated_material_share_contract()
  from public, anon, authenticated;
revoke all on function public.invalidate_generated_material_shares_for_corpus_change()
  from public, anon, authenticated;
revoke all on function public.unshare_generated_materials_on_rag_change()
  from public, anon, authenticated;
revoke all on function public.unshare_generated_materials_on_native_source_change()
  from public, anon, authenticated;

-- 구형 공식 자료는 새 트리거 이전에 모두 비공개로 되돌린다. 분류 마이그레이션보다
-- 먼저 적용되는 환경에서도 fabricated/stale evidence가 공개 상태로 남지 않게 하는 보수적 조치다.
-- 본문은 삭제하지 않으며 사용자가 재생성·검증한 뒤 다시 공유할 수 있다.
update public.generated_materials
set shared = false,
    author_name = null
where shared
  and kind <> 'notebooklm';

-- NotebookLM은 기존 공유 호환을 유지하되, Data API로 넣은 비문자·과대 프롬프트까지
-- 공개 상태로 남기지는 않는다.
update public.generated_materials
set shared = false,
    author_name = null
where shared
  and kind = 'notebooklm'
  and (
    pg_catalog.jsonb_typeof(content) is distinct from 'object'
    or pg_catalog.jsonb_typeof(content -> 'prompt') is distinct from 'string'
    or coalesce(pg_catalog.char_length(pg_catalog.btrim(content ->> 'prompt')), 0)
      not between 10 and 100000
    or pg_catalog.char_length(title) > 200
    or coalesce(pg_catalog.char_length(category), 0) > 100
    or coalesce(pg_catalog.char_length(audience), 0) > 50
    or coalesce(pg_catalog.char_length(duration), 0) > 20
    or coalesce(pg_catalog.char_length(topic), 0) > 100
    or pg_catalog.pg_column_size(content) > 262144
    or pg_catalog.octet_length(content::text) > 131072
  );

drop trigger if exists lock_generated_material_share_validation
  on public.generated_materials;
create trigger lock_generated_material_share_validation
before insert or update of
  kind, category, audience, duration, topic, title, content, shared, author_name
on public.generated_materials
for each statement execute function public.lock_generated_material_share_validation();

drop trigger if exists enforce_generated_material_share_contract
  on public.generated_materials;
create trigger enforce_generated_material_share_contract
before insert or update of
  kind, category, audience, duration, topic, title, content, shared, author_name
on public.generated_materials
for each row execute function public.enforce_generated_material_share_contract();

drop trigger if exists unshare_generated_materials_on_rag_insert
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_insert
after insert on public.rag_rescue
referencing new table as new_rag_rows
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_rag_delete
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_delete
after delete on public.rag_rescue
referencing old table as old_rag_rows
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_rag_truncate
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_truncate
before truncate on public.rag_rescue
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_rag_update
  on public.rag_rescue;
create trigger unshare_generated_materials_on_rag_update
after update on public.rag_rescue
referencing old table as old_rag_rows new table as new_rag_rows
for each statement
execute function public.unshare_generated_materials_on_rag_change();

drop trigger if exists unshare_generated_materials_on_documents_update
  on public.documents;
create trigger unshare_generated_materials_on_documents_update
after update on public.documents
referencing old table as old_native_rows new table as new_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_documents_delete
  on public.documents;
create trigger unshare_generated_materials_on_documents_delete
after delete on public.documents
referencing old table as old_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_documents_truncate
  on public.documents;
create trigger unshare_generated_materials_on_documents_truncate
before truncate on public.documents
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_chunks_update
  on public.chunks;
create trigger unshare_generated_materials_on_chunks_update
after update on public.chunks
referencing old table as old_native_rows new table as new_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_chunks_delete
  on public.chunks;
create trigger unshare_generated_materials_on_chunks_delete
after delete on public.chunks
referencing old table as old_native_rows
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

drop trigger if exists unshare_generated_materials_on_chunks_truncate
  on public.chunks;
create trigger unshare_generated_materials_on_chunks_truncate
before truncate on public.chunks
for each statement
execute function public.unshare_generated_materials_on_native_source_change();

-- 기존 FOR ALL 정책을 작업별 정책으로 나눠 쓰기 의도를 명시한다. 소유권은 RLS가,
-- shared=true 본문의 안전 계약은 위 트리거가 모든 Data API 경로에서 함께 강제한다.
drop policy if exists "own generated_materials" on public.generated_materials;
drop policy if exists generated_materials_owner_select on public.generated_materials;
drop policy if exists generated_materials_owner_insert on public.generated_materials;
drop policy if exists generated_materials_owner_update on public.generated_materials;
drop policy if exists generated_materials_owner_delete on public.generated_materials;

create policy generated_materials_owner_select
on public.generated_materials
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy generated_materials_owner_insert
on public.generated_materials
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy generated_materials_owner_update
on public.generated_materials
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

create policy generated_materials_owner_delete
on public.generated_materials
for delete
to authenticated
using ((select auth.uid()) = user_id);


-- ============================================================================
-- 20260829140500_classify_rag_procedure_sources.sql
-- ============================================================================

-- 생성 결과에서 일반 교재를 SOP 근거로 오인하지 않도록 RAG 문서 유형을 분리한다.
-- 현재 자료실에서 관리자가 확인한 공식 현장활동 지침·대응 매뉴얼·훈련교범만
-- operational_guidance로 백필한다. 제목 추정이 아니라 현재 documents.id 허용목록을 사용한다.

update public.rag_rescue
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{document_type}',
  '"operational_guidance"'::jsonb,
  true
)
where metadata ->> 'document_id' in ('4', '6', '7', '9', '10', '11', '13', '16');

-- 나머지 기존 문서는 일반 교육자료로 명시한다. 이후 적재분은 rag7.py가 관리자가
-- 선택한 document_type을 처음부터 기록한다.
update public.rag_rescue
set metadata = jsonb_set(
  coalesce(metadata, '{}'::jsonb),
  '{document_type}',
  '"training_material"'::jsonb,
  true
)
where not (metadata ? 'document_type');

create index if not exists rag_rescue_active_document_type_idx
  on public.rag_rescue (is_active, (metadata ->> 'document_type'));

-- SOP 검색과 공유 DB 계약이 모두 페이지 제목(Header 2)+본문을 같은 후보 범위로 보게 한다.
-- Supabase JS는 여러 열을 한 번에 FTS할 수 없으므로 저장 생성 열로 합치고 GIN 인덱스를 둔다.
alter table public.rag_rescue
  add column if not exists sop_search_vector tsvector
  generated always as (
    pg_catalog.to_tsvector(
      'simple'::regconfig,
      public.generated_material_normalize_ocr(
        coalesce(metadata ->> 'Header 2', '') || ' ' || coalesce(content, ''),
        coalesce(metadata ->> 'source', '') || ' ' ||
          coalesce(metadata ->> 'Header 2', '')
      )
    )
  ) stored;

create index if not exists rag_rescue_sop_search_vector_idx
  on public.rag_rescue using gin (sop_search_vector)
  where is_active
    and metadata ->> 'document_type' in ('sop', 'operational_guidance');

-- stored generated column은 RAG INSERT/UPDATE 실행자 권한으로 정규화 함수를 호출한다.
-- 인덱서가 쓰는 service_role에만 실행권을 주고 anon/authenticated에는 공개하지 않는다.
grant execute on function public.generated_material_normalize_ocr(text, text)
  to service_role;


-- ============================================================================
-- 20260829160624_allow_common_sop_generation_evidence.sql
-- ============================================================================

-- 요청 분야의 절차 자료와 전 분야 공통 SOP를 같은 생성·저장·공유 계약으로 검증한다.
-- 일반 교육자료는 요청 분야가 정확히 일치할 때만 허용하고, 현장지휘·공통 범위에서는
-- 관리자가 SOP 또는 현장지침으로 분류한 활성 RAG 행만 허용한다.

create or replace function public.generated_material_rag_scope_valid(
  p_metadata jsonb,
  p_category text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select
    p_metadata ->> 'edu_category' = p_category
    or (
      p_metadata ->> 'edu_category' = '현장지휘·공통'
      and p_metadata ->> 'document_type' in ('sop', 'operational_guidance')
    );
$$;

create or replace function public.generated_material_source_provenance_valid(
  p_source jsonb,
  p_category text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from public.rag_rescue as rag
      where rag.is_active
        and public.generated_material_rag_scope_valid(rag.metadata, p_category)
        and rag.metadata ->> 'document_id' ~ '^[0-9]+$'
        and coalesce(
          nullif(pg_catalog.ltrim(rag.metadata ->> 'document_id', '0'), ''),
          '0'
        ) = pg_catalog.trunc((p_source ->> 'document_id')::numeric)::text
        and (
          (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'null'
            and rag.metadata ->> 'page_num' is null
          )
          or (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
            and rag.metadata ->> 'page_num' ~ '^[0-9]+$'
            and coalesce(
              nullif(pg_catalog.ltrim(rag.metadata ->> 'page_num', '0'), ''),
              '0'
            ) = pg_catalog.trunc((p_source ->> 'page')::numeric)::text
          )
        )
        and public.generated_material_source_label(rag.metadata)
          = '[' || pg_catalog.btrim(p_source ->> 'doc') ||
            case when pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
              then ' p.' || pg_catalog.trunc((p_source ->> 'page')::numeric)::text
              else '' end || ']'
    )
    or exists (
      select 1
      from public.documents as document
      join public.chunks as chunk on chunk.document_id = document.id
      where document.id::numeric
          = pg_catalog.trunc((p_source ->> 'document_id')::numeric)
        and document.category = p_category
        and pg_catalog.btrim(document.title) = pg_catalog.btrim(p_source ->> 'doc')
        and document.status = 'processed'
        and (
          (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'null'
            and chunk.page_num is null
          )
          or (
            pg_catalog.jsonb_typeof(p_source -> 'page') = 'number'
            and chunk.page_num::numeric = pg_catalog.trunc((p_source ->> 'page')::numeric)
          )
        )
    );
$$;

create or replace function public.generated_material_share_contract_valid(
  p_kind text,
  p_category text,
  p_audience text,
  p_duration text,
  p_topic text,
  p_title text,
  p_content jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_labels text[] := '{}'::text[];
  v_terms text[];
  v_matching_labels text[] := '{}'::text[];
  v_target_heading text;
  v_target_count integer := 0;
  v_designated text := '';
  v_all_text text := '';
  v_chunks text[] := '{}'::text[];
  v_refs_by_chunk text[] := '{}'::text[];
  v_chunk text;
  v_chunk_index integer;
  v_item jsonb;
  v_bullets text;
  v_refs text;
  v_visual jsonb;
  v_visual_mode text;
  v_label text;
  v_ref text;
  v_match text[];
  v_has_label boolean;
  v_grounded_application boolean := false;
  v_disclosure text;
  v_claim_text text;
  v_cue text := '(SOP|표준[[:space:]]*(작전)?[[:space:]]*절차|현장[[:space:]]*(활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
  v_cue_nocapture text := '(?:SOP|표준[[:space:]]*(?:작전)?[[:space:]]*절차|현장[[:space:]]*(?:활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
  v_number_claim text;
  v_named_claim text;
  v_quoted_named_claim text;
  v_procedure_claim text;
  v_number_capture text;
  v_quoted_named_capture text;
  v_quoted_named_capture_after text;
  v_claim_value text;
  v_claim_supported boolean;
  v_label_match text[];
  v_claim_number text;
  v_label_number text;
begin
  if p_kind not in ('plan', 'lesson', 'slides', 'notebooklm')
    or pg_catalog.jsonb_typeof(p_content) is distinct from 'object'
    or nullif(pg_catalog.btrim(p_title), '') is null
    or pg_catalog.char_length(p_title) > 200
    or pg_catalog.pg_column_size(p_content) > 262144
    or pg_catalog.octet_length(p_content::text) > 131072 then
    return false;
  end if;

  -- API 저장 계약과 같은 메타데이터 상한을 모든 공유 유형에 적용한다.
  -- NotebookLM도 선택 메타데이터를 저장할 수 있으므로 조기 반환 전에 검사한다.
  if coalesce(pg_catalog.char_length(p_category), 0) > 100
    or coalesce(pg_catalog.char_length(p_audience), 0) > 50
    or coalesce(pg_catalog.char_length(p_duration), 0) > 20
    or coalesce(pg_catalog.char_length(p_topic), 0) > 100 then
    return false;
  end if;

  -- 과거 NotebookLM 프롬프트는 공식 훈련 문서가 아니므로 기존 공유 호환만 유지한다.
  if p_kind = 'notebooklm' then
    return pg_catalog.jsonb_typeof(p_content -> 'prompt') = 'string'
      and coalesce(pg_catalog.char_length(pg_catalog.btrim(p_content ->> 'prompt')), 0)
      between 10 and 100000;
  end if;

  if nullif(pg_catalog.btrim(p_category), '') is null
    or nullif(pg_catalog.btrim(p_audience), '') is null
    or nullif(pg_catalog.btrim(p_duration), '') is null
    or nullif(pg_catalog.btrim(p_topic), '') is null
    or pg_catalog.jsonb_typeof(p_content -> 'sopEvidence') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_content #> '{sopEvidence,sourceLabels}') is distinct from 'array' then
    return false;
  end if;

  v_status := p_content #>> '{sopEvidence,status}';
  if v_status is null or v_status not in ('found', 'not_found', 'degraded') then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(p_content #> '{sopEvidence,sourceLabels}') > 20
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(
        p_content #> '{sopEvidence,sourceLabels}'
      ) as label(value)
      where pg_catalog.jsonb_typeof(label.value) is distinct from 'string'
    ) then
    return false;
  end if;
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.btrim(item.value)), '{}'::text[])
  into v_labels
  from pg_catalog.jsonb_array_elements_text(
    p_content #> '{sopEvidence,sourceLabels}'
  ) as item(value)
  where nullif(pg_catalog.btrim(item.value), '') is not null;
  if exists (
    select 1
    from pg_catalog.unnest(v_labels) as label(value)
    where pg_catalog.char_length(label.value) > 300
  ) then
    return false;
  end if;

  -- DB가 정상적으로 실행 중인 공유 트랜잭션에서는 검색 장애 상태를 클라이언트가
  -- 스스로 주장할 수 없다. 검색 장애 초안은 저장만 하고 재생성 후 공유한다.
  if v_status = 'degraded' then
    return false;
  end if;

  -- 계획서·교안은 구형 저장본 호환을 위해 sources 생략을 빈 배열로 보되, 값이 있으면
  -- 슬라이드와 같은 구조·분량·실제 원본 계약을 적용한다. 슬라이드는 API 계약상 배열이 필수다.
  if p_kind = 'slides'
    and pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array' then
    return false;
  end if;
  if p_content ? 'sources'
    and pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array' then
    return false;
  end if;
  if pg_catalog.jsonb_array_length(
    case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
      then p_content -> 'sources' else '[]'::jsonb end
  ) > 80 then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
        then p_content -> 'sources' else '[]'::jsonb end
    ) as source(value)
    where pg_catalog.jsonb_typeof(source.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(source.value -> 'doc') is distinct from 'string'
      or pg_catalog.char_length(
        pg_catalog.btrim(coalesce(source.value ->> 'doc', ''))
      ) not between 1 and 300
      or case
        when pg_catalog.jsonb_typeof(source.value -> 'document_id') = 'number' then
          (source.value ->> 'document_id')::numeric
            <> pg_catalog.trunc((source.value ->> 'document_id')::numeric)
          or (source.value ->> 'document_id')::numeric
            not between 1 and 9007199254740991
        else true
      end
      or not (source.value ? 'page')
      or case
        when pg_catalog.jsonb_typeof(source.value -> 'page') = 'null' then false
        when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number' then
          (source.value ->> 'page')::numeric
            <> pg_catalog.trunc((source.value ->> 'page')::numeric)
          or (source.value ->> 'page')::numeric
            not between 1 and 9007199254740991
        else true
      end
  ) then
    return false;
  end if;

  -- 출처 배지·PPTX 근거자료 부록에는 visual에서 쓰지 않은 sources도 노출된다.
  -- 모든 원소를 공통 provenance 함수로 검사해 coordinated tamper도 차단한다.
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(
      case when pg_catalog.jsonb_typeof(p_content -> 'sources') = 'array'
        then p_content -> 'sources' else '[]'::jsonb end
    ) as source(value)
    where not public.generated_material_source_provenance_valid(source.value, p_category)
  ) then
    return false;
  end if;

  if p_kind in ('plan', 'lesson') then
    if pg_catalog.jsonb_typeof(p_content -> 'sections') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_content -> 'sections') not between 1 and 8 then
      return false;
    end if;
    v_target_heading := case when p_kind = 'plan' then '훈련내용' else '핵심이론' end;
    for v_item in select value from pg_catalog.jsonb_array_elements(p_content -> 'sections') as section(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'heading') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_item -> 'content') is distinct from 'string'
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'heading', ''))) not between 1 and 200
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'content', ''))) not between 1 and 20000 then
        return false;
      end if;
      v_chunk := coalesce(v_item ->> 'heading', '') || E'\n' ||
        coalesce(v_item ->> 'content', '');
      v_chunks := pg_catalog.array_append(v_chunks, v_chunk);
      v_refs_by_chunk := pg_catalog.array_append(v_refs_by_chunk, '');
      v_all_text := v_all_text || E'\n' || v_chunk;
      if pg_catalog.btrim(v_item ->> 'heading') = v_target_heading then
        v_target_count := v_target_count + 1;
        if v_target_count = 1 then
          v_designated := coalesce(v_item ->> 'content', '');
        end if;
      end if;
    end loop;
    -- JS 계약은 첫 지정 섹션을 사용한다. 중복 제목을 허용하면 DB와 앱이 서로 다른
    -- 섹션을 검사할 수 있으므로 공식 공유본에서는 정확히 한 개만 인정한다.
    if v_target_count <> 1 or v_designated = '' then
      return false;
    end if;
  else
    if pg_catalog.jsonb_typeof(p_content -> 'slides') is distinct from 'array' then
      return false;
    end if;
    if pg_catalog.jsonb_array_length(p_content -> 'slides') not between 1 and 20 then
      return false;
    end if;
    for v_item in select value from pg_catalog.jsonb_array_elements(p_content -> 'slides') as slide(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object' then
        return false;
      end if;
      if pg_catalog.jsonb_typeof(v_item -> 'title') is distinct from 'string'
        or (
          v_item ? 'notes'
          and pg_catalog.jsonb_typeof(v_item -> 'notes') is distinct from 'string'
        )
        or pg_catalog.char_length(pg_catalog.btrim(coalesce(v_item ->> 'title', ''))) not between 1 and 200
        or pg_catalog.char_length(coalesce(v_item ->> 'notes', '')) > 30000
        or pg_catalog.jsonb_typeof(v_item -> 'bullets') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_item -> 'bullets') not between 1 and 4
        or (
          v_item ? 'steps'
          and (
            pg_catalog.jsonb_typeof(v_item -> 'steps') is distinct from 'array'
            or pg_catalog.jsonb_array_length(v_item -> 'steps') > 5
          )
        )
        or (
          v_item ? 'sourceRefs'
          and (
            pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') is distinct from 'array'
            or pg_catalog.jsonb_array_length(v_item -> 'sourceRefs') > 4
          )
        ) then
        return false;
      end if;
      if exists (
        select 1
        from pg_catalog.jsonb_array_elements(v_item -> 'bullets') as bullet(value)
        where pg_catalog.jsonb_typeof(bullet.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(bullet.value #>> '{}')) not between 1 and 500
      ) or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(v_item -> 'steps') = 'array'
            then v_item -> 'steps' else '[]'::jsonb end
        ) as step(value)
        where pg_catalog.jsonb_typeof(step.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(step.value #>> '{}')) not between 1 and 100
      ) or exists (
        select 1
        from pg_catalog.jsonb_array_elements(
          case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
            then v_item -> 'sourceRefs' else '[]'::jsonb end
        ) as ref(value)
        where pg_catalog.jsonb_typeof(ref.value) is distinct from 'string'
          or pg_catalog.char_length(pg_catalog.btrim(ref.value #>> '{}')) not between 1 and 300
      ) then
        return false;
      end if;

      if v_item ? 'visual' then
        v_visual := v_item -> 'visual';
        v_visual_mode := v_visual ->> 'mode';
        if pg_catalog.jsonb_typeof(v_visual) is distinct from 'object'
          or pg_catalog.jsonb_typeof(v_visual -> 'mode') is distinct from 'string'
          or v_visual_mode not in ('source-page', 'source-crop', 'native-diagram', 'none')
          or (
            v_visual ? 'documentId'
            and case
              when pg_catalog.jsonb_typeof(v_visual -> 'documentId') = 'number' then
                (v_visual ->> 'documentId')::numeric
                  <> pg_catalog.trunc((v_visual ->> 'documentId')::numeric)
                or (v_visual ->> 'documentId')::numeric
                  not between 1 and 9007199254740991
              else true
            end
          )
          or (
            v_visual ? 'page'
            and case
              when pg_catalog.jsonb_typeof(v_visual -> 'page') = 'number' then
                (v_visual ->> 'page')::numeric
                  <> pg_catalog.trunc((v_visual ->> 'page')::numeric)
                or (v_visual ->> 'page')::numeric
                  not between 1 and 9007199254740991
              else true
            end
          )
          or (
            v_visual ? 'sourceRef'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'sourceRef') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'sourceRef', ''))
              ) not between 1 and 300
            )
          )
          or (
            v_visual ? 'altText'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'altText') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'altText', ''))
              ) not between 1 and 300
            )
          )
          or (
            v_visual ? 'caption'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'caption') is distinct from 'string'
              or pg_catalog.char_length(
                pg_catalog.btrim(coalesce(v_visual ->> 'caption', ''))
              ) not between 1 and 200
            )
          )
          or (
            v_visual ? 'fit'
            and (
              pg_catalog.jsonb_typeof(v_visual -> 'fit') is distinct from 'string'
              or v_visual ->> 'fit' not in ('contain', 'cover')
            )
          ) then
          return false;
        end if;

        if v_visual_mode in ('source-page', 'source-crop') then
          if not (v_visual ? 'documentId')
            or not (v_visual ? 'page')
            or not (v_visual ? 'sourceRef') then
            return false;
          end if;
          if not exists (
            select 1
            from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
            where (source.value ->> 'document_id')::numeric
                = (v_visual ->> 'documentId')::numeric
              and pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
              and (source.value ->> 'page')::numeric
                = (v_visual ->> 'page')::numeric
              and '[' || pg_catalog.btrim(source.value ->> 'doc') ||
                ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text || ']'
                = pg_catalog.btrim(v_visual ->> 'sourceRef')
          ) then
            return false;
          end if;
        end if;
      else
        v_visual := null;
        v_visual_mode := null;
      end if;

      select coalesce(pg_catalog.string_agg(value, E'\n'), '')
      into v_bullets
      from pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(v_item -> 'bullets') = 'array'
          then v_item -> 'bullets' else '[]'::jsonb end
      ) as bullet(value);
      select coalesce(pg_catalog.string_agg(value, E'\n'), '')
      into v_refs
      from pg_catalog.jsonb_array_elements_text(
        case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
          then v_item -> 'sourceRefs' else '[]'::jsonb end
      ) as ref(value);
      -- sourceRefs는 화면 본문이 아니라 인용 목록이다. JS와 같이 각 값을 별도로
      -- 검증한다. SOP 라벨은 확인된 SOP 목록, 그 외 라벨은 위에서 실제 RAG와
      -- 대조한 content.sources 중 하나와 정확히 일치해야 한다.
      for v_ref in
        select pg_catalog.btrim(value)
        from pg_catalog.jsonb_array_elements_text(
          case when pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') = 'array'
            then v_item -> 'sourceRefs' else '[]'::jsonb end
        ) as ref(value)
      loop
        if not (v_ref = any(v_labels))
          and not exists (
            select 1
            from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
            where '[' || pg_catalog.btrim(source.value ->> 'doc') ||
              case when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
                then ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text
                else '' end || ']'
                = v_ref
          ) then
          return false;
        end if;
      end loop;
      v_chunk := coalesce(v_item ->> 'title', '') || E'\n' ||
        v_bullets || E'\n' || coalesce(v_item ->> 'notes', '');
      v_chunks := pg_catalog.array_append(v_chunks, v_chunk);
      v_refs_by_chunk := pg_catalog.array_append(v_refs_by_chunk, v_refs);
      v_all_text := v_all_text || E'\n' || v_chunk;
    end loop;
    if coalesce(pg_catalog.array_length(v_chunks, 1), 0) = 0 then
      return false;
    end if;
  end if;

  v_number_claim := v_cue || '[[:space:]]*(제[[:space:]]*)?[-–—:#]?[[:space:]]*[0-9]{1,4}([[:space:]]*호)?';
  v_named_claim := v_cue || '[[:space:]]*[:：][[:space:]]*[^[:space:].,;!?][^\n.!?]{1,80}';
  v_quoted_named_claim := '[「『“"]{1}[^」』”"\n]{2,80}[」』”"]{1}[[:space:]]*' || v_cue;
  v_procedure_claim := v_cue || '(에|에서는|상|를|을)?[[:space:]]*(따라|따르면|근거로|기준으로|규정상|반드시|우선|금지|허용|실시|시행|수행|해야|한다)';
  v_number_capture := v_cue_nocapture || '[[:space:]]*(?:제[[:space:]]*)?[-–—:#]?[[:space:]]*([0-9]{1,4})(?:[[:space:]]*호)?';
  v_quoted_named_capture := '[「『“"]{1}([^」』”"\n]{2,80})[」』”"]{1}[[:space:]]*' || v_cue_nocapture;
  v_quoted_named_capture_after := v_cue_nocapture || '[[:space:]]*(?:[:：][[:space:]]*)?[「『“"]{1}([^」』”"\n]{2,80})[」』”"]{1}';

  v_terms := public.generated_material_focus_terms(p_topic, p_content ->> 'focus');
  select coalesce(
    pg_catalog.array_agg(distinct public.generated_material_source_label(rag.metadata)),
    '{}'::text[]
  )
  into v_matching_labels
  from public.rag_rescue as rag
  where rag.is_active
    and public.generated_material_rag_scope_valid(rag.metadata, p_category)
    and rag.metadata ->> 'document_type' in ('sop', 'operational_guidance')
    and public.generated_material_rag_row_supports(rag.content, rag.metadata, v_terms);

  if v_status = 'found' then
    if coalesce(pg_catalog.array_length(v_labels, 1), 0) = 0 then
      return false;
    end if;
    if coalesce(pg_catalog.array_length(v_matching_labels, 1), 0) = 0 then
      return false;
    end if;

    -- 클라이언트가 적은 모든 SOP 라벨은 요청 분야 또는 현장지휘·공통 범위의 활성
    -- SOP/현장지침 페이지와 정확히 일치하고, 그 페이지 제목/본문에서 주제가 확인돼야 한다.
    foreach v_label in array v_labels loop
      if not (v_label = any(v_matching_labels)) then
        return false;
      end if;
    end loop;

    if p_kind in ('plan', 'lesson') then
      if position('[관련 SOP 적용]' in v_designated) > 0 then
        foreach v_label in array v_labels loop
          if position(v_label in v_designated) > 0 then
            v_grounded_application := true;
            exit;
          end if;
        end loop;
      end if;
    else
      for v_chunk_index in 1..pg_catalog.array_length(v_chunks, 1) loop
        v_chunk := v_chunks[v_chunk_index];
        v_refs := coalesce(v_refs_by_chunk[v_chunk_index], '');
        if position('[관련 SOP 적용]' in v_chunk) = 0 then
          continue;
        end if;
        foreach v_label in array v_labels loop
          if position(v_label in v_chunk) > 0
            or position(v_label in v_refs) > 0 then
            v_grounded_application := true;
            exit;
          end if;
        end loop;
        exit when v_grounded_application;
      end loop;
    end if;
    if not v_grounded_application then
      return false;
    end if;
  else
    if coalesce(pg_catalog.array_length(v_labels, 1), 0) <> 0 then
      return false;
    end if;
    if coalesce(pg_catalog.array_length(v_matching_labels, 1), 0) <> 0 then
      return false;
    end if;
    v_disclosure :=
      '관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.';
    if p_kind in ('plan', 'lesson') then
      if position(v_disclosure in v_designated) = 0 then
        return false;
      end if;
    elsif position(v_disclosure in v_all_text) = 0 then
      return false;
    end if;
  end if;

  -- 허용 목록에 없는 SOP/현장지침 대괄호 출처를 공유본에 넣지 못하게 한다.
  for v_match in
    select pg_catalog.regexp_matches(v_all_text, '(\[[^]]{2,}\])', 'g')
  loop
    v_ref := v_match[1];
    if v_ref = '[관련 SOP 적용]' then
      continue;
    end if;
    if v_ref ~* v_cue and not (v_ref = any(v_labels)) then
      return false;
    end if;
  end loop;

  if v_status in ('not_found', 'degraded') then
    v_claim_text := pg_catalog.replace(v_all_text, v_disclosure, ' ');
    v_claim_text := pg_catalog.replace(v_claim_text, '[관련 SOP 적용]', ' ');
    v_claim_text := pg_catalog.regexp_replace(v_claim_text, '\[[^]]+\]', ' ', 'g');
    if v_claim_text ~* v_number_claim
      or v_claim_text ~* v_named_claim
      or v_claim_text ~* v_quoted_named_claim
      or v_claim_text ~* v_procedure_claim then
      return false;
    end if;
  else
    -- 확인된 상태에서도 SOP 절차·번호·명칭을 단정한 섹션/슬라이드에는 같은 위치의
    -- 확인된 출처 라벨이 필요하다.
    for v_chunk_index in 1..pg_catalog.array_length(v_chunks, 1) loop
      v_chunk := v_chunks[v_chunk_index];
      v_refs := coalesce(v_refs_by_chunk[v_chunk_index], '');
      v_claim_text := pg_catalog.regexp_replace(v_chunk, '\[[^]]+\]', ' ', 'g');
      if not (
        v_claim_text ~* v_number_claim
        or v_claim_text ~* v_named_claim
        or v_claim_text ~* v_quoted_named_claim
        or v_claim_text ~* v_procedure_claim
      ) then
        continue;
      end if;
      v_has_label := false;
      foreach v_label in array v_labels loop
        if position(v_label in v_chunk) > 0
          or position(v_label in v_refs) > 0 then
          v_has_label := true;
          exit;
        end if;
      end loop;
      if not v_has_label then
        return false;
      end if;

      -- 같은 위치에 실제 라벨이 있어도 그 라벨에 없는 SOP 번호·명칭을 붙이면 거절한다.
      for v_match in select pg_catalog.regexp_matches(v_claim_text, v_number_capture, 'gi')
      loop
        v_claim_number := coalesce(
          nullif(pg_catalog.ltrim(v_match[1], '0'), ''),
          '0'
        );
        v_claim_supported := false;
        foreach v_label in array v_labels loop
          for v_label_match in
            select pg_catalog.regexp_matches(v_label, v_number_capture, 'gi')
          loop
            v_label_number := coalesce(
              nullif(pg_catalog.ltrim(v_label_match[1], '0'), ''),
              '0'
            );
            if v_label_number = v_claim_number then
              v_claim_supported := true;
              exit;
            end if;
          end loop;
          exit when v_claim_supported;
        end loop;
        if not v_claim_supported then
          return false;
        end if;
      end loop;

      -- 콜론 뒤 일반 설명문은 고유명으로 보지 않는다. 따옴표로 명시한 명칭만
      -- 양방향(`“명칭” SOP`, `SOP: “명칭”`)으로 추출해 라벨과 비교한다.
      for v_match in
        select pg_catalog.regexp_matches(v_claim_text, v_quoted_named_capture, 'gi')
        union all
        select pg_catalog.regexp_matches(v_claim_text, v_quoted_named_capture_after, 'gi')
      loop
        v_claim_value := v_match[1];
        if pg_catalog.char_length(public.generated_material_compact_text(v_claim_value)) < 2 then
          continue;
        end if;
        v_claim_supported := false;
        foreach v_label in array v_labels loop
          if position(public.generated_material_compact_text(v_claim_value)
            in public.generated_material_compact_text(v_label)) > 0 then
            v_claim_supported := true;
            exit;
          end if;
        end loop;
        if not v_claim_supported then
          return false;
        end if;
      end loop;
    end loop;
  end if;

  return true;
end;
$$;

revoke all on function public.generated_material_rag_scope_valid(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_source_provenance_valid(jsonb, text)
  from public, anon, authenticated;
revoke all on function public.generated_material_share_contract_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;

-- 공통 SOP가 이미 존재하는 상태에서 과거의 분야 일치 전용 계약으로 공유된 자료는
-- 새 계약상 not_found/found 판단이 달라질 수 있다. 본문은 보존하고 공유 상태만 내려
-- 사용자가 현재 근거로 다시 저장·검증한 뒤 공유하게 한다.
-- 기존 공유 DML의 shared advisory lock과 같은 키를 exclusive로 획득한다. 진행 중인
-- 구형 계약 공유가 끝난 뒤 아래 UPDATE가 보게 하고, 커밋 전에는 새 공유가 들어오지 못하게 한다.
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)
);

update public.generated_materials
set shared = false,
    author_name = null
where shared
  and kind <> 'notebooklm';


-- ============================================================================
-- 20260829163049_protect_generated_material_quality_and_revision.sql
-- ============================================================================

-- 생성물의 핵심 품질 계약을 DB 직접 쓰기에도 적용하고, 여러 사용자가 같은 저장본을
-- 편집할 때 조용히 덮어쓰지 않도록 낙관적 개정 번호를 추가한다.

alter table public.generated_materials
  add column if not exists revision bigint not null default 1;

do $$
begin
  if not exists (
    select 1
    from pg_catalog.pg_constraint
    where conrelid = 'public.generated_materials'::regclass
      and conname = 'generated_materials_revision_positive'
  ) then
    alter table public.generated_materials
      add constraint generated_materials_revision_positive check (revision > 0);
  end if;
end;
$$;

create or replace function public.generated_material_visible_length(p_value text)
returns integer
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.char_length(
    pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(p_value, '')), '[[:space:]]+', ' ', 'g')
  );
$$;

-- JS 품질검사와 같은 [시간: 10분], [실습 · 20분] 표식만 분으로 환산한다.
-- 출처 페이지, 제한시간 설명 등은 합계에 섞지 않는다.
create or replace function public.generated_material_bracketed_minutes(p_value text)
returns table(minutes integer)
language sql
immutable
set search_path = ''
as $$
  select
    (time_match.value[1])::integer
      * case when time_match.value[2] = '시간' then 60 else 1 end
  from pg_catalog.regexp_matches(coalesce(p_value, ''), '\[([^]\n]+)\]', 'g')
    as bracket(value)
  cross join lateral pg_catalog.regexp_matches(
    bracket.value[1],
    '^(?:시간[[:space:]]*[:：][[:space:]]*|[^][\n]{1,50}[[:space:]]*[·•∙][[:space:]]*)([0-9]+)[[:space:]]*(분|시간)(?:[[:space:]]*(?:$|[/|,;·•∙-]))',
    'i'
  ) as time_match(value)
  where bracket.value[1] !~* '(p\.[[:space:]]*[0-9]+|출처|제한[[:space:]]*시간)'
    and (time_match.value[1])::numeric between 1 and 2147483647;
$$;

create or replace function public.generated_material_is_control_marker(p_reference text)
returns boolean
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_body text;
begin
  if pg_catalog.btrim(coalesce(p_reference, '')) = '[관련 SOP 적용]' then
    return true;
  end if;
  if coalesce(p_reference, '') !~ '^\[[^]\n]+\]$' then
    return false;
  end if;
  v_body := pg_catalog.btrim(
    pg_catalog.substr(p_reference, 2, pg_catalog.char_length(p_reference) - 2)
  );
  if v_body ~* '(p\.[[:space:]]*[0-9]+|출처|제한[[:space:]]*시간)' then
    return false;
  end if;
  return v_body ~* '^(?:시간[[:space:]]*[:：][[:space:]]*|[^][\n]{1,50}[[:space:]]*[·•∙][[:space:]]*)[0-9]+[[:space:]]*(?:분|시간)(?:[[:space:]]*(?:$|[/|,;·•∙-].*))?$';
end;
$$;

create or replace function public.generated_material_core_quality_valid(
  p_kind text,
  p_category text,
  p_audience text,
  p_duration text,
  p_topic text,
  p_title text,
  p_content jsonb
)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_expected_minutes integer;
  v_sections jsonb;
  v_slides jsonb;
  v_item jsonb;
  v_heading text;
  v_required_headings text[];
  v_citation_headings text[];
  v_designated_heading text;
  v_safety_heading text;
  v_evaluation_heading text;
  v_minimum_length integer;
  v_text text;
  v_safety_text text := '';
  v_evaluation_text text := '';
  v_designated_text text := '';
  v_all_text text := '';
  v_minutes integer;
  v_time_count integer := 0;
  v_time_total integer := 0;
  v_section_time_count integer;
  v_source_labels text[] := '{}'::text[];
  v_derived_labels text[] := '{}'::text[];
  v_sop_labels text[] := '{}'::text[];
  v_status text;
  v_reference text;
  v_reference_match text[];
  v_slide_count integer;
  v_slide_text text;
  v_visual jsonb;
  v_visual_mode text;
  v_has_safety boolean := false;
  v_has_evaluation boolean := false;
  v_disclosure text;
  v_cue text := '(SOP|표준[[:space:]]*(작전)?[[:space:]]*절차|현장[[:space:]]*(활동)?[[:space:]]*지침|현장[[:space:]]*대응[[:space:]]*매뉴얼|재난[[:space:]]*대응[[:space:]]*매뉴얼)';
begin
  if p_kind not in ('plan', 'lesson', 'slides', 'notebooklm')
    or pg_catalog.jsonb_typeof(p_content) is distinct from 'object'
    or nullif(pg_catalog.btrim(p_title), '') is null
    or pg_catalog.char_length(p_title) > 200
    or pg_catalog.pg_column_size(p_content) > 262144
    or pg_catalog.octet_length(p_content::text) > 131072
    or coalesce(pg_catalog.char_length(p_category), 0) > 100
    or coalesce(pg_catalog.char_length(p_audience), 0) > 50
    or coalesce(pg_catalog.char_length(p_duration), 0) > 20
    or coalesce(pg_catalog.char_length(p_topic), 0) > 100 then
    return false;
  end if;

  if p_kind = 'notebooklm' then
    return pg_catalog.jsonb_typeof(p_content -> 'prompt') = 'string'
      and coalesce(pg_catalog.char_length(pg_catalog.btrim(p_content ->> 'prompt')), 0)
        between 1 and 100000;
  end if;

  if nullif(pg_catalog.btrim(p_category), '') is null
    or nullif(pg_catalog.btrim(p_audience), '') is null
    or p_duration not in ('1시간', '2시간', '4시간')
    or nullif(pg_catalog.btrim(p_topic), '') is null then
    return false;
  end if;
  v_expected_minutes := case p_duration
    when '1시간' then 60
    when '2시간' then 120
    else 240
  end;

  -- 출처 라벨은 클라이언트가 임의로 적은 값이 아니라, 실제 같은 분야 원본에서
  -- 재구성한 sources의 정확한 라벨 집합과 일치해야 한다.
  if pg_catalog.jsonb_typeof(p_content -> 'sources') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_content -> 'sources') not between 1 and 80
    or pg_catalog.jsonb_typeof(p_content -> 'sourceLabels') is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_content -> 'sourceLabels') not between 1 and 80 then
    return false;
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value)
    where pg_catalog.jsonb_typeof(source.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(source.value -> 'document_id') is distinct from 'number'
      or pg_catalog.jsonb_typeof(source.value -> 'doc') is distinct from 'string'
      or not (source.value ? 'page')
      or not public.generated_material_source_provenance_valid(source.value, p_category)
  ) or exists (
    select 1
    from pg_catalog.jsonb_array_elements(p_content -> 'sourceLabels') as label(value)
    where pg_catalog.jsonb_typeof(label.value) is distinct from 'string'
      or pg_catalog.char_length(pg_catalog.btrim(label.value #>> '{}')) not between 2 and 300
  ) then
    return false;
  end if;
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.btrim(value)), '{}'::text[])
  into v_source_labels
  from pg_catalog.jsonb_array_elements_text(p_content -> 'sourceLabels') as label(value);
  select coalesce(
    pg_catalog.array_agg(
      distinct '[' || pg_catalog.btrim(source.value ->> 'doc') ||
        case when pg_catalog.jsonb_typeof(source.value -> 'page') = 'number'
          then ' p.' || pg_catalog.trunc((source.value ->> 'page')::numeric)::text
          else '' end || ']'
    ),
    '{}'::text[]
  )
  into v_derived_labels
  from pg_catalog.jsonb_array_elements(p_content -> 'sources') as source(value);
  if not (v_source_labels @> v_derived_labels and v_source_labels <@ v_derived_labels) then
    return false;
  end if;

  if pg_catalog.jsonb_typeof(p_content -> 'sopEvidence') is distinct from 'object'
    or pg_catalog.jsonb_typeof(p_content #> '{sopEvidence,sourceLabels}') is distinct from 'array' then
    return false;
  end if;
  v_status := p_content #>> '{sopEvidence,status}';
  if v_status not in ('found', 'not_found', 'degraded')
    or pg_catalog.jsonb_array_length(p_content #> '{sopEvidence,sourceLabels}') > 20
    or exists (
      select 1
      from pg_catalog.jsonb_array_elements(p_content #> '{sopEvidence,sourceLabels}') as label(value)
      where pg_catalog.jsonb_typeof(label.value) is distinct from 'string'
    ) then
    return false;
  end if;
  select coalesce(pg_catalog.array_agg(distinct pg_catalog.btrim(value)), '{}'::text[])
  into v_sop_labels
  from pg_catalog.jsonb_array_elements_text(
    p_content #> '{sopEvidence,sourceLabels}'
  ) as label(value)
  where nullif(pg_catalog.btrim(value), '') is not null;
  if not (v_sop_labels <@ v_source_labels)
    or (v_status = 'found' and coalesce(pg_catalog.array_length(v_sop_labels, 1), 0) = 0)
    or (v_status in ('not_found', 'degraded') and coalesce(pg_catalog.array_length(v_sop_labels, 1), 0) <> 0) then
    return false;
  end if;

  if p_kind in ('plan', 'lesson') then
    v_sections := p_content -> 'sections';
    if pg_catalog.jsonb_typeof(v_sections) is distinct from 'array'
      or pg_catalog.jsonb_array_length(v_sections) not between 1 and 8 then
      return false;
    end if;

    if p_kind = 'plan' then
      v_required_headings := array['훈련목표', '훈련내용', '필요장비', '안전관리', '훈련평가'];
      v_citation_headings := array['훈련내용', '필요장비', '안전관리'];
      v_designated_heading := '훈련내용';
      v_safety_heading := '안전관리';
      v_evaluation_heading := '훈련평가';
    else
      v_required_headings := array['학습목표', '도입', '핵심이론', '교관시범', '대원실습', '안전유의사항', '정리·평가'];
      v_citation_headings := array['핵심이론', '교관시범', '안전유의사항'];
      v_designated_heading := '핵심이론';
      v_safety_heading := '안전유의사항';
      v_evaluation_heading := '정리·평가';
    end if;

    foreach v_heading in array v_required_headings loop
      if (
        select pg_catalog.count(*)
        from pg_catalog.jsonb_array_elements(v_sections) as section(value)
        where pg_catalog.btrim(section.value ->> 'heading') = v_heading
      ) <> 1 then
        return false;
      end if;
      select section.value ->> 'content'
      into v_text
      from pg_catalog.jsonb_array_elements(v_sections) as section(value)
      where pg_catalog.btrim(section.value ->> 'heading') = v_heading
      limit 1;
      v_minimum_length := case v_heading
        when '훈련목표' then 50 when '훈련내용' then 220 when '필요장비' then 40
        when '안전관리' then 100 when '훈련평가' then 90 when '학습목표' then 70
        when '도입' then 120 when '핵심이론' then 260 when '교관시범' then 200
        when '대원실습' then 200 when '안전유의사항' then 120 when '정리·평가' then 180
        else 1 end;
      if v_text is null or public.generated_material_visible_length(v_text) < v_minimum_length then
        return false;
      end if;
      v_all_text := v_all_text || E'\n' || v_heading || E'\n' || v_text;
      if v_heading = v_designated_heading then
        v_designated_text := v_text;
      end if;
      if v_heading = v_safety_heading then
        v_safety_text := v_text;
      end if;
      if v_heading = v_evaluation_heading then
        v_evaluation_text := v_text;
      end if;

      -- 계획은 훈련내용, 교안은 학습목표를 제외한 여섯 섹션마다 시간 표식이 필요하다.
      if (p_kind = 'plan' and v_heading = '훈련내용')
        or (p_kind = 'lesson' and v_heading <> '학습목표') then
        select pg_catalog.count(*), coalesce(pg_catalog.sum(minutes), 0)
        into v_section_time_count, v_minutes
        from public.generated_material_bracketed_minutes(v_text);
        if v_section_time_count = 0 then
          return false;
        end if;
        v_time_count := v_time_count + v_section_time_count;
        v_time_total := v_time_total + v_minutes;
      end if;
    end loop;

    if v_time_count = 0 or v_time_total <> v_expected_minutes then
      return false;
    end if;
    if not (
      v_safety_text ~ '(안전|위험|보호|예방|통제|점검|감시|대피)'
      and v_safety_text ~ '(중단|보고|철수|대피|비상|이상|사고)'
    ) or not (
      v_evaluation_text ~ '(평가|확인|관찰|체크|수행|시연|질문|강평)'
      and v_evaluation_text ~ '(기준|통과|정확|누락|횟수|시간|모범답안|체크리스트)'
    ) then
      return false;
    end if;

    -- 모든 필수 섹션의 대괄호를 확인하며, 시간·SOP 적용 제어 표식만 예외로 둔다.
    for v_item in select value from pg_catalog.jsonb_array_elements(v_sections) as section(value)
    loop
      v_heading := pg_catalog.btrim(v_item ->> 'heading');
      if not (v_heading = any(v_required_headings)) then
        continue;
      end if;
      v_text := coalesce(v_item ->> 'content', '');
      if v_heading = any(v_citation_headings) and not exists (
        select 1 from pg_catalog.unnest(v_source_labels) as label(value)
        where position(label.value in v_text) > 0
      ) then
        return false;
      end if;
      for v_reference_match in
        select pg_catalog.regexp_matches(v_text, '(\[[^]\n]{2,}\])', 'g')
      loop
        v_reference := v_reference_match[1];
        if public.generated_material_is_control_marker(v_reference) then
          continue;
        end if;
        if not (v_reference = any(v_source_labels)) then
          return false;
        end if;
      end loop;
    end loop;
  else
    v_slides := p_content -> 'slides';
    if pg_catalog.jsonb_typeof(v_slides) is distinct from 'array' then
      return false;
    end if;
    v_slide_count := pg_catalog.jsonb_array_length(v_slides);
    if (p_duration = '1시간' and v_slide_count not between 10 and 12)
      or (p_duration = '2시간' and v_slide_count not between 14 and 18)
      or (p_duration = '4시간' and v_slide_count not between 18 and 20) then
      return false;
    end if;
    for v_item in select value from pg_catalog.jsonb_array_elements(v_slides) as slide(value)
    loop
      if pg_catalog.jsonb_typeof(v_item) is distinct from 'object'
        or pg_catalog.jsonb_typeof(v_item -> 'title') is distinct from 'string'
        or pg_catalog.jsonb_typeof(v_item -> 'bullets') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_item -> 'bullets') not between 2 and 4
        or pg_catalog.jsonb_typeof(v_item -> 'sourceRefs') is distinct from 'array'
        or pg_catalog.jsonb_array_length(v_item -> 'sourceRefs') not between 1 and 4 then
        return false;
      end if;
      select coalesce(pg_catalog.string_agg(value, ' '), '')
      into v_text
      from pg_catalog.jsonb_array_elements_text(v_item -> 'bullets') as bullet(value);
      if public.generated_material_visible_length(v_text) < 45 then
        return false;
      end if;
      v_slide_text := coalesce(v_item ->> 'title', '') || ' ' || v_text || ' ' || coalesce(v_item ->> 'notes', '');
      v_all_text := v_all_text || E'\n' || v_slide_text;
      if v_slide_text ~ '(안전|위험|보호|예방|통제|점검|감시|대피)'
        and v_slide_text ~ '(중단|보고|철수|대피|비상|이상|사고)' then
        v_has_safety := true;
      end if;
      if v_slide_text ~ '(평가|확인|관찰|체크|수행|시연|질문|강평)'
        and v_slide_text ~ '(기준|통과|정확|누락|횟수|시간|모범답안|체크리스트)' then
        v_has_evaluation := true;
      end if;
      for v_reference in
        select pg_catalog.btrim(value)
        from pg_catalog.jsonb_array_elements_text(v_item -> 'sourceRefs') as ref(value)
      loop
        if not (v_reference = any(v_source_labels)) then
          return false;
        end if;
      end loop;

      if v_item ? 'visual' then
        v_visual := v_item -> 'visual';
        v_visual_mode := v_visual ->> 'mode';
        if pg_catalog.jsonb_typeof(v_visual) is distinct from 'object'
          or v_visual_mode not in ('source-page', 'source-crop', 'native-diagram', 'none') then
          return false;
        end if;
        if v_visual ? 'sourceRef'
          and not (pg_catalog.btrim(v_visual ->> 'sourceRef') = any(v_source_labels)) then
          return false;
        end if;
        if v_visual_mode in ('source-page', 'source-crop') then
          if nullif(pg_catalog.btrim(v_visual ->> 'sourceRef'), '') is null
            or nullif(pg_catalog.btrim(v_visual ->> 'altText'), '') is null
            or v_item ->> 'composition' <> 'visual-explanation' then
            return false;
          end if;
        elsif v_item ->> 'composition' = 'visual-explanation' then
          return false;
        end if;
      end if;
    end loop;
    if not v_has_safety or not v_has_evaluation then
      return false;
    end if;
  end if;

  -- 정상 조회 상태는 기존 DB SOP·출처 계약을 그대로 재사용한다. 검색 장애 상태는
  -- 개인 저장만 허용하되 고정 안내문과 무단 SOP 단정 금지를 DB에서도 확인한다.
  if v_status in ('found', 'not_found') then
    if not public.generated_material_share_contract_valid(
      p_kind, p_category, p_audience, p_duration, p_topic, p_title, p_content
    ) then
      return false;
    end if;
  else
    v_disclosure := 'SOP 자료 검색 상태를 확인할 수 없습니다. SOP 번호·절차를 추정하지 말고 시행 전 다시 확인해야 합니다.';
    if (p_kind in ('plan', 'lesson') and position(v_disclosure in v_designated_text) = 0)
      or (p_kind = 'slides' and position(v_disclosure in v_all_text) = 0) then
      return false;
    end if;
    v_text := pg_catalog.replace(v_all_text, v_disclosure, ' ');
    v_text := pg_catalog.replace(v_text, '[관련 SOP 적용]', ' ');
    v_text := pg_catalog.regexp_replace(v_text, '\[[^]]+\]', ' ', 'g');
    if v_text ~* (v_cue || '[[:space:]]*(제[[:space:]]*)?[-–—:#]?[[:space:]]*[0-9]{1,4}([[:space:]]*호)?')
      or v_text ~* (v_cue || '[[:space:]]*[:：][[:space:]]*[^[:space:].,;!?][^\n.!?]{1,80}')
      or v_text ~* ('[「『“"]{1}[^」』”"\n]{2,80}[」』”"]{1}[[:space:]]*' || v_cue)
      or v_text ~* (v_cue || '(에|에서는|상|를|을)?[[:space:]]*(따라|따르면|근거로|기준으로|규정상|반드시|우선|금지|허용|실시|시행|수행|해야|한다)') then
      return false;
    end if;
  end if;

  return true;
end;
$$;

create or replace function public.enforce_generated_material_core_quality()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.generated_material_core_quality_valid(
    new.kind,
    new.category,
    new.audience,
    new.duration,
    new.topic,
    new.title,
    new.content
  ) then
    raise exception 'generated_material_core_quality_invalid'
      using errcode = '23514',
            hint = 'Repair the required structure, timing, safety, evaluation, and source evidence.';
  end if;
  return new;
end;
$$;

create or replace function public.set_generated_material_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if row(
    new.kind, new.category, new.audience, new.duration,
    new.topic, new.title, new.content
  ) is distinct from row(
    old.kind, old.category, old.audience, old.duration,
    old.topic, old.title, old.content
  ) then
    new.revision := old.revision + 1;
  else
    -- 공유 토글·작성자 표시 변경이나 revision 직접 조작은 편집 개정으로 세지 않는다.
    new.revision := old.revision;
  end if;
  return new;
end;
$$;

revoke all on function public.generated_material_visible_length(text)
  from public, anon, authenticated;
revoke all on function public.generated_material_bracketed_minutes(text)
  from public, anon, authenticated;
revoke all on function public.generated_material_is_control_marker(text)
  from public, anon, authenticated;
revoke all on function public.generated_material_core_quality_valid(
  text, text, text, text, text, text, jsonb
) from public, anon, authenticated;
revoke all on function public.enforce_generated_material_core_quality()
  from public, anon, authenticated;
revoke all on function public.set_generated_material_revision()
  from public, anon, authenticated;

drop trigger if exists enforce_generated_material_core_quality
  on public.generated_materials;
create trigger enforce_generated_material_core_quality
before insert or update of kind, category, audience, duration, topic, title, content
on public.generated_materials
for each row execute function public.enforce_generated_material_core_quality();

drop trigger if exists set_generated_material_revision
  on public.generated_materials;
create trigger set_generated_material_revision
before update on public.generated_materials
for each row execute function public.set_generated_material_revision();


-- ============================================================================
-- 20260902021457_add_login_access_counter.sql
-- ============================================================================

-- 로그인 후 실제 서비스 화면에 진입한 접속을 KST 날짜별로 한 번만 기록한다.
--
-- 공유 계정을 여러 대원이 함께 쓰는 시범운영 특성상 user_id 기준 집계는 실제 이용량을
-- 보여주지 못한다. Supabase가 서명한 JWT의 session_id를 SHA-256 해시한 뒤
-- (KST 날짜, 세션 해시)를 원장으로 남긴다. 앱의 HttpOnly 일일 쿠키가 같은 브라우저의
-- 중복 RPC를 줄이고, DB PK가 동시 요청을 최종 차단한다. IP·이메일·User-Agent는 저장하지 않는다.
--
-- 원장은 비노출 스키마에 두고 RLS와 권한 회수를 함께 적용한다. Data API에 공개되는
-- public 함수는 인자가 없는 SECURITY INVOKER 래퍼뿐이며, private SECURITY DEFINER
-- 함수는 호출자의 인증 상태를 다시 확인하고 search_path를 비운다.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists visitor_private;

revoke all on schema visitor_private from public, anon, authenticated;
grant usage on schema visitor_private to anon, authenticated;

create table if not exists visitor_private.login_session_days (
  visit_date    date        not null,
  session_hash bytea       not null,
  first_seen_at timestamptz not null default now(),
  constraint login_session_days_pkey primary key (visit_date, session_hash),
  constraint login_session_days_hash_length check (
    pg_catalog.octet_length(session_hash) = 32
  )
);

comment on table visitor_private.login_session_days is
  'KST 날짜별 고유 인증 세션 접속 원장. 원본 session_id와 개인정보는 저장하지 않는다.';
comment on column visitor_private.login_session_days.session_hash is
  'KST 날짜와 Supabase JWT session_id를 합친 SHA-256 해시(32바이트)';

alter table visitor_private.login_session_days enable row level security;
revoke all on table visitor_private.login_session_days
  from public, anon, authenticated, service_role;

create or replace function visitor_private.record_daily_login_access()
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $function$
declare
  v_claims jsonb := coalesce((select auth.jwt()), '{}'::jsonb);
  v_session_id uuid;
  v_seen_at timestamptz;
  v_visit_date date;
  v_inserted boolean := false;
begin
  if v_claims ->> 'role' is distinct from 'authenticated'
     or (select auth.uid()) is null
     or nullif(pg_catalog.btrim(v_claims ->> 'session_id'), '') is null then
    raise exception using
      errcode = '42501',
      message = 'authenticated session required';
  end if;

  begin
    v_session_id := (v_claims ->> 'session_id')::uuid;
  exception
    when invalid_text_representation then
      raise exception using
        errcode = '42501',
        message = 'authenticated session required';
  end;

  v_seen_at := pg_catalog.statement_timestamp();
  v_visit_date := (v_seen_at at time zone 'Asia/Seoul')::date;

  insert into visitor_private.login_session_days (
    visit_date,
    session_hash,
    first_seen_at
  )
  values (
    v_visit_date,
    extensions.digest(
      pg_catalog.convert_to(v_visit_date::text || ':' || v_session_id::text, 'UTF8'),
      'sha256'
    ),
    v_seen_at
  )
  on conflict (visit_date, session_hash) do nothing
  returning true into v_inserted;

  return coalesce(v_inserted, false);
end;
$function$;

create or replace function visitor_private.get_login_access_stats()
returns table (
  today_access bigint,
  total_access bigint
)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    count(*) filter (
      where visit_date = (
        pg_catalog.statement_timestamp() at time zone 'Asia/Seoul'
      )::date
    )::bigint as today_access,
    count(*)::bigint as total_access
  from visitor_private.login_session_days;
$function$;

-- PostgREST에 노출되는 래퍼에는 클라이언트 입력값이 없다. 기록용 함수는 인증 사용자만,
-- 집계 조회는 로그인 화면의 anon과 로그인 사용자에게 숫자 두 개만 허용한다.
create or replace function public.record_daily_login_access()
returns boolean
language sql
volatile
security invoker
set search_path = ''
as $function$
  select visitor_private.record_daily_login_access();
$function$;

create or replace function public.get_login_access_stats()
returns table (
  today_access bigint,
  total_access bigint
)
language sql
stable
security invoker
set search_path = ''
as $function$
  select * from visitor_private.get_login_access_stats();
$function$;

revoke all on function visitor_private.record_daily_login_access()
  from public, anon, authenticated;
revoke all on function visitor_private.get_login_access_stats()
  from public, anon, authenticated;
grant execute on function visitor_private.record_daily_login_access()
  to authenticated;
grant execute on function visitor_private.get_login_access_stats()
  to anon, authenticated;

revoke all on function public.record_daily_login_access()
  from public, anon, authenticated;
revoke all on function public.get_login_access_stats()
  from public, anon, authenticated;
grant execute on function public.record_daily_login_access()
  to authenticated;
grant execute on function public.get_login_access_stats()
  to anon, authenticated;


-- ============================================================================
-- 20260902094825_durable_generation_jobs.sql
-- ============================================================================

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

