"""의미 단위 청크 분할 (PRD §10.1: 300~500자, 80자 overlap).

문장/줄 경계에서 가급적 끊어 자연스러운 청크를 만든다. 페이지 번호를 보존한다.
"""
from __future__ import annotations

from dataclasses import dataclass

DEFAULT_SIZE = 450
DEFAULT_OVERLAP = 80
_BOUNDARIES = ["\n", ". ", "。", "! ", "? ", "; ", " "]


@dataclass
class Chunk:
    content: str
    page_num: int | None
    section_title: str | None


def chunk_text(
    text: str,
    page_num=None,
    section_title=None,
    size: int = DEFAULT_SIZE,
    overlap: int = DEFAULT_OVERLAP,
) -> list:
    text = (text or "").strip()
    if not text:
        return []

    chunks = []
    n = len(text)
    start = 0
    while start < n:
        end = min(start + size, n)
        # 마지막 청크가 아니면 문장/줄 경계로 당겨서 끊는다
        if end < n:
            window = text[start:end]
            for sep in _BOUNDARIES:
                idx = window.rfind(sep)
                if idx > size * 0.5:  # 너무 짧게 끊기지 않도록 절반 이상에서만
                    end = start + idx + len(sep)
                    break
        content = text[start:end].strip()
        if content:
            chunks.append(
                Chunk(content=content, page_num=page_num, section_title=section_title)
            )
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return chunks
