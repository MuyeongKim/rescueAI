# -*- coding: utf-8 -*-
import os
import math
import shutil
import subprocess
from collections import Counter
from pathlib import Path
from tqdm import tqdm
from datetime import datetime
import time
import queue
import threading
import traceback
import requests
import tkinter as tk
from tkinter import ttk
from tkinter import filedialog, messagebox

from supabase.client import Client, create_client
from langchain_community.vectorstores import SupabaseVectorStore
from langchain_text_splitters import RecursiveCharacterTextSplitter, MarkdownHeaderTextSplitter
from langchain_core.documents import Document

# Docling 임포트
from docling.document_converter import DocumentConverter

# =========================
# ✅ JSON/임베딩 안전화 유틸
# =========================
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
        embed_instruction="passage: ",
        query_instruction="query: ",
        request_options=None,
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.batch_size = max(1, int(batch_size))
        self.timeout = timeout
        self.embed_instruction = embed_instruction
        self.query_instruction = query_instruction
        self.request_options = request_options or {}
        self.session = requests.Session()
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


class SafeEmbeddings:
    """임베딩 결과의 NaN/Infinity를 0.0으로 치환해 업로드 실패를 방지한다."""

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

    @staticmethod
    def _clean_vector(vector):
        cleaned = []
        for val in vector:
            try:
                num = float(val)
            except (TypeError, ValueError):
                num = 0.0
            if not math.isfinite(num):
                num = 0.0
            cleaned.append(num)
        return cleaned

    def _fit_vector_dim(self, vector):
        if not vector:
            return [0.0] * self.expected_dim
        if self.expected_dim is None:
            self.expected_dim = len(vector)
            return vector
        if len(vector) == self.expected_dim:
            return vector
        if len(vector) > self.expected_dim:
            return vector[: self.expected_dim]
        return vector + [0.0] * (self.expected_dim - len(vector))

    def embed_documents(self, texts):
        safe_texts = [self._normalize_text(text) for text in texts]
        try:
            vectors = self.base_embeddings.embed_documents(safe_texts)
            return [self._fit_vector_dim(self._clean_vector(vec)) for vec in vectors]
        except Exception as batch_error:
            print(f"⚠️ 배치 임베딩 실패, 문서별 재시도 진행: {batch_error}")
            fallback_vectors = []
            for idx, text in enumerate(safe_texts):
                try:
                    vec = self.base_embeddings.embed_query(text)
                    cleaned = self._fit_vector_dim(self._clean_vector(vec))
                    fallback_vectors.append(cleaned)
                except Exception as item_error:
                    print(f"⚠️ 청크 {idx} 임베딩 실패, 0벡터로 대체: {item_error}")
                    fallback_vectors.append([0.0] * self.expected_dim)
            return fallback_vectors

    def embed_query(self, text):
        try:
            vector = self.base_embeddings.embed_query(self._normalize_text(text))
            return self._fit_vector_dim(self._clean_vector(vector))
        except Exception as e:
            print(f"⚠️ 질의 임베딩 실패, 0벡터로 대체: {e}")
            return [0.0] * self.expected_dim


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
QUERY_NAME = "match_rag_rescue"

# 웹앱 분야(edu_category) 표준값 — 생성 페이지·챗봇 분야 필터가 이 값을 사용한다.
# (lib/category.ts 색 지정과도 일치) 새 자료는 이 중에서 고르면 분야 버튼에 바로 나타남.
EDU_CATEGORIES = [
    "화재", "수난", "산악", "구급", "화학사고",
    "드론 운용", "장비 관리", "현장지휘·공통", "복무·행정",
]

# Ollama BGE-M3 임베딩 모델 (1024차원) — 주소도 웹앱과 동일한 EMBEDDING_API_URL 공유
OLLAMA_BASE_URL = os.getenv("EMBEDDING_API_URL", "http://localhost:11434")
OLLAMA_MODEL = os.getenv("EMBEDDING_MODEL", "bge-m3:latest")
EMBED_BATCH_SIZE = 64            # Ollama /api/embed 요청당 텍스트 수
UPLOAD_BATCH_SIZE = 200          # 업로드 루프 배치 크기
SUPABASE_UPSERT_CHUNK_SIZE = 500 # Supabase upsert chunk 크기


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


OLLAMA_REQUEST_OPTIONS = resolve_ollama_request_options(OLLAMA_BASE_URL)

