# CLAUDE.md — 프로젝트 규칙·컨벤션

전북소방 구조 교육훈련 플랫폼(AI 튜터 포함). 제품 명세 [`PRD.md`](PRD.md), 설치/실행 [`SETUP.md`](SETUP.md) 참조.

## 한 줄 요약
구조대원이 **AI 튜터에게 질의(RAG·출처)**, **클릭 몇 번으로 훈련계획·교안 생성(+NotebookLM 프롬프트)**,
**자료실에서 원본 열람**을 하는 교육훈련 플랫폼 PoC.
챗봇·생성 기능은 인덱싱된 교육자료에 근거(출처·페이지)해 동작하고, 근거가 없으면
"확인되지 않습니다"로 답해 환각을 차단한다.
※ 학습/진도/이수(레슨) 기능은 2026-06-18 제거됨(퀴즈 없는 읽음표시라 가치 낮음·이수 보고 불필요).

## 기술 스택
- **Next.js 14** (App Router, TypeScript) + **Tailwind CSS v4**(`@tailwindcss/postcss`, 설정은
  `app/globals.css`의 `@theme` — `tailwind.config.ts` 없음) + **shadcn/ui**(Radix 기반, classic)
- **Vercel AI SDK v4** (`ai`, `@ai-sdk/anthropic`) — `useChat` / `streamText` 스트리밍
- **Anthropic Claude** (`ANTHROPIC_MODEL`, 기본 `claude-sonnet-4-5`)
- **Supabase** (PostgreSQL + pgvector + Auth + Storage), `@supabase/supabase-js` + `@supabase/ssr`
- **임베딩**: 기본 Google `gemini-embedding-001` @ **1024차원**(MRL 절단) / 옵션 OpenAI `text-embedding-3-small`·BGE-M3·Ollama(자체 호스팅).
  `EMBEDDING_PROVIDER`(auto|google|openai|bge|ollama) 로 전환 — auto 는 Ollama 우선·불가 시 Google 폴백.
  **인덱서(rag7.py)와 웹앱은 같은 제공자/모델/차원을 써야 함**(폴백 중 검색 품질 무의미 — 앱 생존용).
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
lib/chat-history.ts  대화 히스토리 상한(순수)   lib/rate-limit.ts  인메모리 레이트리밋
lib/generate.ts AI 자료제작 스키마·프롬프트   lib/generate-material.ts  저장본↔폼 변환(순수)
lib/docx.ts /pptx.ts /hwpx*.ts  문서 변환(클라이언트 동적 import)
lib/courses.ts  분야(카테고리) 상수만        lib/database.types.ts  수작성 DB 타입
lib/demo-flag.ts  DEMO 플래그(미들웨어 공용)  lib/demo.ts  목 데이터
app/home /generate  홈 · AI 자료제작 (+/api/generate)
app/notices /me /docs  공지 · 마이페이지 · 자료실
app/admin/  통계 + documents(자료) · users(사용자) · notices(공지 작성)
components/learning/      CategoryBadge(분야색)·ProgressBar 재사용 컴포넌트 (학습 로직은 제거됨)
components/generate/      GenerateForm(입력) · DocResult/SlideDeckResult/NotebookLmResult(결과)
                          · parts.tsx(공용 조각)
scripts/import-users.mjs  명단(CSV) 일괄 계정 등록 (--random-password 옵션)
scripts/build-setup-sql.mjs  마이그레이션 → setup_new_project.sql 생성 (npm run sql:setup)
supabase/migrations/    0001 테이블 · 0002 RPC · 0003 트리거+RLS · 0004 학습(제거됨)
                        · 0005 플랫폼(공지·체력) · 0006 퀴즈 제거 · 0007 직원필드+비번변경
                        · 0008 뉴스 · 0009 생성물 저장 · 0010 role 자가승격 차단
                        · 0011 인기질문 RPC · 0012 생성물 공유
                        · 20260726… 외부 RAG(rag_rescue) 보안·버전 적재
                        · 20260808… hybrid_search 코사인 수정+정리 · 관리자 통계 RPC
