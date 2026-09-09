# SETUP.md — 설치 · 실행 · 배포 가이드

전북소방 구조 AI 챗봇을 처음부터 띄우는 순서입니다. `PRD.md`(명세), `CLAUDE.md`(규칙)와 함께 보세요.

> 순서: **운영·개발 DB 구분 → 스키마 적용 → 환경변수 → 계정 발급 → 관리자 MFA → 자료 인덱싱 → 실행·검증·배포.**

---

## 0. 준비물
- Node.js 20.19 이상, npm
- Python 3.11 (인덱서)
- Supabase 계정, 선택한 LLM API 키, 임베딩 API 키(기본 Google Gemini)

## 1. 의존성 설치
```bash
npm install
```

## 2. Supabase 프로젝트 생성
1. https://supabase.com → New project에서 목적에 맞는 리전을 선택합니다. 국내 배치가 필요하면
   **Seoul(ap-northeast-2)** 사용 가능 여부를 확인합니다. 기존 프로젝트의 실제 리전을 추정하지 않습니다.
2. Project Settings → API 에서 다음을 복사:
   - `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon public` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` → `SUPABASE_SERVICE_ROLE_KEY` (서버 전용, 절대 노출 금지)
3. 개발은 **별도 클라우드 프로젝트 또는 로컬 Supabase**를 사용합니다. 원격 개발 프로젝트의
   ref를 `config/database-environments.json`의 `developmentProjectRefs`에 등록하고 운영 ref와
   중복시키지 않습니다. 로컬 주소는 localhost/127.0.0.1/::1을 사용합니다.
4. 현재 개발 목록은 비어 있습니다. 로컬/클라우드 선택과 DB 생성이 필요한 준비 상태이며,
   개발 DB가 마련되지 않은 상태에서 운영 DB로 대신 실행하지 않습니다. 새 DB에는 같은 스키마와
   합성 계정·합성 자료를 넣고 실제 대화·직원정보·민감 원문을 그대로 복사하지 않습니다.

## 3. DB 스키마 적용
- **새 프로젝트**: Supabase 대시보드 → SQL Editor에서
  `supabase/setup_new_project.sql` 전체를 한 번에 실행합니다.
- **기존 프로젝트**: `supabase/migrations/README.md`를 기준으로 아직 적용하지 않은
  마이그레이션만 파일명 순서대로 실행합니다.

AI 자료제작 품질·공동계정 편집 보호를 적용하려면
`20260829160624_allow_common_sop_generation_evidence.sql` 다음에
`20260829163049_protect_generated_material_quality_and_revision.sql`을 실행해야 합니다.
후자는 기존 저장본을 삭제하지 않고 `revision=1`을 부여하며, 이후 같은 저장본의 오래된
편집 화면이 최신 내용을 덮어쓰지 못하게 합니다.

장시간 정밀 생성을 화면 요청과 분리하려면 이어서
`20260902094825_durable_generation_jobs.sql`을 적용해야 합니다. 이 마이그레이션은 사용자별
작업 원장, 단계 저장 지점, 품질 게이트와 RLS를 추가하며 기존 생성물은 변경하거나 삭제하지 않습니다.

계정 상태·관리자 추가 인증 보완 앱을 배포하기 전에
`20260909112954_require_ready_accounts_for_data_access.sql`을 적용합니다. 기존 계정의
비밀번호·세션·자료를 보존하면서 `account_ready=true`를 부여하고, 신규 계정은 기본
`account_ready=false`, `must_change_password=true`로 생성합니다. 초기 비밀번호 변경은
관리자 발급 완료 후에만 가능합니다. 파일 실행 순서와 DB 검사 범위는
[`supabase/migrations/README.md`](supabase/migrations/README.md)를 참고하세요.

> Supabase CLI가 있으면 `supabase db push` 로도 적용 가능합니다.

## 4. Storage 버킷 생성 (원본 PDF 뷰어용)
- 최신 통합 SQL 또는 `20260828115838_allow_authenticated_document_downloads.sql`이
  `documents` 비공개 버킷과 인증 사용자 읽기 정책을 자동 구성합니다.
- 웹앱은 로그인 세션과 RLS를 확인한 뒤 5분 유효 서명 URL을 발급해 원본을 열거나,
  필요한 페이지만 PPTX용 이미지로 변환합니다.

## 5. Auth 설정 (비밀번호·이메일 링크)
- Authentication → Providers → **Email** 활성화 (Confirm email/매직링크).
- Authentication → URL Configuration → **Redirect URLs** 에 추가:
  - `http://localhost:3000/auth/callback`
  - 배포 후: `https://<your-app>.vercel.app/auth/callback`
