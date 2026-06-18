# PRD — 전북소방 구조 AI 챗봇

> ⚠️ **스코프 변경 (2026-06-18)**: 학습/과정/진도/이수(레슨) 기능은 **제거**되었습니다
> (퀴즈 없는 읽음표시라 가치 낮음·이수 실적 보고 불필요). 본문의 학습·이수 관련 기술(§ 과정/진도/퀴즈/이수
> 현황 등)은 더 이상 유효하지 않습니다. 현행 스코프는 `CLAUDE.md`·`해야할 기능.md` 기준.

> **이 문서 사용법 (Claude Code)**
> 이 PRD는 AI 코딩 에이전트가 단계별로 구현하도록 작성되었습니다.
> 한 번에 전체를 만들지 말고 **§11 구현 로드맵의 마일스톤 순서대로** 진행하세요.
> 각 마일스톤 완료 시 §12 수용 기준으로 자가 점검 후 다음으로 넘어갑니다.
> 프로젝트 규칙·컨벤션은 `CLAUDE.md`를 함께 참조하세요.

---

## 1. 개요

구조대원이 현장·교육 중 자연어로 질문하면, 전북소방 구조 교육자료에 근거해 답하고
**출처(문서·페이지)를 함께 표시**하는 RAG 기반 AI 챗봇 웹앱.

- **사용자**: 전북소방 구조대원(일반), 관리자(통계·자료관리)
- **개발 형태**: 1인 개발, AI 코딩 도구 활용, 약 30일 내 1차 버전
- **배포**: 개발/시연은 Vercel + Supabase(클라우드), 운영은 국내 공공클라우드로 이전 예정

### 1.1 핵심 원칙

1. **출처 없는 답변 금지** — 인덱싱된 자료에 근거가 없으면 "확인되지 않습니다"로 응답
2. **환각 차단 우선** — 답변 정확성 > 답변 풍부함
3. **모바일 우선** — 구조대원이 현장에서 한 손으로 사용
4. **단순한 운영** — 1인이 유지보수 가능한 최소 구성

---

## 2. 목표 및 성공 기준

| 구분 | 목표 |
|------|------|
| 1차 완성 | 자료 기반 답변 + 출처 표시 + 로그인 + 대화이력 동작 |
| 품질 | 평가셋 50문항 기준 정확도 60% 이상 |
| 응답 속도 | 질문 → 첫 토큰 3초 이내, 전체 답변 10초 이내 |
| 동시 사용 | 시범운영 기준 수십 명 동시 접속 무리 없음 |

---

## 3. 사용자 스토리

```
US-1  구조대원으로서, 장비 사용법을 자연어로 물어보면 즉시 답을 받고 싶다.
US-2  구조대원으로서, 답변의 근거 매뉴얼·페이지를 확인하고 원본을 보고 싶다.
US-3  구조대원으로서, 과거에 물어본 내용을 다시 찾아보고 싶다.
US-4  구조대원으로서, PC와 스마트폰 모두에서 동일하게 쓰고 싶다.
US-5  관리자로서, 누가 무엇을 얼마나 물었는지 통계를 보고 싶다.
US-6  관리자로서, 교육자료를 추가/관리하고 인덱싱하고 싶다. (1차는 스크립트로 대체 가능)
```

---

## 4. 기술 스택

| 영역 | 기술 | 비고 |
|------|------|------|
| 프레임워크 | Next.js 14+ (App Router, TypeScript) | |
| UI | Tailwind CSS + shadcn/ui | |
| 채팅 SDK | Vercel AI SDK (`ai`, `@ai-sdk/anthropic`) | 스트리밍 |
| LLM | Anthropic Claude (`claude-sonnet-4-5`) | 한국어 답변 |
| DB / 인증 / 스토리지 | Supabase (PostgreSQL + pgvector + Auth + Storage) | 서울 리전 |
| 임베딩 | BGE-M3 (1024차원) | 한국어. 대안: OpenAI text-embedding-3-small |
| 인덱싱 | Python 3.11 (pymupdf, sentence-transformers, supabase-py) | 별도 스크립트 |
| 배포 | Vercel (개발/시연) → 추후 국내 공공클라우드 | |
| 차트 | recharts | 관리자 통계 |

> **제약**: localStorage/sessionStorage 등 브라우저 스토리지 의존 금지(서버·DB 사용).
> API 키는 서버 사이드에서만 사용. `SUPABASE_SERVICE_ROLE_KEY`·`ANTHROPIC_API_KEY`는 클라이언트 노출 금지.

