# indexing/ — 자료 인덱싱 파이프라인 (Python)

운영 경로는 프로젝트 루트의 `rag7.py`가 자료를 텍스트 추출 → 청크 → 임베딩한 뒤
Supabase `rag_rescue`에 비활성 스테이징하고 검증 후 활성화합니다. `embed_and_upload.py`는
별도 `documents`/`chunks` 스키마를 위한 레거시 OpenAI/BGE 배치 경로입니다. (PRD §10)

## 사전 준비
1. 루트 `.env.local` 에 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, 임베딩 키 설정
2. **웹앱과 동일한 임베딩 계약**을 사용할 것 (제공자/모델/차원 1024/버전)
3. Supabase Storage 에 **비공개** `documents` 버킷 생성 — 원본 PDF 뷰어용 `file_url` 저장

## 운영 `rag_rescue` 설치 & 실행

`20260726100515_secure_versioned_rag_ingestion.sql` 이후의 최신 마이그레이션을 먼저
적용한 뒤 프로젝트 루트에서 `rag7.py` GUI를 실행합니다.

```bash
cd indexing
python -m venv .venv && source .venv/bin/activate   # 선택
pip install -r requirements-rag7.txt
cd ..
python rag7.py
```

기본 임베딩 계약은 `google / gemini-embedding-001 / 1024 / google-retrieval-v1`입니다.
`rag7.py`는 페이지 번호와 임베딩 계약을 메타데이터에 기록하고, 신규 청크를 비활성
상태로 먼저 적재합니다. 모든 배치가 검증된 경우에만 RPC로 활성화하고 이전 파일 버전을
같은 트랜잭션에서 교체합니다. 기존 `rag_rescue` 행에 임베딩 계약이 없다면 접두사 규약이
불명확하므로 자동 혼합하지 않으며, 백업 후 테이블을 비우고 전체 재인덱싱해야 합니다.

### 레거시 `documents`/`chunks` 배치

`embed_and_upload.py`는 OpenAI/BGE만 지원하며 Google/Gemini 임베딩 계약이나
`rag_rescue` 릴리스 전환을 지원하지 않습니다. Gemini 코퍼스에 사용하지 마세요. 기존
`documents`/`chunks` 경로를 유지해야 하는 경우에만 아래처럼 실행합니다.

```bash
cd indexing
python -m venv .venv && source .venv/bin/activate   # 선택
pip install -r requirements.txt
python embed_and_upload.py                 # docs/ 전체 인덱싱
python embed_and_upload.py ../docs/foo.pdf # 특정 파일만
```

### 운영 코퍼스를 Gemini로 전체 전환

이미 활성 코퍼스가 있는 상태에서 제공자를 바꿀 때는 문서별 GUI 활성화를 사용하지 않습니다.
전환 도구가 임베딩과 원본을 먼저 복구 가능하게 백업하고, 15개 원본을 모두 비활성 상태로
스테이징한 다음 DB 계약과 전체 활성 코퍼스를 한 트랜잭션에서 바꿉니다. 이전 BGE 행은
시범운영 기간 동안 비활성 상태로 보존되어 같은 릴리스 RPC로 롤백할 수 있습니다.

```bash
cd indexing
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-rag7.txt

# 1. DB 전체 행·계약·documents와 Storage 원본을 백업하고 SHA-256 전건 검증
python migrate_rag_to_gemini.py backup

# 2. 출력된 백업 경로를 사용해 원본 전체를 Gemini로 비활성 스테이징(중단 후 재실행 가능)
python migrate_rag_to_gemini.py stage --backup ../.rag-migration/backups/<timestamp>

# 3. 20260828032304_add_rag_corpus_release_switch.sql 적용 후 전체 원자 전환
python migrate_rag_to_gemini.py cutover --backup ../.rag-migration/backups/<timestamp>

# 4. 계약과 전체/문서별 활성 행 수 재검증
python migrate_rag_to_gemini.py verify --backup ../.rag-migration/backups/<timestamp>

# 5. 시범운영 중 문제가 있으면 백업 시점의 기존 BGE 기준선으로 원자 롤백
python migrate_rag_to_gemini.py rollback --backup ../.rag-migration/backups/<timestamp>
```

백업·원본·릴리스 상태 파일은 `.rag-migration/`에 저장되며 Git에는 포함되지 않습니다.
`GOOGLE_GENERATIVE_AI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`는 `.env.local`에서만 읽고
산출물에는 기록하지 않습니다.

