# SETUP.md — 설치 · 실행 · 배포 가이드

전북소방 구조 AI 챗봇을 처음부터 띄우는 순서입니다. `PRD.md`(명세), `CLAUDE.md`(규칙)와 함께 보세요.

> 요약: **Supabase 프로젝트 만들기 → 스키마 적용 → 환경변수 → 관리자 계정 → 자료 인덱싱 → 실행/배포.**

---

## 0. 준비물
- Node.js 18+ (권장 20), npm
- Python 3.11 (인덱서)
- Supabase 계정, Anthropic API 키, OpenAI API 키(임베딩 기본값)

## 1. 의존성 설치
```bash
npm install
```

## 2. Supabase 프로젝트 생성
1. https://supabase.com → New project → **Region: Seoul(ap-northeast-2)**
2. Project Settings → API 에서 다음을 복사:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_ROLE_KEY` (서버 전용, 절대 노출 금지)

## 3. DB 스키마 적용
Supabase 대시보드 → **SQL Editor** 에서 아래 파일을 **순서대로** 실행:
1. `supabase/migrations/0001_init.sql` (확장 + 테이블 + 인덱스)
2. `supabase/migrations/0002_hybrid_search.sql` (하이브리드 검색 RPC)
3. `supabase/migrations/0003_triggers_rls.sql` (트리거 + RLS)
4. `supabase/migrations/0004_learning.sql` (학습 진도 — 교육훈련 플랫폼)
5. `supabase/migrations/0005_platform.sql` (공지 + 제거된 체력 기능의 보존 스키마)
6. `supabase/migrations/0006_remove_quiz.sql` (퀴즈 제거 — 이수 기준 변경)

> Supabase CLI가 있으면 `supabase db push` 로도 적용 가능합니다.

## 4. Storage 버킷 생성 (원본 PDF 뷰어용)
- Storage → New bucket → 이름 `documents`, **Public 체크 해제(비공개)**.
- 웹앱은 로그인 확인 후 1시간 유효 서명 URL을 발급해 원본을 엽니다.

## 5. Auth 설정 (매직링크)
- Authentication → Providers → **Email** 활성화 (Confirm email/매직링크).
- Authentication → URL Configuration → **Redirect URLs** 에 추가:
  - `http://localhost:3000/auth/callback`
  - 배포 후: `https://<your-app>.vercel.app/auth/callback`
- 회원가입 폼은 없습니다. 사용자는 **관리자가 발급**합니다 (아래 6번).

## 6. 환경변수
```bash
cp .env.local.example .env.local
# .env.local 을 열어 값 채우기 (주석 참고)
```
필수: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, 선택한 LLM API 키, `EMBEDDING_PROVIDER`, 선택한 임베딩 API 키,
`NEXT_PUBLIC_SITE_URL`. 기본 Gemini 구성은 `EMBEDDING_PROVIDER=google`과
`GOOGLE_GENERATIVE_AI_API_KEY`를 사용합니다.

## 7. 사용자 / 관리자 계정 만들기
1. Authentication → Users → **Add user** (이메일로 초대) 또는 본인 이메일로 로그인 1회
   → `handle_new_user` 트리거가 `profiles` 행을 자동 생성합니다.
2. 관리자로 승격 (SQL Editor):
   ```sql
   update profiles set role = 'admin' where email = 'admin@jbfire.go.kr';
   ```

## 8. 자료 인덱싱 (RAG 두뇌 채우기)
운영 `RAG_TABLE=rag_rescue` 코퍼스에는 Gemini 임베딩 계약을 기록·검증하는 루트
`rag7.py` GUI 인덱서를 사용합니다. (자세한 내용 `indexing/README.md`)
```bash
cd indexing
python -m venv .venv && source .venv/bin/activate   # 선택
pip install -r requirements-rag7.txt
cd ..
python rag7.py
```
> 웹앱과 인덱서는 **같은 임베딩 계약(제공자/모델/1024차원/버전)** 을 써야 합니다.
> 기본 계약은 `google / gemini-embedding-001 / 1024 / google-retrieval-v1`입니다.

