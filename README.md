# 전북소방 구조 교육훈련 AI

소방 교육자료를 근거로 답변하고 훈련계획과 교안을 만드는 **구조대원 업무지원 플랫폼 PoC**입니다.
AI 튜터는 인덱싱된 자료를 검색해 출처와 페이지를 함께 제시하며, 근거가 부족하면
"관련 교육자료에서 확인되지 않습니다"라고 안내하도록 설계했습니다.

현재는 중간보고와 사용성 검증을 위한 PoC 단계이며, 검증 이후 애플리케이션, 데이터베이스,
LLM 및 임베딩 서비스를 내부망 서버로 이전하는 것을 목표로 합니다.

## 핵심 원칙

- **근거 우선**: 교육자료 검색 결과를 바탕으로 답변과 생성물을 작성합니다.
- **출처 추적**: 문서명과 페이지를 표시하고 자료실 원문으로 연결합니다.
- **환각 억제**: 근거가 없거나 불확실한 내용은 추측하지 않습니다.
- **현장 사용성**: 모바일 우선 UI, 큰 터치 영역, 명확한 상태 표시를 적용합니다.
- **권한 분리**: 사용자 데이터에는 RLS를 적용하고 관리자 기능은 서버에서 권한을 재검증합니다.

## 주요 기능

| 영역 | 내용 | 현재 상태 |
| --- | --- | --- |
| AI 튜터 | 스트리밍 질의응답, 분야 필터, 대화 이력, 출처·페이지, 답변 피드백 | PoC 구현 |
| AI 자료제작 | 훈련계획·교안·슬라이드 생성, 직접 편집, 부분 재생성, 저장·공유 | PoC 구현 |
| 문서 출력 | 한글 HWPX, Word DOCX, 발표자 노트가 포함된 PPTX 다운로드 | PoC 구현 |
| 자료실 | 원본 자료 목록, PDF 열람, AI 답변 출처에서 해당 페이지로 이동 | PoC 구현 |
| RAG 인덱싱 | PDF·HWPX·HWP 등 파싱, OCR, 청크 미리보기, 버전 교체, 원본 등록 | PoC 구현 |
| 구조 동향·공지 | 구조 사례 및 기술 동향 제공, 공지 열람과 관리자 작성 | PoC 구현 |
| 체력단련 | 운동 기록, 월간 마일리지, 순위와 연속 운동 현황 | PoC 구현 |
| 출동 마일리지 | 출동 실적·마일리지 화면 및 관리자 분석 화면 | 예시 데이터 단계 |
| 관리자 | 이용 통계, 인기 질문, 자료·사용자·공지·동향 관리 | PoC 구현 |

분야 분류는 **산악·수난·화재·구급** 네 가지이며, AI 튜터 검색과 AI 자료제작에서 같은
분류 체계를 사용합니다.

> 기존 과정·레슨·진도·이수 기능은 단순 읽음 표시의 실효성이 낮아 2026년 6월 제거했습니다.
> 잔존하던 `lesson_progress` 테이블도 2026년 8월 마이그레이션에서 삭제했습니다.

## 주요 화면

| 경로 | 기능 |
| --- | --- |
| `/login` | 비밀번호 또는 이메일 링크 로그인, 최초 로그인 비밀번호 변경 |
| `/home` | 공지, 핵심 업무, 최근 AI 대화, 구조 동향, 대원 준비도 요약 |
| `/chat` | 교육자료 기반 AI 튜터 |
| `/chat/[conversationId]` | 저장된 대화 열람 |
| `/generate` | 훈련계획·교안·슬라이드·NotebookLM 프롬프트 제작 |
| `/generate/saved` | 개인 생성물 저장, 재편집 및 부분 재생성 |
| `/generate/shared` | 사용자가 공유한 생성물 열람 및 복제 |
| `/docs` | 교육자료 목록 및 검색 |
| `/docs/[id]` | 원본 PDF 열람과 페이지 이동 |
| `/news` | 국내외 구조 동향과 신기술 사례 |
| `/fitness` | 체력단련 기록과 마일리지 |
| `/dispatch` | 출동 마일리지 PoC 화면 |
| `/notices` | 공지사항 |
| `/me` | 사용자 정보와 활동 요약 |
| `/admin/*` | 통계, 자료, 사용자, 공지, 동향 및 출동통계 관리 |

