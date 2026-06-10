"""임베딩 + Supabase 적재 (PRD §10).

흐름: docs/ 스캔 → 텍스트 추출 → 청크 → 임베딩(1024d) → documents/chunks upsert.

실행:
  cd indexing
  pip install -r requirements.txt
  python embed_and_upload.py            # docs/ 전체
  python embed_and_upload.py <파일경로>  # 특정 파일만

환경변수는 ../.env.local 에서 읽는다.
  - NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (필수)
  - EMBEDDING_PROVIDER=openai|bge  (기본 openai)
  - OPENAI_API_KEY, OPENAI_EMBEDDING_MODEL (openai)
  - EMBEDDING_API_URL 대신 직접 sentence-transformers 사용 (bge)
  - STORAGE_BUCKET (기본 documents) — 원본 PDF 업로드 버킷

자료 메타데이터:
  - 폴더명이 산악/수난/화재/구급 이면 category 로 자동 인식
  - docs/manifest.json 으로 파일별 메타 지정/덮어쓰기:
      { "장비매뉴얼.pdf": {"title":"...", "category":"산악",
        "equipment":["유압전개기"], "difficulty":"중급", "publish_date":"2024-01-01"} }
"""
from __future__ import annotations

import glob
import json
import mimetypes
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")

# 로컬 모듈 (parse.py, chunk.py)
sys.path.insert(0, str(Path(__file__).resolve().parent))
from parse import parse_file  # noqa: E402
from chunk import chunk_text  # noqa: E402

DOCS_DIR = ROOT / "docs"
CATEGORIES = {"산악", "수난", "화재", "구급"}
EMBEDDING_DIM = 1024
STORAGE_BUCKET = os.getenv("STORAGE_BUCKET", "documents")
PROVIDER = os.getenv("EMBEDDING_PROVIDER", "openai")

_bge_model = None


# ── Supabase ──────────────────────────────────────────────
def get_supabase():
    from supabase import create_client

    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        sys.exit(
            "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 ../.env.local 에 필요합니다."
        )
    return create_client(url, key)


# ── 임베딩 ────────────────────────────────────────────────
def embed_texts(texts):
    if PROVIDER == "bge":
        return embed_bge(texts)
    return embed_openai(texts)


def embed_openai(texts):
    from openai import OpenAI

    client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
    model = os.getenv("OPENAI_EMBEDDING_MODEL", "text-embedding-3-small")
    out = []
    for i in range(0, len(texts), 100):
        batch = texts[i : i + 100]
        resp = client.embeddings.create(model=model, input=batch, dimensions=EMBEDDING_DIM)
        out.extend([d.embedding for d in resp.data])
    return out


def embed_bge(texts):
    global _bge_model
    from sentence_transformers import SentenceTransformer

    if _bge_model is None:
        print("  BGE-M3 모델 로드 중…")
        _bge_model = SentenceTransformer("BAAI/bge-m3")
    embs = _bge_model.encode(texts, normalize_embeddings=True)
    return [list(map(float, e)) for e in embs]


def to_pgvector(vec):
    return "[" + ",".join(repr(float(x)) for x in vec) + "]"


# ── 메타데이터 ────────────────────────────────────────────
def load_manifest():
    p = DOCS_DIR / "manifest.json"
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            print("  [경고] manifest.json 파싱 실패:", e)
    return {}


def meta_for(path: Path, manifest: dict):
    rel = str(path.relative_to(DOCS_DIR))
    m = manifest.get(path.name) or manifest.get(rel) or {}
    category = m.get("category")
    if not category and path.parent.name in CATEGORIES:
        category = path.parent.name
    return {
        "title": m.get("title") or path.stem,
        "category": category,
        "equipment": m.get("equipment"),
        "difficulty": m.get("difficulty"),
        "publish_date": m.get("publish_date"),
    }


