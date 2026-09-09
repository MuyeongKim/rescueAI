# supabase/migrations — DB 스키마의 단일 출처

## 규칙

1. **스키마 변경은 반드시 여기에 새 파일로 추가한다.** 이미 적용된 파일은 고치지 않는다
   (원격 DB 에는 이미 실행돼 있어 수정해도 반영되지 않고, 새 프로젝트와만 어긋난다).
2. **파일명은 `YYYYMMDDHHMMSS_설명.sql`** (Supabase CLI 표준).
   `0001_`~`0012_` 는 규칙 도입 전의 레거시라 이름을 바꾸지 않는다. 정렬 순서상 항상 먼저 온다.
3. **재실행 안전하게 쓴다** — `create ... if not exists`, `create or replace`,
   `drop policy if exists` 로 감싼다.
4. 마이그레이션을 추가/수정했으면 **`npm run sql:setup` 을 실행**해
   `supabase/setup_new_project.sql` 을 다시 만든다.

## setup_new_project.sql 은 손대지 않는다

새 Supabase 프로젝트 부트스트랩용 통합 SQL 은 이 폴더에서 **자동 생성**된다
(`scripts/build-setup-sql.mjs`). 예전에는 손으로 관리하다 마이그레이션과 어긋나
`generated_materials`·`popular_questions`·생성물 공유 컬럼이 빠지고, 이미 삭제한
`quiz_attempts` 는 남아 있었다 — 그 파일로 새 프로젝트를 세우면 AI 자료제작 저장·공유·
인기질문이 통째로 죽는 상태였다. 다시 그렇게 되지 않도록 생성물로 바꿨다.

## 적용 방법

- **기존 프로젝트**: 새로 추가된 마이그레이션 파일만 Supabase SQL Editor 에서 순서대로 실행.
- **새 프로젝트**: `supabase/setup_new_project.sql` 전체를 한 번에 실행.

## DB 런타임 테스트

`supabase/tests/generated_materials_sharing_rls_test.sql`은 공유 RLS·트리거·함수 권한을 실제
PostgreSQL에서 확인하는 61개 pgTAP 검사입니다. 현재 저장소에는 로컬 프로젝트 설정인
`supabase/config.toml`이 없으므로 Docker 기반 pgTAP을 기본 `npm test`에 포함하거나 동작하지
않는 `test:db` 스크립트로 감싸지 않습니다. `npm test`는 PGlite로 후속 마이그레이션의 실행과
공유 무효화를 확인하지만, Supabase 고유 `auth`·RLS 계약은 아래처럼 로컬 설정을 만든 환경에서
별도로 실행해야 합니다.

```bash
supabase init       # 최초 한 번: supabase/config.toml 생성
supabase start      # Docker 필요
supabase test db supabase/tests/generated_materials_sharing_rls_test.sql --local
```

## 목록