- 회원가입 폼은 없습니다. 사용자는 **관리자가 발급**합니다 (아래 7번).
- Authentication → Sign In / Providers에서 **Allow new users to sign up을 끕니다.**
  로그인 화면의 `shouldCreateUser: false`만으로 직접 Auth API 가입을 막을 수는 없습니다.
  Email 로그인과 Confirm email은 유지합니다. 이 설정은 기존 계정의 로그인·동시 세션을 끊지 않습니다.
- 동일 계정을 여러 기기·브라우저에서 함께 쓰는 시범운영이라면 Authentication → Sessions의
  **Single session per user**가 꺼져 있는지 확인합니다. 앱의 로그아웃은 현재 브라우저 세션만
  종료하지만, 이 Supabase 옵션이 켜져 있으면 최근 세션 외의 로그인은 토큰 갱신 때 종료됩니다.
  같은 브라우저의 탭들은 쿠키를 공유하므로 한 탭에서 로그아웃하면 함께 로그아웃됩니다.
- 같은 계정으로 사용하는 사람들은 대화·저장물·AI 요청 한도를 공유하며 개인별 접근 이력을
  구분할 수 없습니다. 자료제작의 기존 계정당 활성 작업 1개 제한도 공유합니다.
  비밀번호를 변경하는 보안 작업은 다른 기기의 재로그인이 필요할 수 있으므로 사용자끼리 조율합니다.
- 유출 비밀번호 차단은 Supabase Pro 이상 기능입니다. 무료 요금제에서는 자동 활성화하거나
  요금제를 변경하지 않습니다. 일반 사용자가 관리자 역할을 공유하는 방식은 사용하지 않습니다.

### DB 직접 접속과 HTTPS API 구분

Supabase Database → Settings에서 **SSL 강제**와 **Network restrictions**를 확인합니다.
웹앱·관리 도구가 HTTPS Data API/Auth/Storage만 사용한다면 외부 PostgreSQL·pooler 허용 IP를
비워 직접 접속을 차단하는 구성을 유지할 수 있습니다. 직접 DB 접속이 필요한 적재·백업·관리
도구가 추가되면 사용 주체·고정 송신 IP·TLS 호환성을 먼저 확인하고 필요한 범위만 허용합니다.