## 동작 흐름

```text
PDF/HWPX/HWP/DOCX/PPTX/이미지
        |
        v
rag7.py GUI -> 문서 변환·OCR -> 페이지 보존 청킹 -> 1024차원 임베딩
        |                                             |
        +--------> Supabase Storage + PostgreSQL/pgvector
                                                      |
사용자 질문 -> 하이브리드 검색(벡터+키워드) -> 재순위·컨텍스트 조립
                                                      |
                                                      v
                                            LLM 답변 + 출처·페이지
```

`rag7.py`는 신규 청크를 비활성 상태로 먼저 적재하고, 전체 배치 검증이 끝난 경우에만 새 버전을
활성화합니다. 새 버전 활성화와 이전 버전 교체는 하나의 DB 트랜잭션으로 처리하며, Storage
원본 등록은 단계별 검증과 실패 시 정리 절차를 거쳐 불완전한 데이터가 검색되지 않도록 합니다.

## 기술 스택

| 구분 | 구성 |
| --- | --- |
| 웹 | Next.js 14 App Router, React 18, TypeScript |
| UI | Tailwind CSS v4, shadcn/ui, Radix UI, Pretendard |
| AI | Vercel AI SDK v4, Claude·Gemini·OpenAI 호환 LLM 선택 |
| 데이터 | Supabase PostgreSQL, pgvector, Auth, 비공개 Storage, RLS |
| 검색 | 벡터·키워드 하이브리드 검색, 질의 확장, 선택적 재순위 |
| 임베딩 | 기본 `gemini-embedding-001` 1024차원, OpenAI·BGE-M3·Ollama 선택 |
| 인덱싱 | Python, Docling, EasyOCR, LibreOffice, `rag7.py` GUI |
| 문서 생성 | HWPX, DOCX, PptxGenJS |
| 검증 | Vitest, TypeScript, Next.js 프로덕션 빌드 |

LLM은 `LLM_PROVIDER=claude|gemini|openai-compat`, 임베딩은
`EMBEDDING_PROVIDER=google|openai|bge|ollama|auto`로 전환할 수 있습니다.

> 웹앱의 질의 임베딩과 인덱서의 문서 임베딩은 **제공자, 모델, 차원, 전처리 버전이 모두
> 같아야 합니다.** 임베딩 모델을 변경하면 기존 자료를 같은 설정으로 전체 재인덱싱해야 합니다.

## 빠른 시작

### 준비물

- Node.js 18 이상, 권장 버전 20
- npm
- Supabase 프로젝트
- 사용할 LLM 및 임베딩 제공자의 API 키
- 자료 인덱싱 시 Python 3.11

### 웹앱 실행

```bash
npm install
cp .env.local.example .env.local
# .env.local 값을 환경에 맞게 설정
npm run dev
```

브라우저에서 `http://localhost:3000`으로 접속합니다. 환경변수 설명과 서버 전용 키 구분은
[`.env.local.example`](.env.local.example)을 기준으로 확인합니다.

실제 API와 Supabase 없이 UI 흐름만 시연할 때는 데모 모드를 사용할 수 있습니다.

```bash
NEXT_PUBLIC_DEMO_MODE=1 NEXT_PUBLIC_SUPABASE_URL=https://demo.supabase.co npm run dev
```

데모 모드는 미들웨어의 인증 검사를 통째로 통과시키므로, **실제 Supabase 백엔드가 연결된
환경에서는 플래그가 켜져 있어도 자동으로 무시**합니다(`lib/demo-flag.ts`). 그래서 위 명령처럼
Supabase 주소를 자리표시자로 덮어써야 데모가 켜집니다. 이 가드는 운영 배포에 데모 플래그가
실수로 들어가 인증이 열리는 사고를 막기 위한 것이므로 제거하지 마세요.

