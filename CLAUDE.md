# CLAUDE.md — 프로젝트 규칙·컨벤션

전북소방 구조 교육훈련 플랫폼(AI 튜터 포함). 제품 명세 [`PRD.md`](PRD.md), 설치/실행 [`SETUP.md`](SETUP.md) 참조.

## 한 줄 요약
구조대원이 **AI 튜터에게 질의(RAG·출처)**, **클릭 몇 번으로 훈련계획·교안·PPT 생성**,
**자료실에서 원본 열람**을 하는 교육훈련 플랫폼 PoC.
챗봇의 기술 사실·수치·절차와 자료제작은 인덱싱된 교육자료에 근거(출처·페이지)한다.
튜터의 기능 문의·일반 인사·답변 불만은 고정 안내로 답하고, 학습 준비 질문은 자료에서 확인한
항목과 AI의 읽기·이해·복습 순서 제안을 구분한다. 학습 조언으로 새 기술 사실·조작·구조 절차를 만들지 않는다.
학습 답변은 공개 전에 원문과 대조하고, 선택 교정이 필요하면 교정본을 재검토한다. 검토 실패·시간초과 시 초안을 공개하지 않는다.
근거 미확인·검색 장애는 구분해 안내하고 추가 질문이나 원문 확인으로 이어준다.
※ 학습/진도/이수(레슨) 기능은 2026-06-18 제거됨(퀴즈 없는 읽음표시라 가치 낮음·이수 보고 불필요).

## 기술 스택
- **Next.js 15** (App Router, TypeScript) + **Tailwind CSS v4**(`@tailwindcss/postcss`, 설정은
  `app/globals.css`의 `@theme` — `tailwind.config.ts` 없음) + **shadcn/ui**(Radix 기반, classic)
- **Vercel AI SDK v5** (`ai`, `@ai-sdk/react`, 제공자 패키지 v2) — `useChat` / UI message 스트리밍
  (`lib/chat-message.ts`, `lib/chat-transport.ts`가 SDK 메시지와 기존 대화 저장 형식을 변환).
- **Anthropic Claude** (`ANTHROPIC_MODEL`, 기본 `claude-sonnet-4-5`)
- **Supabase** (PostgreSQL + pgvector + Auth + Storage), `@supabase/supabase-js` + `@supabase/ssr`
- **임베딩**: 기본 Google `gemini-embedding-001` @ **1024차원**(MRL 절단) / 옵션 OpenAI `text-embedding-3-small`·BGE-M3·Ollama(자체 호스팅).
  `EMBEDDING_PROVIDER`(auto|google|openai|bge|ollama) 로 전환 — auto 는 Ollama를 뜻하며
  장애 시 다른 벡터 공간으로 자동 폴백하지 않음(웹앱은 키워드 검색만 유지, 인덱서는 중단).
  **인덱서(rag7.py)와 웹앱은 같은 제공자/모델/차원/버전을 써야 함.**
- **차트** recharts · **PDF** react-pdf · **날짜** date-fns
- **인덱싱** Python (`indexing/`, 웹앱과 분리)

## 디렉터리
```
app/            App Router (화면 + /api/chat, /api/feedback)
components/ui/  shadcn 컴포넌트
components/chat /admin  도메인 컴포넌트
lib/supabase/   client(브라우저) · server(SSR) · admin(service role, 서버 전용)
lib/rag.ts      검색 + 컨텍스트 조립        lib/embeddings.ts  쿼리 임베딩
lib/auth.ts     세션·프로필 조회 + API/페이지 가드   lib/safe-redirect.ts  redirect 파라미터 검증(순수)
lib/generation-job*.ts  영속 생성 작업 공개 계약·DB projection·Workflow 시작
lib/chat-history.ts  대화 히스토리 상한(순수)   lib/rate-limit.ts  인메모리 사전 제한
lib/ai-usage.ts  세션 기반 DB 공용 AI 요청량 제한(계정별·전체, 실패 시 차단)
lib/generate.ts AI 자료제작 스키마·프롬프트   lib/generate-material.ts  저장본↔폼 변환(순수)
lib/docx.ts /pptx.ts /hwpx*.ts  문서 변환(클라이언트 동적 import)
lib/courses.ts  분야(카테고리) 상수만        lib/database.types.ts  수작성 DB 타입
lib/demo-flag.ts  DEMO 플래그(미들웨어 공용)  lib/demo.ts  목 데이터
app/home /generate  홈 · AI 자료제작 (+/api/generate)
app/api/generate/jobs  품질 우선 비동기 작업 생성·상태 조회·저장 지점 재시도
app/notices /me /docs  공지 · 마이페이지 · 자료실
app/admin/  통계 + documents(자료) · users(사용자) · notices(공지 작성)
components/learning/      CategoryBadge(분야색)·ProgressBar 재사용 컴포넌트 (학습 로직은 제거됨)
components/generate/      GenerateForm(입력) · DocResult/SlideDeckResult(결과) · NotebookLmResult(저장본 호환)
                          · parts.tsx(공용 조각)
scripts/import-users.mjs  명단(CSV) 신규 계정 발급 (항상 무작위 초기 비밀번호, 기존 계정 유지)
scripts/run-app.mjs  dev/build/start 환경 검사·실행   config/database-environments.json  DB 환경별 공개 식별자
scripts/build-setup-sql.mjs  마이그레이션 → setup_new_project.sql 생성 (npm run sql:setup)
supabase/migrations/    0001 테이블 · 0002 RPC · 0003 트리거+RLS · 0004 학습(제거됨)
                        · 0005 플랫폼(공지·체력) · 0006 퀴즈 제거 · 0007 직원필드+비번변경
                        · 0008 뉴스 · 0009 생성물 저장 · 0010 role 자가승격 차단
                        · 0011 인기질문 RPC · 0012 생성물 공유
                        · 20260726… 외부 RAG(rag_rescue) 보안·버전 적재
                        · 20260808… hybrid_search 코사인 수정+정리 · 관리자 통계 RPC
                        · 20260829… 생성물 공유 SOP DB 보호 · SOP/현장지침 문서 유형 분류
indexing/       Python 파이프라인          docs/  원본 자료 투입 위치
workflows/      Vercel Workflow 기반 장시간 정밀 생성 단계
eval/           평가셋 러너(vitest 통합)
```