---

## 5. 시스템 아키텍처

```
[사용자 브라우저 (PC·모바일)]
        │  HTTPS
        ▼
[Next.js (Vercel)]
   ├─ 화면(App Router) : /login /chat /chat/[id] /docs /docs/[id] /admin
   ├─ API Route /api/chat      : 질문 → RAG 검색 → Claude 스트리밍 답변
   ├─ API Route /api/feedback  : 답변 피드백 저장
   └─ Supabase 클라이언트(서버/브라우저)
        │
        ▼
[Supabase]
   ├─ Auth        : 사용자 인증(매직링크/OTP)
   ├─ PostgreSQL  : profiles, documents, chunks, conversations, messages
   ├─ pgvector    : chunks.embedding 벡터 검색
   ├─ RPC         : hybrid_search() (벡터 + 키워드 RRF)
   └─ Storage     : 원본 자료(PDF) 보관

[Python 인덱싱 파이프라인] (오프라인/배치)
   docs → 텍스트추출 → 청크 → 임베딩 → chunks 테이블 적재
```

---

## 6. 데이터 모델 (Supabase)

> 아래 SQL을 Supabase SQL Editor에서 순서대로 실행. (마일스톤 M1)

### 6.1 확장 + 테이블

```sql
create extension if not exists vector;
create extension if not exists pg_trgm;

-- 사용자 프로필 (auth.users 확장)
create table profiles (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text,
  full_name text,
  role      text default 'user',     -- user | admin
  division  text,                    -- 소속 구조대
  created_at timestamptz default now()
);

-- 자료 메타데이터
create table documents (
  id              bigserial primary key,
  title           text not null,
  source_type     text not null,      -- pdf | hwpx | pptx | video
  category        text,               -- 산악 | 수난 | 화재 | 구급
  equipment       text[],
  difficulty      text,               -- 초급 | 중급 | 고급
  original_filename text,
  file_url        text,               -- Supabase Storage URL
  publish_date    date,
  status          text default 'processed',  -- processing | processed | failed
  created_at      timestamptz default now()
);
create index documents_category_idx on documents(category);
create index documents_status_idx on documents(status);

-- 인덱싱된 청크 (RAG 두뇌)
create table chunks (
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
create index chunks_embedding_idx on chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);
create index chunks_tsv_idx on chunks using gin(tsv);
create index chunks_doc_idx on chunks(document_id);

-- 대화 세션
create table conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) on delete cascade,
  title      text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index conversations_user_idx on conversations(user_id, updated_at desc);

-- 메시지 (질문·답변)
create table messages (
  id              bigserial primary key,
  conversation_id uuid references conversations(id) on delete cascade,
  role            text not null,      -- user | assistant
  content         text not null,
  sources         jsonb,              -- [{document_id, doc, page, content}]
  feedback        smallint,           -- 1=👍, -1=👎, null=미평가
  latency_ms      int,
  created_at      timestamptz default now()
);
create index messages_conv_idx on messages(conversation_id, created_at);
create index messages_created_idx on messages(created_at desc);
```

### 6.2 하이브리드 검색 함수 (RPC)

```sql
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
```

### 6.3 트리거 + RLS

```sql
-- 회원가입 시 profiles 자동 생성
create or replace function handle_new_user()
returns trigger language plpgsql security definer as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, new.raw_user_meta_data->>'full_name');
  return new;
end; $$;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function handle_new_user();

-- updated_at 자동 갱신
create or replace function bump_conversation_updated_at()
returns trigger language plpgsql as $$
begin
  update conversations set updated_at = now() where id = new.conversation_id;
  return new;
end; $$;
create trigger messages_bump_conversation
  after insert on messages for each row execute function bump_conversation_updated_at();

-- RLS
alter table profiles enable row level security;
alter table conversations enable row level security;
alter table messages enable row level security;
alter table documents enable row level security;
alter table chunks enable row level security;

create policy "own profile select" on profiles for select using (auth.uid() = id);
create policy "own profile update" on profiles for update using (auth.uid() = id);
create policy "own conversations" on conversations for all using (auth.uid() = user_id);
create policy "own messages" on messages for all using (
  exists (select 1 from conversations c where c.id = messages.conversation_id and c.user_id = auth.uid())
);
create policy "authenticated read documents" on documents for select to authenticated using (true);
create policy "authenticated read chunks" on chunks for select to authenticated using (true);
create policy "admin all messages" on messages for select using (
  exists (select 1 from profiles where id = auth.uid() and role = 'admin')
);
```

