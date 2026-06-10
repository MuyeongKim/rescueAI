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