## 플랫폼 도메인 규칙
- **기본 분야(카테고리) = 산악·수난·화재·구급·일반구조**(`lib/courses.ts`의 COURSE_CATEGORIES).
  외부 RAG에 존재하는 추가 분야도 동적으로 노출하며, 챗봇 필터·자료제작 분야에 함께 사용.
- 학습/진도/이수(레슨) 기능은 **제거됨**(2026-06-18). `documents`는 자료실(`/docs`) 원본 열람용으로만.
  `lesson_progress` 테이블도 2026-08-08 마이그레이션에서 삭제됨.
- 출동 마일리지·체력단련 기능은 **제거됨**(2026-08-27). 기존 `workout_logs` 데이터와 스키마는
  복구 가능성을 위해 보존하지만 앱에서는 조회·기록하지 않음.
- AI 자료제작: `/generate` 클릭·선택형 UI → `/api/generate/jobs`가 사용자별 작업을 저장하고
  Vercel Workflow를 시작한다. `/api/generate`는 데모·동기 호환 경로로 유지한다.
  필수 입력은 자료 유형·분야·주제·대상·시간이고, 날짜·장소·현장 조건은 필요한 경우만 입력한다.
  사용자에게 모델 선택을 요구하지 않고 정밀 생성 모델을 우선 사용한다. 작업은 근거 조회→전체 구성→
  초안(슬라이드는 2장 묶음)→품질 검사→최대 2회 선택 보완으로 나누며 각 완료 단계를
  `generation_jobs.checkpoint`에 저장한다. Workflow 실행 연결이 확인된 뒤에는 브라우저를 닫아도 이어지고, `?j=<uuid>`로 본인 작업의
  진행률·경과시간·예상 완료를 다시 확인한다. 품질 게이트를 통과한 결과만 완성본으로 공개한다.
  `/generate`의 최근 작업 목록에서 다시 진입하고, 개인 편집 초안은 `generation_drafts`에
  소유자 RLS·revision CAS로 자동보관한다(`?d=<uuid>`). 미완성 초안 보관은 공식 저장·공유와 별개다.
  정밀 생성의 완성본은 `generation-grounding-review.ts`에서 원문·요청 조건을 별도로 검토하고,
  본문·근거 서명이 달라지면 재검토한다. 저장·공유와 내보내기 직전에는 서버가 읽은 실제 원문으로
  기술 수치를 다시 대조한다. 수치의 존재 여부나 모델 검토를 사실성 보증으로 표현하지 않는다.
  훈련계획은 고정 5개, 교안은 실습형 7개 섹션으로 생성하고 시간·안전·평가·분량·중복·출처·
  슬라이드 밀도를 결정론적으로 점검한다. 교육시간별 장수는 권장값이고 편집 본문은 6~20장을 허용한다. 문서는 DOCX/HWPX로 다운로드한다. 슬라이드는 16:9
  미리보기에서 레이아웃·순서·단계를 편집할 수 있고, 장별 `[Sources]` 노트가 있는 분야 색 표준
  양식 PPTX로 다운로드한다. 과거 NotebookLM 저장본은 재열람 호환만 유지한다.