| 파일 | 내용 |
| --- | --- |
| `0001_init.sql` | 확장 + 기본 테이블(profiles·documents·chunks·conversations·messages) |
| `0002_hybrid_search.sql` | 하이브리드 검색 RPC (※ 거리 연산자는 20260808 에서 수정) |
| `0003_triggers_rls.sql` | 가입 트리거 + RLS 기본 정책 |
| `0004_learning.sql` | 학습 진도·퀴즈 (기능 제거됨, 이력 보존용) |
| `0005_platform.sql` | 공지 + 체력 마일리지 + 리더보드 RPC |
| `0006_remove_quiz.sql` | 퀴즈 제거 |
| `0007_profile_fields.sql` | 직원 필드(계급·팀·디지털식별번호) + 비번변경 강제 플래그 |
| `0008_news.sql` | 구조 동향(뉴스) |
| `0009_generated_materials.sql` | AI 자료제작 생성물 저장 |
| `0010_lock_profile_role.sql` | `profiles.role` 자가 승격 차단 트리거 |
| `0011_popular_questions.sql` | 인기 질문 집계 RPC |
| `0012_share_materials.sql` | 생성물 공유(shared·author_name) |
| `20260726100515_secure_versioned_rag_ingestion.sql` | 외부 RAG(rag_rescue) 보안·무중단 버전 적재 |
| `20260808090000_fix_hybrid_search_and_cleanup.sql` | hybrid_search 코사인(`<=>`) 통일 + hnsw 인덱스, `lesson_progress` 삭제 |
| `20260808091000_admin_dashboard_stats.sql` | 관리자 대시보드 집계 RPC(앱 메모리 집계 → DB 이관) |
| `20260827131016_remove_retired_mileage_stats.sql` | 제거된 체력 기능을 관리자 통계 집계에서 제외(기존 기록 보존) |
| `20260828032304_add_rag_corpus_release_switch.sql` | 임베딩 제공자 변경용 전체 코퍼스 원자 전환·롤백 릴리스 |
| `20260828115838_allow_authenticated_document_downloads.sql` | 비공개 원본 PDF 버킷 생성 + 인증 사용자 읽기 정책 |
| `20260829052407_protect_generated_material_sharing.sql` | 생성물 공유 SOP 계약 DB 트리거 + 소유자 RLS 작업별 분리 |
| `20260829140500_classify_rag_procedure_sources.sql` | 공식 SOP·현장지침 문서 유형 백필·페이지 제목+본문 통합 검색 인덱스 |
| `20260829160624_allow_common_sop_generation_evidence.sql` | 현장지휘·공통 SOP의 교차 분야 생성·저장·공유 검증 허용(공통 일반자료 차단) |
| `20260829163049_protect_generated_material_quality_and_revision.sql` | 생성물 핵심 품질 DB 강제 + 공동계정 재편집 충돌 방지 revision |
| `20260902021457_add_login_access_counter.sql` | 로그인 후 KST 일일 고유 접속 집계 + 공개 숫자 전용 최소 권한 RPC |
| `20260902094825_durable_generation_jobs.sql` | 장시간 정밀 자료제작 작업 원장 + 저장 지점·품질 게이트·소유자 공개 조회 RLS |
| `20260904222054_improve_tutor_recovery.sql` | 튜터 검색 장애 상태 보존 + 요청 UUID 중복 방지 |
| `20260904222055_private_generation_drafts.sql` | 개인 편집 초안 자동보관 + 소유자 RLS·CAS·분량 제한 |
| `20260905124809_rank_rag_keyword_candidates.sql` | 활성·분야 범위에서 관련성 정렬 후 후보 수를 제한하는 키워드 검색 RPC |
| `20260905140458_align_generated_document_endnote_evidence.sql` | 문서 말미 출처와 DB 핵심 품질·SOP 검사 정렬, 기존 원본 검증과 슬라이드 같은 장 출처 보호 유지 |

| `20260906010516_generation_job_review_controls.sql` | 목차 검토·취소 상태와 소유자 전용 검토 초안·품질 문제 공개 projection |
| `20260906010707_align_edited_slide_count.sql` | 편집 PPT 6~20장 허용, 시간별 권장 장수와 공식 저장 제한 분리 |
| `20260908042754_close_public_rpc_leaks_and_limit_private_drafts.sql` | 인기 질문 본인 한정·폐기 RPC 차단·초안 개수와 총 용량 DB 강제 |
| `20260908042842_enforce_password_change_completion.sql` | 초기 비밀번호 플래그 직접 변경 차단(아래 후속 파일까지 함께 적용) |
| `20260908042907_distributed_ai_usage_budget.sql` | 계정·기능별 분당 및 계정·전체 일일 AI 가중 요청량 원자 제한 |
| `20260908043547_harden_legacy_function_permissions.sql` | 기존 함수 검색 경로 고정·트리거 직접 실행 권한 회수 |
| `20260908043629_use_verified_auth_password_completion.sql` | Auth 내부 해시 변경 트리거 제거·서버가 실제 비밀번호 변경 성공 후 완료 기록 |
| `20260909112954_require_ready_accounts_for_data_access.sql` | 신규 발급 준비 상태·현재 Auth 계정 검사·공용/개인 RLS와 Storage 접근 제한·관리자 예외의 TOTP/AAL2 |

### 2026-09-09 계정·관리자 경계 적용