`cutover`는 상태 파일과 15개 원본 manifest를 먼저 검증한 다음 현재 DB 계약을 판별합니다.
현재 계약이 백업의 BGE 계약과 정확히 같을 때만 최초 릴리스 등록과 전환 RPC를 실행하며,
백업 또는 대상 Gemini 어느 쪽과도 다른 계약이거나 계약 행이 모호하면 DB를 변경하지 않고
중단합니다.

전환 RPC는 커밋됐지만 응답 수신 또는 로컬 `gemini_release.json` 기록 전에 연결이 끊길 수
있습니다. 같은 `cutover --backup ...` 명령을 재실행하면 현재 Gemini 계약, 전체·문서별 활성
행 수, `rag_corpus_releases`의 정확한 `release_id`와 `active` 상태를 다시 확인합니다. 모두
일치할 때는 릴리스 upsert나 전환 RPC를 반복하지 않고 검증 결과만 로컬 상태 파일에 복구합니다.
RPC의 `activated_count`는 이번 호출에서 새로 바뀐 행 수가 아니라 **전환 후 총 활성 행 수**이므로
항상 릴리스 `expected_rows`와 같아야 합니다.

`rollback`은 `backup_manifest.json`의 임베딩 제공자·모델·차원·버전과
`active_row_count`가 모두 정확히 같은 릴리스가 단 하나일 때만
`switch_rag_rescue_corpus` RPC를 호출합니다. 후보가 없거나 둘 이상이면 DB를 바꾸지 않고
중단합니다. RPC 커밋 뒤에도 활성 행 수, `rag_embedding_config` 계약, 기준선 릴리스의
`active` 상태를 다시 조회해 모두 백업과 같은지 검증합니다. 같은 백업 경로로 재실행해도
이미 활성화된 기준선을 다시 검증하므로, RPC 응답 확인이 불확실할 때도 임의의 다른 릴리스를
선택하지 않습니다.

#### PostgREST `57014 statement timeout` 복구

전체 코퍼스 전환은 대량 행을 한 트랜잭션에서 갱신하므로 PostgREST의 짧은 요청 제한을
넘길 수 있습니다. `57014 canceling statement due to statement timeout`은 성공이나 부분 성공으로
간주하지 않습니다. 도구는 현재 DB 계약을 다시 읽고, 대상 계약·활성 행 수·활성 릴리스가
모두 일치할 때만 성공 상태를 기록합니다. 기준선 계약이 유지되거나 전체 검증이 끝나지 않으면
로컬 상태를 임의로 `active`로 바꾸지 않고 중단합니다.

오류 메시지는 `gemini_release.json`의 Gemini release ID(`cutover`) 또는 백업 계약과 정확히
일치하는 유일한 기준선 release ID(`rollback`)를 아래 SQL에 실제 UUID로 넣어 출력합니다.
API 키나 service-role 키는 포함하지 않습니다. 메시지에 나온 SQL을 그대로 Supabase SQL
Editor에서 실행하세요. `120s` 설정은 해당 SQL Editor 실행에만 적용합니다.

```sql
set statement_timeout = '120s';
select * from public.switch_rag_rescue_corpus('<오류 메시지의 실제 release_id>'::uuid);
```

SQL이 `activated_count`를 반환하며 성공한 뒤에는 새 명령을 만들지 말고 같은 백업 경로로
원래 명령을 다시 실행합니다.

```bash
# cutover 시간제한을 SQL Editor에서 처리한 뒤
python migrate_rag_to_gemini.py cutover --backup ../.rag-migration/backups/<timestamp>

# rollback 시간제한을 SQL Editor에서 처리한 뒤
python migrate_rag_to_gemini.py rollback --backup ../.rag-migration/backups/<timestamp>
```

재실행한 `cutover`는 Gemini 계약과 전체/문서별 활성 행, 정확한 active release를 검증한 뒤
RPC를 반복하지 않고 `gemini_release.json`을 복구합니다. 재실행한 `rollback`도 기준선 계약과
활성 행·active release가 이미 일치하면 RPC를 반복하지 않고 검증 결과를 반환합니다.

