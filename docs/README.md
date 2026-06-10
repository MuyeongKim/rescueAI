# docs/ — 원본 교육자료 투입 위치

여기에 전북소방 구조 교육자료(PDF/PPTX)를 넣고 인덱서를 실행하면 챗봇이 근거로 사용한다.

## 넣는 방법
1. 카테고리 폴더에 파일을 둔다 (카테고리 자동 인식):
   ```
   docs/
   ├── 산악/  로프구조_기초.pdf
   ├── 수난/  수난구조_장비.pdf
   ├── 화재/  ...
   └── 구급/  ...
   ```
   폴더로 분류하지 않으면 `category` 는 비어 있게 되고, `manifest.json` 으로 지정할 수 있다.
2. (선택) `docs/manifest.json` 으로 제목·장비·난이도·발행일을 지정한다.
   템플릿: `manifest.example.json`
3. 인덱싱 실행:
   ```bash
   cd indexing && pip install -r requirements.txt && python embed_and_upload.py
   ```

## 주의
- 이 폴더의 자료 파일은 **git에 커밋하지 않는 것**을 권장한다(저작권). `.gitignore` 에
  `docs/**/*.pdf` 등이 포함되어 있다. `README.md`/`manifest*.json` 은 추적된다.
- 원본 PDF는 인덱싱 시 Supabase Storage(`documents` 버킷)에 업로드되어 뷰어에서 열린다.
- 저작권: 외부 자료는 출처 표기, 유튜브 등은 자막만 사용(영상 다운로드 금지) — PRD §14.
