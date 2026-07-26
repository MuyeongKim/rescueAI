# -*- coding: utf-8 -*-
import os
import hashlib
import math
import shutil
import subprocess
import tempfile
import uuid
from collections import Counter
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from tqdm import tqdm
from datetime import datetime
import time
import queue
import threading
import traceback
import requests
import tkinter as tk
import tkinter.font as tkfont
import re
from tkinter import ttk
from tkinter import filedialog, messagebox
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from supabase import Client, create_client

# =========================
# ✅ JSON/임베딩 안전화 유틸
# =========================
@dataclass
class TextDocument:
    page_content: str
    metadata: dict = field(default_factory=dict)


@dataclass
class ConvertedPage:
    text: str
    page_num: int | None


@dataclass(frozen=True)
class PreparedDocument:
    original_path: Path
    parsing_path: Path
    viewer_pdf_path: Path | None
    converted_from_office: bool


@dataclass(frozen=True)
class PdfTextLayerAnalysis:
    total_pages: int
    text_pages: int
    low_text_pages: tuple[int, ...]

    @property
    def coverage(self):
        return self.text_pages / self.total_pages if self.total_pages else 0.0


@dataclass(frozen=True)
class IngestionPreview:
    source_name: str
    parser_name: str
    converted_from_office: bool
    total_pages: int
    extracted_pages: int
    low_text_pages: tuple[int, ...]
    total_characters: int
    chunk_count: int
    file_hash: str
    samples: tuple[str, ...]

    def as_text(self):
        low_pages = (
            ", ".join(str(page) for page in self.low_text_pages[:20])
            if self.low_text_pages
            else "없음"
        )
        if len(self.low_text_pages) > 20:
            low_pages += f" 외 {len(self.low_text_pages) - 20}개"
        lines = [
            f"원본 파일: {self.source_name}",
            f"파서: {self.parser_name}",
            f"오피스 문서 PDF 변환: {'예' if self.converted_from_office else '아니오'}",
            f"전체/추출 페이지: {self.total_pages} / {self.extracted_pages}",
            f"저텍스트 페이지: {low_pages}",
            f"추출 문자 수: {self.total_characters:,}",
            f"생성 청크 수: {self.chunk_count:,}",
            f"원본 SHA-256: {self.file_hash}",
            "",
            "[청크 샘플]",
        ]
        for index, sample in enumerate(self.samples, start=1):
            lines.extend([f"\n--- 샘플 {index} ---", sample])
        return "\n".join(lines)


@dataclass
class SourceDocumentLink:
    document_id: int
    storage_path: str | None = None
    previous_storage_path: str | None = None
    previous_source_type: str | None = None
    previous_status: str | None = None
    created_row: bool = False
    updated_existing: bool = False
    uploaded_object: bool = False


class IngestionCancelled(RuntimeError):
    pass


class LocalMarkdownHeaderTextSplitter:
    """Torch/transformers 의존 없이 #/##/### 기준으로 마크다운을 나눈다."""

    def __init__(self, headers_to_split_on, strip_headers=False):
        self.header_map = dict(headers_to_split_on)
        self.strip_headers = strip_headers

    def split_text(self, text):
        docs = []
        current_metadata = {}
        current_lines = []

        def flush():
            content = "\n".join(current_lines).strip()
            if content:
                docs.append(TextDocument(page_content=content, metadata=dict(current_metadata)))

        for line in text.splitlines():
            match = re.match(r"^(#{1,3})\s+(.+?)\s*$", line)
            if match and match.group(1) in self.header_map:
                flush()
                current_lines = []
                level = len(match.group(1))
                header_key = self.header_map[match.group(1)]
                current_metadata[header_key] = match.group(2).strip()
                for deeper_level in range(level + 1, 4):
                    current_metadata.pop(self.header_map.get("#" * deeper_level), None)
                if not self.strip_headers:
                    current_lines.append(line)
                continue
            current_lines.append(line)

        flush()
        return docs


class LocalRecursiveCharacterTextSplitter:
    """긴 텍스트를 안정적인 크기/overlap으로 나누는 경량 splitter."""

    def __init__(self, chunk_size=1000, chunk_overlap=200, separators=None):
        self.chunk_size = int(chunk_size)
        self.chunk_overlap = max(0, int(chunk_overlap))
        self.separators = separators or ["\n\n", "\n", ". ", " ", ""]

    def split_text(self, text):
        text = text.strip()
        if not text:
            return []
        pieces = self._split_recursive(text, self.separators)
        chunks = []
        current = ""
        for piece in pieces:
            if not piece:
                continue
            candidate = piece if not current else f"{current}{piece}"
            if len(candidate) <= self.chunk_size:
                current = candidate
                continue
            if current:
                chunks.append(current)
            current = piece
        if current:
            chunks.append(current)
        return self._apply_overlap(chunks)

    def _split_recursive(self, text, separators):
        if len(text) <= self.chunk_size:
            return [text]
        if not separators:
            return [text[i : i + self.chunk_size] for i in range(0, len(text), self.chunk_size)]

        sep = separators[0]
        if sep == "":
            return [text[i : i + self.chunk_size] for i in range(0, len(text), self.chunk_size)]

        raw_parts = text.split(sep)
        if len(raw_parts) == 1:
            return self._split_recursive(text, separators[1:])

        out = []
        last_index = len(raw_parts) - 1
        for index, raw_part in enumerate(raw_parts):
            # 구분자를 버리면 문장부호와 줄바꿈이 사라져 의미가 달라진다.
            part = raw_part + (sep if index < last_index else "")
            if not part:
                continue
            if len(part) > self.chunk_size:
                out.extend(self._split_recursive(part, separators[1:]))
            else:
                out.append(part)
        return out

    def _apply_overlap(self, chunks):
        if self.chunk_overlap <= 0 or len(chunks) <= 1:
            return chunks
        overlapped = [chunks[0]]
        for chunk in chunks[1:]:
            previous_tail = overlapped[-1][-self.chunk_overlap :].strip()
            if previous_tail:
                overlapped.append(f"{previous_tail}\n{chunk}".strip())
            else:
                overlapped.append(chunk)
        return overlapped


