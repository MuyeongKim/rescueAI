# 전북소방 구조 교육훈련 플랫폼 (AI 튜터 포함)

구조대원이 **자료로 학습(과정·진도·이수)**, **AI 튜터에게 질의(RAG·출처)**,
**클릭 몇 번으로 훈련계획·교안·슬라이드 생성(+NotebookLM 프롬프트)** 하는
구조 교육훈련 플랫폼 PoC. 챗봇·생성 기능은 인덱싱된 교육자료에 **근거(출처·페이지)와 함께**
동작하고, 근거가 없으면 "확인되지 않습니다"로 답해 환각을 차단합니다.

- 제품 명세: [`PRD.md`](PRD.md)
- 설치/실행/배포: [`SETUP.md`](SETUP.md)
- 프로젝트 규칙·컨벤션: [`CLAUDE.md`](CLAUDE.md)

## 기술 스택
Next.js 14 (App Router, TS) · Tailwind v3 + shadcn/ui · Vercel AI SDK v4 + Anthropic Claude ·
Supabase(Postgres + pgvector + Auth + Storage) · 임베딩 OpenAI `text-embedding-3-small`@1024
(또는 BGE-M3) · recharts · react-pdf · Python 인덱서(`indexing/`).

## 빠른 시작
```bash
npm install
cp .env.local.example .env.local   # 값 채우기 (SETUP.md 참고)
# Supabase 스키마 적용: supabase/migrations/0001~0003 을 SQL Editor에서 실행
npm run dev                        # http://localhost:3000
```
자료 인덱싱·관리자 계정·배포는 **[SETUP.md](SETUP.md)** 를 따르세요.

## 주요 화면 / API
- `/home` 학습자 홈(진도·이수·추천) · `/courses` 과정 목록 · `/courses/[분야]` 레슨·진도
  (이수 = 분야의 모든 자료 학습 완료)
- `/generate` 자료 생성 — 클릭·선택형으로 **훈련계획·교안(docx)·슬라이드(PPTX, 발표자 노트)**
  생성, NotebookLM용 프롬프트 조립. 사용법은 SETUP.md "자료 생성" 절 참고
- `/login` 매직링크 · `/chat` AI 튜터(스트리밍·출처·피드백) · `/chat/[id]` 과거 대화
- `/docs` 자료 목록 · `/docs/[id]?page=N` PDF 뷰어 · `/admin` 통계(이용+학습 현황)
- `POST /api/chat` RAG+Claude · `/api/feedback` 👍/👎 · `/api/progress` 레슨 완료 · `/api/generate` 자료 생성

## 검증 명령
```bash
npm run build      # 프로덕션 빌드(타입체크 포함)
npm run lint       # ESLint
npx tsc --noEmit   # 타입만 체크
npm test           # 단위 테스트(vitest): 과정 편성·체력 마일리지
```