---

## 7. 기능 요구사항 — 화면

각 화면은 모바일 우선. 본문 16px+, 터치영역 48px+, 색 대비 충분히.

### 7.1 `/login` — 로그인
- Supabase Auth 매직링크 또는 OTP(이메일) 방식
- 회원가입 폼 없음 — 관리자가 계정 발급 (또는 매직링크 화이트리스트)
- 로그인 성공 시 `/chat`으로 리다이렉트
- 미인증 사용자가 보호 경로 접근 시 `/login`으로 리다이렉트 (middleware)
- 컴포넌트: Card, Input, Button, Form (shadcn)

### 7.2 `/chat` — 챗봇 메인 (핵심 화면)
- Vercel AI SDK `useChat()` 기반 채팅 UI
- 메시지 입력창(하단 고정), 메시지 목록(스크롤), 스트리밍 응답 표시
- assistant 메시지 하단에:
  - **출처 칩(Badge)**: `문서명 p.34` 형태. 클릭 시 `/docs/[id]` 해당 페이지 또는 원본 PDF 뷰어로 이동
  - **피드백 버튼**: 👍/👎 → `/api/feedback` 호출
- 새 대화 시작 시 `conversations` 레코드 생성, 메시지마다 `messages` 저장
- 예시 질문 칩 3개 제공 (첫 진입 시)
- 컴포넌트: ScrollArea, Input, Button, Badge, Sheet(출처 미리보기)

### 7.3 `/chat/[conversationId]` — 과거 대화 보기
- 특정 대화의 메시지 전체 로드(시간순)
- 좌측 또는 상단에 대화 목록(최근순), 검색 입력
- RLS로 본인 대화만 조회
- 컴포넌트: Card, Accordion 또는 목록, Input(검색)

### 7.4 `/docs` — 자료 목록
- 카테고리(산악/수난/화재/구급)·난이도 필터 + 제목 검색
- 표 형태: 제목 / 카테고리 / 장비 / 발행일
- 행 클릭 시 `/docs/[id]` PDF 뷰어(Dialog 또는 페이지)
- 컴포넌트: Table, Select, Input, Dialog, Tabs

### 7.5 `/docs/[id]` — 자료 뷰어
- `file_url`의 PDF를 react-pdf로 렌더, 특정 페이지로 점프 가능(`?page=34`)
- 출처 칩에서 넘어올 때 해당 페이지 자동 표시

### 7.6 `/admin` — 관리자 대시보드
- 접근 제어: `profiles.role = 'admin'`만. 아니면 403/리다이렉트
- 카드형 통계: 총 사용자, 총 질문수, 평균 응답시간, 답변 만족도(👍 비율)
- 차트: 일별 질문수(최근 30일, recharts), 카테고리별 자료 인용 횟수
- 자주 묻는 질문 TOP 20 테이블
- 컴포넌트: Card, Table, recharts

---

## 8. 기능 요구사항 — API

### 8.1 `POST /api/chat`
**요청**
```json
{ "messages": [{ "role": "user", "content": "공압지지대 사용법" }],
  "conversationId": "uuid (없으면 신규 생성)",
  "category": "산악 | null (선택 필터)" }
```
**처리**
1. 마지막 user 메시지로 임베딩 생성(서버에서 임베딩 API 또는 엔드포인트 호출)
2. Supabase `hybrid_search(query_text, query_embedding, 5, category)` 호출
3. 검색된 청크를 컨텍스트로 조립 (각 청크에 `[문서명 p.N]` 라벨)
4. Claude `messages.stream()` 호출 — 시스템 프롬프트는 §9.2
5. 스트리밍으로 토큰 반환 (Vercel AI SDK `streamText` / `toDataStreamResponse`)
6. 완료 후 `messages`에 user·assistant 두 건 저장(assistant엔 `sources`, `latency_ms` 포함)
7. `conversationId` 없으면 신규 `conversations` 생성, 제목은 첫 질문 앞부분으로

**응답**: 텍스트 스트림. 메타(sources)는 스트림 종료 후 별도 데이터 파트 또는 message annotation으로 전달.

### 8.2 `POST /api/feedback`
```json
{ "messageId": 123, "feedback": 1 }   // 1=👍, -1=👎
```
→ `messages.feedback` 업데이트. 본인 메시지만(RLS).