SSL 강제를 바꾸면 DB가 재시작될 수 있으므로 적용 시간과 연결 복구를 확인해야 합니다.
IP 제한은 HTTPS Data API·Auth·Storage에는 적용되지 않습니다. API 키·로그인·RLS는 별도로
유지하며, 외부 직접 접속을 막았다는 사실만으로 API 권한 점검을 생략하지 않습니다.
앱의 로그인·검색·저장·원본 다운로드와 실제 인덱서 연결을 각각 확인하세요.
[SSL 적용 범위](https://supabase.com/docs/guides/platform/ssl-enforcement),
[IP 제한 적용 범위](https://supabase.com/docs/guides/platform/network-restrictions).

### AI 요청량과 초안 보관량

앱 배포 전에 2026-09-08 보안 마이그레이션을 파일명 순서대로 적용합니다.
AI 요청은 세션의 실제 사용자 ID로 DB의 `consume_ai_budget`을 호출합니다. 확인 실패는
AI 실행을 503으로 중단하며 서버 메모리 제한으로 대체하지 않습니다. 여러 서버·공용 계정의 요청을
합산하되 로그인 세션이나 동시 접속 자체를 잠그지 않습니다.

기본 일일 한도는 계정 2,000단위·서비스 전체 4,000단위이며 한국시간 자정에 새로 시작합니다.
일반 채팅 1, 동기 전체 생성 20, 장시간 생성/재시도/재개 40 등 작업별 가중치를 사용합니다.
이는 과다 호출 방지 기준이며 실제 원화 과금이나 토큰 수의 정산·상한 보증이 아닙니다.
DB 운영자는 비공개 `security_private.ai_budget_settings`와 `ai_usage_policy`에서 값을 조정할 수 있습니다.
공용 계정에서 한도에 도달하면 누가 사용했든 같은 계정 사용자 모두에게 재시도 안내가 표시됩니다.

개인 초안은 계정당 미저장 200개·저장 완료 사본 200개, 합계 200MiB까지 보관합니다.
직접 Data API를 호출해도 DB에서 검사하며, 이전 데이터가 초과한 경우 삭제·축소는 허용합니다.
자료 만들기의 **저장 완료 초안 포함해서 보기**에서 이전 사본을 정리할 수 있습니다. 정리 안내는
새 창으로 열어 현재 편집 중인 내용을 유지합니다.

관리자 뉴스 수집은 같은 출처의 POST만 받습니다. Cron GET에는 `CRON_SECRET`이 필요하고
관리자 로그인 쿠키만으로는 실행되지 않습니다. Cron도 서비스 전체 AI 요청량에 포함됩니다.

## 6. 환경변수

웹앱의 로컬 개발·로컬 빌드에는 다음 파일을 사용합니다.

```bash
cp .env.development.local.example .env.development.local
# 별도 개발 DB와 개발용 API 키로 설정
```

`RESCUEAI_DATABASE_ENV=development`와 개발 DB URL·anon 키·service role 키를 함께 지정합니다.
원격 개발 DB의 ref 등록도 필요합니다. `npm run dev/build/start`는 `scripts/run-app.mjs`를 거쳐
운영/개발 목적을 검사합니다. 운영 URL·미등록 개발 프로젝트·누락된 개발 설정이면 Next.js를
시작하기 전에 중단합니다. 이 검사를 우회하는 별도 실행 명령을 만들지 않습니다.

운영 배포 변수와 서버 전용 인덱싱·발급 도구의 키 목록은 `.env.local.example`을 참고합니다.
기존 `.env.local`은 운영 도구에서 사용할 수 있으므로 내용을 개발 파일로 그대로 복사하지 않습니다.
개발용 발급은 `node --env-file=.env.development.local scripts/import-users.mjs <명단.csv>`처럼
대상을 명시합니다. `RESCUEAI_DATABASE_ENV=development`인 발급은 DB registry도 검사하며,
빠진 개발 키를 운영 `.env.local`에서 보충하지 않습니다. 인덱서도 실행 전 별도 개발 URL과
키를 확인해야 합니다.

필수: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, 선택한 LLM API 키, `EMBEDDING_PROVIDER`, 선택한 임베딩 API 키,
`NEXT_PUBLIC_SITE_URL`. 기본 Gemini 구성은 `EMBEDDING_PROVIDER=google`과
`GOOGLE_GENERATIVE_AI_API_KEY`를 사용합니다.

DB 없이 UI만 시연할 때는 `.env.development.local`의 `NEXT_PUBLIC_DEMO_MODE=1`,
`NEXT_PUBLIC_SUPABASE_URL=https://demo.supabase.co`를 지정하고 Supabase·외부 API 키를 비웁니다.
실제 Supabase URL이 연결된 환경에서는 데모 플래그만으로 인증이 열리지 않습니다.

## 7. 사용자 / 관리자 계정 만들기

신규 가입을 꺼 둔 상태에서 로그인만으로 계정을 만들 수 없습니다. 아래 두 경로 중 하나를 사용합니다.

### CSV 일괄 발급

CSV 열은 `email,full_name,division,rank,team,digital_id,role`이며 관리자 행만 `role=admin`으로
지정합니다. 운영용 발급은 대상 URL·키를 확인한 서버에서 실행하고, 개발 발급은 개발 환경 파일을
명시합니다.

```bash
node --env-file=.env.development.local scripts/import-users.mjs <명단.csv>
```

- 항상 무작위 20자 초기 비밀번호를 발급합니다. 직원 식별번호는 비밀번호로 사용하지 않습니다.
  `--random-password`는 과거 명령의 호환 옵션이며 붙이지 않아도 무작위입니다.
- Auth 생성 → 프로필 설정 → 비밀번호 파일 기록 후에만 `account_ready=true`가 됩니다.
  `must_change_password=true`는 첫 로그인에서 실제 비밀번호 변경을 마칠 때까지 유지합니다.
- 기존 계정은 재실행해도 비밀번호·프로필·권한을 변경하지 않습니다. 실패로 남은 신규 계정은
  상태를 점검해 정리한 뒤 재발급합니다. 기존 계정 갱신용 도구로 사용하지 않습니다.
- 비밀번호 파일은 `<명단.csv>.<시각>-<무작위>.passwords.csv`이며 0600으로 새로 생성합니다.
  `--password-file <출력.passwords.csv>`로 경로를 지정할 수 있고 기존 파일·심볼릭 링크는
  덮어쓰지 않습니다. Git에서도 제외합니다.
- 출력에 성공한 계정만 개별 전달하고 파일을 삭제합니다. 마지막 완료 단계가 실패하면 파일에
  실패 계정의 행이 남을 수 있습니다. SDK 오류 내용·비밀번호는 콘솔에 출력하지 않습니다.

### 최초 관리자 수동 발급

1. Supabase Authentication → Users에서 새 계정을 만들고 무작위 임시 비밀번호를 개별 전달합니다.
   `handle_new_user`는 준비 미완료 프로필을 자동 생성합니다.
2. 새로 만든 계정 UUID·이메일을 대조한 뒤, SQL Editor에서 **그 신규 행만** 준비 완료로 설정합니다.
   아래 UUID는 실제 신규 계정의 값으로 교체합니다. `service_role` 전환은 기존 역할 보호 트리거가
   의도된 관리자 설정을 허용하도록 하기 위한 것입니다.

   ```sql
   begin;
   set local role service_role;
   update public.profiles
   set role = 'admin', account_ready = true, must_change_password = true
   where id = '<새로 만든 계정 UUID>'::uuid
     and account_ready = false
   returning id, role, account_ready, must_change_password;
   commit;
   ```

3. 반환된 행이 정확히 한 개이고 설정이 맞는지 확인합니다. 기존 공용 계정을 대상으로 이 SQL을
   반복하거나 비밀번호 변경 요구를 소급 설정하지 않습니다.
4. 관리자가 첫 로그인에서 비밀번호를 바꾼 뒤 아래 추가 인증을 등록합니다.

### 관리자 인증 앱 등록과 분실 복구

Supabase Auth의 MFA 설정에서 App Authenticator(TOTP) 등록·검증이 활성화되어 있는지 먼저
확인합니다. 앱은 관리자만 추가 인증을 요구하며 일반 계정에 전체 MFA 강제를 설정하지 않습니다.
[Supabase MFA 설정과 인증 수준](https://supabase.com/docs/guides/auth/auth-mfa).

1. 관리자 계정으로 `/admin-mfa`를 엽니다. 이름을 입력하고 **등록 시작하기**를 누릅니다.
2. 인증 앱으로 QR을 스캔하거나 직접 입력 키를 등록하고 현재 6자리 번호를 입력합니다.
3. **관리자 화면으로 이동**으로 진입합니다. 새 로그인 세션에서 추가 인증이 필요하면 같은
   화면에서 인증합니다. 일반 홈·AI 튜터·자료제작은 추가 인증 전에 계속 이용할 수 있습니다.
4. 추가 인증을 마친 세션에서 별도 기기에 **예비 인증 앱**을 등록합니다. 기본용과 예비용
   검증 완료 수단은 2개까지 등록할 수 있습니다. QR·비밀키를 메시지나 로그에 남기지 않습니다.

등록 화면을 닫아 QR을 잃었다면 **미완료 등록**을 취소하고 다시 시작합니다. 검증 완료된 인증
수단은 이 화면에서 삭제할 수 없습니다. 주 기기를 잃으면 예비 인증 앱을 선택해 인증합니다.

두 기기 모두 사용할 수 없으면 서비스 운영 담당자가 별도 연락 경로로 본인 확인 후 해당 계정의
인증 수단을 초기화합니다. Supabase 관리 콘솔 또는 서버 전용 Auth Admin MFA API에서 **그 계정의
분실 수단만** 처리하고, 세션 무효화·비밀번호 재설정 필요 여부도 확인합니다. 이후 새 수단을
등록하고 관리 화면/API 접근을 재검증합니다. 앱의 MFA 가드를 끄거나 공용 일반 계정에 관리자
권한을 주는 방법으로 복구하지 않습니다. 이 앱은 자체 복구 코드를 발급하지 않습니다.

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
npm run build      # 로컬 빌드는 등록된 개발 DB/명시적 데모 설정 필요
npm run lint       # ESLint
npx tsc --noEmit   # 타입만 체크
```

프로젝트는 AI SDK v5와 `@ai-sdk/react`·제공자 패키지 v2를 사용합니다. 스트림 형식 변경 시
질문 전송·후속 질문·중단·출처 및 검색 장애 표시·DB 재열람을 함께 확인합니다. 구조화 자료 생성의
재시도·완료·저장·다운로드도 별도로 검증하며, 빌드 통과만으로 외부 모델 동작을 확인했다고 보지 않습니다.

## 10. Vercel 배포
1. GitHub에 푸시 → Vercel에서 Import.
2. Environment Variables의 **Production**에 운영 DB URL·키와 필요한 서버 키만 등록합니다.
   Preview에는 운영 키를 복사하지 말고 별도 개발 DB·개발용 키 및
   `RESCUEAI_DATABASE_ENV=development`를 지정합니다. 각 프로젝트 ref가
   `config/database-environments.json`의 해당 목록과 일치해야 합니다.
3. `NEXT_PUBLIC_SITE_URL` 을 배포 도메인으로, Supabase Redirect URLs 에 콜백 추가.
4. Vercel 프로젝트에서 **Fluid Compute를 활성화**하고 Function 최대 실행 시간이 최소
   **300초**인지 확인합니다. 정밀 모델 한 단계는 최대 235초를 쓰며, 이보다 짧은 프로젝트
   한도에서는 Workflow가 체크포인트를 저장하기 전에 종료될 수 있습니다.
5. Deploy. `workflow` 패키지와 `withWorkflow()`가 내부 실행 경로를 함께 빌드하므로 별도
   Workflow 비밀키를 브라우저 환경변수로 추가하지 않습니다. `/.well-known/workflow/` 내부 경로를
   로그인 리다이렉트로 막으면 단계 재개가 끊기므로 현재 미들웨어 예외를 유지합니다.
6. 배포 뒤 인증 사용자로 자료 생성 → 실행 ID 확인 → 화면 종료·재접속 → 완료 → 파일 다운로드를
   한 번 수행해 Workflow와 `generation_jobs`가 함께 동작하는지 확인합니다.
7. 최초 비밀번호 미변경·발급 미완료·프로필 삭제·Auth 삭제 후 토큰으로 공용/개인 자료를 직접
   조회해 차단되는지 확인합니다. 관리자 AAL1의 관리 접근 차단, TOTP 인증 뒤 허용, 공용 일반
   계정 두 브라우저의 동시 로그인·한쪽 로그아웃도 함께 검증합니다. 합성 계정·자료를 사용하고
   검증 후 정리합니다. 이 가이드만으로 특정 배포의 적용 완료나 보안 인증을 주장하지 않습니다.

## 11. 운영(공공클라우드) 이전 메모
- 코드는 그대로 두고 **환경변수(URL·키)만 교체**하면 됩니다 (PRD §14).
- Supabase는 셀프호스팅 또는 국내 PostgreSQL+pgvector로 이전 가능.
- 임베딩을 BGE-M3로 바꾸려면: `EMBEDDING_PROVIDER=bge`, `indexing/serve.py` 기동,
  `EMBEDDING_API_URL` 설정, 자료 재인덱싱(차원/모델 동일하게).

---

## 교육훈련 플랫폼 (PRD 확장)
챗봇을 **AI 튜터**로 포함하는 구조 교육훈련 플랫폼 PoC입니다.
- `/home`에는 공지·최근 대화·구조 동향과 주요 기능 이동을 표시합니다.
- 과정·레슨·진도·이수 기능은 제거됐고 `lesson_progress`도 후속 마이그레이션에서 삭제합니다.
  이전 PRD의 해당 기능을 새 환경에 다시 구성하거나 공개 API를 추가하지 않습니다.

## AI 자료제작 (`/generate`) — 훈련계획·교안·슬라이드

"막막한 빈 화면" 없이 **클릭 몇 번으로** 훈련계획과 교육자료를 만드는 화면입니다.
인덱싱된 교육자료(벡터DB)를 근거로 생성하므로, **자료 인덱싱(§8)이 선행**되어야 합니다.

### 사용 방법
1. 사이드바(또는 모바일 탭바) **AI 자료제작** 클릭
2. **생성할 자료** 선택 — 3종:
   - **훈련계획**: 개요(대상·시간·장소·목표) → 준비물·안전조치 → 단계별 진행(시간 배분) → 평가·강평
   - **교육자료(교안)**: 학습 목표 → 도입 → 본문(시범·실습 포인트) → 정리·평가
   - **슬라이드(PPTX)**: 슬라이드 10~20장(제목+핵심문장+**발표자 노트**)을 생성하고
     분야 색 표준 양식 PPTX로 다운로드
3. **분야 / 대상 / 교육 시간**을 선택하고 **주제** 입력
   - `공기호흡기 착용 방법`처럼 구체적인 주제는 바로 생성
   - `산악사고 대비 훈련`처럼 범위가 넓은 주제는 교범 근거와 최근 본인 저장 자료를 바탕으로
     겹침이 적은 세부 훈련 방향을 먼저 제안 → 하나를 선택하거나 직접 입력
   - 훈련계획은 필요할 때만 **훈련 일자·장소** 입력
   - 인원·교관·보유 장비·훈련 환경이 정해졌다면 **현장 조건** 한 칸에 입력
   - 생성 모델·훈련 형태·훈련 방법은 시스템이 목적에 맞게 자동 적용
4. **생성** → 실제 단계·진행률·경과시간·예상 완료 확인 → SOP·표준절차 적용 내용과 근거 상태 확인 → 미리보기 확인 →
   **워드(docx)/PPTX 다운로드** 또는 텍스트 복사

훈련계획·교안·슬라이드는 서버 작업으로 생성됩니다. Workflow 실행 연결이 확인된 뒤에는 화면을 닫아도 계속 진행되며 생성 뒤 주소의
`?j=<작업번호>`를 다시 열면 이어서 확인할 수 있습니다. 예상 완료 시각은 단계 수를 바탕으로 한
안내값이며 마감시간이 아닙니다. 모델 지연이 있어도 저장된 단계에서 자동 재시도하고, 반복 실패나
품질 미통과 시에는 같은 화면의 **저장된 작업 다시 시도**로 이어갑니다.

모든 자료 유형에 SOP 확인이 적용됩니다. `rag7.py`에서 같은 분야의 자료를
`표준작전절차(SOP)` 또는 `현장활동 지침·매뉴얼`로 분류했고 관련 근거가 검색되면 출처와 적용
내용을 표시합니다. 근거를 찾지 못했거나 검색 상태를 확인할 수 없으면 담당자가 시행 전 최신
SOP를 확인해야 한다고 명시하며, 모델이 SOP 번호나 절차를 추정하지 않습니다. 이 필수 내용이
누락되거나 근거 상태가 서버 재검증 결과와 다르면 저장·공유·복사·파일 다운로드가 차단됩니다.
`20260829052407_protect_generated_material_sharing.sql`은 공유 계약을,
`20260829163049_protect_generated_material_quality_and_revision.sql`은 필수 구성·시간·안전·평가·
출처의 핵심 품질을 DB 트리거에서도 강제해 Data API 직접 호출 우회를 막습니다. 후자는 저장본에
개정 번호도 부여해 같은 일반 계정을 여러 명이 사용하더라도 오래 열린 편집 화면이 최신 저장본을
조용히 덮어쓰지 못하게 합니다. 적용 과정에서 기존 자료 본문은 삭제하지 않으며, 이전 공식 공유본은
재검증 전 비공개로 전환되므로 필요한 자료는 다시 생성·저장한 뒤 공유해 주세요.

### 동작에 필요한 것 (유형별)
| 유형 | 설정한 LLM의 API 키 | 인덱싱 자료(Supabase) |
|---|---|---|
| 훈련계획 / 교안 / 슬라이드 | **필요** (생성 시) | **필요** (근거 컨텍스트) |
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
- [ ] **AC-9** 일반 계정의 관리 접근 차단, 관리자는 추가 인증 뒤에만 통계·관리 API 허용
- [ ] **AC-10** 모바일/PC 레이아웃 정상
- [ ] **AC-11** 평가셋 50문항 정확도 60% 이상 (`eval/` 참고)

### 플랫폼 추가 점검
- [ ] **PL-1** 로그인 후 `/home`에 공지·최근 대화·주요 기능 이동이 보인다
- [ ] **PL-2** 초기 비밀번호 미변경·발급 미완료 계정의 자료/API 접근이 차단된다
- [ ] **PL-3** 삭제된 계정의 아직 유효한 토큰으로 공용 자료를 직접 조회해도 차단된다
- [ ] **PL-4** `/generate` 에서 훈련계획·교안이 자료 근거(출처 표시)로 생성되고 docx로 받아진다
- [ ] **PL-5** `/generate` 슬라이드 생성 → 발표형/상세형·분야 색·발표자 노트·검증된 원문
  시각자료가 반영된 PPTX가 받아진다
- [ ] **PL-6** 슬라이드 미리보기에서 레이아웃·순서를 조정한 뒤 PPTX에 반영된다
- [ ] **PL-7** 관리자 TOTP 등록·새 세션 추가 인증·예비 앱 인증이 동작한다
- [ ] **PL-8** 넓은 주제는 세부 훈련 방향을 선택할 수 있고, 구체적인 주제는 추가 단계 없이 생성된다
- [ ] **PL-9** 훈련계획·교안·슬라이드 모두 SOP 근거 있음/없음/검색 장애 상태를 구분하며,
  근거가 없을 때 SOP 번호나 절차를 만들어내지 않는다
- [ ] **PL-10** 같은 계정으로 두 브라우저에 로그인해 한쪽 로그아웃이 다른 브라우저를 끊지 않고,
  동시 생성은 하나의 진행 작업으로 합쳐지며, 오래된 화면의 수정·삭제는 409로 최신본을 보존한다

## 트러블슈팅
- **개발 DB 설정 오류로 실행 중단**: `.env.development.local`의 개발 URL·키·환경 구분,
  원격 ref의 `developmentProjectRefs` 등록을 확인합니다. 운영 ref를 개발 목록에 추가해 우회하지 않습니다.
- **신규 계정의 등록 정보를 확인할 수 없음**: 관리자가 `account_ready`와 Auth 생성·차단 상태를
  확인합니다. 일괄 발급 실패를 기존 계정 갱신으로 해결하려 하지 않습니다.
- **관리자 화면 대신 추가 인증으로 이동**: `/admin-mfa`에서 인증 앱 등록 또는 6자리 추가 인증을
  마칩니다. 두 인증 기기를 잃었으면 위 분실 복구 절차를 따릅니다.
- **답변이 안 나옴**: `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` 확인. 콘솔 로그 `[chat]` 참고.
- **출처가 비어 있음**: 자료 인덱싱이 안 됐거나 임베딩 계약 불일치. 운영 경로는
  `rag_rescue`의 활성 행과 `rag_embedding_config` 계약을 확인하세요. 레거시 경로만
  `chunks` 테이블 행 수를 확인합니다.
- **로그인 링크 클릭 후 오류**: Supabase Redirect URLs 에 `/auth/callback` 등록 여부 확인.
- **PDF가 안 열림**: 비공개 `documents` 버킷, 인증 사용자 Storage 읽기 정책,
  `documents.file_url` 경로를 확인합니다. 일반 열람·PPTX 생성에는 service role 키를 쓰지 않습니다.
- **임베딩 차원 오류**: 스키마 `vector(1024)` 와 모델 차원(1024) 일치 여부 확인.
