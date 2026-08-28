-- ⚠️ 자동 생성 파일 — 직접 수정하지 마세요.
--    출처: supabase/migrations/*.sql  ·  재생성: npm run sql:setup
--
-- 새 Supabase 프로젝트를 세울 때 이 파일 전체를 SQL Editor 에 붙여 한 번에 실행하세요.
-- 마이그레이션을 순서대로 이어붙인 것이라, 기존 프로젝트에 개별 마이그레이션을 적용한 결과와
-- 동일한 스키마가 됩니다. (중간에 만들었다가 지우는 테이블이 보이는 것은 정상 — 이력 그대로입니다.)
--
-- 포함된 마이그레이션 17개:
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

