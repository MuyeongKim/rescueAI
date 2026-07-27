import importlib
import sys
import types

import pytest


def load_rag7(monkeypatch):
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    monkeypatch.setenv("EMBEDDING_PROVIDER", "google")
    monkeypatch.setenv("GOOGLE_GENERATIVE_AI_API_KEY", "test-google-key")
    monkeypatch.setenv("EMBEDDING_PREFER_LOCAL", "0")
    install_external_stubs(monkeypatch)
    import rag7

    return importlib.reload(rag7)


def install_external_stubs(monkeypatch):
    supabase_module = types.ModuleType("supabase")
    supabase_module.Client = object
    supabase_module.create_client = lambda *_args, **_kwargs: object()
    monkeypatch.setitem(sys.modules, "supabase", supabase_module)


class StubEmbeddings:
    def __init__(self, documents_result=None, query_result=None, documents_error=None):
        self.documents_result = documents_result
        self.query_result = query_result
        self.documents_error = documents_error

    def embed_documents(self, texts):
        if self.documents_error:
            raise self.documents_error
        return self.documents_result

    def embed_query(self, text):
        return self.query_result


class StubResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_resolve_ollama_base_url_prefers_local_when_model_exists(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    monkeypatch.setenv("EMBEDDING_PREFER_LOCAL", "1")

    def fake_get(url, timeout):
        assert url == "http://localhost:11434/api/tags"
        assert timeout == 1.5
        return StubResponse({"models": [{"name": "bge-m3:latest"}]})

    monkeypatch.setattr(rag7.requests, "get", fake_get)

    selected = rag7.resolve_ollama_base_url(
        fallback_url="http://fallback.example:11434",
        model="bge-m3:latest",
        local_url="http://localhost:11434",
    )

    assert selected == "http://localhost:11434"


def test_resolve_ollama_base_url_uses_fallback_when_local_model_missing(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    monkeypatch.setenv("EMBEDDING_PREFER_LOCAL", "1")

    monkeypatch.setattr(
        rag7.requests,
        "get",
        lambda *_args, **_kwargs: StubResponse({"models": [{"name": "nomic-embed-text"}]}),
    )

    selected = rag7.resolve_ollama_base_url(
        fallback_url="http://fallback.example:11434",
        model="bge-m3:latest",
        local_url="http://localhost:11434",
    )

    assert selected == "http://fallback.example:11434"


def test_ollama_model_tag_must_match_exactly(monkeypatch):
    rag7 = load_rag7(monkeypatch)

    assert rag7._ollama_model_names_match("bge-m3:latest", "bge-m3:latest")
    assert not rag7._ollama_model_names_match("bge-m3:q8_0", "bge-m3:latest")
    assert not rag7._ollama_model_names_match("bge-m3:latest", "bge-m3")


def test_resolve_ollama_base_url_uses_fallback_when_local_probe_fails(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    monkeypatch.setenv("EMBEDDING_PREFER_LOCAL", "1")

    def fake_get(*_args, **_kwargs):
        raise rag7.requests.RequestException("local down")

    monkeypatch.setattr(rag7.requests, "get", fake_get)

    selected = rag7.resolve_ollama_base_url(
        fallback_url="http://fallback.example:11434",
        model="bge-m3:latest",
        local_url="http://localhost:11434",
    )

    assert selected == "http://fallback.example:11434"


def test_safe_embeddings_rejects_dimension_mismatch(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    embeddings = rag7.SafeEmbeddings(
        StubEmbeddings(documents_result=[[0.1, 0.2, 0.3]]),
        expected_dim=2,
    )

    with pytest.raises(ValueError, match="임베딩 차원 불일치"):
        embeddings.embed_documents(["chunk"])


def test_safe_embeddings_does_not_replace_failures_with_zero_vectors(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    embeddings = rag7.SafeEmbeddings(
        StubEmbeddings(documents_error=RuntimeError("ollama down")),
        expected_dim=2,
    )

    with pytest.raises(RuntimeError, match="임베딩 실패"):
        embeddings.embed_documents(["chunk"])


@pytest.mark.parametrize("bad_vector", [[float("nan"), 0.2], [0.0, 0.0]])
def test_safe_embeddings_rejects_invalid_vectors(monkeypatch, bad_vector):
    rag7 = load_rag7(monkeypatch)
    embeddings = rag7.SafeEmbeddings(
        StubEmbeddings(documents_result=[bad_vector]),
        expected_dim=2,
    )

    with pytest.raises(ValueError):
        embeddings.embed_documents(["chunk"])


def test_recursive_splitter_preserves_sentence_separators(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    text = "첫 문장입니다. 둘째 문장입니다. 셋째 문장입니다."
    splitter = rag7.LocalRecursiveCharacterTextSplitter(
        chunk_size=18,
        chunk_overlap=0,
        separators=[". ", " ", ""],
    )

    chunks = splitter.split_text(text)

    assert "".join(chunks) == text


def test_mixed_pdf_pages_enable_ocr(monkeypatch):
    rag7 = load_rag7(monkeypatch)

    class Page:
        def __init__(self, text):
            self.text = text

        def extract_text(self):
            return self.text

    pypdf = types.ModuleType("pypdf")
    pypdf.PdfReader = lambda _path: types.SimpleNamespace(
        pages=[Page("가" * 100), Page(""), Page("나" * 100)]
    )
    monkeypatch.setitem(sys.modules, "pypdf", pypdf)
    monkeypatch.setenv("DOCLING_OCR", "auto")
    monkeypatch.setenv("DOCLING_TEXT_PAGE_RATIO", "0.9")

    assert rag7._resolve_do_ocr("mixed.pdf", lambda _message: None) is True


def test_low_text_pdf_enables_full_page_ocr(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    analysis = rag7.PdfTextLayerAnalysis(
        total_pages=10,
        text_pages=1,
        low_text_pages=tuple(range(2, 11)),
    )

    assert rag7._resolve_force_full_page_ocr("vector-text.pdf", analysis) is True

    monkeypatch.setenv("DOCLING_FORCE_FULL_PAGE_OCR", "0")
    assert rag7._resolve_force_full_page_ocr("vector-text.pdf", analysis) is False


def test_recovers_only_missing_pdf_pages_with_useful_text(monkeypatch):
    rag7 = load_rag7(monkeypatch)

    class Page:
        def __init__(self, text):
            self.text = text

        def extract_text(self):
            return self.text

    pypdf = types.ModuleType("pypdf")
    pypdf.PdfReader = lambda _path: types.SimpleNamespace(
        pages=[
            Page("기존 페이지 본문" * 10),
            Page("복구할 페이지 본문" * 10),
            Page("짧음"),
        ]
    )
    monkeypatch.setitem(sys.modules, "pypdf", pypdf)

    pages = rag7.recover_missing_pdf_text_pages("manual.pdf", {1})

    assert [(page.page_num, page.text) for page in pages] == [
        (2, "복구할 페이지 본문" * 10)
    ]


def test_docling_conversion_preserves_page_numbers(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    monkeypatch.setenv("DOCLING_OCR", "0")

    class Document:
        pages = {1: object(), 2: object()}

        def export_to_markdown(self, page_no=None):
            return f"page {page_no}" if page_no is not None else "all pages"

    class DocumentConverter:
        def __init__(self, **_kwargs):
            pass

        def convert(self, _file_path):
            return types.SimpleNamespace(document=Document())

    converter = types.ModuleType("docling.document_converter")
    converter.DocumentConverter = DocumentConverter
    converter.PdfFormatOption = lambda **kwargs: kwargs

    base_models = types.ModuleType("docling.datamodel.base_models")
    base_models.InputFormat = types.SimpleNamespace(PDF="pdf")

    pipeline_options = types.ModuleType("docling.datamodel.pipeline_options")
    pipeline_options.PdfPipelineOptions = type("PdfPipelineOptions", (), {})

    monkeypatch.setitem(sys.modules, "docling", types.ModuleType("docling"))
    monkeypatch.setitem(sys.modules, "docling.datamodel", types.ModuleType("docling.datamodel"))
    monkeypatch.setitem(sys.modules, "docling.document_converter", converter)
    monkeypatch.setitem(sys.modules, "docling.datamodel.base_models", base_models)
    monkeypatch.setitem(sys.modules, "docling.datamodel.pipeline_options", pipeline_options)

    pages, parser = rag7.convert_file_to_pages("manual.pdf")

    assert parser == "docling"
    assert [(page.page_num, page.text) for page in pages] == [
        (1, "page 1"),
        (2, "page 2"),
    ]


def test_docling_uses_korean_easyocr_options(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    monkeypatch.setenv("DOCLING_OCR", "1")
    monkeypatch.setenv("DOCLING_OCR_LANGS", "ko,en")
    monkeypatch.setenv("DOCLING_OCR_DOWNLOAD", "0")
    captured = {}

    class Document:
        pages = {1: object()}

        def export_to_markdown(self, page_no=None):
            return "구조 교육 자료 본문입니다." if page_no else "전체 본문"

    class DocumentConverter:
        def __init__(self, format_options):
            captured["options"] = format_options["pdf"]["pipeline_options"]

        def convert(self, _file_path):
            return types.SimpleNamespace(document=Document())

    class EasyOcrOptions:
        def __init__(self, **kwargs):
            captured["ocr_kwargs"] = kwargs

    converter = types.ModuleType("docling.document_converter")
    converter.DocumentConverter = DocumentConverter
    converter.PdfFormatOption = lambda **kwargs: kwargs

    base_models = types.ModuleType("docling.datamodel.base_models")
    base_models.InputFormat = types.SimpleNamespace(PDF="pdf")

    pipeline_options = types.ModuleType("docling.datamodel.pipeline_options")
    pipeline_options.PdfPipelineOptions = type("PdfPipelineOptions", (), {})
    pipeline_options.EasyOcrOptions = EasyOcrOptions

    monkeypatch.setitem(sys.modules, "docling", types.ModuleType("docling"))
    monkeypatch.setitem(sys.modules, "docling.datamodel", types.ModuleType("docling.datamodel"))
    monkeypatch.setitem(sys.modules, "docling.document_converter", converter)
    monkeypatch.setitem(sys.modules, "docling.datamodel.base_models", base_models)
    monkeypatch.setitem(sys.modules, "docling.datamodel.pipeline_options", pipeline_options)

    pages, parser = rag7.convert_file_to_pages("scanned.pdf")

    assert parser == "docling-easyocr"
    assert pages[0].page_num == 1
    assert captured["options"].do_ocr is True
    assert captured["options"].do_table_structure is True
    assert captured["ocr_kwargs"] == {
        "lang": ["ko", "en"],
        "download_enabled": False,
        "force_full_page_ocr": False,
    }


def test_prepare_hwpx_converts_to_temporary_pdf(monkeypatch, tmp_path):
    rag7 = load_rag7(monkeypatch)
    source = tmp_path / "구조매뉴얼.hwpx"
    source.write_bytes(b"hwpx")
    converted_path = None

    def fake_run(command, **_kwargs):
        output_dir = command[command.index("--outdir") + 1]
        output = rag7.Path(output_dir) / "구조매뉴얼.pdf"
        output.write_bytes(b"%PDF-1.7")
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(rag7, "_libreoffice_binary", lambda: "/fake/soffice")
    monkeypatch.setattr(rag7.subprocess, "run", fake_run)

    with rag7.prepare_document_for_parsing(source) as prepared:
        converted_path = prepared.parsing_path
        assert prepared.original_path == source.resolve()
        assert prepared.converted_from_office is True
        assert prepared.viewer_pdf_path == converted_path
        assert converted_path.read_bytes() == b"%PDF-1.7"

    assert converted_path is not None
    assert not converted_path.exists()


def test_preview_cancellation_happens_before_any_database_change(monkeypatch, tmp_path):
    rag7 = load_rag7(monkeypatch)
    source = tmp_path / "manual.txt"
    source.write_text("원본", encoding="utf-8")
    previews = []

    monkeypatch.setattr(
        rag7,
        "ensure_embedding_contract",
        lambda: pytest.fail("승인 전에 임베딩 계약을 변경하면 안 됩니다."),
    )
    monkeypatch.setattr(
        rag7,
        "convert_file_to_pages",
        lambda *_args, **_kwargs: (
            [rag7.ConvertedPage(text="구조 교육용 본문 " * 20, page_num=1)],
            "stub-parser",
        ),
    )
    monkeypatch.setattr(
        rag7,
        "ensure_source_document",
        lambda *_args, **_kwargs: pytest.fail("승인 전에 자료실을 변경하면 안 됩니다."),
    )
    monkeypatch.setattr(
        rag7,
        "find_linked_document_id",
        lambda *_args, **_kwargs: pytest.fail("승인 전에 DB를 조회하면 안 됩니다."),
    )

    with pytest.raises(rag7.IngestionCancelled):
        rag7.run_ingestion_pipeline(
            source,
            "화재",
            "2026",
            True,
            preview_cb=lambda preview: previews.append(preview) or False,
        )

    assert len(previews) == 1
    assert previews[0].chunk_count > 0


def test_source_document_registration_and_rollback(monkeypatch, tmp_path):
    rag7 = load_rag7(monkeypatch)
    original = tmp_path / "구조매뉴얼.hwpx"
    viewer_pdf = tmp_path / "구조매뉴얼.pdf"
    original.write_bytes(b"hwpx-source")
    viewer_pdf.write_bytes(b"%PDF-viewer")
    calls = []

    class DocumentQuery:
        def __init__(self, action="select", payload=None):
            self.action = action
            self.payload = payload

        def select(self, *_args, **_kwargs):
            self.action = "select"
            return self

        def insert(self, payload):
            self.action = "insert"
            self.payload = payload
            return self

        def delete(self):
            self.action = "delete"
            return self

        def eq(self, *_args):
            return self

        def order(self, *_args, **_kwargs):
            return self

        def limit(self, *_args):
            return self

        def neq(self, *_args):
            return self

        def execute(self):
            calls.append((self.action, self.payload))
            if self.action == "select":
                return types.SimpleNamespace(data=[], count=0)
            if self.action == "insert":
                return types.SimpleNamespace(data=[{"id": 42}])
            return types.SimpleNamespace(data=[])

    class Bucket:
        def upload(self, path, file, file_options):
            calls.append(("upload", path, file.read(), file_options))
            return {"path": path}

        def remove(self, paths):
            calls.append(("remove", paths))
            return {"paths": paths}

    class Storage:
        def from_(self, bucket):
            assert bucket == "documents"
            return Bucket()

    class Supabase:
        storage = Storage()

        def table(self, name):
            assert name == "documents"
            return DocumentQuery()

    monkeypatch.setattr(rag7, "supabase", Supabase())
    prepared = rag7.PreparedDocument(
        original_path=original,
        parsing_path=viewer_pdf,
        viewer_pdf_path=viewer_pdf,
        converted_from_office=True,
    )

    link = rag7.ensure_source_document(
        prepared,
        category_name="화재",
        file_hash="a" * 64,
    )
    rag7.rollback_source_document_link(link)

    insert_payload = next(call[1] for call in calls if call[0] == "insert")
    assert insert_payload["original_filename"] == "구조매뉴얼.hwpx"
    assert insert_payload["source_type"] == "pdf"
    upload_path = next(call[1] for call in calls if call[0] == "upload")
    assert upload_path == f"rag/aa/{'a' * 64}.pdf"
    assert upload_path.isascii()
    assert link.document_id == 42
    assert link.created_row is True
    assert any(call[0] == "upload" for call in calls)
    assert any(call[0] == "delete" for call in calls)
    assert any(call[0] == "remove" for call in calls)


def test_chunk_quality_filter_removes_image_only_and_dot_leader_noise(monkeypatch):
    rag7 = load_rag7(monkeypatch)

    assert rag7.clean_chunk_content("<!-- image -->\n\n구조 안전수칙") == "구조 안전수칙"
    assert rag7.is_useful_chunk("<!-- image -->\n\n<!-- image -->") is False
    assert rag7.is_useful_chunk(("· " * 40) + "목차 12") is False
    assert rag7.is_useful_chunk("급류구조 시 개인부력장비를 착용한다.") is True


def test_activate_ingestion_uses_atomic_rpc(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    calls = []

    class Query:
        def execute(self):
            calls.append(("execute",))
            return types.SimpleNamespace(data=[{"activated_count": 3}])

    class Supabase:
        def rpc(self, name, params):
            calls.append(("rpc", name, params))
            return Query()

    monkeypatch.setattr(rag7, "supabase", Supabase())

    activated = rag7.activate_ingestion(
        ingestion_id="b79dcd8d-908d-4eb7-a7be-8dd082504e95",
        category_name="화재",
        year_name="2026",
        source_name="manual.pdf",
        expected_count=3,
        replace_existing=True,
    )

    assert activated == 3
    assert calls[0] == (
        "rpc",
        "activate_rag_rescue_ingestion",
        {
            "p_ingestion_id": "b79dcd8d-908d-4eb7-a7be-8dd082504e95",
            "p_category": "화재",
            "p_year": "2026",
            "p_source": "manual.pdf",
            "p_expected_count": 3,
            "p_replace_existing": True,
        },
    )
    assert calls[1] == ("execute",)