`20260726100515_secure_versioned_rag_ingestion.sql` 마이그레이션을 먼저 적용하고,
기존 계약 없는 `rag_rescue` 데이터는 백업 후 비우고 같은 계약으로 전체 재인덱싱해야 합니다.
`indexing/embed_and_upload.py`는 별도 `documents`/`chunks` 스키마를 위한 레거시
OpenAI/BGE 배치 경로이며 Google/Gemini 임베딩을 지원하지 않습니다. `rag_rescue` 또는
Gemini 코퍼스 인덱싱에 사용하지 마세요.
이미 운영 중인 코퍼스의 임베딩 제공자를 바꿀 때는
`20260828032304_add_rag_corpus_release_switch.sql`을 적용하고
`indexing/migrate_rag_to_gemini.py`로 백업 → 비활성 스테이징 → 전체 원자 전환을 수행합니다.

HWPX/HWP 자동 변환에는 LibreOffice가 필요합니다. 스캔 PDF의 한국어 OCR 모델은
외부망에서 아래처럼 미리 받아 내부망으로 함께 반입하고, 내부망 환경변수에는
`DOCLING_OCR_DOWNLOAD=0`을 지정하세요.
텍스트가 벡터 윤곽선으로 저장된 PDF는 텍스트층 비율이 10% 이하일 때 전체 페이지
OCR을 자동 적용합니다. 필요하면 `DOCLING_FORCE_FULL_PAGE_OCR=1|0`으로 재정의할 수 있습니다.
Docling이 일부 페이지를 건너뛰더라도 유효한 PDF 텍스트층이 있으면 해당 페이지만 자동 병합합니다.
```bash
docling-tools models download easyocr --easyocr-lang ko --easyocr-lang en
```

## 9. 개발 서버 / 빌드
```bash
npm run dev        # http://localhost:3000
npm run build      # 프로덕션 빌드(타입체크 포함)
npm run lint       # ESLint
npx tsc --noEmit   # 타입만 체크
```

## 10. Vercel 배포
1. GitHub에 푸시 → Vercel에서 Import.
2. Environment Variables 에 `.env.local` 의 키들을 모두 등록
   (`NEXT_PUBLIC_*` 포함, 서버 키는 그대로 비공개).
3. `NEXT_PUBLIC_SITE_URL` 을 배포 도메인으로, Supabase Redirect URLs 에 콜백 추가.
4. Deploy.

## 11. 운영(공공클라우드) 이전 메모
- 코드는 그대로 두고 **환경변수(URL·키)만 교체**하면 됩니다 (PRD §14).
- Supabase는 셀프호스팅 또는 국내 PostgreSQL+pgvector로 이전 가능.
- 임베딩을 BGE-M3로 바꾸려면: `EMBEDDING_PROVIDER=bge`, `indexing/serve.py` 기동,
  `EMBEDDING_API_URL` 설정, 자료 재인덱싱(차원/모델 동일하게).

---

## 교육훈련 플랫폼 (PRD 확장)
챗봇을 **AI 튜터**로 포함하는 구조 교육훈련 플랫폼 PoC입니다.
- `/home` 학습자 홈: 전체 진도율·이수 과정·이어서 학습·빠른 이동
- `/courses` 과정 목록(분야별 자동 편성) · `/courses/[분야]` 레슨 목록·완료 체크·진도율
- **이수 기준**: 분야(과정)의 모든 자료 학습 완료 = 이수 (퀴즈 기능은 2026-06 회의 결정으로 제거)
- 과정/레슨은 **인덱싱된 자료로 자동 생성**됩니다. 자료를 카테고리 폴더로 넣으면 바로 과정이 생깁니다.
- 레슨 완료(`/api/progress`)는 `lesson_progress` 에 저장, 관리자 대시보드 "학습 현황"에 집계됩니다.

## AI 자료제작 (`/generate`) — 훈련계획·교안·슬라이드·NotebookLM 프롬프트

"막막한 빈 화면" 없이 **클릭 몇 번으로** 훈련계획과 교육자료를 만드는 화면입니다.
인덱싱된 교육자료(벡터DB)를 근거로 생성하므로, **자료 인덱싱(§8)이 선행**되어야 합니다.

### 사용 방법
1. 사이드바(또는 모바일 탭바) **AI 자료제작** 클릭
2. **생성할 자료** 선택 — 4종:
   - **훈련계획**: 개요(대상·시간·장소·목표) → 준비물·안전조치 → 단계별 진행(시간 배분) → 평가·강평
   - **교육자료(교안)**: 학습 목표 → 도입 → 본문(시범·실습 포인트) → 정리·평가
   - **슬라이드(PPTX)**: 슬라이드 10~20장(제목+핵심문장+**발표자 노트**)을 생성하고
     분야 색 표준 양식 PPTX로 다운로드
   - **NotebookLM 프롬프트**: 인덱싱된 자료 목록을 포함한 프롬프트를 조립 — 복사해서
     NotebookLM에 자료 업로드 후 붙여넣으면 그쪽에서 슬라이드 생성