### 데이터베이스 준비

1. Supabase에서 `vector`, `pg_trgm` 확장을 사용할 수 있는 프로젝트를 준비합니다.
2. **새 프로젝트**라면 [`supabase/setup_new_project.sql`](supabase/setup_new_project.sql)
   전체를 SQL Editor에서 한 번에 실행합니다. 이 파일은 모든 마이그레이션에서 자동 생성되며
   (`npm run sql:setup`), 직접 수정하지 않습니다.
3. **기존 프로젝트**라면 `supabase/migrations/`에서 아직 적용하지 않은 파일만 파일명 순서로
   실행합니다. 규칙과 파일별 설명은
   [`supabase/migrations/README.md`](supabase/migrations/README.md)에 있습니다.
4. 원본 자료용 비공개 Storage 버킷 `documents`를 생성합니다.
5. 관리자 계정과 일반 사용자 계정을 등록합니다.
   일괄 등록은 `node scripts/import-users.mjs <명단.csv>`를 사용하며,
   `--random-password`를 붙이면 무작위 초기 비밀번호를 발급해 별도 CSV로 떨어뜨립니다
   (명단 유출만으로 로그인되지 않게 하려면 이쪽을 권장합니다).

세부 설치와 인증 설정은 [`SETUP.md`](SETUP.md), 실제 운영 전환 순서는
[`DEPLOYMENT.md`](DEPLOYMENT.md)를 참고합니다.

## RAG 자료 인덱싱

### GUI 인덱서