raw_embeddings = FastOllamaEmbeddings(
    model=OLLAMA_MODEL,
    base_url=OLLAMA_BASE_URL,
    batch_size=EMBED_BATCH_SIZE,
    request_options=OLLAMA_REQUEST_OPTIONS,
)
embeddings = SafeEmbeddings(raw_embeddings)
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# =========================
# ✅ 2. DB 관리 함수
# =========================
def delete_category_data(category, year):
    try:
        supabase.table(TABLE_NAME).delete().eq("metadata->>category", category).eq("metadata->>year", year).execute()
        print(f"🗑️ '{category}/{year}' 기존 데이터 삭제 완료")
    except Exception as e:
        print(f"⚠️ 삭제 중 오류: {e}")


def build_table_metadata_summary(max_rows=5000, page_size=1000):
    """테이블 metadata를 읽어 현재 적재된 자료 요약 문자열을 생성한다."""
    total_count = None
    try:
        count_result = supabase.table(TABLE_NAME).select("id", count="exact", head=True).execute()
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
        result = supabase.table(TABLE_NAME).select("metadata").range(start, end).execute()
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
    progress_cb=None,
    status_cb=None,
    log_cb=None,
):
    """분석/청킹/임베딩/업로드 전체 파이프라인을 실행한다."""

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
    set_status("작업 시작")

    if should_delete:
        set_status("기존 데이터 삭제 중...")
        t0 = time.perf_counter()
        delete_category_data(category_name, year_name)
        log(f"⏱️ 삭제 소요: {time.perf_counter() - t0:.2f}초")
    set_progress(8)

    set_status("Docling 문서 분석 중...")
    t0 = time.perf_counter()
    converter = DocumentConverter()
    result = converter.convert(pdf_file)
    full_text = result.document.export_to_markdown()
    log(f"✅ 분석 완료! ({len(full_text)} 자)")
    log(f"⏱️ 문서 변환 소요: {time.perf_counter() - t0:.2f}초")
    set_progress(30)

    markdown_splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=[("#", "Header 1"), ("##", "Header 2"), ("###", "Header 3")],
        strip_headers=False
    )
    md_docs = markdown_splitter.split_text(full_text)

    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=1000,
        chunk_overlap=200,
        separators=["\n\n", "\n", "。", ". ", " ", ""]
    )

    final_docs = []
    upload_date = datetime.now().strftime("%Y-%m-%d")
    total_md = len(md_docs)
    progress_interval = max(1, total_md // 40) if total_md else 1

    set_status(f"청킹/필터링 중... (0/{total_md})")
    for idx, md_doc in enumerate(md_docs, start=1):
        content = md_doc.page_content.strip()
        if content == "" or len(content) < 20:
            pass
        elif content.startswith("## ") and len(content) < 10:
            pass
        elif content.count("··") > 5 or content.count("..") > 5:
            pass
        else:
            chunks = text_splitter.split_text(content)
            for chunk in chunks:
                metadata = {
                    "source": os.path.basename(pdf_file),
                    "category": category_name,      # 원본 분류(기존 n8n 호환)
                    "edu_category": category_name,  # 웹앱 분야 필드 — 생성/챗봇 분야 필터가 사용
                    "year": year_name,
                    "upload_date": upload_date,
                    "parser": "docling",
                }
                metadata.update(md_doc.metadata)
                metadata = sanitize_for_json(metadata)
                final_docs.append(Document(page_content=chunk, metadata=metadata))

        if idx == total_md or (idx % progress_interval == 0):
            ratio = idx / total_md if total_md else 1.0
            set_progress(30 + ratio * 30)
            set_status(f"청킹/필터링 중... ({idx}/{total_md})")

    log(f"✅ 필터링 완료! 총 {len(final_docs)}개 유효 청크 생성됨")
    if not final_docs:
        total_elapsed = time.perf_counter() - pipeline_start
        set_progress(100)
        return {
            "uploaded_chunks": 0,
            "total_chunks": 0,
            "upload_seconds": 0.0,
            "total_seconds": total_elapsed,
        }

    set_status(f"임베딩/업로드 중... (0/{math.ceil(len(final_docs) / UPLOAD_BATCH_SIZE)} 배치)")
    t0 = time.perf_counter()
    vector_store = SupabaseVectorStore(
        client=supabase,
        embedding=embeddings,
        table_name=TABLE_NAME,
        query_name=QUERY_NAME,
        chunk_size=SUPABASE_UPSERT_CHUNK_SIZE,
    )

    total_batches = math.ceil(len(final_docs) / UPLOAD_BATCH_SIZE)
    for batch_idx, start in enumerate(
        tqdm(range(0, len(final_docs), UPLOAD_BATCH_SIZE), desc="📦 업로드"), start=1
    ):
        batch = final_docs[start : start + UPLOAD_BATCH_SIZE]
        vector_store.add_documents(batch)
        ratio = batch_idx / total_batches if total_batches else 1.0
        set_progress(60 + ratio * 40)
        set_status(f"임베딩/업로드 중... ({batch_idx}/{total_batches} 배치)")

    upload_elapsed = time.perf_counter() - t0
    total_elapsed = time.perf_counter() - pipeline_start
    log(f"⏱️ 업로드 소요: {upload_elapsed:.2f}초")
    log(f"⏱️ 전체 파이프라인 소요: {total_elapsed:.2f}초")
    set_progress(100)
    set_status("완료")

    return {
        "uploaded_chunks": len(final_docs),
        "total_chunks": len(final_docs),
        "upload_seconds": upload_elapsed,
        "total_seconds": total_elapsed,
    }


# =========================
# ✅ 3. GUI 클래스 (기존과 동일)
# =========================
class RAGIngestionGUI:
    # 색상 팔레트 (소방 네이비 + 레드 액센트)
    NAVY = "#1f2d3d"
    NAVY_SUB = "#aebfce"
    RED = "#e74c3c"
    RED_DARK = "#c0392b"
    BG = "#eef1f4"
    CARD = "#ffffff"
    INK = "#2c3e50"
    MUTED = "#7f8c8d"
    FONT = "Malgun Gothic"

    def __init__(self):
        self.root = tk.Tk()
        self.root.title("소방 구조 RAG 적재기")
        self.root.geometry("600x830")
        self.root.minsize(560, 720)
        self.root.configure(bg=self.BG)
        self.file_path = ""
        self.category = ""
        self.year = ""
        self.should_delete = False
        self.is_running = False
        self.ui_queue = queue.Queue()

        self._init_style()

        # ── 헤더 ──
        header = tk.Frame(self.root, bg=self.NAVY)
        header.pack(fill="x")
        tk.Label(header, text="🚒  소방 구조 RAG 적재기", bg=self.NAVY, fg="white",
                 font=(self.FONT, 16, "bold")).pack(anchor="w", padx=20, pady=(16, 0))
        tk.Label(header, text="문서를 분석·임베딩해 벡터DB(rag_2026)에 적재합니다",
                 bg=self.NAVY, fg=self.NAVY_SUB, font=(self.FONT, 9)).pack(anchor="w", padx=20, pady=(2, 16))

        # ── 본문 컨테이너 ──
        body = tk.Frame(self.root, bg=self.BG)
        body.pack(fill="both", expand=True, padx=16, pady=14)

        # [카드1] 분야 · 연도
        card1 = ttk.LabelFrame(body, text="  문서 분야 · 연도  ", style="Card.TLabelframe")
        card1.pack(fill="x", pady=(0, 12))
        inner1 = tk.Frame(card1, bg=self.CARD)
        inner1.pack(fill="x", padx=14, pady=12)
        tk.Label(inner1, text="분야 (웹앱 분야로 사용)", bg=self.CARD, fg=self.INK,
                 font=(self.FONT, 9, "bold")).grid(row=0, column=0, sticky="w", pady=(0, 4))
        # 표준 분야 드롭다운(오타·불일치 방지). 필요 시 직접 입력도 허용(편집 가능 콤보).
        self.cat_entry = ttk.Combobox(inner1, width=24, values=EDU_CATEGORIES, font=(self.FONT, 10))
        self.cat_entry.set("현장지휘·공통")
        self.cat_entry.grid(row=1, column=0, sticky="w", padx=(0, 18))
        tk.Label(inner1, text="연도", bg=self.CARD, fg=self.INK,
                 font=(self.FONT, 9, "bold")).grid(row=0, column=1, sticky="w", pady=(0, 4))
        self.year_entry = ttk.Entry(inner1, width=10, font=(self.FONT, 10), justify="center")
        self.year_entry.insert(0, "2026")
        self.year_entry.grid(row=1, column=1, sticky="w")

        # [카드2] 분석할 파일
        card2 = ttk.LabelFrame(body, text="  분석할 파일  ", style="Card.TLabelframe")
        card2.pack(fill="x", pady=(0, 12))
        inner2 = tk.Frame(card2, bg=self.CARD)
        inner2.pack(fill="x", padx=14, pady=12)
        self.file_btn = ttk.Button(inner2, text="📁  파일 선택", command=self.browse_file)
        self.file_btn.pack(side="left")
        self.file_label = tk.Label(inner2, text="선택된 파일 없음", bg=self.CARD, fg=self.MUTED,
                                   font=(self.FONT, 9))
        self.file_label.pack(side="left", padx=12)

        # [카드3] 업로드 옵션
        card3 = ttk.LabelFrame(body, text="  업로드 옵션  ", style="Card.TLabelframe")
        card3.pack(fill="x", pady=(0, 12))
        inner3 = tk.Frame(card3, bg=self.CARD)
        inner3.pack(fill="x", padx=14, pady=10)
        self.delete_var = tk.BooleanVar(value=True)
        tk.Checkbutton(inner3, text="업로드 전 동일 분야/연도 데이터 삭제 (중복 방지)",
                       variable=self.delete_var, bg=self.CARD, fg=self.RED_DARK,
                       activebackground=self.CARD, selectcolor="white",
                       font=(self.FONT, 9)).pack(anchor="w")

        # ── 액션 버튼 ──
        actions = tk.Frame(body, bg=self.BG)
        actions.pack(fill="x", pady=(0, 12))
        self.start_btn = ttk.Button(actions, text="🚀  분석 · 업로드 시작",
                                    command=self.start_process, style="Accent.TButton")
        self.start_btn.pack(fill="x", ipady=6)
        self.overview_btn = ttk.Button(actions, text="📋  테이블 현황 보기",
                                       command=self.show_table_overview)
        self.overview_btn.pack(fill="x", pady=(8, 0))

        # [카드4] 진행 상황
        card4 = ttk.LabelFrame(body, text="  진행 상황  ", style="Card.TLabelframe")
        card4.pack(fill="both", expand=True)
        inner4 = tk.Frame(card4, bg=self.CARD)
        inner4.pack(fill="both", expand=True, padx=14, pady=12)

        status_row = tk.Frame(inner4, bg=self.CARD)
        status_row.pack(fill="x")
        self.status_var = tk.StringVar(value="대기 중")
        self.status_label = tk.Label(status_row, textvariable=self.status_var, bg=self.CARD,
                                     fg=self.NAVY, font=(self.FONT, 10, "bold"))
        self.status_label.pack(side="left")
        self.progress_pct_label = tk.Label(status_row, text="0.0%", bg=self.CARD, fg=self.MUTED,
                                           font=(self.FONT, 10, "bold"))
        self.progress_pct_label.pack(side="right")

        self.progress_var = tk.DoubleVar(value=0.0)
        self.progress_bar = ttk.Progressbar(
            inner4, orient="horizontal", mode="determinate", maximum=100,
            variable=self.progress_var, style="Fire.Horizontal.TProgressbar"
        )
        self.progress_bar.pack(fill="x", pady=(8, 10))

        self.log_widget = tk.Text(inner4, height=9, wrap="word", state="disabled",
                                  bg="#1b2733", fg="#d6e0ea", insertbackground="#d6e0ea",
                                  relief="flat", font=("Consolas", 9), padx=10, pady=8)
        self.log_widget.pack(fill="both", expand=True)

    def _init_style(self):
        """ttk 테마·커스텀 스타일 (clam 기반: 색상 커스터마이즈 가능)."""
        style = ttk.Style()
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure("Card.TLabelframe", background=self.CARD,
                        bordercolor="#d9e0e6", relief="solid", borderwidth=1)
        style.configure("Card.TLabelframe.Label", background=self.BG,
                        foreground=self.INK, font=(self.FONT, 10, "bold"))
        style.configure("TButton", font=(self.FONT, 10), padding=6)
        style.map("TButton", background=[("active", "#dfe6ec")])
        style.configure("Accent.TButton", font=(self.FONT, 12, "bold"), padding=8,
                        background=self.RED, foreground="white", borderwidth=0)
        style.map("Accent.TButton",
                  background=[("active", self.RED_DARK), ("disabled", "#e0b3af")],
                  foreground=[("disabled", "#f5f5f5")])
        style.configure("Fire.Horizontal.TProgressbar", troughcolor="#e4e9ee",
                        background=self.RED, bordercolor="#e4e9ee", thickness=18)
        style.configure("TCombobox", padding=4)
        style.configure("TEntry", padding=4)

    def browse_file(self):
        self.file_path = filedialog.askopenfilename(
            filetypes=[
                ("지원되는 파일", "*.pdf;*.docx;*.pptx;*.txt;*.md;*.html;*.htm;*.jpg;*.png;*.jpeg;*.bmp;*.tiff"),
                ("PDF files", "*.pdf"),
                ("Word files", "*.docx"),
                ("PowerPoint files", "*.pptx"),
                ("Text files", "*.txt"),
                ("Markdown files", "*.md"),
                ("HTML files", "*.html;*.htm"),
                ("Image files", "*.jpg;*.jpeg;*.png;*.bmp;*.tiff"),
                ("All files", "*.*")
            ]
        )
        if self.file_path:
            self.file_label.config(text=os.path.basename(self.file_path), fg="blue")

    def start_process(self):
        if self.is_running:
            return

        self.category = self.cat_entry.get().strip()
        self.year = self.year_entry.get().strip()
        self.should_delete = self.delete_var.get()
        if not self.category or not self.year or not self.file_path:
            messagebox.showwarning("경고", "모든 정보를 입력해주세요!")
            return

        self._set_controls_enabled(False)
        self._set_status("작업 시작 준비 중...")
        self._set_progress(0.0)
        self._append_log("=" * 60)
        self._append_log(
            f"[시작] 파일={os.path.basename(self.file_path)}, category={self.category}, year={self.year}"
        )

        self.is_running = True
        worker = threading.Thread(
            target=self._run_pipeline_worker,
            args=(self.file_path, self.category, self.year, self.should_delete),
            daemon=True,
        )
        worker.start()
        self.root.after(100, self._drain_ui_queue)

    def show_table_overview(self):
        if self.is_running:
            messagebox.showwarning("안내", "작업 중에는 메타태그 조회를 잠시 제한합니다.")
            return
        try:
            self.root.config(cursor="watch")
            self.root.update_idletasks()
            summary_text = build_table_metadata_summary(max_rows=5000, page_size=1000)
            self._show_text_popup(f"'{TABLE_NAME}' 메타태그 현황", summary_text)
        except Exception as e:
            messagebox.showerror("오류", f"메타태그 조회 중 에러: {e}")
        finally:
            self.root.config(cursor="")

    def _show_text_popup(self, title, text):
        popup = tk.Toplevel(self.root)
        popup.title(title)
        popup.geometry("700x520")

        text_widget = tk.Text(popup, wrap="word")
        scrollbar = tk.Scrollbar(popup, command=text_widget.yview)
        text_widget.configure(yscrollcommand=scrollbar.set)

        text_widget.insert("1.0", text)
        text_widget.config(state="disabled")

        text_widget.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

    def _set_controls_enabled(self, enabled):
        state = "normal" if enabled else "disabled"
        self.cat_entry.config(state=state)
        self.year_entry.config(state=state)
        self.file_btn.config(state=state)
        self.start_btn.config(state=state)
        self.overview_btn.config(state=state)

    def _set_status(self, text):
        self.status_var.set(text)
        self.root.update_idletasks()

    def _set_progress(self, value):
        value = max(0.0, min(100.0, float(value)))
        self.progress_var.set(value)
        self.progress_pct_label.config(text=f"{value:.1f}%")
        self.root.update_idletasks()

    def _append_log(self, line):
        self.log_widget.config(state="normal")
        self.log_widget.insert("end", f"{line}\n")
        self.log_widget.see("end")
        self.log_widget.config(state="disabled")

    def _run_pipeline_worker(self, pdf_file, category_name, year_name, should_delete):
        try:
            result = run_ingestion_pipeline(
                pdf_file=pdf_file,
                category_name=category_name,
                year_name=year_name,
                should_delete=should_delete,
                progress_cb=lambda v: self.ui_queue.put(("progress", v)),
                status_cb=lambda s: self.ui_queue.put(("status", s)),
                log_cb=lambda s: self.ui_queue.put(("log", s)),
            )
            self.ui_queue.put(("done", result))
        except Exception as e:
            self.ui_queue.put(("error", f"{e}\n\n{traceback.format_exc()}"))

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
                    messagebox.showwarning("안내", "업로드할 유효 청크가 없습니다.")
                else:
                    messagebox.showinfo("완료", f"업로드 성공! (청크 {uploaded}개)")
            elif kind == "error":
                has_done = True
                self.is_running = False
                self._set_controls_enabled(True)
                self._set_status("오류 발생")
                self._append_log(f"[오류]\n{payload}")
                messagebox.showerror("오류", f"업로드 중 에러:\n{payload}")

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
