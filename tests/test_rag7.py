import importlib
import sys
import types

import pytest


def load_rag7(monkeypatch):
    monkeypatch.setenv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321")
    monkeypatch.setenv("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
    monkeypatch.setenv("EMBEDDING_PREFER_LOCAL", "0")
    install_external_stubs(monkeypatch)
    import rag7

    return importlib.reload(rag7)


def install_external_stubs(monkeypatch):
    supabase_client = types.ModuleType("supabase.client")
    supabase_client.Client = object
    supabase_client.create_client = lambda *_args, **_kwargs: object()

    vectorstores = types.ModuleType("langchain_community.vectorstores")
    vectorstores.SupabaseVectorStore = object

    text_splitters = types.ModuleType("langchain_text_splitters")
    text_splitters.RecursiveCharacterTextSplitter = object
    text_splitters.MarkdownHeaderTextSplitter = object

    documents = types.ModuleType("langchain_core.documents")

    class Document:
        def __init__(self, page_content, metadata=None):
            self.page_content = page_content
            self.metadata = metadata or {}

    documents.Document = Document

    docling_converter = types.ModuleType("docling.document_converter")
    docling_converter.DocumentConverter = object

    monkeypatch.setitem(sys.modules, "supabase.client", supabase_client)
    monkeypatch.setitem(sys.modules, "langchain_community.vectorstores", vectorstores)
    monkeypatch.setitem(sys.modules, "langchain_text_splitters", text_splitters)
    monkeypatch.setitem(sys.modules, "langchain_core.documents", documents)
    monkeypatch.setitem(sys.modules, "docling.document_converter", docling_converter)


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
        fallback_url="http://100.66.187.122:11434",
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
        fallback_url="http://100.66.187.122:11434",
        model="bge-m3:latest",
        local_url="http://localhost:11434",
    )

    assert selected == "http://100.66.187.122:11434"


def test_resolve_ollama_base_url_uses_fallback_when_local_probe_fails(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    monkeypatch.setenv("EMBEDDING_PREFER_LOCAL", "1")

    def fake_get(*_args, **_kwargs):
        raise rag7.requests.RequestException("local down")

    monkeypatch.setattr(rag7.requests, "get", fake_get)

    selected = rag7.resolve_ollama_base_url(
        fallback_url="http://100.66.187.122:11434",
        model="bge-m3:latest",
        local_url="http://localhost:11434",
    )

    assert selected == "http://100.66.187.122:11434"


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


def test_delete_existing_source_data_filters_by_source_category_and_year(monkeypatch):
    rag7 = load_rag7(monkeypatch)
    calls = []

    class Query:
        def delete(self):
            calls.append(("delete",))
            return self

        def eq(self, column, value):
            calls.append(("eq", column, value))
            return self

        def execute(self):
            calls.append(("execute",))
            return object()

    class Supabase:
        def table(self, name):
            calls.append(("table", name))
            return Query()

    monkeypatch.setattr(rag7, "supabase", Supabase())

    rag7.delete_existing_source_data("화재", "2026", "manual.pdf")

    assert calls == [
        ("table", "rag_rescue"),
        ("delete",),
        ("eq", "metadata->>edu_category", "화재"),
        ("eq", "metadata->>year", "2026"),
        ("eq", "metadata->>source", "manual.pdf"),
        ("execute",),
    ]
