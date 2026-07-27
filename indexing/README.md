# indexing/ — 자료 인덱싱 파이프라인 (Python)

웹앱과 분리된 배치 스크립트. `docs/` 의 자료를 텍스트 추출 → 청크 → 임베딩 → Supabase
`documents`/`chunks` 테이블에 적재한다. (PRD §10)

## 사전 준비
1. 루트 `.env.local` 에 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, 임베딩 키 설정
2. **웹앱과 동일한 임베딩 설정**을 사용할 것 (`EMBEDDING_PROVIDER`, 모델/차원 1024)
3. Supabase Storage 에 **비공개** `documents` 버킷 생성 — 원본 PDF 뷰어용 `file_url` 저장

## 설치 & 실행
```bash
cd indexing
python -m venv .venv && source .venv/bin/activate   # 선택
pip install -r requirements.txt
python embed_and_upload.py                 # docs/ 전체 인덱싱
python embed_and_upload.py ../docs/foo.pdf # 특정 파일만
```

### `rag7.py` GUI 인덱서
외부 `rag_rescue` 테이블을 쓰는 PoC 경로입니다. 먼저 최신 Supabase 마이그레이션을
적용한 뒤 프로젝트 루트에서 실행합니다.

```bash
cd indexing
pip install -r requirements-rag7.txt
cd ..
python rag7.py
```

`rag7.py`는 페이지 번호와 임베딩 계약을 메타데이터에 기록하고, 신규 청크를 비활성
상태로 먼저 적재합니다. 모든 배치가 검증된 경우에만 RPC로 활성화하고 이전 파일 버전을
같은 트랜잭션에서 교체합니다. 기존 `rag_rescue` 행에 임베딩 계약이 없다면 접두사 규약이
불명확하므로 자동 혼합하지 않으며, 백업 후 테이블을 비우고 전체 재인덱싱해야 합니다.

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

## 포맷 지원
| 포맷 | 처리 |
|------|------|
| PDF  | pymupdf 페이지별 텍스트 |
| PPTX | python-pptx 슬라이드 본문 + 발표자 노트 (슬라이드=페이지) |
| HWPX/HWP | 배치 인덱서는 사전 PDF 변환, `rag7.py` GUI는 LibreOffice 자동 변환 |

## 임베딩 제공자
- `EMBEDDING_PROVIDER=openai` (기본): `text-embedding-3-small` @ 1024차원
- `EMBEDDING_PROVIDER=bge`: `requirements.txt` 의 `sentence-transformers` 주석 해제 후 사용.
  웹앱 쿼리 임베딩을 위해 `serve.py` 를 띄우고 `EMBEDDING_API_URL` 설정.
- `rag7.py`는 `auto | google | openai | bge | ollama`를 지원한다. `auto`는 Ollama를
  뜻하며, 장애 시 Google로 자동 전환하지 않는다.

## 멱등성
같은 `original_filename` 문서가 이미 있으면 삭제(연쇄로 chunks 삭제) 후 재적재하므로
같은 파일을 다시 돌려도 중복되지 않는다.