이전 마이그레이션들을 적용한 뒤 `20260909112954_require_ready_accounts_for_data_access.sql`을
**앱 배포와 새 계정 발급 전에** 실행합니다. `npm run sql:setup`으로 생성한 통합 SQL은 새 DB용이며,
기존 DB에 통째로 다시 적용하는 대신 새 파일만 적용합니다. 적용 이력과 실제 조회 결과를 별도로
확인해야 하며 문서나 통합 SQL 생성 자체가 운영 적용 완료를 의미하지 않습니다.

- 기존 프로필에는 `account_ready=true`를 추가하고 기존 비밀번호·변경 필요 상태·세션·자료를
  보존합니다. 이후 새 프로필은 `account_ready=false`, `must_change_password=true`로 생성합니다.
  Auth 사용자 메타데이터는 발급 준비 상태·역할·비밀번호 완료의 근거로 사용하지 않습니다.
- `access_private.is_registered_account()`는 현재 Auth 존재·삭제/차단 상태와 발급 완료를 확인합니다.
  `is_active_account()`는 비밀번호 변경 완료도 확인합니다. helper는 인자 없는 비공개 스키마의
  함수이며 Auth 테이블 내용을 클라이언트에 공개하지 않습니다.
- 공용 자료·개인 데이터 12개 테이블과 Storage의 제한적 정책은 기존 허용 조건과 AND로 결합합니다.
  본인/공유/활성 자료 범위를 넓히지 않으며, service role의 적재·worker 권한은 유지합니다.
  본인 프로필은 초기 비밀번호 변경에 필요한 범위에서 읽을 수 있습니다. 발급 미완료 계정은
  비밀번호 변경 API로도 준비 상태를 해제할 수 없습니다.
- 관리자 타인 메시지/과거 운동기록 조회와 관리 AI 예산에는 `is_verified_admin()`이
  관리자 역할·현재 검증된 TOTP·JWT AAL2를 함께 확인합니다. 일반 기능과 일반 AI 사용에는
  관리자도 AAL1을 유지할 수 있습니다. 앱 가드와 `/admin-mfa` 등록 화면을 함께 배포합니다.
- 공개 접속 통계 조회는 유지하며, 접속 기록과 AI 예산의 SECURITY DEFINER 경로는 같은
  계정 상태 검사를 다시 수행합니다. 단순 RLS 추가만으로 definer 함수가 보호된다고 간주하지 않습니다.

적용 전 `auth.users.deleted_at/banned_until`과 `auth.mfa_factors.user_id/status/factor_type`가 있는지
확인합니다. 새 계정은 CSV 발급 완료 또는 신규 계정만 대상으로 한 관리자 설정 후에 이용할 수 있습니다.
수동 최초 관리자 생성·비밀번호 파일 0600 보관·MFA 등록/분실 복구는 [`SETUP.md`](../../SETUP.md)를
따릅니다. 정상 합성 계정에는 `account_ready=true`와 비밀번호 변경 완료를 설정해 검증합니다.

`tests/account-access-migration.test.ts`는 실제 PostgreSQL(PGlite)에서 반복 적용·기존 계정/세션
보존, 채워진 공용/개인 테이블·Storage·키워드 검색의 차단, 신규 발급, 관리자 MFA 예외와 서비스
역할 유지를 검사합니다. `tests/import-users.test.ts`는 발급 실패·삭제 실패·파일 저장 실패와
무작위 비밀번호·기존 계정 유지·0600/덮어쓰기 차단을 검사합니다. 실제 Supabase의 서명 JWT·
MFA 등록과 HTTPS Storage 동작은 대상 환경의 합성 계정으로 추가 확인해야 합니다.

SQL 외 운영 설정은 별도로 관리합니다. SSL 강제·직접 PostgreSQL/pooler 허용 IP 제한은
HTTPS Data API·Auth·Storage에 적용되지 않습니다. 개발 DB는 별도 생성 후 같은 스키마와 합성
데이터를 준비하고, 원격 ref를 `config/database-environments.json`에 등록해야 합니다.

