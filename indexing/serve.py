"""(옵션) BGE-M3 임베딩 HTTP 서비스.

EMBEDDING_PROVIDER=bge 로 운영할 때, 웹앱이 쿼리 임베딩을 위해 호출하는 엔드포인트.
lib/embeddings.ts 의 embedBGE() 와 호환된다.

실행:
  pip install -r requirements.txt fastapi uvicorn sentence-transformers
  uvicorn serve:app --host 0.0.0.0 --port 8000

요청:  POST /embed   {"texts": ["질문1", ...]}
응답:  {"embeddings": [[...1024...], ...]}
"""
from __future__ import annotations

from typing import List

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="BGE-M3 Embedding Service")

_model = None


def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer("BAAI/bge-m3")
    return _model


class EmbedRequest(BaseModel):
    texts: List[str]


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/embed")
def embed(req: EmbedRequest):
    model = get_model()
    embs = model.encode(req.texts, normalize_embeddings=True)
    return {"embeddings": [list(map(float, e)) for e in embs]}