### 8.3 인증/세션
- Supabase SSR(`@supabase/ssr`)로 서버 컴포넌트·route handler에서 세션 검증
- `middleware.ts`로 `/chat`, `/docs`, `/admin` 보호

---

## 9. RAG 명세

### 9.1 검색
- 하이브리드: 벡터(코사인) + 키워드(tsvector) → RRF(k=60) 결합 (RPC `hybrid_search`)
- 기본 top_k = 5
- category 필터 옵셔널

### 9.2 시스템 프롬프트 (Claude)
```
당신은 전북소방본부 구조대원을 돕는 AI 어시스턴트입니다.

[답변 규칙]
1. 아래 '참고 자료'에 있는 내용만 근거로 답변하세요.
2. 참고 자료에 근거가 없으면 추측하지 말고 정확히 이렇게 답하세요:
   "관련 매뉴얼에서 확인되지 않습니다. 구조 매뉴얼 담당자에게 문의하세요."
3. 부상자 생사 판단 등 의학적·법적 판단은 하지 말고,
   "현장 지휘관 또는 119 의료지도에 문의하세요" 라고 안내하세요.
4. 답변은 한국어로, 구조대원이 현장에서 빠르게 읽도록 간결하게 작성하세요.
5. 답변 끝에는 근거가 된 자료를 표시하세요.

[참고 자료]
{검색된 청크들 — 각 청크 앞에 [문서명 p.N] 라벨}
```

### 9.3 출처 처리
- 검색 결과 상위 청크의 `(document_id, doc, page)`를 중복 제거해 최대 3개를 `sources`로 저장·표시
- UI 출처 칩 클릭 → `/docs/[document_id]?page=N`

---

## 10. 인덱싱 파이프라인 (Python, 별도 디렉터리 `indexing/`)

> 웹앱과 분리. 자료가 추가되면 배치로 실행해 `chunks`를 채움.

### 10.1 처리 흐름
```
docs/ 폴더 → 파일별 텍스트 추출 → 의미 단위 청크(300~500자, 80자 overlap)
→ 메타데이터(카테고리·장비 등) 부여 → 임베딩(BGE-M3, 1024d, 정규화)
→ documents·chunks 테이블 upsert (Supabase)
```

### 10.2 포맷별 추출
| 포맷 | 방법 |
|------|------|
| PDF | pymupdf 페이지별 텍스트. 표 많으면 페이지 이미지 → Claude Vision 캡션(후순위) |
| HWPX | LibreOffice headless로 PDF 변환 후 동일 처리 (또는 pyhwpx) |
| PPTX | python-pptx 슬라이드별 본문+노트, 슬라이드=청크 |
| 동영상 | (후순위) Whisper API 자막 추출, 시간코드 포함 |

### 10.3 파일
- `indexing/parse.py` — 포맷별 텍스트 추출
- `indexing/chunk.py` — 청크 분할
- `indexing/embed_and_upload.py` — 임베딩 + Supabase 적재
- `indexing/requirements.txt`

---

## 11. 구현 로드맵 (Claude Code 작업 순서)

> 마일스톤 단위로 진행. 각 마일스톤 끝에서 §12 수용 기준 확인 후 다음으로.

### M0 — 프로젝트 부트스트랩
- [ ] `create-next-app` (TypeScript, Tailwind, App Router)
- [ ] shadcn/ui 초기화 + 컴포넌트 추가(button card input textarea scroll-area badge dialog sheet table tabs select form accordion)
- [ ] `@supabase/supabase-js @supabase/ssr ai @ai-sdk/anthropic lucide-react recharts react-pdf date-fns` 설치
- [ ] `.env.local` 템플릿(§ CLAUDE.md 참조), `.gitignore`에 `.env*` 추가
- [ ] `lib/supabase/{client,server}.ts` 작성

### M1 — DB 스키마 적용
- [ ] §6 SQL을 Supabase에 적용(또는 `supabase/migrations/`에 파일로)
- [ ] 타입 생성(`supabase gen types typescript`) → `lib/database.types.ts`

### M2 — 인증
- [ ] `/login` 매직링크/OTP
- [ ] `middleware.ts`로 `/chat /docs /admin` 보호
- [ ] 로그인/로그아웃 동작

### M3 — 챗봇 (RAG 없이 먼저)
- [ ] `/chat` UI(useChat) + `/api/chat`에서 Claude 단순 응답(스트리밍)
- [ ] 대화·메시지 DB 저장