def sanitize_for_json(value):
    """Supabase JSON 직렬화에서 깨지는 NaN/Infinity/비표준 타입을 정리한다."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {str(k): sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [sanitize_for_json(v) for v in value]
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    return str(value)


def _env_int(name, default, minimum=None, maximum=None):
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _env_float(name, default, minimum=None, maximum=None):
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        value = default
    if minimum is not None:
        value = max(minimum, value)
    if maximum is not None:
        value = min(maximum, value)
    return value


def _libreoffice_binary():
    configured = os.getenv("LIBREOFFICE_BIN", "").strip()
    candidates = [
        configured,
        shutil.which("soffice"),
        shutil.which("libreoffice"),
        "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    return None


@contextmanager
def prepare_document_for_parsing(file_path, log_cb=None):
    """HWPX/HWP를 임시 PDF로 변환하고, 다른 파일은 원본 경로를 그대로 제공한다."""

    def log(text):
        if log_cb:
            log_cb(text)
        else:
            print(text)

    original_path = Path(file_path).expanduser().resolve()
    if not original_path.is_file():
        raise FileNotFoundError(f"파일을 찾을 수 없습니다: {original_path}")

    max_size_mb = _env_int("RAG_MAX_FILE_MB", 200, minimum=1, maximum=2048)
    if original_path.stat().st_size > max_size_mb * 1024 * 1024:
        raise RuntimeError(f"파일 크기가 제한({max_size_mb}MB)을 초과합니다.")

    suffix = original_path.suffix.lower()
    if suffix not in {".hwpx", ".hwp"}:
        yield PreparedDocument(
            original_path=original_path,
            parsing_path=original_path,
            viewer_pdf_path=original_path if suffix == ".pdf" else None,
            converted_from_office=False,
        )
        return

    soffice = _libreoffice_binary()
    if not soffice:
        raise RuntimeError(
            "HWPX/HWP 변환에 LibreOffice가 필요합니다. LibreOffice를 설치하거나 "
            "LIBREOFFICE_BIN에 soffice 실행 파일 경로를 지정하세요."
        )

    timeout_seconds = _env_int(
        "RAG_CONVERSION_TIMEOUT_SECONDS", 180, minimum=30, maximum=1800
    )
    with tempfile.TemporaryDirectory(prefix="rescueai-hwpx-") as temp_dir:
        temp_path = Path(temp_dir)
        output_dir = temp_path / "output"
        profile_dir = temp_path / "lo-profile"
        output_dir.mkdir()
        profile_dir.mkdir()
        command = [
            soffice,
            f"-env:UserInstallation={profile_dir.resolve().as_uri()}",
            "--headless",
            "--convert-to",
            "pdf",
            "--outdir",
            str(output_dir),
            str(original_path),
        ]
        log(f"ℹ️ {suffix.upper()[1:]} 문서를 임시 PDF로 변환합니다.")
        try:
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise RuntimeError(
                f"LibreOffice 변환이 {timeout_seconds}초를 초과해 중단되었습니다."
            ) from error

        expected_pdf = output_dir / f"{original_path.stem}.pdf"
        candidates = sorted(output_dir.glob("*.pdf"))
        converted_pdf = expected_pdf if expected_pdf.is_file() else (candidates[0] if candidates else None)
        if result.returncode != 0 or converted_pdf is None or converted_pdf.stat().st_size == 0:
            detail = (result.stderr or result.stdout or "출력 PDF 없음").strip()
            raise RuntimeError(f"LibreOffice PDF 변환 실패: {detail}")

        log(f"✅ 임시 PDF 변환 완료: {converted_pdf.name}")
        yield PreparedDocument(
            original_path=original_path,
            parsing_path=converted_pdf,
            viewer_pdf_path=converted_pdf,
            converted_from_office=True,
        )


def analyze_pdf_text_layer(file_path, min_chars_per_page=None):
    """PDF 페이지별 텍스트층 품질을 분석한다. 판별 실패 시 None."""
    try:
        from pypdf import PdfReader

        if min_chars_per_page is None:
            min_chars_per_page = _env_int(
                "DOCLING_MIN_TEXT_CHARS_PER_PAGE", 40, minimum=1, maximum=1000
            )
        reader = PdfReader(file_path)
        if not reader.pages:
            return PdfTextLayerAnalysis(0, 0, ())
        text_pages = 0
        low_text_pages = []
        for page_number, page in enumerate(reader.pages, start=1):
            if len((page.extract_text() or "").strip()) >= min_chars_per_page:
                text_pages += 1
            else:
                low_text_pages.append(page_number)
        return PdfTextLayerAnalysis(
            total_pages=len(reader.pages),
            text_pages=text_pages,
            low_text_pages=tuple(low_text_pages),
        )
    except Exception:
        return None


def _pdf_text_layer_coverage(file_path, min_chars_per_page=40):
    analysis = analyze_pdf_text_layer(file_path, min_chars_per_page)
    return analysis.coverage if analysis is not None else None


def _pdf_has_text_layer(file_path, min_chars=40):
    """혼합 스캔 PDF를 놓치지 않도록 충분한 비율의 페이지에 텍스트가 있는지 판별한다."""
    analysis = analyze_pdf_text_layer(file_path, min_chars)
    if analysis is None:
        return False
    threshold = _env_float("DOCLING_TEXT_PAGE_RATIO", 1.0, minimum=0.0, maximum=1.0)
    return analysis.coverage >= threshold


def _resolve_do_ocr(file_path, log, pdf_analysis=None):
    """OCR 사용 여부를 자동 결정한다.
    DOCLING_OCR=auto(기본): PDF는 텍스트 레이어 유무로 자동 판단, 그 외 형식은 OFF.
    DOCLING_OCR=1/0: 자동 판단을 무시하고 강제 ON/OFF."""
    mode = os.getenv("DOCLING_OCR", "auto").strip().lower()
    if mode in {"1", "true", "yes", "on"}:
        return True
    if mode in {"0", "false", "no", "off"}:
        return False

    # auto: 텍스트 문서/오피스 파일은 OCR 불필요, PDF만 스캔 여부로 판단
    if Path(file_path).suffix.lower() != ".pdf":
        return False
    analysis = pdf_analysis or analyze_pdf_text_layer(file_path)
    if analysis is None:
        log("⚠️ PDF 텍스트 레이어 판별 실패 — 누락 방지를 위해 OCR을 켭니다.")
        return True

    threshold = _env_float("DOCLING_TEXT_PAGE_RATIO", 1.0, minimum=0.0, maximum=1.0)
    if analysis.coverage >= threshold:
        return False

    low_pages = ", ".join(str(page) for page in analysis.low_text_pages[:20])
    if len(analysis.low_text_pages) > 20:
        low_pages += f" 외 {len(analysis.low_text_pages) - 20}개"
    log(
        f"ℹ️ 텍스트 페이지 비율 {analysis.coverage:.0%}, 저텍스트 페이지({low_pages}) "
        "이미지 영역에 한국어 OCR을 적용합니다."
    )
    return True


def convert_file_to_pages(file_path, log_cb=None, pdf_analysis=None):
    """Docling 결과를 페이지 단위로 반환하고, PDF 변환 실패 시 pypdf로 폴백한다."""

    def log(text):
        if log_cb:
            log_cb(text)
        else:
            print(text)

    try:
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions

        # OCR은 페이지별 텍스트층 분석 결과로 결정한다. 강제값은 DOCLING_OCR로 지정한다.
        do_ocr = _resolve_do_ocr(file_path, log, pdf_analysis)
        pdf_options = PdfPipelineOptions()
        pdf_options.do_ocr = do_ocr
        pdf_options.do_table_structure = True
        if do_ocr:
            from docling.datamodel.pipeline_options import EasyOcrOptions

            ocr_languages = [
                language.strip()
                for language in os.getenv("DOCLING_OCR_LANGS", "ko,en").split(",")
                if language.strip()
            ] or ["ko", "en"]
            download_enabled = os.getenv("DOCLING_OCR_DOWNLOAD", "1").strip().lower() not in {
                "0",
                "false",
                "no",
                "off",
            }
            pdf_options.ocr_options = EasyOcrOptions(
                lang=ocr_languages,
                download_enabled=download_enabled,
            )
            log(f"ℹ️ EasyOCR 언어: {', '.join(ocr_languages)}")

        converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_options)}
        )
        result = converter.convert(file_path)
        document = result.document
        page_numbers = sorted(int(page_no) for page_no in (document.pages or {}).keys())
        pages = []
        for page_no in page_numbers:
            text = document.export_to_markdown(page_no=page_no).strip()
            if text:
                pages.append(ConvertedPage(text=text, page_num=page_no))
        if not pages:
            text = document.export_to_markdown().strip()
            if text:
                pages.append(ConvertedPage(text=text, page_num=None))
        if not pages:
            raise RuntimeError("Docling 변환 결과가 비어 있습니다.")
        return pages, "docling-easyocr" if do_ocr else "docling"
    except Exception as docling_error:
        suffix = Path(file_path).suffix.lower()
        if suffix != ".pdf":
            raise RuntimeError(f"Docling 문서 변환 실패: {docling_error}") from docling_error
        if _resolve_do_ocr(file_path, log, pdf_analysis):
            raise RuntimeError(
                "OCR이 필요한 PDF에서 Docling 변환이 실패했습니다. pypdf 폴백은 스캔 페이지를 "
                "누락하므로 적재를 중단합니다. Docling/OCR 환경을 복구한 뒤 다시 실행하세요. "
                f"원인: {docling_error}"
            ) from docling_error
        log(f"⚠️ Docling 변환 실패, pypdf 텍스트 추출로 폴백: {docling_error}")
        return convert_pdf_to_pages_with_pypdf(file_path), "pypdf"


def convert_pdf_to_pages_with_pypdf(file_path):
    """텍스트 기반 PDF를 pypdf로 페이지별 추출한다."""
    from pypdf import PdfReader

    reader = PdfReader(file_path)
    pages = []
    for page_idx, page in enumerate(reader.pages, start=1):
        text = page.extract_text() or ""
        text = text.replace("\x00", " ").strip()
        if not text:
            continue
        pages.append(
            ConvertedPage(
                text=f"# {Path(file_path).stem}\n\n## Page {page_idx}\n\n{text}",
                page_num=page_idx,
            )
        )
    if sum(len(page.text) for page in pages) < 20:
        raise RuntimeError("pypdf로 추출한 텍스트가 비어 있습니다. 스캔 PDF면 OCR 가능한 환경에서 Docling을 복구해야 합니다.")
    return pages


def convert_file_to_markdown(file_path, log_cb=None):
    """기존 호출 호환용. 신규 파이프라인은 convert_file_to_pages()를 사용한다."""
    pages, parser = convert_file_to_pages(file_path, log_cb=log_cb)
    return "\n\n".join(page.text for page in pages), parser


def convert_pdf_to_markdown_with_pypdf(file_path):
    """기존 호출 호환용."""
    return "\n\n".join(page.text for page in convert_pdf_to_pages_with_pypdf(file_path))


def create_retry_session():
    retry = Retry(
        total=4,
        connect=4,
        read=4,
        status=4,
        backoff_factor=0.8,
        status_forcelist=(429, 500, 502, 503, 504),
        allowed_methods=frozenset({"GET", "POST"}),
        respect_retry_after_header=True,
    )
    session = requests.Session()
    session.mount("http://", HTTPAdapter(max_retries=retry))
    session.mount("https://", HTTPAdapter(max_retries=retry))
    return session


class FastOllamaEmbeddings:
    """
    Ollama 임베딩을 배치 단위로 처리해 요청 횟수를 줄인다.
    - 우선 /api/embed (배치) 사용
    - 미지원 환경이면 /api/embeddings (단건)로 자동 폴백
    """

    def __init__(
        self,
        model,
        base_url,
        batch_size=64,
        timeout=120,
        embed_instruction="",
        query_instruction="",
        request_options=None,
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.batch_size = max(1, int(batch_size))
        self.timeout = timeout
        self.embed_instruction = embed_instruction
        self.query_instruction = query_instruction
        self.request_options = request_options or {}
        self.session = create_retry_session()
        self._use_embed_batch_api = None  # None=미확정, True/False=확정

    def _embed_via_batch_api(self, prompts):
        payload = {"model": self.model, "input": prompts}
        if self.request_options:
            payload["options"] = self.request_options
        res = self.session.post(
            f"{self.base_url}/api/embed",
            json=payload,
            timeout=self.timeout,
        )
        if res.status_code != 200:
            raise ValueError(f"/api/embed 호출 실패: {res.status_code}, {res.text}")
        data = res.json()
        embeddings = data.get("embeddings")
        if not isinstance(embeddings, list):
            raise ValueError(f"/api/embed 응답 형식 오류: {data}")
        if len(embeddings) != len(prompts):
            raise ValueError(
                f"/api/embed 응답 개수 불일치: 요청 {len(prompts)} / 응답 {len(embeddings)}"
            )
        return embeddings

    def _embed_via_legacy_api(self, prompt):
        payload = {"model": self.model, "prompt": prompt}
        if self.request_options:
            payload["options"] = self.request_options
        res = self.session.post(
            f"{self.base_url}/api/embeddings",
            json=payload,
            timeout=self.timeout,
        )
        if res.status_code != 200:
            raise ValueError(f"/api/embeddings 호출 실패: {res.status_code}, {res.text}")
        data = res.json()
        embedding = data.get("embedding")
        if not isinstance(embedding, list):
            raise ValueError(f"/api/embeddings 응답 형식 오류: {data}")
        return embedding

    def _embed_batch(self, prompts):
        if self._use_embed_batch_api is not False:
            try:
                vectors = self._embed_via_batch_api(prompts)
                self._use_embed_batch_api = True
                return vectors
            except Exception as e:
                if self._use_embed_batch_api is True:
                    raise
                self._use_embed_batch_api = False
                print(f"⚠️ /api/embed 미지원 또는 실패, /api/embeddings로 폴백: {e}")

        return [self._embed_via_legacy_api(prompt) for prompt in prompts]

    def embed_documents(self, texts):
        prompts = [f"{self.embed_instruction}{text}" for text in texts]
        all_vectors = []
        for i in range(0, len(prompts), self.batch_size):
            sub = prompts[i : i + self.batch_size]
            all_vectors.extend(self._embed_batch(sub))
        return all_vectors

    def embed_query(self, text):
        prompt = f"{self.query_instruction}{text}"
        return self._embed_batch([prompt])[0]


class GoogleGenAIEmbeddings:
    """
    Google Generative AI 임베딩 (gemini-embedding-001). 웹앱(lib/embeddings.ts)과 동일 모델·차원.
    - 문서 적재: taskType=RETRIEVAL_DOCUMENT / 쿼리: RETRIEVAL_QUERY (웹앱과 대칭)
    - outputDimensionality=1024 로 MRL 절단 → DB vector(1024) 스키마와 일치
    langchain 의존 없이 REST(batchEmbedContents)만 사용한다.
    """

    BASE = "https://generativelanguage.googleapis.com/v1beta"

    def __init__(self, model="gemini-embedding-001", api_key="", output_dim=1024, batch_size=100, timeout=120):
        if not api_key:
            raise SystemExit(
                "GOOGLE_GENERATIVE_AI_API_KEY 가 필요합니다 (EMBEDDING_PROVIDER=google).\n"
                ".env.local 에 설정하세요."
            )
        self.model = model
        self.api_key = api_key
        self.output_dim = int(output_dim)
        self.batch_size = max(1, int(batch_size))
        self.timeout = timeout
        self.session = create_retry_session()

    def _embed(self, texts, task_type):
        vectors = []
        model_path = f"models/{self.model}"
        for i in range(0, len(texts), self.batch_size):
            sub = texts[i : i + self.batch_size]
            payload = {
                "requests": [
                    {
                        "model": model_path,
                        "content": {"parts": [{"text": t}]},
                        "taskType": task_type,
                        "outputDimensionality": self.output_dim,
                    }
                    for t in sub
                ]
            }
            res = self.session.post(
                f"{self.BASE}/{model_path}:batchEmbedContents?key={self.api_key}",
                json=payload,
                timeout=self.timeout,
            )
            if res.status_code != 200:
                raise ValueError(f"Google 임베딩 호출 실패: {res.status_code}, {res.text}")
            data = res.json()
            embeddings = data.get("embeddings")
            if not isinstance(embeddings, list) or len(embeddings) != len(sub):
                raise ValueError(f"Google 임베딩 응답 형식/개수 오류: {data}")
            vectors.extend(e.get("values", []) for e in embeddings)
        return vectors

    def embed_documents(self, texts):
        return self._embed(list(texts), "RETRIEVAL_DOCUMENT")

    def embed_query(self, text):
        return self._embed([text], "RETRIEVAL_QUERY")[0]


class OpenAIEmbeddings:
    """OpenAI embeddings REST 클라이언트. text-embedding-3 계열의 1024차원 출력을 사용한다."""

    BASE = "https://api.openai.com/v1"

    def __init__(self, model, api_key, output_dim=1024, batch_size=100, timeout=120):
        if not api_key:
            raise SystemExit("OPENAI_API_KEY 가 필요합니다 (EMBEDDING_PROVIDER=openai).")
        self.model = model
        self.api_key = api_key
        self.output_dim = int(output_dim)
        self.batch_size = max(1, int(batch_size))
        self.timeout = timeout
        self.session = create_retry_session()

    def _embed(self, texts):
        vectors = []
        for i in range(0, len(texts), self.batch_size):
            sub = texts[i : i + self.batch_size]
            response = self.session.post(
                f"{self.BASE}/embeddings",
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": self.model,
                    "input": sub,
                    "dimensions": self.output_dim,
                    "encoding_format": "float",
                },
                timeout=self.timeout,
            )
            if response.status_code != 200:
                raise ValueError(
                    f"OpenAI 임베딩 호출 실패: {response.status_code}, {response.text}"
                )
            data = sorted(response.json().get("data", []), key=lambda row: row.get("index", 0))
            if len(data) != len(sub):
                raise ValueError("OpenAI 임베딩 응답 개수가 요청과 다릅니다.")
            vectors.extend(row.get("embedding", []) for row in data)
        return vectors

    def embed_documents(self, texts):
        return self._embed(list(texts))

    def embed_query(self, text):
        return self._embed([text])[0]


class BGEEmbeddings:
    """indexing/serve.py 호환 BGE 임베딩 서비스 클라이언트."""

    def __init__(self, base_url, timeout=120):
        if not base_url:
            raise SystemExit("EMBEDDING_API_URL 가 필요합니다 (EMBEDDING_PROVIDER=bge).")
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.session = create_retry_session()

    def embed_documents(self, texts):
        response = self.session.post(
            f"{self.base_url}/embed",
            json={"texts": list(texts)},
            timeout=self.timeout,
        )
        if response.status_code != 200:
            raise ValueError(f"BGE 임베딩 호출 실패: {response.status_code}, {response.text}")
        vectors = response.json().get("embeddings")
        if not isinstance(vectors, list) or len(vectors) != len(texts):
            raise ValueError("BGE 임베딩 응답 형식/개수가 요청과 다릅니다.")
        return vectors

    def embed_query(self, text):
        return self.embed_documents([text])[0]


class SafeEmbeddings:
    """임베딩 결과를 검증해 잘못된 벡터가 DB에 적재되지 않게 한다."""

    def __init__(self, base_embeddings, expected_dim=1024):
        self.base_embeddings = base_embeddings
        self.expected_dim = expected_dim

    @staticmethod
    def _normalize_text(text):
        if text is None:
            return " "
        normalized = str(text).replace("\x00", " ").strip()
        if not normalized:
            return " "
        return normalized.encode("utf-8", errors="ignore").decode("utf-8", errors="ignore")

    def _validate_vector(self, vector):
        if not isinstance(vector, (list, tuple)):
            raise ValueError("임베딩 응답이 숫자 배열이 아닙니다.")

        cleaned = []
        for index, val in enumerate(vector):
            try:
                num = float(val)
            except (TypeError, ValueError) as error:
                raise ValueError(f"임베딩 {index}번 원소가 숫자가 아닙니다: {val!r}") from error
            if not math.isfinite(num):
                raise ValueError(f"임베딩 {index}번 원소가 유한수가 아닙니다: {num!r}")
            cleaned.append(num)

        if self.expected_dim is None:
            self.expected_dim = len(cleaned)
        if len(cleaned) != self.expected_dim:
            raise ValueError(
                f"임베딩 차원 불일치: {len(cleaned)} / 기대값 {self.expected_dim}. "
                "EMBEDDING_MODEL 또는 DB vector 차원을 확인하세요."
            )
        norm = math.sqrt(sum(value * value for value in cleaned))
        if norm <= 1e-12:
            raise ValueError("임베딩 벡터의 노름이 0입니다. 모델 응답을 확인하세요.")
        return cleaned

    def embed_documents(self, texts):
        safe_texts = [self._normalize_text(text) for text in texts]
        try:
            vectors = self.base_embeddings.embed_documents(safe_texts)
        except Exception as batch_error:
            raise RuntimeError(f"임베딩 실패: 업로드를 중단합니다. {batch_error}") from batch_error
        if len(vectors) != len(safe_texts):
            raise ValueError(
                f"임베딩 응답 개수 불일치: 요청 {len(safe_texts)} / 응답 {len(vectors)}"
            )
        return [self._validate_vector(vec) for vec in vectors]

    def embed_query(self, text):
        try:
            vector = self.base_embeddings.embed_query(self._normalize_text(text))
            return self._validate_vector(vector)
        except Exception as e:
            raise RuntimeError(f"질의 임베딩 실패: {e}") from e


# =========================
# ✅ 1. 설정 및 보안
# =========================
# ⚠️ 키를 코드에 하드코딩하지 않는다. 웹앱과 동일한 .env.local(또는 환경변수)에서 읽는다.
#    (.env.local 은 git 에 커밋되지 않으므로 키 노출 방지)
def _load_env_local():
    """프로젝트 루트의 .env.local 을 단순 파싱해 환경변수로 올린다 (dotenv 의존 없이)."""
    env_path = Path(__file__).resolve().parent / ".env.local"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        key, val = key.strip(), val.strip()
        if key and key not in os.environ:
            os.environ[key] = val

_load_env_local()

SUPABASE_URL = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "")
if not SUPABASE_URL or not SUPABASE_KEY:
    raise SystemExit(
        "NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 가 필요합니다.\n"
        ".env.local 에 설정하거나 환경변수로 지정하세요."
    )

TABLE_NAME = "rag_rescue"  # 소문자로 통일 (웹앱 RAG_TABLE 과 일치해야 함)
EMBEDDING_CONFIG_TABLE = "rag_embedding_config"
ACTIVATE_INGESTION_RPC = "activate_rag_rescue_ingestion"
STORAGE_BUCKET = "documents"
EMBEDDING_DIMENSIONS = 1024

# 웹앱 분야(edu_category) 표준값 — 생성 페이지·챗봇 분야 필터가 이 값을 사용한다.
# (lib/category.ts 색 지정과도 일치) 새 자료는 이 중에서 고르면 분야 버튼에 바로 나타남.
EDU_CATEGORIES = [
    "화재", "수난", "산악", "구급", "일반구조", "화학사고",
    "드론 운용", "장비 관리", "현장지휘·공통", "복무·행정",
]

# Ollama BGE-M3 임베딩 모델 (1024차원) — 기본은 웹앱과 동일한 EMBEDDING_API_URL 공유
OLLAMA_MODEL = os.getenv("EMBEDDING_MODEL", "bge-m3:latest")
OLLAMA_FALLBACK_BASE_URL = os.getenv("EMBEDDING_API_URL", "http://localhost:11434")
OLLAMA_LOCAL_BASE_URL = os.getenv("EMBEDDING_LOCAL_API_URL", "http://localhost:11434")
EMBED_BATCH_SIZE = 64            # Ollama /api/embed 요청당 텍스트 수
try:
    UPLOAD_BATCH_SIZE = max(
        1, min(200, int(os.getenv("RAG_UPLOAD_BATCH_SIZE", "64")))
    )
except ValueError:
    UPLOAD_BATCH_SIZE = 64


def _ollama_model_names_match(installed_name, requested_model):
    installed = str(installed_name or "").strip()
    requested = str(requested_model or "").strip()
    return bool(installed and requested and installed == requested)


def _ollama_has_model(base_url, model, timeout=3.0):
    try:
        response = requests.get(f"{base_url.rstrip('/')}/api/tags", timeout=timeout)
        response.raise_for_status()
        return any(
            _ollama_model_names_match(item.get("name") or item.get("model"), model)
            for item in response.json().get("models", [])
        )
    except Exception:
        return False


def resolve_ollama_base_url(
    fallback_url,
    model,
    local_url="http://localhost:11434",
    timeout=1.5,
):
    """
    로컬 Ollama에 요청 모델이 있으면 로컬을 우선 사용하고, 없거나 접속 실패 시 fallback_url을 사용한다.
    EMBEDDING_PREFER_LOCAL=0 으로 자동 탐지를 끌 수 있다.
    """
    fallback_url = (fallback_url or "http://localhost:11434").rstrip("/")
    local_url = (local_url or "http://localhost:11434").rstrip("/")
    if os.getenv("EMBEDDING_PREFER_LOCAL", "1").lower() in {"0", "false", "no", "off"}:
        print(f"ℹ️ 로컬 Ollama 자동 탐지 비활성화: {fallback_url} 사용")
        return fallback_url

    try:
        res = requests.get(f"{local_url}/api/tags", timeout=timeout)
        res.raise_for_status()
        models = res.json().get("models", [])
        for item in models:
            if _ollama_model_names_match(item.get("name") or item.get("model"), model):
                print(f"🏠 로컬 Ollama 모델 감지됨: {model} @ {local_url}")
                return local_url
        print(f"ℹ️ 로컬 Ollama에 {model} 없음: {fallback_url} 사용")
    except Exception as e:
        print(f"ℹ️ 로컬 Ollama 확인 실패: {e} — {fallback_url} 사용")
    return fallback_url


def resolve_ollama_request_options(base_url):
    """
    Ollama 임베딩 요청 옵션을 구성한다.
    - OLLAMA_NUM_GPU 환경변수가 있으면 최우선 사용
    - 로컬 Ollama(localhost/127.0.0.1) + NVIDIA GPU 감지 시 num_gpu=1 전달
    """
    env_num_gpu = os.getenv("OLLAMA_NUM_GPU")
    if env_num_gpu is not None and env_num_gpu != "":
        try:
            parsed = int(env_num_gpu)
            print(f"🧩 OLLAMA_NUM_GPU={parsed} 환경변수 적용")
            return {"num_gpu": parsed}
        except ValueError:
            print(f"⚠️ OLLAMA_NUM_GPU 값이 정수가 아님: {env_num_gpu} (자동 감지로 진행)")

    is_local = ("localhost" in base_url) or ("127.0.0.1" in base_url)
    has_nvidia_smi = shutil.which("nvidia-smi") is not None
    if is_local and has_nvidia_smi:
        try:
            probe = subprocess.run(
                ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
                capture_output=True,
                text=True,
                timeout=3,
                check=False,
            )
            if probe.returncode == 0 and probe.stdout.strip():
                print("🖥️ NVIDIA GPU 감지됨: Ollama 요청에 num_gpu=1 적용")
                return {"num_gpu": 1}
        except Exception:
            pass

    print("ℹ️ GPU 옵션 강제 없이 Ollama 기본 동작 사용")
    return {}


# 임베딩 제공자 — 웹앱(lib/embeddings.ts)과 반드시 동일해야 검색이 된다.
# auto는 Ollama를 의미한다. 적재 시 다른 제공자로 자동 폴백하면 같은 테이블에 서로 다른
# 벡터 공간이 섞이므로, Ollama/정확한 모델 태그가 없으면 즉시 중단한다.
EMBEDDING_PROVIDER_REQUESTED = os.getenv("EMBEDDING_PROVIDER", "google").strip().lower()
EMBEDDING_PROVIDER = (
    "ollama" if EMBEDDING_PROVIDER_REQUESTED == "auto" else EMBEDDING_PROVIDER_REQUESTED
)
OLLAMA_BASE_URL = None

if EMBEDDING_PROVIDER == "ollama":
    OLLAMA_BASE_URL = resolve_ollama_base_url(
        fallback_url=OLLAMA_FALLBACK_BASE_URL,
        model=OLLAMA_MODEL,
        local_url=OLLAMA_LOCAL_BASE_URL,
    )
    if not _ollama_has_model(OLLAMA_BASE_URL, OLLAMA_MODEL):
        raise SystemExit(
            f"Ollama에서 정확한 모델 '{OLLAMA_MODEL}'을 확인할 수 없습니다: {OLLAMA_BASE_URL}\n"
            "인덱싱 중 제공자 자동 전환은 벡터 공간을 오염시키므로 중단합니다. "
            "Ollama/모델을 준비하거나 EMBEDDING_PROVIDER를 명시적으로 변경하세요."
        )

if EMBEDDING_PROVIDER == "google":
    EMBEDDING_MODEL_NAME = os.getenv("GOOGLE_EMBEDDING_MODEL", "gemini-embedding-001")
    print(f"🔷 임베딩 제공자: Google ({EMBEDDING_MODEL_NAME}, 1024차원)")
    raw_embeddings = GoogleGenAIEmbeddings(
        model=EMBEDDING_MODEL_NAME,
        api_key=os.getenv("GOOGLE_GENERATIVE_AI_API_KEY", ""),
        output_dim=EMBEDDING_DIMENSIONS,
    )
elif EMBEDDING_PROVIDER == "ollama":
    EMBEDDING_MODEL_NAME = OLLAMA_MODEL
    OLLAMA_REQUEST_OPTIONS = resolve_ollama_request_options(OLLAMA_BASE_URL)
    print(f"🔶 임베딩 제공자: Ollama ({OLLAMA_MODEL} @ {OLLAMA_BASE_URL})")
    raw_embeddings = FastOllamaEmbeddings(
        model=OLLAMA_MODEL,
        base_url=OLLAMA_BASE_URL,
        batch_size=EMBED_BATCH_SIZE,
        request_options=OLLAMA_REQUEST_OPTIONS,
    )
elif EMBEDDING_PROVIDER == "openai":
    EMBEDDING_MODEL_NAME = os.getenv(
        "OPENAI_EMBEDDING_MODEL", "text-embedding-3-small"
    )
    print(f"🟢 임베딩 제공자: OpenAI ({EMBEDDING_MODEL_NAME}, 1024차원)")
    raw_embeddings = OpenAIEmbeddings(
        model=EMBEDDING_MODEL_NAME,
        api_key=os.getenv("OPENAI_API_KEY", ""),
        output_dim=EMBEDDING_DIMENSIONS,
    )
elif EMBEDDING_PROVIDER == "bge":
    EMBEDDING_MODEL_NAME = os.getenv("BGE_EMBEDDING_MODEL", "BAAI/bge-m3")
    print(f"🟠 임베딩 제공자: BGE ({EMBEDDING_MODEL_NAME}, 1024차원)")
    raw_embeddings = BGEEmbeddings(os.getenv("EMBEDDING_API_URL", ""))
else:
    raise SystemExit(
        f"지원하지 않는 EMBEDDING_PROVIDER='{EMBEDDING_PROVIDER_REQUESTED}'. "
        "auto | google | openai | bge | ollama 중 하나를 사용하세요.\n"
        "웹앱(lib/embeddings.ts)과 다른 모델로 적재하면 검색이 조용히 망가지므로 중단합니다."
    )

default_versions = {
    "google": "google-retrieval-v1",
    "openai": "openai-raw-v1",
    "bge": "bge-m3-raw-v1",
    "ollama": "bge-m3-raw-v1" if "bge-m3" in EMBEDDING_MODEL_NAME.lower() else "ollama-raw-v1",
}
EMBEDDING_VERSION = os.getenv(
    "EMBEDDING_VERSION", default_versions[EMBEDDING_PROVIDER]
).strip()
EMBEDDING_CONTRACT = {
    "table_name": TABLE_NAME,
    "provider": EMBEDDING_PROVIDER,
    "model": EMBEDDING_MODEL_NAME,
    "dimensions": EMBEDDING_DIMENSIONS,
    "version": EMBEDDING_VERSION,
}

embeddings = SafeEmbeddings(raw_embeddings, expected_dim=EMBEDDING_DIMENSIONS)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# =========================
# ✅ 2. DB 관리 함수
# =========================
def call_with_retry(operation_name, operation, attempts=4):
    """멱등적인 Supabase 작업만 지수 백오프로 재시도한다."""
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            return operation()
        except Exception as error:
            last_error = error
            if attempt >= attempts:
                break
            delay = 0.8 * (2 ** (attempt - 1))
            print(f"⚠️ {operation_name} 실패 ({attempt}/{attempts}), {delay:.1f}초 후 재시도: {error}")
            time.sleep(delay)
    raise RuntimeError(f"{operation_name} 최종 실패: {last_error}") from last_error


def execute_with_retry(operation_name, query_factory, attempts=4):
    return call_with_retry(
        operation_name,
        lambda: query_factory().execute(),
        attempts=attempts,
    )


def ensure_embedding_contract():
    """DB의 임베딩 계약과 현재 인덱서 설정이 정확히 같은지 확인한다."""
    try:
        result = (
            supabase.table(EMBEDDING_CONFIG_TABLE)
            .select("table_name,provider,model,dimensions,version")
            .eq("table_name", TABLE_NAME)
            .limit(1)
            .execute()
        )
    except Exception as error:
        raise RuntimeError(
            "RAG 보안/버전 마이그레이션이 적용되지 않았습니다. "
            "supabase/migrations/20260726100515_secure_versioned_rag_ingestion.sql을 먼저 적용하세요."
        ) from error

    rows = result.data or []
    if rows:
        existing = rows[0]
        mismatches = [
            key
            for key in ("provider", "model", "dimensions", "version")
            if existing.get(key) != EMBEDDING_CONTRACT[key]
        ]
        if mismatches:
            expected = ", ".join(
                f"{key}={EMBEDDING_CONTRACT[key]!r}" for key in mismatches
            )
            actual = ", ".join(f"{key}={existing.get(key)!r}" for key in mismatches)
            raise RuntimeError(
                "임베딩 계약 불일치로 적재를 중단합니다. "
                f"현재 인덱서({expected}), DB({actual}). 제공자/모델 변경 시 전체 재인덱싱이 필요합니다."
            )
        return

    try:
        count_result = (
            supabase.table(TABLE_NAME)
            .select("id", count="exact", head=True)
            .eq("is_active", True)
            .execute()
        )
        active_count = int(getattr(count_result, "count", 0) or 0)
    except Exception as error:
        raise RuntimeError(
            "rag_rescue의 활성 상태를 확인할 수 없습니다. 최신 마이그레이션 적용 여부를 확인하세요."
        ) from error

    if active_count > 0:
        raise RuntimeError(
            "기존 활성 청크가 있지만 임베딩 계약이 없습니다. 기존 rag7.py는 BGE 접두사 때문에 "
            "웹앱 쿼리와 호환되지 않으므로 자동 승계하지 않습니다. 기존 데이터를 백업/비운 뒤 "
            "동일한 설정으로 전체 재인덱싱하세요."
        )

    execute_with_retry(
        "임베딩 계약 생성",
        lambda: supabase.table(EMBEDDING_CONFIG_TABLE).upsert(
            EMBEDDING_CONTRACT,
            on_conflict="table_name",
            ignore_duplicates=True,
        ),
    )
    # 동시 실행에서 다른 계약이 먼저 등록됐을 수 있으므로 DB 값을 다시 검증한다.
    ensure_embedding_contract()


def find_linked_document_id(source_name, category_name):
    """자료실에 같은 원본이 있으면 출처 링크용 documents.id를 연결한다."""
    try:
        result = (
            supabase.table("documents")
            .select("id")
            .eq("original_filename", source_name)
            .eq("category", category_name)
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        rows = result.data or []
        return int(rows[0]["id"]) if rows else None
    except Exception as error:
        print(f"⚠️ 자료실 문서 연결 조회 실패(인덱싱은 계속): {error}")
        return None


def _storage_path_for_file(file_hash):
    normalized_hash = str(file_hash or "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{64}", normalized_hash):
        raise ValueError("Storage 경로 생성에는 64자리 SHA-256 해시가 필요합니다.")
    return f"rag/{normalized_hash[:2]}/{normalized_hash}.pdf"


def _remove_storage_path(storage_path):
    if not storage_path or re.match(r"^https?://", storage_path):
        return
    call_with_retry(
        "Storage 원본 정리",
        lambda: supabase.storage.from_(STORAGE_BUCKET).remove([storage_path]),
    )


def _storage_path_is_referenced(storage_path, excluding_document_id):
    result = (
        supabase.table("documents")
        .select("id", count="exact", head=True)
        .eq("file_url", storage_path)
        .neq("id", excluding_document_id)
        .execute()
    )
    return int(getattr(result, "count", 0) or 0) > 0


def ensure_source_document(prepared, category_name, file_hash, log_cb=None):
    """열람용 PDF를 비공개 Storage에 올리고 documents 행을 생성하거나 갱신한다."""
    if prepared.viewer_pdf_path is None:
        return None

    def log(text):
        if log_cb:
            log_cb(text)
        else:
            print(text)

    source_name = prepared.original_path.name
    existing_result = (
        supabase.table("documents")
        .select("id,file_url,source_type,status")
        .eq("original_filename", source_name)
        .eq("category", category_name)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    existing_rows = existing_result.data or []
    existing = existing_rows[0] if existing_rows else None

    # Supabase Storage 객체 키는 AWS 호환 ASCII 문자만 사용한다. 한글 원본명은
    # documents.original_filename/title에 보존하고 객체는 내용 해시로 식별한다.
    storage_path = _storage_path_for_file(file_hash)

    if existing and existing.get("file_url") == storage_path:
        log(f"ℹ️ 자료실 원본 연결 재사용: documents.id={existing['id']}")
        return SourceDocumentLink(
            document_id=int(existing["id"]),
            storage_path=storage_path,
        )

    def upload_pdf():
        with prepared.viewer_pdf_path.open("rb") as source:
            return supabase.storage.from_(STORAGE_BUCKET).upload(
                path=storage_path,
                file=source,
                file_options={
                    "content-type": "application/pdf",
                    "cache-control": "3600",
                    "upsert": "true",
                },
            )

    call_with_retry("자료실 원본 PDF 업로드", upload_pdf)
    uploaded_object = True

    try:
        if existing:
            document_id = int(existing["id"])
            execute_with_retry(
                "자료실 문서 갱신",
                lambda: (
                    supabase.table("documents")
                    .update(
                        {
                            "file_url": storage_path,
                            "source_type": "pdf",
                            "status": "processed",
                        }
                    )
                    .eq("id", document_id)
                ),
            )
            log(f"✅ 자료실 원본 갱신: documents.id={document_id}")
            return SourceDocumentLink(
                document_id=document_id,
                storage_path=storage_path,
                previous_storage_path=existing.get("file_url"),
                previous_source_type=existing.get("source_type"),
                previous_status=existing.get("status"),
                updated_existing=True,
                uploaded_object=uploaded_object,
            )

        insert_payload = {
            "title": prepared.original_path.stem,
            "source_type": "pdf",
            "category": category_name,
            "original_filename": source_name,
            "file_url": storage_path,
            "status": "processed",
        }
        try:
            insert_result = supabase.table("documents").insert(insert_payload).execute()
            inserted_rows = insert_result.data or []
        except Exception:
            # 응답만 유실되고 insert가 반영된 경우를 확인해 중복 생성을 막는다.
            reconcile = (
                supabase.table("documents")
                .select("id")
                .eq("original_filename", source_name)
                .eq("category", category_name)
                .eq("file_url", storage_path)
                .order("created_at", desc=True)
                .limit(1)
                .execute()
            )
            inserted_rows = reconcile.data or []
            if not inserted_rows:
                raise
        if not inserted_rows:
            raise RuntimeError("documents 행 생성 결과에 id가 없습니다.")

        document_id = int(inserted_rows[0]["id"])
        log(f"✅ 자료실 원본 등록: documents.id={document_id}")
        return SourceDocumentLink(
            document_id=document_id,
            storage_path=storage_path,
            created_row=True,
            uploaded_object=uploaded_object,
        )
    except Exception:
        try:
            if _storage_path_is_referenced(storage_path, -1):
                log("⚠️ DB 반영 가능성이 있어 업로드된 Storage 원본을 보존합니다.")
            else:
                _remove_storage_path(storage_path)
        except Exception as cleanup_error:
            log(
                "⚠️ DB 반영 여부를 확인할 수 없어 Storage 원본을 보존합니다. "
                f"path={storage_path}, error={cleanup_error}"
            )
        raise


def rollback_source_document_link(link):
    """RAG 활성화 실패 시 이번 실행에서 바꾼 자료실 연결을 되돌린다."""
    if link is None:
        return

    if link.created_row:
        execute_with_retry(
            "자료실 신규 행 롤백",
            lambda: supabase.table("documents").delete().eq("id", link.document_id),
        )
    elif link.updated_existing:
        execute_with_retry(
            "자료실 문서 갱신 롤백",
            lambda: (
                supabase.table("documents")
                .update(
                    {
                        "file_url": link.previous_storage_path,
                        "source_type": link.previous_source_type or "pdf",
                        "status": link.previous_status or "processed",
                    }
                )
                .eq("id", link.document_id)
            ),
        )

    if (
        link.uploaded_object
        and not _storage_path_is_referenced(link.storage_path, link.document_id)
    ):
        _remove_storage_path(link.storage_path)


def finalize_source_document_link(link, log_cb=None):
    """활성화 성공 후 더 이상 참조되지 않는 이전 Storage 원본을 정리한다."""
    previous_path = link.previous_storage_path if link else None
    if (
        not link
        or not link.updated_existing
        or not previous_path
        or previous_path == link.storage_path
        or re.match(r"^https?://", previous_path)
    ):
        return

    try:
        if not _storage_path_is_referenced(previous_path, link.document_id):
            _remove_storage_path(previous_path)
            if log_cb:
                log_cb(f"🧹 이전 자료실 원본 정리: {previous_path}")
    except Exception as error:
        if log_cb:
            log_cb(f"⚠️ 이전 자료실 원본 정리 보류: {error}")


def file_sha256(file_path):
    digest = hashlib.sha256()
    with open(file_path, "rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def clean_chunk_content(content):
    cleaned = re.sub(r"<!--\s*image\s*-->", "", str(content or ""), flags=re.IGNORECASE)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def is_useful_chunk(content):
    cleaned = clean_chunk_content(content)
    if not cleaned or not any(character.isalnum() for character in cleaned):
        return False

    visible_length = sum(not character.isspace() for character in cleaned)
    dot_leader_count = cleaned.count("·")
    return not (
        dot_leader_count >= 20
        and dot_leader_count / max(visible_length, 1) >= 0.2
    )


def to_pgvector(vector):
    return "[" + ",".join(format(value, ".17g") for value in vector) + "]"


def cleanup_staged_ingestion(ingestion_id):
    execute_with_retry(
        "실패한 스테이징 정리",
        lambda: (
            supabase.table(TABLE_NAME)
            .delete()
            .eq("ingestion_id", str(ingestion_id))
            .eq("is_active", False)
        ),
    )


def activate_ingestion(
    ingestion_id,
    category_name,
    year_name,
    source_name,
    expected_count,
    replace_existing,
):
    result = execute_with_retry(
        "인덱싱 활성화",
        lambda: supabase.rpc(
            ACTIVATE_INGESTION_RPC,
            {
                "p_ingestion_id": str(ingestion_id),
                "p_category": category_name,
                "p_year": year_name,
                "p_source": source_name,
                "p_expected_count": expected_count,
                "p_replace_existing": bool(replace_existing),
            },
        ),
    )
    rows = result.data or []
    activated_count = int(rows[0].get("activated_count", 0)) if rows else 0
    if activated_count != expected_count:
        raise RuntimeError(
            f"활성화 결과 불일치: 기대 {expected_count}개 / 활성화 {activated_count}개"
        )
    return activated_count


def build_table_metadata_summary(max_rows=5000, page_size=1000):
    """테이블 metadata를 읽어 현재 적재된 자료 요약 문자열을 생성한다."""
    total_count = None
    try:
        count_result = (
            supabase.table(TABLE_NAME)
            .select("id", count="exact", head=True)
            .eq("is_active", True)
            .execute()
        )
        total_count = getattr(count_result, "count", None)
    except Exception:
        total_count = None

    category_year_counter = Counter()
    source_counter = Counter()
    parser_counter = Counter()
    upload_date_counter = Counter()

    fetched = 0
    while fetched < max_rows:
        start = fetched
        end = min(fetched + page_size - 1, max_rows - 1)
        result = (
            supabase.table(TABLE_NAME)
            .select("metadata")
            .eq("is_active", True)
            .range(start, end)
            .execute()
        )
        rows = result.data or []
        if not rows:
            break

        for row in rows:
            metadata = row.get("metadata") or {}
            if not isinstance(metadata, dict):
                continue
            category = str(metadata.get("category", "미분류"))
            year = str(metadata.get("year", "미지정"))
            source = str(metadata.get("source", "unknown"))
            parser = str(metadata.get("parser", "unknown"))
            upload_date = str(metadata.get("upload_date", "unknown"))

            category_year_counter[(category, year)] += 1
            source_counter[source] += 1
            parser_counter[parser] += 1
            upload_date_counter[upload_date] += 1

        fetched += len(rows)
        if len(rows) < (end - start + 1):
            break

    lines = [f"[{TABLE_NAME}] 메타태그 요약"]
    if total_count is not None:
        lines.append(f"- 테이블 전체 행 수(추정): {total_count}")
    lines.append(f"- 이번 조회로 읽은 행 수: {fetched} (최대 {max_rows})")
    if total_count is not None and total_count > fetched:
        lines.append("- 참고: 행 수가 많아 일부만 샘플링해 집계했습니다.")

    lines.append("")
    lines.append("카테고리/연도별 건수 (상위 30):")
    if category_year_counter:
        for (category, year), count in category_year_counter.most_common(30):
            lines.append(f"- {category}/{year}: {count}")
    else:
        lines.append("- 데이터 없음")

    lines.append("")
    lines.append("원본 파일별 건수 (상위 20):")
    if source_counter:
        for source, count in source_counter.most_common(20):
            lines.append(f"- {source}: {count}")
    else:
        lines.append("- 데이터 없음")

    lines.append("")
    lines.append("파서별 건수:")
    if parser_counter:
        for parser, count in parser_counter.most_common():
            lines.append(f"- {parser}: {count}")
    else:
        lines.append("- 데이터 없음")

    lines.append("")
    lines.append("업로드 날짜별 건수 (상위 20):")
    if upload_date_counter:
        for upload_date, count in upload_date_counter.most_common(20):
            lines.append(f"- {upload_date}: {count}")
    else:
        lines.append("- 데이터 없음")

    return "\n".join(lines)


def run_ingestion_pipeline(
    pdf_file,
    category_name,
    year_name,
    should_delete,
    register_source=True,
    progress_cb=None,
    status_cb=None,
    log_cb=None,
    preview_cb=None,
):
    """품질 확인 후 자료실 연결, 스테이징 적재와 원자적 활성화를 수행한다."""

    def set_progress(value):
        value = max(0.0, min(100.0, float(value)))
        if progress_cb:
            progress_cb(value)

    def set_status(text):
        if status_cb:
            status_cb(text)
        print(text)

    def log(text):
        if log_cb:
            log_cb(text)
        print(text)

    pipeline_start = time.perf_counter()
    set_progress(0)
    source_name = Path(pdf_file).name
    ingestion_id = uuid.uuid4()
    staged_count = 0
    source_link = None

    set_status("문서 준비 중...")
    log(
        "ℹ️ 인덱서 임베딩 설정: "
        f"{EMBEDDING_PROVIDER}/{EMBEDDING_MODEL_NAME}/"
        f"{EMBEDDING_DIMENSIONS}d/{EMBEDDING_VERSION}"
    )
    if should_delete:
        log("ℹ️ 신규 버전 검증 후 동일 분야/연도/파일의 이전 버전을 원자적으로 교체합니다.")
    set_progress(4)

    with prepare_document_for_parsing(pdf_file, log_cb=log) as prepared:
        set_status("문서 분석 중...")
        t0 = time.perf_counter()
        pdf_analysis = (
            analyze_pdf_text_layer(prepared.parsing_path)
            if prepared.parsing_path.suffix.lower() == ".pdf"
            else None
        )
        pages, parser_name = convert_file_to_pages(
            prepared.parsing_path,
            log_cb=log,
            pdf_analysis=pdf_analysis,
        )
        if prepared.converted_from_office:
            parser_name = f"libreoffice->{parser_name}"
        total_characters = sum(len(page.text) for page in pages)
        log(
            f"✅ 분석 완료! parser={parser_name}, {len(pages)}페이지 블록, "
            f"{total_characters}자"
        )
        log(f"⏱️ 문서 변환 소요: {time.perf_counter() - t0:.2f}초")
        set_progress(28)

        markdown_splitter = LocalMarkdownHeaderTextSplitter(
            headers_to_split_on=[
                ("#", "Header 1"),
                ("##", "Header 2"),
                ("###", "Header 3"),
            ],
            strip_headers=False,
        )
        text_splitter = LocalRecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
            separators=["\n\n", "\n", "。", ". ", " ", ""],
        )

        md_docs = []
        for page in pages:
            page_docs = markdown_splitter.split_text(page.text)
            if not page_docs and page.text.strip():
                page_docs = [TextDocument(page_content=page.text.strip())]
            for page_doc in page_docs:
                page_doc.metadata["page_num"] = page.page_num
                md_docs.append(page_doc)

        final_docs = []
        upload_date = datetime.now().strftime("%Y-%m-%d")
        file_hash = file_sha256(prepared.original_path)
        total_md = len(md_docs)
        progress_interval = max(1, total_md // 40) if total_md else 1
        chunk_index = 0

        set_status(f"청킹/필터링 중... (0/{total_md})")
        for idx, md_doc in enumerate(md_docs, start=1):
            content = md_doc.page_content.strip()
            if (
                content
                and len(content) >= 20
                and not (content.startswith("## ") and len(content) < 10)
                and content.count("··") <= 5
                and content.count("..") <= 5
            ):
                for chunk in text_splitter.split_text(content):
                    cleaned_chunk = clean_chunk_content(chunk)
                    if not is_useful_chunk(cleaned_chunk):
                        continue
                    metadata = {
                        "source": source_name,
                        "category": category_name,
                        "edu_category": category_name,
                        "year": year_name,
                        "upload_date": upload_date,
                        "parser": parser_name,
                        "page_num": md_doc.metadata.get("page_num"),
                        "chunk_index": chunk_index,
                        "file_hash": file_hash,
                        "ingestion_id": str(ingestion_id),
                        "embedding_provider": EMBEDDING_PROVIDER,
                        "embedding_model": EMBEDDING_MODEL_NAME,
                        "embedding_dimensions": EMBEDDING_DIMENSIONS,
                        "embedding_version": EMBEDDING_VERSION,
                    }
                    metadata.update(md_doc.metadata)
                    final_docs.append(
                        TextDocument(
                            page_content=cleaned_chunk,
                            metadata=sanitize_for_json(metadata),
                        )
                    )
                    chunk_index += 1

            if idx == total_md or (idx % progress_interval == 0):
                ratio = idx / total_md if total_md else 1.0
                set_progress(28 + ratio * 22)
                set_status(f"청킹/필터링 중... ({idx}/{total_md})")

        extracted_page_numbers = {
            page.page_num for page in pages if page.page_num is not None
        }
        total_pages = (
            pdf_analysis.total_pages
            if pdf_analysis is not None
            else (max(extracted_page_numbers) if extracted_page_numbers else len(pages))
        )
        extracted_pages = (
            len(extracted_page_numbers) if extracted_page_numbers else len(pages)
        )
        preview = IngestionPreview(
            source_name=source_name,
            parser_name=parser_name,
            converted_from_office=prepared.converted_from_office,
            total_pages=total_pages,
            extracted_pages=extracted_pages,
            low_text_pages=pdf_analysis.low_text_pages if pdf_analysis else (),
            total_characters=total_characters,
            chunk_count=len(final_docs),
            file_hash=file_hash,
            samples=tuple(doc.page_content[:700] for doc in final_docs[:3]),
        )
        log(f"✅ 필터링 완료! 총 {len(final_docs)}개 유효 청크 생성됨")
        set_progress(50)
        set_status("품질 미리보기 확인 대기 중...")
        if preview_cb is not None and not preview_cb(preview):
            raise IngestionCancelled("사용자가 품질 미리보기에서 적재를 취소했습니다.")

        if not final_docs:
            total_elapsed = time.perf_counter() - pipeline_start
            set_progress(100)
            set_status("유효 청크 없음")
            return {
                "uploaded_chunks": 0,
                "total_chunks": 0,
                "upload_seconds": 0.0,
                "total_seconds": total_elapsed,
                "preview": preview,
            }

        try:
            set_status("임베딩 계약 확인 중...")
            ensure_embedding_contract()
            log(
                "✅ DB 임베딩 계약 확인: "
                f"{EMBEDDING_PROVIDER}/{EMBEDDING_MODEL_NAME}/"
                f"{EMBEDDING_DIMENSIONS}d/{EMBEDDING_VERSION}"
            )
            set_progress(52)

            set_status("자료실 원본 연결 중...")
            if register_source and prepared.viewer_pdf_path is not None:
                source_link = ensure_source_document(
                    prepared,
                    category_name,
                    file_hash,
                    log_cb=log,
                )
                document_id = source_link.document_id if source_link else None
            else:
                if register_source:
                    log("ℹ️ 이 파일 형식은 열람용 PDF가 없어 기존 자료실 연결만 확인합니다.")
                document_id = find_linked_document_id(source_name, category_name)

            if document_id is not None:
                for doc in final_docs:
                    doc.metadata["document_id"] = document_id
            set_progress(56)

            total_batches = math.ceil(len(final_docs) / UPLOAD_BATCH_SIZE)
            set_status(f"임베딩/스테이징 중... (0/{total_batches} 배치)")
            upload_start = time.perf_counter()
            for batch_idx, start in enumerate(
                tqdm(
                    range(0, len(final_docs), UPLOAD_BATCH_SIZE),
                    desc="🧠 임베딩/스테이징",
                ),
                start=1,
            ):
                batch = final_docs[start : start + UPLOAD_BATCH_SIZE]
                vectors = embeddings.embed_documents(
                    [doc.page_content for doc in batch]
                )
                rows = []
                for offset, (doc, vector) in enumerate(zip(batch, vectors)):
                    absolute_index = start + offset
                    rows.append(
                        {
                            "id": str(uuid.uuid5(ingestion_id, str(absolute_index))),
                            "content": doc.page_content,
                            "metadata": doc.metadata,
                            "embedding": to_pgvector(vector),
                            "ingestion_id": str(ingestion_id),
                            "is_active": False,
                        }
                    )

                execute_with_retry(
                    f"{batch_idx}번 배치 스테이징",
                    lambda rows=rows: supabase.table(TABLE_NAME).upsert(
                        rows, on_conflict="id"
                    ),
                )
                staged_count += len(rows)
                ratio = batch_idx / total_batches if total_batches else 1.0
                set_progress(56 + ratio * 38)
                set_status(
                    f"임베딩/스테이징 중... ({batch_idx}/{total_batches} 배치, "
                    f"{staged_count}/{len(final_docs)} 청크)"
                )

            set_status("스테이징 검증 및 활성화 중...")
            activated_count = activate_ingestion(
                ingestion_id=ingestion_id,
                category_name=category_name,
                year_name=year_name,
                source_name=source_name,
                expected_count=len(final_docs),
                replace_existing=should_delete,
            )
            if activated_count != len(final_docs):
                raise RuntimeError("활성화 청크 수가 생성 청크 수와 다릅니다.")
        except Exception:
            if staged_count > 0:
                try:
                    cleanup_staged_ingestion(ingestion_id)
                    log(f"🧹 실패한 스테이징 데이터 정리 완료: ingestion_id={ingestion_id}")
                except Exception as cleanup_error:
                    log(
                        "⚠️ 스테이징 자동 정리 실패. 관리자 확인 필요: "
                        f"ingestion_id={ingestion_id}, error={cleanup_error}"
                    )
            if source_link is not None:
                try:
                    rollback_source_document_link(source_link)
                    log("🧹 자료실 원본 연결 롤백 완료")
                except Exception as rollback_error:
                    log(f"⚠️ 자료실 원본 연결 롤백 실패. 관리자 확인 필요: {rollback_error}")
            raise

        finalize_source_document_link(source_link, log_cb=log)
        upload_elapsed = time.perf_counter() - upload_start

    total_elapsed = time.perf_counter() - pipeline_start
    log(f"✅ 검증/활성화 완료: ingestion_id={ingestion_id}")
    log(f"⏱️ 임베딩·업로드·활성화 소요: {upload_elapsed:.2f}초")
    log(f"⏱️ 전체 파이프라인 소요: {total_elapsed:.2f}초")
    set_progress(100)
    set_status("완료")

    return {
        "uploaded_chunks": len(final_docs),
        "total_chunks": len(final_docs),
        "upload_seconds": upload_elapsed,
        "total_seconds": total_elapsed,
        "ingestion_id": str(ingestion_id),
        "document_id": source_link.document_id if source_link else document_id,
        "preview": preview,
    }


# =========================
# ✅ 3. GUI 클래스
# =========================
class ToggleControl(tk.Frame):
    """Canvas로 그린 키보드 접근 가능한 이진 토글."""

    def __init__(
        self,
        parent,
        text,
        variable,
        *,
        font,
        background,
        foreground,
        muted,
        accent,
        line,
    ):
        super().__init__(parent, bg=background)
        self.variable = variable
        self.enabled = True
        self.background = background
        self.foreground = foreground
        self.muted = muted
        self.accent = accent
        self.line = line

        self.canvas = tk.Canvas(
            self,
            width=38,
            height=22,
            bg=background,
            highlightthickness=1,
            highlightbackground=background,
            takefocus=1,
        )
        self.canvas.pack(side="left")
        self.label = tk.Label(
            self,
            text=text,
            bg=background,
            fg=foreground,
            font=font,
            cursor="hand2",
        )
        self.label.pack(side="left", padx=(8, 0))

        self.canvas.bind("<Button-1>", self._toggle)
        self.label.bind("<Button-1>", self._toggle)
        self.canvas.bind("<space>", self._toggle)
        self.canvas.bind("<Return>", self._toggle)
        self.canvas.bind("<FocusIn>", lambda _event: self._draw())
        self.canvas.bind("<FocusOut>", lambda _event: self._draw())
        self.variable.trace_add("write", lambda *_args: self._draw())
        self._draw()

    def _toggle(self, _event=None):
        if not self.enabled:
            return "break"
        self.variable.set(not self.variable.get())
        self.canvas.focus_set()
        return "break"

    def _draw(self):
        self.canvas.delete("all")
        selected = bool(self.variable.get())
        if selected:
            track = self.accent if self.enabled else "#d9a3a0"
        else:
            track = self.line
        knob_x = 19 if selected else 3
        self.canvas.create_oval(2, 3, 20, 19, fill=track, outline=track)
        self.canvas.create_oval(18, 3, 36, 19, fill=track, outline=track)
        self.canvas.create_rectangle(11, 3, 27, 19, fill=track, outline=track)
        self.canvas.create_oval(
            knob_x,
            4,
            knob_x + 15,
            18,
            fill="white",
            outline="#c5cdd3",
        )
        if self.canvas.focus_get() == self.canvas:
            self.canvas.configure(highlightbackground=self.accent)
        else:
            self.canvas.configure(highlightbackground=self.background)

    def set_enabled(self, enabled):
        self.enabled = bool(enabled)
        self.label.config(
            fg=self.foreground if self.enabled else self.muted,
            cursor="hand2" if self.enabled else "arrow",
        )
        self.canvas.config(
            cursor="hand2" if self.enabled else "arrow",
            takefocus=1 if self.enabled else 0,
        )
        self._draw()


class RAGIngestionGUI:
    # 현장 지휘 콘솔을 모티프로 한 중립색 + 신호색 팔레트.
    NAVY = "#153247"
    NAVY_DEEP = "#0f2534"
    NAVY_SUB = "#b9c8d2"
    RED = "#d6372d"
    RED_DARK = "#b52a22"
    AMBER = "#e9aa32"
    SUCCESS = "#17836d"
    ERROR = "#c73535"
    BG = "#eef2f5"
    CARD = "#ffffff"
    SOFT = "#f6f8fa"
    INK = "#17232d"
    MUTED = "#667480"
    LINE = "#d7dfe5"
    LOG_BG = "#101d26"
    LOG_TEXT = "#d8e1e7"
    FONT = "Malgun Gothic"
    MONO_FONT = "Consolas"

    def __init__(self):
        self.root = tk.Tk()
        self.FONT = self._resolve_font(
            ("Pretendard", "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR"),
            self.FONT,
        )
        self.MONO_FONT = self._resolve_font(
            ("SF Mono", "Menlo", "Consolas", "DejaVu Sans Mono"),
            self.MONO_FONT,
        )
        self.root.title("전북소방 교육자료 적재 콘솔")
        self.root.minsize(680, 740)
        self.root.configure(bg=self.BG)
        self.file_path = ""
        self.category = ""
        self.year = ""
        self.should_delete = False
        self.register_source = True
        self.is_running = False
        self.ui_queue = queue.Queue()

        self._init_style()

        # 지휘 콘솔 헤더: 신호색 스트립은 적재 작업의 경계만 표시한다.
        header = tk.Frame(self.root, bg=self.NAVY_DEEP)
        header.pack(fill="x")
        tk.Frame(header, bg=self.RED, width=6).pack(side="left", fill="y")
        header_content = tk.Frame(header, bg=self.NAVY_DEEP)
        header_content.pack(fill="x", padx=22, pady=15)

        header_top = tk.Frame(header_content, bg=self.NAVY_DEEP)
        header_top.pack(fill="x")
        tk.Label(
            header_top,
            text="JEONBUK FIRE SERVICE  /  RESCUE AI",
            bg=self.NAVY_DEEP,
            fg=self.AMBER,
            font=(self.MONO_FONT, 8, "bold"),
        ).pack(side="left")
        self.header_status_label = tk.Label(
            header_top,
            text="대기",
            width=7,
            bg="#27485c",
            fg="#e7eef2",
            font=(self.FONT, 8, "bold"),
            padx=8,
            pady=4,
        )
        self.header_status_label.pack(side="right")

        tk.Label(
            header_content,
            text="교육자료 적재 콘솔",
            bg=self.NAVY_DEEP,
            fg="white",
            font=(self.FONT, 19, "bold"),
        ).pack(anchor="w", pady=(5, 1))
        tk.Label(
            header_content,
            text=(
                f"{TABLE_NAME}  ·  {EMBEDDING_PROVIDER.upper()}  ·  "
                f"{EMBEDDING_MODEL_NAME}  ·  {EMBEDDING_DIMENSIONS}D"
            ),
            bg=self.NAVY_DEEP,
            fg=self.NAVY_SUB,
            font=(self.MONO_FONT, 8),
        ).pack(anchor="w")

        body = tk.Frame(self.root, bg=self.BG)
        body.pack(fill="both", expand=True, padx=18, pady=(16, 18))

        settings_panel = tk.Frame(
            body,
            bg=self.CARD,
            highlightbackground=self.LINE,
            highlightthickness=1,
        )
        settings_panel.pack(fill="x")

        panel_header = tk.Frame(settings_panel, bg=self.CARD)
        panel_header.pack(fill="x", padx=18, pady=(14, 12))
        tk.Label(
            panel_header,
            text="적재 설정",
            bg=self.CARD,
            fg=self.INK,
            font=(self.FONT, 12, "bold"),
        ).pack(side="left")
        tk.Label(
            panel_header,
            text="3단계 검토",
            bg=self.CARD,
            fg=self.MUTED,
            font=(self.FONT, 8),
        ).pack(side="right")
        self._add_divider(settings_panel)

        # 01. 원본 파일
        file_section = tk.Frame(settings_panel, bg=self.CARD)
        file_section.pack(fill="x", padx=18, pady=13)
        self._build_step_label(file_section, "01", "원본 파일").pack(
            side="left", anchor="n"
        )
        file_content = tk.Frame(file_section, bg=self.CARD)
        file_content.pack(side="left", fill="x", expand=True)
        file_box = tk.Frame(
            file_content,
            bg=self.SOFT,
            highlightbackground=self.LINE,
            highlightthickness=1,
        )
        file_box.pack(fill="x")
        self.file_label = tk.Label(
            file_box,
            text="선택된 파일 없음",
            bg=self.SOFT,
            fg=self.MUTED,
            anchor="w",
            font=(self.FONT, 9),
            padx=12,
        )
        self.file_label.pack(side="left", fill="x", expand=True, ipady=10)
        self.file_btn = ttk.Button(
            file_box,
            text="파일 선택",
            command=self.browse_file,
            style="Secondary.TButton",
        )
        self.file_btn.pack(side="right", padx=6, pady=6)
        self.file_meta_label = tk.Label(
            file_content,
            text="PDF · HWPX · HWP · DOCX · PPTX · 이미지",
            bg=self.CARD,
            fg=self.MUTED,
            font=(self.FONT, 8),
        )
        self.file_meta_label.pack(anchor="w", pady=(5, 0))
        self._add_divider(settings_panel)

        # 02. 분류 정보
        classify_section = tk.Frame(settings_panel, bg=self.CARD)
        classify_section.pack(fill="x", padx=18, pady=13)
        self._build_step_label(classify_section, "02", "분류 정보").pack(
            side="left", anchor="n"
        )
        classify_content = tk.Frame(classify_section, bg=self.CARD)
        classify_content.pack(side="left", fill="x", expand=True)
        classify_content.grid_columnconfigure(0, weight=1)
        tk.Label(
            classify_content,
            text="분야",
            bg=self.CARD,
            fg=self.MUTED,
            font=(self.FONT, 8, "bold"),
        ).grid(row=0, column=0, sticky="w", pady=(0, 5))
        tk.Label(
            classify_content,
            text="연도",
            bg=self.CARD,
            fg=self.MUTED,
            font=(self.FONT, 8, "bold"),
        ).grid(row=0, column=1, sticky="w", padx=(12, 0), pady=(0, 5))
        # 표준 분야만 선택하게 해 메타데이터 오타로 필터에서 자료가 사라지는 일을 막는다.
        self.cat_entry = ttk.Combobox(
            classify_content,
            values=EDU_CATEGORIES,
            font=(self.FONT, 9),
            state="readonly",
            style="Field.TCombobox",
        )
        self.cat_entry.set("현장지휘·공통")
        self.cat_entry.grid(row=1, column=0, sticky="ew")
        self.year_entry = ttk.Entry(
            classify_content,
            width=10,
            font=(self.FONT, 9),
            justify="center",
            style="Field.TEntry",
        )
        self.year_entry.insert(0, str(datetime.now().year))
        self.year_entry.grid(row=1, column=1, sticky="ew", padx=(12, 0))
        self._add_divider(settings_panel)

        # 03. 반영 방식
        option_section = tk.Frame(settings_panel, bg=self.CARD)
        option_section.pack(fill="x", padx=18, pady=13)
        self._build_step_label(option_section, "03", "반영 방식").pack(
            side="left", anchor="n"
        )
        option_content = tk.Frame(option_section, bg=self.CARD)
        option_content.pack(side="left", fill="x", expand=True)
        self.delete_var = tk.BooleanVar(value=True)
        self.delete_check = ToggleControl(
            option_content,
            text="검증 완료 후 동일 자료의 이전 버전 교체",
            variable=self.delete_var,
            font=(self.FONT, 9),
            background=self.CARD,
            foreground=self.INK,
            muted="#9ca6ae",
            accent=self.RED,
            line="#aeb9c1",
        )
        self.delete_check.pack(anchor="w")
        self.register_source_var = tk.BooleanVar(value=True)
        self.register_source_check = ToggleControl(
            option_content,
            text="열람용 PDF를 자료실 원본에 자동 연결",
            variable=self.register_source_var,
            font=(self.FONT, 9),
            background=self.CARD,
            foreground=self.INK,
            muted="#9ca6ae",
            accent=self.RED,
            line="#aeb9c1",
        )
        self.register_source_check.pack(anchor="w", pady=(6, 0))

        actions = tk.Frame(body, bg=self.BG)
        actions.pack(fill="x", pady=13)
        actions.grid_columnconfigure(0, weight=1)
        self.start_btn = ttk.Button(
            actions,
            text="품질 검토 시작",
            command=self.start_process,
            style="Primary.TButton",
        )
        self.start_btn.grid(row=0, column=0, sticky="ew")
        self.overview_btn = ttk.Button(
            actions,
            text="적재 현황",
            command=self.show_table_overview,
            style="Secondary.TButton",
        )
        self.overview_btn.grid(row=0, column=1, padx=(10, 0), sticky="ew")

        activity_panel = tk.Frame(
            body,
            bg=self.CARD,
            highlightbackground=self.LINE,
            highlightthickness=1,
        )
        activity_panel.pack(fill="both", expand=True)
        activity_header = tk.Frame(activity_panel, bg=self.CARD)
        activity_header.pack(fill="x", padx=16, pady=(13, 8))
        self.status_dot = tk.Canvas(
            activity_header,
            width=10,
            height=10,
            bg=self.CARD,
            highlightthickness=0,
        )
        self.status_dot.create_oval(2, 2, 8, 8, fill=self.MUTED, outline="")
        self.status_dot.pack(side="left", padx=(0, 7))
        self.status_var = tk.StringVar(value="문서 선택 대기")
        self.status_label = tk.Label(
            activity_header,
            textvariable=self.status_var,
            bg=self.CARD,
            fg=self.INK,
            font=(self.FONT, 9, "bold"),
        )
        self.status_label.pack(side="left")
        self.progress_pct_label = tk.Label(
            activity_header,
            text="0%",
            bg=self.CARD,
            fg=self.MUTED,
            font=(self.MONO_FONT, 9, "bold"),
        )
        self.progress_pct_label.pack(side="right")
        self.progress_var = tk.DoubleVar(value=0.0)
        self.progress_bar = ttk.Progressbar(
            activity_panel,
            orient="horizontal",
            mode="determinate",
            maximum=100,
            variable=self.progress_var,
            style="Signal.Horizontal.TProgressbar",
        )
        self.progress_bar.pack(fill="x", padx=16, pady=(0, 11))

        log_header = tk.Frame(activity_panel, bg=self.SOFT)
        log_header.pack(fill="x", padx=16)
        tk.Label(
            log_header,
            text="작업 로그",
            bg=self.SOFT,
            fg=self.MUTED,
            font=(self.FONT, 8, "bold"),
        ).pack(side="left", padx=10, pady=7)
        tk.Label(
            log_header,
            text="실시간",
            bg=self.SOFT,
            fg=self.MUTED,
            font=(self.MONO_FONT, 7),
        ).pack(side="right", padx=10)

        self.log_widget = tk.Text(
            activity_panel,
            height=8,
            wrap="word",
            state="disabled",
            bg=self.LOG_BG,
            fg=self.LOG_TEXT,
            insertbackground=self.LOG_TEXT,
            selectbackground="#355a70",
            relief="flat",
            font=(self.MONO_FONT, 8),
            padx=12,
            pady=10,
            spacing1=1,
            spacing3=2,
        )
        self.log_widget.pack(fill="both", expand=True, padx=16, pady=(0, 16))
        self.log_widget.tag_configure("success", foreground="#69d0ae")
        self.log_widget.tag_configure("warning", foreground="#f0bd5b")
        self.log_widget.tag_configure("error", foreground="#ff8b84")
        self.log_widget.tag_configure("info", foreground="#8ebbd6")
        self.log_widget.tag_configure("divider", foreground="#536773")

        self._center_window(760, 860)

    def _init_style(self):
        """플랫폼 기본 테마 편차를 줄이는 운영 콘솔용 ttk 스타일."""
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass

        style.configure(
            "Primary.TButton",
            font=(self.FONT, 10, "bold"),
            padding=(14, 10),
            background=self.RED,
            foreground="white",
            bordercolor=self.RED,
            lightcolor=self.RED,
            darkcolor=self.RED,
            borderwidth=1,
            focusthickness=2,
            focuscolor=self.AMBER,
        )
        style.map(
            "Primary.TButton",
            background=[
                ("pressed", self.RED_DARK),
                ("active", self.RED_DARK),
                ("disabled", "#d9a3a0"),
            ],
            foreground=[("disabled", "#f7e9e8")],
            bordercolor=[
                ("pressed", self.RED_DARK),
                ("active", self.RED_DARK),
                ("disabled", "#d9a3a0"),
            ],
        )
        style.configure(
            "Secondary.TButton",
            font=(self.FONT, 9, "bold"),
            padding=(12, 9),
            background=self.CARD,
            foreground=self.INK,
            bordercolor=self.LINE,
            lightcolor=self.CARD,
            darkcolor=self.CARD,
            borderwidth=1,
            focusthickness=2,
            focuscolor=self.RED,
        )
        style.map(
            "Secondary.TButton",
            background=[
                ("pressed", "#e8edf1"),
                ("active", self.SOFT),
                ("disabled", "#f1f3f5"),
            ],
            foreground=[("disabled", "#9ca6ae")],
            bordercolor=[("active", "#aebbc4")],
        )
        style.configure(
            "Field.TCombobox",
            font=(self.FONT, 9),
            padding=(9, 8),
            fieldbackground=self.CARD,
            background=self.CARD,
            foreground=self.INK,
            bordercolor=self.LINE,
            lightcolor=self.CARD,
            darkcolor=self.CARD,
            arrowcolor=self.MUTED,
            borderwidth=1,
        )
        style.map(
            "Field.TCombobox",
            fieldbackground=[("readonly", self.CARD), ("disabled", "#f1f3f5")],
            foreground=[("readonly", self.INK), ("disabled", "#9ca6ae")],
            bordercolor=[("focus", self.RED)],
        )
        style.configure(
            "Field.TEntry",
            font=(self.FONT, 9),
            padding=(9, 8),
            fieldbackground=self.CARD,
            foreground=self.INK,
            bordercolor=self.LINE,
            lightcolor=self.CARD,
            darkcolor=self.CARD,
            borderwidth=1,
        )
        style.map(
            "Field.TEntry",
            fieldbackground=[("disabled", "#f1f3f5")],
            foreground=[("disabled", "#9ca6ae")],
            bordercolor=[("focus", self.RED)],
        )
        style.configure(
            "Signal.Horizontal.TProgressbar",
            troughcolor="#e4e9ed",
            background=self.RED,
            bordercolor="#e4e9ed",
            lightcolor=self.RED,
            darkcolor=self.RED,
            thickness=8,
        )
        style.configure(
            "Vertical.TScrollbar",
            background="#c7d0d6",
            troughcolor=self.SOFT,
            bordercolor=self.SOFT,
            arrowcolor=self.MUTED,
        )

    def _resolve_font(self, candidates, fallback):
        try:
            installed = set(tkfont.families(self.root))
        except tk.TclError:
            return fallback
        return next((font for font in candidates if font in installed), fallback)

    def _center_window(self, width, height):
        self.root.update_idletasks()
        screen_width = self.root.winfo_screenwidth()
        screen_height = self.root.winfo_screenheight()
        x = max(0, (screen_width - width) // 2)
        y = max(24, (screen_height - height) // 2)
        self.root.geometry(f"{width}x{height}+{x}+{y}")

    def _center_popup(self, popup, width, height):
        self.root.update_idletasks()
        root_x = self.root.winfo_rootx()
        root_y = self.root.winfo_rooty()
        root_width = self.root.winfo_width()
        root_height = self.root.winfo_height()
        x = root_x + max(0, (root_width - width) // 2)
        y = root_y + max(0, (root_height - height) // 2)
        popup.geometry(f"{width}x{height}+{x}+{y}")

    def _build_step_label(self, parent, number, title):
        container = tk.Frame(parent, bg=self.CARD, width=108, height=46)
        container.pack_propagate(False)
        tk.Label(
            container,
            text=number,
            bg=self.CARD,
            fg=self.RED,
            font=(self.MONO_FONT, 9, "bold"),
        ).pack(anchor="w")
        tk.Label(
            container,
            text=title,
            bg=self.CARD,
            fg=self.INK,
            font=(self.FONT, 9, "bold"),
        ).pack(anchor="w", pady=(2, 0))
        return container

    def _add_divider(self, parent):
        tk.Frame(parent, bg=self.LINE, height=1).pack(fill="x")

    @staticmethod
    def _format_file_size(size_bytes):
        size = float(size_bytes)
        for unit in ("B", "KB", "MB", "GB"):
            if size < 1024 or unit == "GB":
                return f"{size:.0f} {unit}" if unit == "B" else f"{size:.1f} {unit}"
            size /= 1024
        return f"{size_bytes} B"

    @staticmethod
    def _compact_filename(filename, max_length=52):
        if len(filename) <= max_length:
            return filename
        suffix_length = 16
        return f"{filename[: max_length - suffix_length - 1]}…{filename[-suffix_length:]}"

    def browse_file(self):
        # macOS Cocoa 파일 대화상자는 세미콜론 묶음("*.pdf;*.docx")·"*.*" 를 UTI로 변환 못해
        # NSInvalidArgumentException(object cannot be nil)으로 크래시한다. 확장자는 튜플로, All은 "*".
        self.file_path = filedialog.askopenfilename(
            filetypes=[
                ("지원되는 파일", ("*.pdf", "*.hwpx", "*.hwp", "*.docx", "*.pptx",
                                "*.txt", "*.md", "*.html", "*.htm", "*.jpg", "*.png",
                                "*.jpeg", "*.bmp", "*.tiff")),
                ("PDF 문서", "*.pdf"),
                ("한글 문서", ("*.hwpx", "*.hwp")),
                ("Word 문서", "*.docx"),
                ("PowerPoint 문서", "*.pptx"),
                ("텍스트 문서", ("*.txt", "*.md")),
                ("HTML 문서", ("*.html", "*.htm")),
                ("이미지", ("*.jpg", "*.jpeg", "*.png", "*.bmp", "*.tiff")),
                ("모든 파일", "*"),
            ]
        )
        if self.file_path:
            selected = Path(self.file_path)
            self.file_label.config(
                text=self._compact_filename(selected.name),
                fg=self.INK,
            )
            self.file_meta_label.config(
                text=(
                    f"{selected.suffix.upper().lstrip('.') or 'FILE'}  ·  "
                    f"{self._format_file_size(selected.stat().st_size)}"
                ),
                fg=self.MUTED,
            )
            self._set_status("품질 검토 준비 완료")

    def start_process(self):
        if self.is_running:
            return

        self.category = self.cat_entry.get().strip()
        self.year = self.year_entry.get().strip()
        self.should_delete = self.delete_var.get()
        self.register_source = self.register_source_var.get()
        if not self.category or not self.year or not self.file_path:
            messagebox.showwarning(
                "입력 확인",
                "원본 파일, 분야, 연도를 모두 지정하세요.",
                parent=self.root,
            )
            return
        if not re.fullmatch(r"(19|20)\d{2}", self.year):
            messagebox.showwarning(
                "연도 확인",
                "연도는 네 자리 숫자로 입력하세요. 예: 2026",
                parent=self.root,
            )
            self.year_entry.focus_set()
            return
        if not Path(self.file_path).is_file():
            messagebox.showwarning(
                "파일 확인",
                "선택한 원본 파일을 찾을 수 없습니다. 파일을 다시 선택하세요.",
                parent=self.root,
            )
            return

        self.is_running = True
        self._set_controls_enabled(False)
        self._set_status("작업 시작 준비 중...")
        self._set_progress(0.0)
        self._append_log("=" * 60)
        self._append_log(
            f"[시작] 파일={os.path.basename(self.file_path)}, category={self.category}, year={self.year}"
        )

        worker = threading.Thread(
            target=self._run_pipeline_worker,
            args=(
                self.file_path,
                self.category,
                self.year,
                self.should_delete,
                self.register_source,
            ),
            daemon=True,
        )
        worker.start()
        self.root.after(100, self._drain_ui_queue)

    def show_table_overview(self):
        if self.is_running:
            messagebox.showwarning(
                "작업 진행 중",
                "현재 적재 작업이 끝난 뒤 현황을 확인하세요.",
                parent=self.root,
            )
            return
        try:
            self.root.config(cursor="watch")
            self.root.update_idletasks()
            summary_text = build_table_metadata_summary(max_rows=5000, page_size=1000)
            self._show_text_popup(f"'{TABLE_NAME}' 메타태그 현황", summary_text)
        except Exception as e:
            messagebox.showerror(
                "현황 조회 실패",
                f"적재 현황을 불러오지 못했습니다.\n\n{e}",
                parent=self.root,
            )
        finally:
            self.root.config(cursor="")

    def _show_text_popup(self, title, text):
        popup = tk.Toplevel(self.root)
        popup.title(title)
        popup.transient(self.root)
        popup.configure(bg=self.BG)

        header = tk.Frame(popup, bg=self.NAVY_DEEP)
        header.pack(fill="x")
        tk.Frame(header, bg=self.RED, width=5).pack(side="left", fill="y")
        tk.Label(
            header,
            text="적재 현황",
            bg=self.NAVY_DEEP,
            fg="white",
            font=(self.FONT, 15, "bold"),
        ).pack(side="left", padx=18, pady=16)
        tk.Label(
            header,
            text=TABLE_NAME,
            bg=self.NAVY_DEEP,
            fg=self.NAVY_SUB,
            font=(self.MONO_FONT, 8),
        ).pack(side="right", padx=18)

        content = tk.Frame(popup, bg=self.BG)
        content.pack(fill="both", expand=True, padx=16, pady=(16, 10))
        text_widget = tk.Text(
            content,
            wrap="word",
            bg=self.CARD,
            fg=self.INK,
            relief="flat",
            highlightbackground=self.LINE,
            highlightthickness=1,
            font=(self.MONO_FONT, 9),
            padx=14,
            pady=12,
            spacing3=2,
        )
        scrollbar = ttk.Scrollbar(
            content,
            command=text_widget.yview,
            style="Vertical.TScrollbar",
        )
        text_widget.configure(yscrollcommand=scrollbar.set)
        text_widget.insert("1.0", text)
        text_widget.config(state="disabled")
        text_widget.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        actions = tk.Frame(popup, bg=self.BG)
        actions.pack(fill="x", padx=16, pady=(0, 16))
        ttk.Button(
            actions,
            text="닫기",
            command=popup.destroy,
            style="Secondary.TButton",
        ).pack(side="right")

        popup.bind("<Escape>", lambda _event: popup.destroy())
        self._center_popup(popup, 720, 560)

    def _show_preview_confirmation(self, preview):
        approved = {"value": False}
        popup = tk.Toplevel(self.root)
        popup.title("적재 전 품질 검토")
        popup.minsize(680, 600)
        popup.transient(self.root)
        popup.configure(bg=self.BG)

        header = tk.Frame(popup, bg=self.NAVY_DEEP)
        header.pack(fill="x")
        tk.Frame(header, bg=self.RED, width=5).pack(side="left", fill="y")
        header_content = tk.Frame(header, bg=self.NAVY_DEEP)
        header_content.pack(fill="x", padx=18, pady=15)
        tk.Label(
            header_content,
            text="적재 전 품질 검토",
            bg=self.NAVY_DEEP,
            fg="white",
            font=(self.FONT, 15, "bold"),
        ).pack(anchor="w")
        tk.Label(
            header_content,
            text="승인하기 전에는 자료실과 검색 데이터가 변경되지 않습니다.",
            bg=self.NAVY_DEEP,
            fg=self.NAVY_SUB,
            font=(self.FONT, 8),
        ).pack(anchor="w", pady=(3, 0))

        content = tk.Frame(popup, bg=self.BG)
        content.pack(fill="both", expand=True, padx=16, pady=(16, 10))

        metrics = tk.Frame(
            content,
            bg=self.CARD,
            highlightbackground=self.LINE,
            highlightthickness=1,
        )
        metrics.pack(fill="x")
        metric_items = (
            ("추출 페이지", f"{preview.extracted_pages:,} / {preview.total_pages:,}"),
            ("문자", f"{preview.total_characters:,}"),
            ("청크", f"{preview.chunk_count:,}"),
            ("OCR 대상", f"{len(preview.low_text_pages):,}"),
        )
        for index, (label, value) in enumerate(metric_items):
            if index:
                tk.Frame(metrics, bg=self.LINE, width=1).pack(
                    side="left", fill="y", pady=12
                )
            metric = tk.Frame(metrics, bg=self.CARD)
            metric.pack(side="left", fill="x", expand=True, padx=12, pady=11)
            tk.Label(
                metric,
                text=value,
                bg=self.CARD,
                fg=self.INK,
                font=(self.MONO_FONT, 13, "bold"),
            ).pack(anchor="w")
            tk.Label(
                metric,
                text=label,
                bg=self.CARD,
                fg=self.MUTED,
                font=(self.FONT, 8),
            ).pack(anchor="w", pady=(2, 0))

        quality_bg = "#fff6df" if preview.low_text_pages else "#eaf6f2"
        quality_fg = "#8a5d08" if preview.low_text_pages else self.SUCCESS
        if preview.chunk_count == 0:
            quality_bg = "#fdeceb"
            quality_fg = self.ERROR
            quality_text = "유효 청크가 없어 적재할 수 없습니다."
        elif preview.low_text_pages:
            quality_text = (
                f"OCR 대상 페이지 {len(preview.low_text_pages)}개가 포함되어 있습니다."
            )
        else:
            quality_text = "페이지 텍스트층이 안정적으로 확인됐습니다."
        tk.Label(
            content,
            text=quality_text,
            bg=quality_bg,
            fg=quality_fg,
            anchor="w",
            font=(self.FONT, 8, "bold"),
            padx=12,
            pady=8,
        ).pack(fill="x", pady=(10, 10))

        file_row = tk.Frame(content, bg=self.BG)
        file_row.pack(fill="x", pady=(0, 7))
        tk.Label(
            file_row,
            text=self._compact_filename(preview.source_name, 64),
            bg=self.BG,
            fg=self.INK,
            font=(self.FONT, 9, "bold"),
        ).pack(side="left")
        tk.Label(
            file_row,
            text=preview.parser_name,
            bg=self.BG,
            fg=self.MUTED,
            font=(self.MONO_FONT, 8),
        ).pack(side="right")

        samples = []
        for index, sample in enumerate(preview.samples, start=1):
            samples.extend((f"[샘플 {index}]", sample.strip(), ""))
        if not samples:
            samples.append("추출된 청크 샘플이 없습니다.")
        text_widget = tk.Text(
            content,
            wrap="word",
            bg=self.CARD,
            fg=self.INK,
            relief="flat",
            highlightbackground=self.LINE,
            highlightthickness=1,
            font=(self.FONT, 9),
            padx=14,
            pady=12,
            spacing3=2,
        )
        scrollbar = ttk.Scrollbar(
            content,
            command=text_widget.yview,
            style="Vertical.TScrollbar",
        )
        text_widget.configure(yscrollcommand=scrollbar.set)
        text_widget.insert("1.0", "\n".join(samples))
        text_widget.tag_configure(
            "sample_heading",
            foreground=self.RED,
            font=(self.MONO_FONT, 8, "bold"),
        )
        for index in range(1, len(preview.samples) + 1):
            marker = f"[샘플 {index}]"
            start = text_widget.search(marker, "1.0", stopindex="end")
            if start:
                text_widget.tag_add(
                    "sample_heading",
                    start,
                    f"{start}+{len(marker)}c",
                )
        text_widget.config(state="disabled")
        text_widget.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        actions = tk.Frame(popup, bg=self.BG)
        actions.pack(fill="x", padx=16, pady=(0, 16))

        def close(value):
            approved["value"] = value
            popup.destroy()

        approve_button = ttk.Button(
            actions,
            text="승인하고 적재",
            command=lambda: close(True),
            style="Primary.TButton",
        )
        approve_button.pack(side="right")
        ttk.Button(
            actions,
            text="취소",
            command=lambda: close(False),
            style="Secondary.TButton",
        ).pack(side="right", padx=(0, 8))
        if preview.chunk_count == 0:
            approve_button.config(state="disabled")

        popup.protocol("WM_DELETE_WINDOW", lambda: close(False))
        popup.bind("<Escape>", lambda _event: close(False))
        if preview.chunk_count > 0:
            popup.bind("<Return>", lambda _event: close(True))
        self._center_popup(popup, 800, 660)
        popup.grab_set()
        approve_button.focus_set()
        self.root.wait_window(popup)
        return approved["value"]

    def _set_controls_enabled(self, enabled):
        state = "normal" if enabled else "disabled"
        self.cat_entry.config(state="readonly" if enabled else "disabled")
        self.year_entry.config(state=state)
        self.file_btn.config(state=state)
        self.start_btn.config(state=state)
        self.overview_btn.config(state=state)
        self.delete_check.set_enabled(enabled)
        self.register_source_check.set_enabled(enabled)
        self.start_btn.config(text="품질 검토 시작" if enabled else "문서 처리 중")

    def _set_status(self, text):
        self.status_var.set(text)
        if any(token in text for token in ("오류", "실패")):
            dot_color = self.ERROR
            badge_bg = self.ERROR
            badge_text = "오류"
        elif "완료" in text:
            dot_color = self.SUCCESS
            badge_bg = self.SUCCESS
            badge_text = "완료"
        elif "취소" in text:
            dot_color = self.AMBER
            badge_bg = "#9a6a12"
            badge_text = "취소"
        elif text == "품질 검토 준비 완료":
            dot_color = self.SUCCESS
            badge_bg = "#276956"
            badge_text = "준비"
        elif self.is_running:
            dot_color = self.RED
            badge_bg = self.RED
            badge_text = "진행"
        else:
            dot_color = self.MUTED
            badge_bg = "#27485c"
            badge_text = "대기"

        self.status_dot.delete("all")
        self.status_dot.create_oval(2, 2, 8, 8, fill=dot_color, outline="")
        self.header_status_label.config(text=badge_text, bg=badge_bg)
        self.root.update_idletasks()

    def _set_progress(self, value):
        value = max(0.0, min(100.0, float(value)))
        self.progress_var.set(value)
        self.progress_pct_label.config(text=f"{value:.0f}%")
        self.root.update_idletasks()

    def _append_log(self, line):
        line = str(line)
        if any(token in line for token in ("[오류]", "❌", "Traceback")):
            tag = "error"
        elif any(token in line for token in ("[완료]", "✅")):
            tag = "success"
        elif any(token in line for token in ("[취소]", "⚠️")):
            tag = "warning"
        elif any(token in line for token in ("[시작]", "ℹ️")):
            tag = "info"
        elif line and set(line) == {"="}:
            tag = "divider"
        else:
            tag = None

        self.log_widget.config(state="normal")
        if tag:
            self.log_widget.insert("end", f"{line}\n", tag)
        else:
            self.log_widget.insert("end", f"{line}\n")
        self.log_widget.see("end")
        self.log_widget.config(state="disabled")

    def _request_preview(self, preview):
        event = threading.Event()
        decision = {}
        self.ui_queue.put(("preview", (preview, event, decision)))
        event.wait()
        return bool(decision.get("approved"))

    def _run_pipeline_worker(
        self,
        pdf_file,
        category_name,
        year_name,
        should_delete,
        register_source,
    ):
        try:
            result = run_ingestion_pipeline(
                pdf_file=pdf_file,
                category_name=category_name,
                year_name=year_name,
                should_delete=should_delete,
                register_source=register_source,
                progress_cb=lambda v: self.ui_queue.put(("progress", v)),
                status_cb=lambda s: self.ui_queue.put(("status", s)),
                log_cb=lambda s: self.ui_queue.put(("log", s)),
                preview_cb=self._request_preview,
            )
            self.ui_queue.put(("done", result))
        except IngestionCancelled as error:
            self.ui_queue.put(("cancelled", str(error)))
        except Exception as e:
            self.ui_queue.put(
                (
                    "error",
                    {
                        "message": str(e),
                        "traceback": traceback.format_exc(),
                    },
                )
            )

    def _drain_ui_queue(self):
        has_done = False
        while True:
            try:
                kind, payload = self.ui_queue.get_nowait()
            except queue.Empty:
                break

            if kind == "progress":
                self._set_progress(payload)
            elif kind == "status":
                self._set_status(payload)
            elif kind == "log":
                self._append_log(payload)
            elif kind == "preview":
                preview, event, decision = payload
                try:
                    decision["approved"] = self._show_preview_confirmation(preview)
                finally:
                    event.set()
            elif kind == "done":
                has_done = True
                self.is_running = False
                self._set_controls_enabled(True)
                self._set_status("완료")
                self._set_progress(100)
                uploaded = payload.get("uploaded_chunks", 0)
                total_seconds = payload.get("total_seconds", 0.0)
                self._append_log(f"[완료] 업로드 청크 수: {uploaded}, 총 소요: {total_seconds:.2f}초")
                if uploaded == 0:
                    messagebox.showwarning(
                        "적재 결과",
                        "적재할 유효 청크가 없습니다. 추출 결과와 원본을 확인하세요.",
                        parent=self.root,
                    )
                else:
                    messagebox.showinfo(
                        "적재 완료",
                        f"검색 자료 적재가 완료됐습니다.\n\n청크 {uploaded:,}개",
                        parent=self.root,
                    )
            elif kind == "cancelled":
                has_done = True
                self.is_running = False
                self._set_controls_enabled(True)
                self._set_status("사용자 취소")
                self._append_log(f"[취소] {payload}")
                messagebox.showinfo(
                    "적재 취소",
                    "품질 검토 단계에서 적재를 취소했습니다.",
                    parent=self.root,
                )
            elif kind == "error":
                has_done = True
                self.is_running = False
                self._set_controls_enabled(True)
                self._set_status("오류 발생")
                message = payload.get("message", "알 수 없는 오류")
                trace = payload.get("traceback", "")
                self._append_log(f"[오류] {message}\n\n{trace}")
                messagebox.showerror(
                    "적재 실패",
                    f"{message}\n\n상세 내용은 작업 로그를 확인하세요.",
                    parent=self.root,
                )

        if self.is_running and not has_done:
            self.root.after(100, self._drain_ui_queue)

    def run(self):
        self.root.mainloop()
        return None

# =========================
# ✅ 4. 핵심 분석 및 업로드 로직 (수정됨)
# =========================
def main():
    gui = RAGIngestionGUI()
    gui.run()

if __name__ == "__main__":
    main()