현재 PoC의 권장 경로는 루트의 `rag7.py`입니다.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r indexing/requirements-rag7.txt
python rag7.py
```

- PDF 텍스트층을 페이지별로 검사하고 필요한 페이지만 한국어·영어 OCR을 적용합니다.
- HWPX/HWP는 LibreOffice로 임시 PDF를 만든 뒤 같은 파이프라인으로 처리합니다.
- DOCX, PPTX, TXT, Markdown, HTML 및 주요 이미지 형식도 선택할 수 있습니다.
- 업로드 전 추출 페이지, 문자 수, 청크 수와 청크 샘플을 검토할 수 있습니다.
- 원본 자동 등록을 켜면 자료실의 `documents` 행과 비공개 Storage 원본을 함께 연결합니다.

HWPX/HWP 자동 변환에는 LibreOffice가 필요합니다. 인터넷이 차단된 내부망에서는 Docling과
EasyOCR 모델을 사전에 반입하고 `DOCLING_OCR_DOWNLOAD=0`으로 설정해야 합니다.

### 배치 인덱서

카테고리 폴더 단위의 일괄 적재에는 `indexing/embed_and_upload.py`를 사용할 수 있습니다.

```bash
cd indexing
pip install -r requirements.txt
python embed_and_upload.py
```

자세한 포맷·OCR·메타데이터 규칙은 [`indexing/README.md`](indexing/README.md)를 참고합니다.

## AI 자료제작 출력

| 유형 | 결과 |
| --- | --- |
| 훈련계획 | 전북소방 표준 양식 HWPX, DOCX, 텍스트 |
| 교육자료(교안) | HWPX, DOCX, 텍스트 |
| 슬라이드 | 분야 색상 표준 양식 PPTX, 발표자 노트 포함 |
| NotebookLM | 업로드할 자료 목록과 작성 조건이 포함된 프롬프트 |

생성 결과는 화면에서 직접 수정하거나 일부 섹션만 다시 생성할 수 있습니다. 개인 저장본은 다시
편집할 수 있고, 사용자가 명시적으로 공유한 자료만 동료의 공유 자료 화면에 표시됩니다.

모든 생성물은 교육자료에 근거한 **AI 초안**이므로 실제 훈련에 사용하기 전에 담당 교관이 내용,
최신성, 현장 여건 및 안전 기준을 반드시 검토해야 합니다.

## 검증 명령

```bash
npm test           # Vitest 단위·통합 테스트
npm run build      # 프로덕션 빌드, 타입 및 Next.js 검사 포함
npm run typecheck  # TypeScript 타입 검사
npm run lint       # ESLint
npm run sql:setup  # 마이그레이션에서 setup_new_project.sql 재생성
```

RAG 평가셋과 실행 방법은 [`eval/README.md`](eval/README.md)를 참고합니다.

## 보안 주의사항

- `SUPABASE_SERVICE_ROLE_KEY`, LLM API 키, 임베딩 API 키는 서버 전용입니다.
- 서버 전용 키에 `NEXT_PUBLIC_` 접두사를 붙이거나 클라이언트 코드에서 참조하지 않습니다.
- `documents` Storage 버킷은 비공개로 유지하고 인증된 사용자에게만 서명 URL을 발급합니다.
- 토큰과 비밀번호를 Git 저장소, 로그, 문서 또는 채팅에 남기지 않습니다.
- 사용자 데이터 테이블에는 RLS를 적용하고 본인 데이터만 접근하도록 유지합니다.

인증·요청 처리는 `lib/auth.ts`를 단일 출처로 사용합니다.

| 위치 | 사용할 가드 | 하는 일 |
| --- | --- | --- |
| 페이지·레이아웃 | `requireUserAndProfile()` | 세션 확인 + 최초 로그인 비밀번호 변경 강제 |
| 일반 route handler | `requireApiUser()` | 세션 확인 + 비밀번호 미변경 계정 차단 |
| 관리자 route handler | `requireApiAdmin()` | 위 항목 + `admin` 역할 재확인 |

- route handler에서 `supabase.auth.getUser()`를 직접 호출하지 않습니다. 비밀번호를 바꾸지 않은
  계정이 API로 새어 들어옵니다(초기 비밀번호는 디지털식별번호라 명단을 아는 사람이 알 수 있습니다).
- 로그인 후 이동 경로 등 리다이렉트 파라미터는 반드시 `safeRedirectPath()`를 통과시킵니다.
  외부 URL과 `javascript:` 스킴을 차단합니다.
- LLM을 호출하는 엔드포인트에는 `rateLimit()`을 적용하고, 클라이언트가 보낸 대화 이력은
  `trimChatHistory()`로 개수와 길이를 제한합니다.
- 응답 보안 헤더(CSP, `X-Frame-Options`, HSTS 등)는 `next.config.mjs`에서 관리합니다.

## PoC 범위와 내부망 이전

- 출동 마일리지 화면은 현재 예시 데이터이며 구조활동일지 연동은 후속 과제입니다.
- 외부 LLM과 Supabase를 사용하는 PoC 환경은 실제 운영 환경이 아닙니다.
- 내부망 이전 시 PostgreSQL/pgvector, 비공개 파일 저장소, OpenAI 호환 LLM 및
  BGE-M3/Ollama 임베딩 서비스를 내부 서버로 교체할 수 있습니다.
- 임베딩 제공자가 바뀌면 전체 자료 재인덱싱과 검색 품질 평가가 필요합니다.
- OCR 모델, Python 패키지, Node 패키지는 망 분리 전에 검증된 버전으로 반입해야 합니다.

상세한 이전 순서와 점검표는 [`내부망 이전 가이드.md`](내부망%20이전%20가이드.md)를 참고합니다.

## 문서

- [`PRD.md`](PRD.md): 초기 제품 요구사항과 RAG 기준
- [`SETUP.md`](SETUP.md): 설치, Supabase, 인증 및 배포 가이드
- [`DEPLOYMENT.md`](DEPLOYMENT.md): PoC에서 실제 플랫폼으로 전환하는 실행 계획
- [`내부망 이전 가이드.md`](내부망%20이전%20가이드.md): 내부 서버 이전 런북
- [`indexing/README.md`](indexing/README.md): 인덱싱 파이프라인 상세
- [`eval/README.md`](eval/README.md): RAG 평가셋과 실행 방법
- [`CLAUDE.md`](CLAUDE.md): 프로젝트 개발 규칙과 코딩 컨벤션