## 보안 규칙 (필수)
- `ANTHROPIC_API_KEY`·`OPENAI_API_KEY`·`SUPABASE_SERVICE_ROLE_KEY` 는 **서버 전용**.
  클라이언트 번들에 절대 노출 금지. (`NEXT_PUBLIC_` 접두사 붙이지 말 것)
- service role 클라이언트(`lib/supabase/admin.ts`)는 **role='admin' 검증 후** 또는 인덱서에서만.
  자료제작 예외는 `lib/supabase/generation-worker.ts`와 `lib/supabase/generation-rag.ts`의
  제한된 전용 창구로만 둔다. 내구성 worker는 `requireApiUser()`를 통과한 API가 발급한 작업
  ID·실행 토큰으로 `generation_jobs` 갱신과 생성 근거 조회만 수행한다. 인증·레이트리밋을
  통과한 저장/공유/내보내기 검증 API는 `generation-rag.ts`를 통해 생성과 같은 RAG의 출처·SOP·원문만 읽기
  전용으로 재검증한다. 인증·레이트리밋을 통과한 동기 생성·부분 재생성도 worker 전용 클라이언트가
  없을 때 SOP 조회에만 같은 제한된 reader를 사용한다. 일반 자료 검색은 기존 세션·RLS와 조건
  쿼리를 유지한다. 요청 하나당 SOP 전문 검색의 동시 실행 상한은 2개, 일반 전문 검색은 4개이며, 조회 제한
  시간이나 DB 정책을 넓히지 않는다. 사용자 저장행 조회·쓰기는 계속 세션 클라이언트와 RLS·개정
  번호 CAS를 사용한다.
  초기 비밀번호 완료 처리는 `lib/supabase/password-change.ts`의 전용 writer만 예외로 둔다.
  `/api/auth/change-password`에서 출처·세션·등록 프로필·입력·횟수를 검증하고 같은 세션의
  Auth 비밀번호 변경 성공을 확인한 뒤, 인증된 본인 행의 `must_change_password=false`만 쓴다.
  요청에서 사용자 ID를 받거나 Auth 내부 비밀번호 해시 변경만으로 완료 처리하지 않는다.
- 모든 사용자 데이터 테이블은 **RLS** 적용. 본인 데이터만 접근.
- 인기 질문도 현재 계정의 질문만 조회한다. 개인 질문을 다른 계정에 추천용 원문으로 노출하지 않는다.
  폐기 기능은 화면 제거와 함께 DB RPC의 PUBLIC·anon·authenticated 실행 권한도 회수한다.
- **브라우저 스토리지(localStorage/sessionStorage) 의존 금지** — 상태는 서버/DB에.
- 인증 가드는 `lib/auth.ts` 단일 출처:
  페이지/레이아웃=`requireUserAndProfile()`(첫 로그인 비번변경 강제),
  route handler=`requireApiUser()` / 관리자 API=`requireApiAdmin()`.
  API 에서 `supabase.auth.getUser()` 를 직접 쓰지 말 것 — 비번 미변경 계정이 API 로 새어 들어온다.
- 등록 프로필 조회 오류·누락은 접근을 차단한다. 사용자 메타데이터나 가상 프로필로
  비밀번호 변경 상태·역할을 대신 판단하지 않는다. 초기 비밀번호 변경 API만 공통 가드에서
  변경 필요 플래그를 예외로 하며, 세션·등록 프로필 검증은 동일하게 적용한다.
- `profiles.account_ready`는 관리자 발급 완료 상태다. 신규 계정은 `false`, 초기 비밀번호
  변경 필요는 `true`이며, 발급이 끝나기 전에는 비밀번호 변경 API도 차단한다. 새 마이그레이션은
  기존 계정만 `account_ready=true`로 보존한다. 클라이언트가 준비 상태를 직접 바꿀 수 없다.
  공용·개인 테이블과 Storage의 제한적 RLS는 현재 Auth 존재·삭제/차단 상태·발급 완료·
  비밀번호 변경 완료를 검사한다. 소유자·공유·활성 자료 조건을 대신하거나 넓히지 않는다.
- 관리자 페이지는 `requireAdminAndProfile()`, 관리자 API는 `requireApiAdmin()`으로
  DB 역할과 현재 검증된 TOTP·서명 검증된 세션의 `aal2`를 확인한다. `/admin-mfa`와
  전용 등록 API만 추가 인증 전 접근을 허용한다. 일반 기능·공용 일반 계정에는 MFA를 강제하지 않는다.
  관리자 DB 예외도 `access_private.is_verified_admin()`을 사용한다. 복구를 위해 MFA 검사를
  끄거나 일반 사용자에게 관리자 역할을 주지 않는다. 등록·분실 절차는 `SETUP.md`를 따른다.