3. **분야 / 대상 / 교육 시간** 버튼 선택, 필요하면 **훈련 내용·훈련 일자** 입력(선택)
4. **생성** → 미리보기 확인 → **워드(docx)/PPTX 다운로드** 또는 텍스트 복사

### 동작에 필요한 것 (유형별)
| 유형 | AI 키(`ANTHROPIC_API_KEY`) | 인덱싱 자료(Supabase) |
|---|---|---|
| 훈련계획 / 교안 / 슬라이드 | **필요** (생성 시) | **필요** (근거 컨텍스트) |
| NotebookLM 프롬프트 | 불필요 (클라이언트 조립) | 자료 목록 표시에만 사용 |
| docx·PPTX 파일 변환 | 불필요 (브라우저에서 변환) | — |

- 데모 모드(`NEXT_PUBLIC_DEMO_MODE=1`)에서는 AI·DB 없이 **목 문서/슬라이드**로 전체 흐름을
  시연할 수 있습니다(파일 다운로드는 실제로 동작).
- 모든 생성물은 **AI 초안**입니다. 화면·문서에 "시행 전 검토 필요" 문구가 함께 출력됩니다.

## 수용 기준 점검 체크리스트 (PRD §12)
실제 키·자료를 연결한 뒤 확인하세요.

- [ ] **AC-1** 로그아웃 상태로 `/chat` 접속 → `/login` 으로 이동
- [ ] **AC-2** 로그인 후 질문 시 3초 내 첫 토큰 스트리밍
- [ ] **AC-3** 답변 하단 출처 칩 표시, 클릭 시 `/docs/[id]?page=N` 로 이동
- [ ] **AC-4** 자료에 없는 질문 → "관련 매뉴얼에서 확인되지 않습니다…" 로 응답
- [ ] **AC-5** "이 사람 살았나요?" 류 → 119 의료지도/현장 지휘관 안내로 응답
- [ ] **AC-6** 대화·메시지 저장, `/chat/[id]` 에서 과거 대화 재열람
- [ ] **AC-7** 다른 계정으로 로그인 시 남의 대화 안 보임(RLS)
- [ ] **AC-8** 👍/👎 → `messages.feedback` 에 저장
- [ ] **AC-9** 일반 계정으로 `/admin` 접근 차단, 관리자만 통계 표시
- [ ] **AC-10** 모바일/PC 레이아웃 정상
- [ ] **AC-11** 평가셋 50문항 정확도 60% 이상 (`eval/` 참고)

### 플랫폼 추가 점검
- [ ] **PL-1** 로그인 후 `/home` 에 진도율·과정 카드가 보인다
- [ ] **PL-2** `/courses/[분야]` 에서 레슨 완료 토글 시 진도율이 갱신된다
- [ ] **PL-3** 분야의 모든 레슨 완료 시 과정에 "이수" 배지가 표시된다
- [ ] **PL-4** `/generate` 에서 훈련계획·교안이 자료 근거(출처 표시)로 생성되고 docx로 받아진다
- [ ] **PL-5** `/generate` 슬라이드 생성 → 분야 색 표준 양식 PPTX(발표자 노트 포함)가 받아진다
- [ ] **PL-6** NotebookLM 프롬프트에 해당 분야 인덱싱 자료 목록이 포함된다
- [ ] **PL-7** 관리자 대시보드에 "학습 현황"(레슨 완료·과정 이수)이 집계된다

## 트러블슈팅
- **답변이 안 나옴**: `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` 확인. 콘솔 로그 `[chat]` 참고.
- **출처가 비어 있음**: 자료 인덱싱이 안 됐거나 임베딩 계약 불일치. 운영 경로는
  `rag_rescue`의 활성 행과 `rag_embedding_config` 계약을 확인하세요. 레거시 경로만
  `chunks` 테이블 행 수를 확인합니다.
- **로그인 링크 클릭 후 오류**: Supabase Redirect URLs 에 `/auth/callback` 등록 여부 확인.
- **PDF가 안 열림**: 비공개 `documents` 버킷 존재 여부와 `documents.file_url` 경로,
  `SUPABASE_SERVICE_ROLE_KEY` 설정을 확인.
- **임베딩 차원 오류**: 스키마 `vector(1024)` 와 모델 차원(1024) 일치 여부 확인.
