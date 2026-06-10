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
4. `supabase/migrations/0004_learning.sql` (학습 진도 + 퀴즈 이수 — 교육훈련 플랫폼)

> Supabase CLI가 있으면 `supabase db push` 로도 적용 가능합니다.

## 4. Storage 버킷 생성 (원본 PDF 뷰어용)
- Storage → New bucket → 이름 `documents`, **Public** 체크.
- (비공개로 하려면 인덱서/뷰어를 서명 URL 방식으로 바꿔야 합니다. 1차는 Public 권장.)

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
`SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`EMBEDDING_PROVIDER=openai`, `NEXT_PUBLIC_SITE_URL`.

## 7. 사용자 / 관리자 계정 만들기
1. Authentication → Users → **Add user** (이메일로 초대) 또는 본인 이메일로 로그인 1회
   → `handle_new_user` 트리거가 `profiles` 행을 자동 생성합니다.
2. 관리자로 승격 (SQL Editor):
   ```sql
   update profiles set role = 'admin' where email = 'admin@jbfire.go.kr';
   ```

## 8. 자료 인덱싱 (RAG 두뇌 채우기)
실제 PDF를 `docs/` 에 넣고 인덱서를 돌립니다. (자세한 내용 `indexing/README.md`)
```bash
# 예: docs/산악/로프구조.pdf 처럼 카테고리 폴더에 배치
cd indexing
pip install -r requirements.txt
python embed_and_upload.py
```
> 웹앱과 인덱서는 **같은 임베딩 설정(EMBEDDING_PROVIDER/모델/1024차원)** 을 써야 합니다.

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
- `/quiz/[분야]` **AI 자동 출제** 이수 퀴즈(자료 근거 5문항, 60% 합격 → 이수)
- 과정/레슨은 **인덱싱된 자료로 자동 생성**됩니다. 자료를 카테고리 폴더로 넣으면 바로 과정이 생깁니다.
- 레슨 완료(`/api/progress`)·퀴즈 응시(`/api/quiz/*`)는 `lesson_progress`·`quiz_attempts` 에 저장,
  관리자 대시보드의 "학습 현황"에 집계됩니다.

> 퀴즈 정답/해설은 **AES-GCM 암호화 토큰**으로만 오가며(클라이언트에 평문 노출 없음),
> 제출 시 서버에서 토큰을 복호화해 **서버 채점** 후 기록합니다. 토큰 변조는 거부됩니다.
> (선택) `QUIZ_SECRET` 환경변수로 암호화 키를 지정하세요(미설정 시 service role 키로 대체).

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
- [ ] **PL-3** `/quiz/[분야]` 에서 AI가 자료 기반 5문항을 출제하고 채점·해설을 보여준다
- [ ] **PL-4** 60% 이상 합격 시 과정에 "퀴즈 합격/이수" 배지가 표시된다
- [ ] **PL-5** 관리자 대시보드에 "학습 현황"(레슨 완료·퀴즈 응시/합격률/평균) 이 집계된다

## 트러블슈팅
- **답변이 안 나옴**: `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` 확인. 콘솔 로그 `[chat]` 참고.
- **출처가 비어 있음**: 자료 인덱싱이 안 됐거나 임베딩 설정 불일치. `chunks` 테이블 행 수 확인.
- **로그인 링크 클릭 후 오류**: Supabase Redirect URLs 에 `/auth/callback` 등록 여부 확인.
- **PDF가 안 열림**: `documents` 버킷 Public 여부, `documents.file_url` 값 확인.
- **임베딩 차원 오류**: 스키마 `vector(1024)` 와 모델 차원(1024) 일치 여부 확인.
