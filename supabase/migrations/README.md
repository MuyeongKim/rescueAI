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