### M4 — RAG 연결
- [ ] 임베딩 생성 경로(서버) + `hybrid_search` RPC 호출
- [ ] 컨텍스트 주입 + §9.2 시스템 프롬프트
- [ ] 출처 칩 표시 + `sources` 저장

### M5 — 인덱싱 파이프라인(Python)
- [ ] `indexing/` 스크립트로 샘플 자료 50개 인덱싱
- [ ] 챗봇이 실제 자료 기반으로 답하는지 확인

### M6 — 자료 화면 + 출처 점프
- [ ] `/docs` 목록·필터, `/docs/[id]` PDF 뷰어(page 점프)
- [ ] 출처 칩 → 자료 뷰어 연결

### M7 — 대화 이력 + 피드백
- [ ] `/chat/[id]` 과거 대화, 대화 목록·검색
- [ ] `/api/feedback` + 👍/👎 버튼

### M8 — 관리자 대시보드
- [ ] `/admin` 접근 제어
- [ ] 통계 카드 + recharts + FAQ TOP 20

### M9 — 마감 점검
- [ ] 모바일 점검, 로딩/에러 처리, 환각 가드레일 확인
- [ ] 평가셋 50문항 측정(60% 이상)

---

## 12. 수용 기준 (Acceptance Criteria)

```
AC-1  미인증 사용자가 /chat 접근 시 /login 으로 이동한다.
AC-2  로그인 후 질문하면 3초 내 첫 토큰이 스트리밍된다.
AC-3  답변 하단에 출처 칩(문서명·페이지)이 표시되고, 클릭 시 해당 자료/페이지로 이동한다.
AC-4  인덱싱된 자료에 근거가 없는 질문에는 "확인되지 않습니다"로 답한다(환각 없음).
AC-5  의학적 생사 판단 요구 질문은 거부하고 119 의료지도 안내로 응답한다.
AC-6  대화·메시지가 DB에 저장되고, /chat/[id]에서 과거 대화를 다시 볼 수 있다.
AC-7  사용자는 본인 대화만 조회 가능하다(RLS 검증).
AC-8  👍/👎 피드백이 messages.feedback에 저장된다.
AC-9  /admin 은 role='admin' 만 접근 가능하고 통계가 표시된다.
AC-10 PC·모바일 모두에서 레이아웃이 깨지지 않는다.
AC-11 평가셋 50문항 정확도 60% 이상.
```

---

## 13. 범위 외 (Out of Scope, 차년도)

- 음성 입력/출력(STT/TTS), VR/AR 훈련
- 실시간 화상, 다국어
- 시험·과제·이수증 발급(정식 LMS 기능)
- 자료 업로드 UI(1차는 Python 스크립트로 대체; 추후 관리자 업로드 화면)
- 동영상 멀티모달 인덱싱(자막 추출은 후순위)

---

## 14. 보안 · 제약

- `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`는 서버에서만 사용, 클라이언트 노출 금지
- 모든 사용자 데이터 테이블 RLS 필수
- 브라우저 스토리지(localStorage 등) 의존 금지 — 상태는 서버/DB
- 개발·시연은 외부 클라우드, 운영 이전 시 환경변수(URL·키)만 교체하면 되도록 환경 분리
- 자료 저작권: 외부 자료는 출처 표기, 유튜브는 자막만(영상 다운로드 금지)

---

## 15. 디렉터리 구조(목표)

```
jeonbuk-rescue-ai/
├── app/
│   ├── (auth)/login/page.tsx
│   ├── chat/page.tsx
│   ├── chat/[conversationId]/page.tsx
│   ├── docs/page.tsx
│   ├── docs/[id]/page.tsx
│   ├── admin/page.tsx
│   ├── api/chat/route.ts
│   ├── api/feedback/route.ts
│   ├── layout.tsx
│   └── page.tsx
├── components/
│   ├── ui/                      # shadcn
│   ├── chat/{ChatInterface,MessageBubble,SourceBadge}.tsx
│   └── admin/StatsChart.tsx
├── lib/
│   ├── supabase/{client,server}.ts
│   ├── rag.ts                   # 검색 + 컨텍스트 조립
│   ├── embeddings.ts            # 임베딩 생성
│   └── database.types.ts
├── indexing/                    # Python (웹앱과 분리)
│   ├── parse.py / chunk.py / embed_and_upload.py
│   └── requirements.txt
├── supabase/migrations/         # §6 SQL
├── middleware.ts
├── .env.local                   # git ignore
├── CLAUDE.md
└── PRD.md
```