PDF는 페이지별 텍스트층을 검사해 스캔·혼합 문서에 한국어/영어 EasyOCR을 적용합니다.
HWPX/HWP는 LibreOffice로 임시 PDF를 만든 뒤 동일한 경로로 처리합니다. 청크 샘플과
페이지·문자 수를 미리보기에서 승인해야만 Storage/DB가 변경됩니다. 원본 자동 등록 옵션을
켜면 PDF 또는 변환 PDF를 비공개 `documents` 버킷과 `documents` 행에 연결하므로 챗봇
출처에서 자료실 원문을 바로 열 수 있습니다.

```bash
# HWPX/HWP 자동 변환에 필요
# macOS: brew install --cask libreoffice

# 인터넷이 차단된 내부망으로 옮기기 전에 EasyOCR 모델을 사전 다운로드
docling-tools models download easyocr --easyocr-lang ko --easyocr-lang en
```

내부망에서는 사전 다운로드한 모델 디렉터리를 함께 반입하고
`DOCLING_OCR_DOWNLOAD=0`으로 설정합니다. LibreOffice 경로를 자동 탐지하지 못하면
`LIBREOFFICE_BIN`에 `soffice` 실행 파일 경로를 지정하세요.
텍스트층 비율이 10% 이하인 벡터형 PDF는 전체 페이지 OCR을 자동 적용하며,
`DOCLING_FORCE_FULL_PAGE_OCR=1|0`으로 강제하거나 해제할 수 있습니다.
Docling 변환에서 누락된 페이지는 유효한 PDF 텍스트층이 있을 때 자동 보완됩니다.

## 자료 메타데이터 부여
- **폴더 분류**: `docs/산악/장비.pdf` 처럼 카테고리 폴더에 넣으면 `category` 자동 인식
  (산악 / 수난 / 화재 / 구급)
- **manifest**: `docs/manifest.json` 으로 파일별 제목·장비·난이도·발행일 지정/덮어쓰기
  (`docs/manifest.example.json` 참고)
- **자료 유형**: 운영 GUI `rag7.py`에서 아래 유형을 선택하며 각 청크의
  `metadata.document_type`에 기록됩니다.
  - `일반 교육자료` → `training_material`
  - `현장활동 지침·매뉴얼` → `operational_guidance`
  - `표준작전절차(SOP)` → `sop`

AI 자료제작은 요청한 교육 분야와 같은 `edu_category` 안에서 `sop`와
`operational_guidance`만 별도의 SOP 근거 검색에 사용합니다. 공통 적용 문서도 현재는 사용할
분야로 분류해 적재해야 하며, 다른 분야의 지침을 키워드 일치만으로 근거로 승격하지 않습니다.
문서 제목에 SOP라는 단어가 있다는 이유만으로 자동 분류하지 말고, 발행기관과 문서 성격을
확인한 관리자가 유형을 지정해야 합니다. 기존 운영 자료는
`20260829140500_classify_rag_procedure_sources.sql` 적용 후 분류되며, 새로 적재하거나 재적재할
때는 GUI에서 올바른 유형을 선택합니다.

## 포맷 지원
| 포맷 | 처리 |
|------|------|
| PDF  | pymupdf 페이지별 텍스트 |
| PPTX | python-pptx 슬라이드 본문 + 발표자 노트 (슬라이드=페이지) |
| HWPX/HWP | 레거시 배치 인덱서는 사전 PDF 변환, `rag7.py` GUI는 LibreOffice 자동 변환 |

## 임베딩 제공자
- 운영 `rag7.py`의 기본 계약은 `google / gemini-embedding-001 / 1024 /
  google-retrieval-v1`입니다.
- `rag7.py`는 `auto | google | openai | bge | ollama`를 지원합니다. `auto`는 Ollama를
  뜻하며, 장애 시 Google로 자동 전환하지 않습니다.
- 레거시 `embed_and_upload.py`는 `openai`(기본, `text-embedding-3-small` @ 1024차원)와
  `bge`만 지원합니다. BGE는 `requirements.txt`의 `sentence-transformers` 주석을 해제해
  사용하며, 웹앱 쿼리 임베딩에는 `serve.py`와 `EMBEDDING_API_URL`이 필요합니다.

## 레거시 배치 멱등성
`embed_and_upload.py`는 같은 `original_filename` 문서가 이미 있으면 삭제(연쇄로
`chunks` 삭제) 후 재적재하므로 같은 파일을 다시 돌려도 중복되지 않습니다.
