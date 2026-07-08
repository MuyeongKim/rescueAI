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

-- role 자가 승격 차단(0010): service_role(관리자 API) 외의 role 변경은 조용히 원복.
create or replace function protect_profile_role()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and current_user <> 'service_role' then
    new.role := old.role;
  end if;
  return new;
end; $$;
drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role
  before update on public.profiles
  for each row execute function protect_profile_role();

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
-- 0006_remove_quiz.sql — 퀴즈 기능 제거
-- 회의 결정(2026-06-11): 퀴즈 이수 대신 "분야의 모든 자료 학습 완료 = 이수"로 단순화.
-- 진도는 lesson_progress 가 계속 담당한다.

drop table if exists quiz_attempts;
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