def upload_to_storage(sb, path: Path):
    try:
        data = path.read_bytes()
        ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        sb.storage.from_(STORAGE_BUCKET).upload(
            path.name, data, {"content-type": ctype, "upsert": "true"}
        )
        return sb.storage.from_(STORAGE_BUCKET).get_public_url(path.name)
    except Exception as e:
        print("  [경고] Storage 업로드 실패(", e, ") — file_url 없이 진행")
        return None


# ── 파일 처리 ─────────────────────────────────────────────
def process_file(sb, path: Path, manifest: dict):
    print("▶", path.relative_to(ROOT))
    ext = path.suffix.lower()
    source_type = {".pdf": "pdf", ".pptx": "pptx", ".hwpx": "hwpx"}.get(ext, ext.lstrip("."))

    pages = parse_file(str(path))
    if not pages:
        print("  텍스트 없음 — 건너뜀")
        return

    all_chunks = []
    for pg in pages:
        all_chunks.extend(chunk_text(pg.text, pg.page_num, pg.section_title))
    if not all_chunks:
        print("  청크 없음 — 건너뜀")
        return

    meta = meta_for(path, manifest)

    # 멱등성: 같은 파일명 문서가 있으면 삭제(연쇄로 chunks 삭제) 후 재적재
    existing = sb.table("documents").select("id").eq("original_filename", path.name).execute()
    for row in existing.data or []:
        sb.table("documents").delete().eq("id", row["id"]).execute()

    file_url = upload_to_storage(sb, path) if ext == ".pdf" else None

    inserted = (
        sb.table("documents")
        .insert(
            {
                "title": meta["title"],
                "source_type": source_type,
                "category": meta["category"],
                "equipment": meta["equipment"],
                "difficulty": meta["difficulty"],
                "original_filename": path.name,
                "file_url": file_url,
                "publish_date": meta["publish_date"],
                "status": "processed",
            }
        )
        .execute()
    )
    doc_id = inserted.data[0]["id"]

    print("  청크 " + str(len(all_chunks)) + "개 임베딩…")
    embs = embed_texts([c.content for c in all_chunks])
    if embs and len(embs[0]) != EMBEDDING_DIM:
        sys.exit(
            "임베딩 차원 불일치: %d (기대 %d). EMBEDDING_PROVIDER/모델 확인."
            % (len(embs[0]), EMBEDDING_DIM)
        )

    rows = []
    for c, e in zip(all_chunks, embs):
        rows.append(
            {
                "document_id": doc_id,
                "content": c.content,
                "embedding": to_pgvector(e),
                "page_num": c.page_num,
                "section_title": c.section_title,
            }
        )
    for i in range(0, len(rows), 200):
        sb.table("chunks").insert(rows[i : i + 200]).execute()

    print("  ✓ 적재 완료 (document_id=" + str(doc_id) + ", chunks=" + str(len(rows)) + ")")


def collect_files(arg=None):
    if arg:
        p = Path(arg)
        return [p] if p.exists() else []
    files = []
    for ext in ("*.pdf", "*.pptx", "*.hwpx"):
        files += [Path(p) for p in glob.glob(str(DOCS_DIR / "**" / ext), recursive=True)]
    return sorted(set(files))


def main():
    arg = sys.argv[1] if len(sys.argv) > 1 else None
    files = collect_files(arg)
    if not files:
        print("처리할 자료가 없습니다. docs/ 에 PDF/PPTX를 넣으세요:", DOCS_DIR)
        return

    sb = get_supabase()
    manifest = load_manifest()
    print("제공자=" + PROVIDER + ", 총 " + str(len(files)) + "개 파일 처리")

    ok, fail = 0, 0
    for f in files:
        try:
            process_file(sb, f, manifest)
            ok += 1
        except NotImplementedError as e:
            print("  [건너뜀]", e)
        except Exception as e:
            fail += 1
            print("  [오류]", f.name, ":", e)

    print("완료. 성공 " + str(ok) + ", 실패 " + str(fail))


if __name__ == "__main__":
    main()