2026-09-08 보안 보완은 `20260908`로 시작하는 위 5개 파일을 앱 배포 전에 순서대로 적용합니다. 비밀번호 관련 첫 파일만
적용하고 중단하지 않습니다. Auth는 일반 로그인 중에도 내부 해시를 갱신할 수 있으므로, 마지막
파일이 자동 해제 트리거를 제거하고 새 비밀번호 변경 API만 완료 플래그를 기록하도록 합니다.
이전 적용 파일은 수정하지 않습니다. 기존 계정·세션·대화·자료는 보존하며, 초안 기존 초과분은
삭제하지 않고 용량이 줄어드는 정리 작업을 허용합니다. 사용 한도는 `security_private.ai_budget_settings`와
`ai_usage_policy`에서 DB 관리자가 조정하며 다시 적용해도 기존 설정을 덮어쓰지 않습니다.
신규 가입 차단은 SQL과 별도로 Supabase Auth 설정에서 적용합니다.

2026-09-06 자료제작 개선은 위 두 마이그레이션을 앱 배포 전에 순서대로 적용합니다.
기존 작업·생성물은 수정하지 않으며 checkpoint와 run_token의 비공개, 소유자 조회 RLS,
서비스 역할의 작업 변경, 미통과 결과의 result 차단을 유지합니다. PGlite에서는 반복 적용,
역할별 조회·쓰기·함수 실행 차단, 취소 뒤 오래된 worker 갱신 차단, 편집 PPT 장수 경계와
같은 장 SOP 출처·비활성 원본·개정 번호 보호를 검증합니다.

2026-09-05 튜터·자료제작 개선을 배포하기 전에는 위 두 후속 마이그레이션을 순서대로 적용합니다.
기존 메시지는 장애 여부를 소급 판정하지 않고 `retrieval_degraded=false`로 초기화됩니다.
초안은 공식 생성물과 별도이며, `snapshot`은 미완성 편집을 허용합니다. 공식 저장·공유의 품질 검사는
계속 `generated_materials` 계약과 서버 API에서 수행합니다. 메시지 중복·소유권과 초안의 RLS·CAS·
불변 식별자는 PGlite 회귀검사에 포함됩니다. 두 마이그레이션은 2026-09-05 운영 Supabase에
순서대로 적용했으며, 기존 데이터 보존·신규 컬럼·초안 RLS·역할별 권한을 확인했습니다.

키워드 검색 정렬 변경은 앱 배포 전에 `20260905124809_rank_rag_keyword_candidates.sql`을
적용합니다. `search_rag_rescue_keywords(query_text, match_count, filter)`는 기존 활성 본문 GIN
인덱스로 검색한 뒤 `ts_rank_cd DESC, id ASC`로 정렬하고 최대 100개를 반환합니다. 앱의 기존
검색별 후보 수·동시 요청 상한은 유지합니다. 이 함수는 `SECURITY INVOKER`이며 익명 실행을
차단하고 인증 사용자·서비스 역할에만 실행을 허용합니다. 원본·벡터·기존 검색 RPC는 변경하지
않습니다. 2026-09-05 운영 DB 적용 후 실행 권한, 활성 자료 수 보존과 실제 검색을 확인했습니다.
`tests/rag-keyword-search-migration.test.ts`는 LIMIT 밖에 있던 최고 관련 후보의 회수와 분야·RLS·
입력 경계를 실제 PostgreSQL(PGlite)에서 검증합니다.

문서 말미 출처 방식의 훈련계획·교안 저장에는
`20260905140458_align_generated_document_endnote_evidence.sql`이 필요합니다. 기존 앱의
본문 인라인 출처 제거 방식과 DB 검사의 기준을 맞추는 후속 변경입니다. 두 검증 함수만
재정의하며 데이터·RLS·트리거·revision은 변경하지 않습니다. 검증 함수는 계속 서버 트리거에서만
호출하며 공개·익명·인증 사용자의 직접 실행을 허용하지 않습니다. 실제 출처와 SOP 번호·명칭,
분야·시간·안전·평가 검사와 슬라이드의 같은 장 출처 연결은 유지합니다.
2026-09-05 운영 적용 전후 기존 저장물 9개·공유 상태와 활성 RAG 20,938개 보존, 함수 직접 실행
차단을 확인했습니다. 적용 뒤 동일한 생성 결과를 브라우저에서 다시 저장해 성공했으며,
`tests/generated-document-endnote-migration.test.ts`에서 실제 PostgreSQL 함수로 저장·거절 경계와
반복 적용·revision·역할별 실행 차단을 검증합니다.