- 일괄 발급은 무작위 20자 비밀번호만 사용한다. 직원 식별번호를 비밀번호로 쓰지 않는다.
  기존 계정의 비밀번호·프로필·역할은 재실행으로 변경하지 않는다. 발급용 `*.passwords.csv`는
  Git 제외·0600·배타적 생성으로 보관하며 완료 계정만 개별 전달한 뒤 삭제한다.
- `npm run dev/build/start`의 `scripts/run-app.mjs` 검사를 유지한다. 비운영 실행은
  `.env.development.local`과 `RESCUEAI_DATABASE_ENV=development`를 사용하고, 원격 개발 DB의
  ref는 `config/database-environments.json`의 개발 목록에 등록한다. 개발 DB 미설정·미등록·
  운영 DB 혼용은 실행을 차단한다. 운영 `.env.local` 값을 개발용으로 복사하지 않는다.
- Supabase 신규 가입은 서버 설정에서 끄고 로그인에 `shouldCreateUser: false`를 유지한다.
  공용 계정의 동시 로그인과 `signOut({ scope: 'local' })`는 유지한다. 비밀번호 변경 같은
  보안 작업에서 Auth가 다른 세션을 종료할 수 있는 점은 일반 로그아웃과 구분한다.
- **리다이렉트 파라미터는 반드시 `safeRedirectPath()` 통과** — 외부 URL·`javascript:` 차단.
- LLM 을 태우는 엔드포인트에는 `rateLimit()` 사전 제한과 실제 실행 직전 `guardAiUsage()`가
  필요하다. DB에서 사용자·작업별 분당 상한 및 계정·전체 KST 일일 가중 요청량을 원자적으로
  검사한다. 사용자 입력으로 한도·대상 계정을 지정하거나 확인 실패 시 제한을 우회하지 않는다.
  Cron 뉴스만 비밀값 확인 후 서비스 역할 전용 무인자 RPC를 사용한다. 가중 요청량은 실제
  과금액·토큰 수 보증이 아니다. 클라이언트 대화는 `trimChatHistory()`로 개수·길이를 자른다.
- 초안은 DB에서도 미저장·저장 완료 각각 200개/합계 200MiB를 강제한다. 동시 요청·직접 API를
  고려하고 보관 실패 시 현재 편집을 유지한 채 기존 초안을 정리할 경로를 제공한다.
- 데모 모드(`NEXT_PUBLIC_DEMO_MODE`)는 실제 Supabase 백엔드가 붙으면 자동으로 꺼진다(`lib/demo-flag.ts`).
  플래그 하나로 미들웨어 인증이 통째로 열리므로 이 가드를 제거하지 말 것.

## 코딩 컨벤션
- 서버 컴포넌트 기본, 상호작용 필요한 곳만 `"use client"`.
- Supabase 접근: 브라우저=`lib/supabase/client`, 서버=`lib/supabase/server`, 집계=`lib/supabase/admin`.
- UI 한국어. 모바일 우선(본문 16px+, 터치 48px+, 대비 충분히).
- 타이포: **Pretendard** self-host(`public/fonts`, `font-sans`). 분야 색은 `lib/category.ts`
  단일 출처(산악=emerald·수난=sky·화재=orange·구급=rose), `<CategoryBadge>` 재사용. 색 클래스는
  전체 문자열로 둘 것(Tailwind v4가 소스를 자동 스캔하므로 동적 조합 문자열은 감지 못함).
- 환각 가드레일: §9.2 시스템 프롬프트를 단일 출처(`lib/rag.ts`)에서 관리.

## 자주 쓰는 명령
```bash
npm run dev        # 등록된 별도 개발 DB 또는 명시적 데모로 실행
npm run build      # 빌드(타입 체크 포함), 비운영 실행은 개발 DB 환경 검사
npm run lint       # ESLint
npm run typecheck  # 타입만 체크(tsc --noEmit)
npm test           # 단위 테스트(vitest)
npm run sql:setup  # 마이그레이션 → supabase/setup_new_project.sql 재생성

# 인덱싱(자료 추가 시): SETUP.md 참고
cd indexing && pip install -r requirements-rag7.txt && cd .. && python rag7.py
```

## 환경변수
웹앱 개발은 `.env.development.local.example`을 `.env.development.local`로 복사 후 별도 개발
DB 값과 개발용 API 키를 채운다. 개발 DB가 없으면 먼저 로컬/별도 클라우드 구성을 결정해야 하며,
운영 DB로 자동 연결하지 않는다. 운영 배포 변수와 서버 전용 발급·인덱싱 도구의 `.env.local`
키 목록은 `.env.local.example`을 참고한다. 민감한 실데이터는 개발 DB에 그대로 복사하지 않는다.