indexing/       Python 파이프라인          docs/  원본 자료 투입 위치
eval/           평가셋 러너(vitest 통합)
```

## 플랫폼 도메인 규칙
- **기본 분야(카테고리) = 산악·수난·화재·구급·일반구조**(`lib/courses.ts`의 COURSE_CATEGORIES).
  외부 RAG에 존재하는 추가 분야도 동적으로 노출하며, 챗봇 필터·자료제작 분야에 함께 사용.
- 학습/진도/이수(레슨) 기능은 **제거됨**(2026-06-18). `documents`는 자료실(`/docs`) 원본 열람용으로만.
  `lesson_progress` 테이블도 2026-08-08 마이그레이션에서 삭제됨.
- 출동 마일리지·체력단련 기능은 **제거됨**(2026-08-27). 기존 `workout_logs` 데이터와 스키마는
  복구 가능성을 위해 보존하지만 앱에서는 조회·기록하지 않음.
- AI 자료제작: `/generate` 클릭·선택형 UI → `/api/generate`(분야 자료 컨텍스트+generateObject).
  구체적인 주제 입력 필수. 훈련계획은 고정 5개, 교안은 실습형 7개 섹션으로 생성하고 시간·안전·평가·
  분량·중복·출처를 결정론적으로 점검해 필요한 경우 전체 초안을 한 번 보완한다. 문서는 DOCX/HWPX,
  슬라이드는 의미별 레이아웃과 장별 `[Sources]` 노트가 있는 분야 색 표준 양식 PPTX로 다운로드,
  NotebookLM 프롬프트는 클라이언트 조립(AI 미호출).

## 보안 규칙 (필수)
- `ANTHROPIC_API_KEY`·`OPENAI_API_KEY`·`SUPABASE_SERVICE_ROLE_KEY` 는 **서버 전용**.
  클라이언트 번들에 절대 노출 금지. (`NEXT_PUBLIC_` 접두사 붙이지 말 것)
- service role 클라이언트(`lib/supabase/admin.ts`)는 **role='admin' 검증 후** 또는 인덱서에서만.
- 모든 사용자 데이터 테이블은 **RLS** 적용. 본인 데이터만 접근.
- **브라우저 스토리지(localStorage/sessionStorage) 의존 금지** — 상태는 서버/DB에.
- 인증 가드는 `lib/auth.ts` 단일 출처:
  페이지/레이아웃=`requireUserAndProfile()`(첫 로그인 비번변경 강제),
  route handler=`requireApiUser()` / 관리자 API=`requireApiAdmin()`.
  API 에서 `supabase.auth.getUser()` 를 직접 쓰지 말 것 — 비번 미변경 계정이 API 로 새어 들어온다.
- **리다이렉트 파라미터는 반드시 `safeRedirectPath()` 통과** — 외부 URL·`javascript:` 차단.
- LLM 을 태우는 엔드포인트에는 `rateLimit()` 필수(비용 방어). 클라이언트가 보낸 대화 히스토리는
  `trimChatHistory()` 로 개수·길이를 자른다.
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
npm run dev        # 개발 서버
npm run build      # 프로덕션 빌드(타입 체크 포함)
npm run lint       # ESLint
npm run typecheck  # 타입만 체크(tsc --noEmit)
npm test           # 단위 테스트(vitest)
npm run sql:setup  # 마이그레이션 → supabase/setup_new_project.sql 재생성

# 인덱싱(자료 추가 시): SETUP.md 참고
cd indexing && pip install -r requirements.txt && python embed_and_upload.py
```

## 환경변수
`.env.local.example` 를 `.env.local` 로 복사 후 채운다. 키 목록·설명은 그 파일 주석 참고.
