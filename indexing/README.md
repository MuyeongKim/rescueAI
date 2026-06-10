# indexing/ — 자료 인덱싱 파이프라인 (Python)

웹앱과 분리된 배치 스크립트. `docs/` 의 자료를 텍스트 추출 → 청크 → 임베딩 → Supabase
`documents`/`chunks` 테이블에 적재한다. (PRD §10)

## 사전 준비
1. 루트 `.env.local` 에 `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, 임베딩 키 설정
2. **웹앱과 동일한 임베딩 설정**을 사용할 것 (`EMBEDDING_PROVIDER`, 모델/차원 1024)
3. Supabase Storage 에 `documents` 버킷 생성(공개) — 원본 PDF 뷰어용 `file_url` 저장

## 설치 & 실행
```bash
cd indexing
python -m venv .venv && source .venv/bin/activate   # 선택
pip install -r requirements.txt
python embed_and_upload.py                 # docs/ 전체 인덱싱
python embed_and_upload.py ../docs/foo.pdf # 특정 파일만
```

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
| HWPX | `soffice --headless --convert-to pdf` 로 PDF 변환 후 인덱싱 |

## 임베딩 제공자
- `EMBEDDING_PROVIDER=openai` (기본): `text-embedding-3-small` @ 1024차원
- `EMBEDDING_PROVIDER=bge`: `requirements.txt` 의 `sentence-transformers` 주석 해제 후 사용.
  웹앱 쿼리 임베딩을 위해 `serve.py` 를 띄우고 `EMBEDDING_API_URL` 설정.

## 멱등성
같은 `original_filename` 문서가 이미 있으면 삭제(연쇄로 chunks 삭제) 후 재적재하므로
같은 파일을 다시 돌려도 중복되지 않는다.
