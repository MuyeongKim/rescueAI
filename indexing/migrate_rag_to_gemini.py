"""rag_rescue를 Gemini 임베딩으로 안전하게 전환하는 운영 도구.

``backup`` → ``stage`` → ``cutover`` → ``verify`` 순서로 전환하고,
필요하면 ``rollback``으로 백업 시점의 기존 기준선 릴리스를 다시 활성화한다.

- rag_rescue 전체 행(임베딩 포함, gzip JSONL)
- rag_embedding_config 계약
- documents 메타데이터
- 활성 원본별 category/year/document_id/file_hash 매핑
- Supabase Storage의 원본 PDF와 SHA-256 검증 결과
- Gemini 문서 임베딩을 비활성 상태로 전체 스테이징
- DB 계약과 전체 활성 코퍼스를 단일 RPC 트랜잭션으로 전환·검증

기존 BGE 행은 롤백용 비활성 릴리스로 보존한다. 비밀키는 루트
``.env.local``에서만 읽고 백업 산출물에는 기록하지 않는다.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shlex
import sys
import uuid
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_BACKUP_ROOT = ROOT / ".rag-migration" / "backups"
RAG_TABLE = "rag_rescue"
CONFIG_TABLE = "rag_embedding_config"
DOCUMENTS_TABLE = "documents"
STORAGE_BUCKET = "documents"
PAGE_SIZE = 500
GEMINI_PROVIDER = "google"
GEMINI_MODEL = "gemini-embedding-001"
GEMINI_DIMENSIONS = 1024
GEMINI_VERSION = "google-retrieval-v1"
RELEASE_TABLE = "rag_corpus_releases"
SWITCH_RPC = "switch_rag_rescue_corpus"
RELEASE_STATE_FILE = "gemini_release.json"
EMBEDDING_CONTRACT_KEYS = ("provider", "model", "dimensions", "version")
ROLLBACK_RELEASE_STATES = {"active", "inactive"}


def is_statement_timeout(error: BaseException) -> bool:
    """PostgREST가 전달한 PostgreSQL 57014 statement timeout을 식별한다."""
    if str(getattr(error, "code", "")) == "57014":
        return True
    for value in getattr(error, "args", ()):
        if isinstance(value, dict) and str(value.get("code", "")) == "57014":
            return True
    message = str(error).lower()
    return "57014" in message or "canceling statement due to statement timeout" in message


def statement_timeout_recovery_message(
    *,
    command: str,
    backup: Path,
    release_id: Any,
    database_status: str,
) -> str:
    """비밀 없이 SQL Editor와 동일 명령 재실행 절차를 만든다."""
    try:
        normalized_release_id = str(uuid.UUID(str(release_id)))
    except (TypeError, ValueError, AttributeError) as error:
        raise RuntimeError("statement timeout 복구용 릴리스 ID가 UUID가 아닙니다.") from error
    backup_argument = shlex.quote(str(backup.resolve()))
    return (
        "PostgREST RPC가 PostgreSQL 57014 statement timeout으로 취소되었습니다. "
        "원자 RPC의 부분 성공을 가정하지 않았습니다.\n"
        f"현재 DB 계약 재조회 결과: {database_status}\n"
        "Supabase SQL Editor에서 아래 SQL을 실행하세요(릴리스 ID는 검증된 상태에서 가져옴):\n"
        "set statement_timeout = '120s';\n"
        f"select * from public.{SWITCH_RPC}('{normalized_release_id}'::uuid);\n"
        "SQL이 성공한 뒤 전체 DB 검증과 로컬 상태 복구를 위해 같은 명령을 재실행하세요:\n"
        f"python migrate_rag_to_gemini.py {command} --backup {backup_argument}"
    )


def load_env_local() -> None:
    """python-dotenv 없이 루트 .env.local을 읽는다."""
    env_path = ROOT / ".env.local"
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key and key not in os.environ:
            os.environ[key] = value.strip()


def get_supabase():
    load_env_local()
    url = os.getenv("NEXT_PUBLIC_SUPABASE_URL", "").strip()
    key = os.getenv("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    if not url or not key:
        raise RuntimeError(
            "NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 필요합니다."
        )
    from supabase import create_client

    return create_client(url, key)


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def json_default(value: Any) -> str:
    if isinstance(value, (datetime, Path)):
        return str(value)
    raise TypeError(f"JSON으로 직렬화할 수 없는 값입니다: {type(value).__name__}")


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2, default=json_default) + "\n",
        encoding="utf-8",
    )
    temporary.replace(path)


def write_jsonl_gzip(path: Path, rows: Iterable[dict[str, Any]]) -> int:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    count = 0
    with gzip.open(temporary, "wt", encoding="utf-8") as stream:
        for row in rows:
            stream.write(
                json.dumps(row, ensure_ascii=False, default=json_default, separators=(",", ":"))
            )
            stream.write("\n")
            count += 1
    temporary.replace(path)
    return count


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fetch_all_rows(client, table: str, columns: str, *, order_by: str = "id") -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        response = (
            client.table(table)
            .select(columns)
            .order(order_by)
            .range(offset, offset + PAGE_SIZE - 1)
            .execute()
        )
        page = response.data or []
        rows.extend(page)
        if len(page) < PAGE_SIZE:
            return rows
        offset += len(page)


def normalized_document_id(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def safe_local_filename(document_id: int, original_filename: str) -> str:
    filename = Path(str(original_filename or "source.pdf")).name
    filename = re.sub(r"[\x00-\x1f/:]", "_", filename).strip() or "source.pdf"
    return f"{document_id:03d}_{filename}"


def build_source_manifest(
    rag_rows: list[dict[str, Any]], documents: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    docs_by_id = {int(row["id"]): row for row in documents}
    grouped: dict[tuple[str, str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in rag_rows:
        if not row.get("is_active"):
            continue
        metadata = row.get("metadata") or {}
        key = (
            str(metadata.get("edu_category") or metadata.get("category") or "").strip(),
            str(metadata.get("year") or "").strip(),
            str(metadata.get("source") or "").strip(),
        )
        if not all(key):
            raise RuntimeError(f"활성 청크에 category/year/source가 없습니다: id={row.get('id')}")
        grouped[key].append(row)

    manifest: list[dict[str, Any]] = []
    for (category, year, source), rows in sorted(grouped.items()):
        metadata_rows = [row.get("metadata") or {} for row in rows]
        document_ids = {
            value
            for value in (normalized_document_id(meta.get("document_id")) for meta in metadata_rows)
            if value is not None
        }
        file_hashes = {
            str(meta.get("file_hash") or "").strip().lower()
            for meta in metadata_rows
            if str(meta.get("file_hash") or "").strip()
        }
        ingestion_ids = {
            str(row.get("ingestion_id") or "").strip()
            for row in rows
            if str(row.get("ingestion_id") or "").strip()
        }
        if len(document_ids) != 1:
            raise RuntimeError(
                f"원본 {source!r}의 document_id가 하나가 아닙니다: {sorted(document_ids)}"
            )
        if len(file_hashes) != 1:
            raise RuntimeError(
                f"원본 {source!r}의 file_hash가 하나가 아닙니다: {sorted(file_hashes)}"
            )
        document_id = next(iter(document_ids))
        document = docs_by_id.get(document_id)
        if document is None:
            raise RuntimeError(f"documents.id={document_id}가 없습니다: {source}")
        storage_path = str(document.get("file_url") or "").strip()
        if not storage_path or re.match(r"^https?://", storage_path):
            raise RuntimeError(
                f"documents.id={document_id}의 비공개 Storage 경로가 올바르지 않습니다: {storage_path!r}"
            )
        original_filename = str(document.get("original_filename") or source).strip()
        manifest.append(
            {
                "source": source,
                "category": category,
                "year": year,
                "document_id": document_id,
                "file_hash": next(iter(file_hashes)),
                "storage_bucket": STORAGE_BUCKET,
                "storage_path": storage_path,
                "original_filename": original_filename,
                "local_filename": safe_local_filename(document_id, original_filename),
                "chunk_count": len(rows),
                "ingestion_ids": sorted(ingestion_ids),
            }
        )
    return manifest


def download_sources(client, output_dir: Path, sources: list[dict[str, Any]]) -> list[dict[str, Any]]:
    source_dir = output_dir / "source-pdfs"
    source_dir.mkdir(parents=True, exist_ok=True)
    verified: list[dict[str, Any]] = []
    for index, source in enumerate(sources, start=1):
        local_path = source_dir / source["local_filename"]
        temporary = local_path.with_suffix(local_path.suffix + ".tmp")
        print(f"[{index:02d}/{len(sources):02d}] 원본 다운로드: {source['source']}")
        payload = client.storage.from_(source["storage_bucket"]).download(source["storage_path"])
        if not isinstance(payload, (bytes, bytearray)):
            raise RuntimeError(f"Storage 다운로드 응답이 bytes가 아닙니다: {source['source']}")
        temporary.write_bytes(bytes(payload))
        actual_hash = sha256_file(temporary)
        if actual_hash != source["file_hash"]:
            temporary.unlink(missing_ok=True)
            raise RuntimeError(
                f"SHA-256 불일치: {source['source']} (기대 {source['file_hash']}, 실제 {actual_hash})"
            )
        temporary.replace(local_path)
        verified.append(
            {
                **source,
                "local_path": str(local_path.relative_to(output_dir)),
                "downloaded_bytes": local_path.stat().st_size,
                "verified_sha256": actual_hash,
            }
        )
    return verified


def backup_command(output: Path | None) -> Path:
    client = get_supabase()
    output_dir = (output or (DEFAULT_BACKUP_ROOT / utc_timestamp())).resolve()
    if output_dir.exists() and any(output_dir.iterdir()):
        raise RuntimeError(f"비어 있지 않은 백업 경로입니다: {output_dir}")
    output_dir.mkdir(parents=True, exist_ok=True)

    print("1/5 rag_rescue 전체 행 조회 중...")
    rag_rows = fetch_all_rows(
        client,
        RAG_TABLE,
        "id,content,metadata,embedding,ingestion_id,is_active,created_at",
    )
    print("2/5 임베딩 계약과 documents 조회 중...")
    config_rows = fetch_all_rows(
        client,
        CONFIG_TABLE,
        "table_name,provider,model,dimensions,version,updated_at",
        order_by="table_name",
    )
    documents = fetch_all_rows(
        client,
        DOCUMENTS_TABLE,
        "id,title,source_type,category,equipment,difficulty,original_filename,file_url,publish_date,status,created_at",
    )
    sources = build_source_manifest(rag_rows, documents)

    if not rag_rows:
        raise RuntimeError("rag_rescue가 비어 있어 백업을 중단합니다.")
    if len(sources) != 15:
        raise RuntimeError(f"예상한 활성 원본 15건과 다릅니다: {len(sources)}건")

    print("3/5 DB 백업 파일 기록 중...")
    rag_path = output_dir / "rag_rescue.jsonl.gz"
    written_count = write_jsonl_gzip(rag_path, rag_rows)
    write_json(output_dir / "rag_embedding_config.json", config_rows)
    write_json(output_dir / "documents.json", documents)
    write_json(output_dir / "source_manifest.json", sources)

    print("4/5 Storage 원본 15건 다운로드 및 해시 검증 중...")
    verified_sources = download_sources(client, output_dir, sources)
    write_json(output_dir / "source_manifest.json", verified_sources)

    active_count = sum(bool(row.get("is_active")) for row in rag_rows)
    contract = next(
        (row for row in config_rows if row.get("table_name") == RAG_TABLE), None
    )
    if contract is None:
        raise RuntimeError("rag_rescue 임베딩 계약을 찾지 못했습니다.")

    tracked_files = [
        rag_path,
        output_dir / "rag_embedding_config.json",
        output_dir / "documents.json",
        output_dir / "source_manifest.json",
        *sorted((output_dir / "source-pdfs").glob("*")),
    ]
    checksums = {
        str(path.relative_to(output_dir)): sha256_file(path) for path in tracked_files
    }
    write_json(output_dir / "checksums.json", checksums)
    backup_manifest = {
        "format_version": 1,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "table_name": RAG_TABLE,
        "rag_row_count": written_count,
        "active_row_count": active_count,
        "document_row_count": len(documents),
        "active_source_count": len(verified_sources),
        "source_bytes": sum(row["downloaded_bytes"] for row in verified_sources),
        "embedding_contract": contract,
        "checksums_file": "checksums.json",
    }
    write_json(output_dir / "backup_manifest.json", backup_manifest)
    checksums["backup_manifest.json"] = sha256_file(output_dir / "backup_manifest.json")
    write_json(output_dir / "checksums.json", checksums)

    print("5/5 백업 자체 검증 완료")
    print(f"백업 경로: {output_dir}")
    print(
        f"RAG {written_count:,}행(활성 {active_count:,}), 원본 {len(verified_sources)}건, "
        f"{backup_manifest['source_bytes'] / 1024 / 1024:.1f} MiB"
    )
    return output_dir


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def require_backup_dir(path: Path) -> tuple[Path, dict[str, Any], list[dict[str, Any]]]:
    backup_dir = path.expanduser().resolve()
    backup_manifest_path = backup_dir / "backup_manifest.json"
    source_manifest_path = backup_dir / "source_manifest.json"
    if not backup_manifest_path.is_file() or not source_manifest_path.is_file():
        raise RuntimeError(f"유효한 백업 경로가 아닙니다: {backup_dir}")
    backup_manifest = read_json(backup_manifest_path)
    sources = read_json(source_manifest_path)
    if backup_manifest.get("rag_row_count") != backup_manifest.get("active_row_count"):
        raise RuntimeError("전환 기준 백업에 비활성 행이 포함돼 있습니다.")
    if len(sources) != backup_manifest.get("active_source_count"):
        raise RuntimeError("백업 manifest의 원본 수가 서로 다릅니다.")
    return backup_dir, backup_manifest, sources


def exact_count(query) -> int:
    response = query.execute()
    return int(getattr(response, "count", 0) or 0)


def baseline_expectations(
    backup_manifest: dict[str, Any],
) -> tuple[dict[str, Any], int]:
    """백업이 가리키는 기존 임베딩 계약과 활성 행 수를 엄격히 읽는다."""
    if backup_manifest.get("table_name") != RAG_TABLE:
        raise RuntimeError("백업 manifest의 RAG 테이블이 rag_rescue가 아닙니다.")

    contract = backup_manifest.get("embedding_contract")
    if not isinstance(contract, dict) or contract.get("table_name") != RAG_TABLE:
        raise RuntimeError("백업 manifest의 rag_rescue 임베딩 계약이 올바르지 않습니다.")

    expected_contract = {key: contract.get(key) for key in EMBEDDING_CONTRACT_KEYS}
    for key in ("provider", "model", "version"):
        value = expected_contract[key]
        if not isinstance(value, str) or not value or value != value.strip():
            raise RuntimeError(f"백업 임베딩 계약의 {key} 값이 올바르지 않습니다.")
    if (
        type(expected_contract["dimensions"]) is not int
        or expected_contract["dimensions"] <= 0
    ):
        raise RuntimeError("백업 임베딩 계약의 dimensions 값이 올바르지 않습니다.")

    expected_rows = backup_manifest.get("active_row_count")
    if type(expected_rows) is not int or expected_rows <= 0:
        raise RuntimeError("백업 manifest의 active_row_count가 올바르지 않습니다.")
    return expected_contract, expected_rows


def release_matches_baseline(
    release: dict[str, Any], expected_contract: dict[str, Any], expected_rows: int
) -> bool:
    return (
        all(release.get(key) == expected_contract[key] for key in EMBEDDING_CONTRACT_KEYS)
        and release.get("expected_rows") == expected_rows
    )


def find_baseline_release(
    client, backup_manifest: dict[str, Any]
) -> dict[str, Any]:
    """백업 계약·활성 행 수와 정확히 같은 유일한 릴리스를 찾는다."""
    expected_contract, expected_rows = baseline_expectations(backup_manifest)
    query = client.table(RELEASE_TABLE).select(
        "id,provider,model,dimensions,version,expected_rows,state"
    )
    for key in EMBEDDING_CONTRACT_KEYS:
        query = query.eq(key, expected_contract[key])
    try:
        response = query.eq("expected_rows", expected_rows).limit(2).execute()
    except Exception as error:
        raise RuntimeError("기준선 릴리스 조회에 실패했습니다.") from error

    rows = response.data or []
    if not isinstance(rows, list):
        raise RuntimeError("기준선 릴리스 조회 응답이 올바르지 않습니다.")
    candidates = [
        row
        for row in rows
        if isinstance(row, dict)
        and release_matches_baseline(row, expected_contract, expected_rows)
    ]
    if not candidates:
        raise RuntimeError(
            "백업 계약과 활성 행 수가 일치하는 기준선 릴리스를 찾지 못했습니다."
        )
    if len(candidates) != 1:
        raise RuntimeError(
            "기준선 릴리스 후보가 2개 이상이어서 롤백을 중단합니다."
        )

    candidate = candidates[0]
    if not candidate.get("id"):
        raise RuntimeError("기준선 릴리스 ID가 없습니다.")
    if candidate.get("state") not in ROLLBACK_RELEASE_STATES:
        raise RuntimeError(
            "기준선 릴리스가 롤백 가능한 active/inactive 상태가 아닙니다."
        )
    return candidate


def verify_rollback(
    client, baseline_release: dict[str, Any], backup_manifest: dict[str, Any]
) -> dict[str, Any]:
    """RPC 커밋 뒤 활성 행, DB 계약, 활성 릴리스를 각각 재조회한다."""
    expected_contract, expected_rows = baseline_expectations(backup_manifest)
    active_count = exact_count(
        client.table(RAG_TABLE)
        .select("id", count="exact", head=True)
        .eq("is_active", True)
    )
    if active_count != expected_rows:
        raise RuntimeError(
            "롤백 후 활성 RAG 행 수가 백업과 다릅니다: "
            f"백업 {expected_rows}, 현재 {active_count}"
        )

    expected_db_contract = {"table_name": RAG_TABLE, **expected_contract}
    contract_rows = (
        client.table(CONFIG_TABLE)
        .select("table_name,provider,model,dimensions,version")
        .eq("table_name", RAG_TABLE)
        .limit(2)
        .execute()
        .data
        or []
    )
    if contract_rows != [expected_db_contract]:
        raise RuntimeError("롤백 후 DB 임베딩 계약이 백업 계약과 다릅니다.")

    active_releases = (
        client.table(RELEASE_TABLE)
        .select("id,provider,model,dimensions,version,expected_rows,state")
        .eq("state", "active")
        .limit(2)
        .execute()
        .data
        or []
    )
    if len(active_releases) != 1:
        raise RuntimeError(
            f"롤백 후 활성 릴리스가 정확히 하나가 아닙니다: {len(active_releases)}개"
        )
    active_release = active_releases[0]
    if (
        str(active_release.get("id")) != str(baseline_release["id"])
        or active_release.get("state") != "active"
        or not release_matches_baseline(
            active_release, expected_contract, expected_rows
        )
    ):
        raise RuntimeError("롤백 후 기준선 릴리스가 활성 상태가 아닙니다.")

    return {
        "release_id": str(baseline_release["id"]),
        "release_state": "active",
        "active_rows": active_count,
        "contract": expected_contract,
    }


def assert_live_baseline(client, backup_manifest: dict[str, Any]) -> None:
    config_rows = (
        client.table(CONFIG_TABLE)
        .select("table_name,provider,model,dimensions,version")
        .eq("table_name", RAG_TABLE)
        .limit(1)
        .execute()
        .data
        or []
    )
    if len(config_rows) != 1:
        raise RuntimeError("현재 rag_rescue 임베딩 계약을 확인할 수 없습니다.")
    expected_contract = backup_manifest["embedding_contract"]
    current_contract = config_rows[0]
    contract_keys = ("provider", "model", "dimensions", "version")
    if any(current_contract.get(key) != expected_contract.get(key) for key in contract_keys):
        raise RuntimeError(
            "백업 이후 DB 임베딩 계약이 변경됐습니다. 새 백업을 만든 뒤 진행하세요."
        )
    active_count = exact_count(
        client.table(RAG_TABLE)
        .select("id", count="exact", head=True)
        .eq("is_active", True)
    )
    if active_count != int(backup_manifest["active_row_count"]):
        raise RuntimeError(
            "백업 이후 활성 RAG 행 수가 변경됐습니다: "
            f"백업 {backup_manifest['active_row_count']}, 현재 {active_count}"
        )


def new_release_state(sources: list[dict[str, Any]]) -> dict[str, Any]:
    release_id = uuid.uuid4()
    entries = []
    for source in sources:
        ingestion_id = uuid.uuid5(
            release_id,
            f"{source['document_id']}\n{source['category']}\n{source['year']}\n{source['source']}",
        )
        entries.append(
            {
                "ingestion_id": str(ingestion_id),
                "source": source["source"],
                "category": source["category"],
                "year": source["year"],
                "document_id": source["document_id"],
                "file_hash": source["file_hash"],
                "local_path": source["local_path"],
                "status": "pending",
            }
        )
    return {
        "format_version": 1,
        "release_id": str(release_id),
        "label": f"Gemini 전체 재임베딩 {utc_timestamp()}",
        "provider": GEMINI_PROVIDER,
        "model": GEMINI_MODEL,
        "dimensions": GEMINI_DIMENSIONS,
        "version": GEMINI_VERSION,
        "created_at": datetime.now(timezone.utc).isoformat(),
        "status": "staging",
        "entries": entries,
    }


def load_or_create_release_state(
    backup_dir: Path, sources: list[dict[str, Any]]
) -> tuple[Path, dict[str, Any]]:
    state_path = backup_dir / RELEASE_STATE_FILE
    if state_path.is_file():
        state = read_json(state_path)
    else:
        state = new_release_state(sources)
        write_json(state_path, state)
    if len(state.get("entries") or []) != len(sources):
        raise RuntimeError("Gemini 릴리스 상태 파일의 원본 수가 백업과 다릅니다.")
    expected = (GEMINI_PROVIDER, GEMINI_MODEL, GEMINI_DIMENSIONS, GEMINI_VERSION)
    actual = (
        state.get("provider"),
        state.get("model"),
        state.get("dimensions"),
        state.get("version"),
    )
    if actual != expected:
        raise RuntimeError(f"Gemini 릴리스 계약이 예상과 다릅니다: {actual}")
    return state_path, state


def import_gemini_indexer():
    # rag7.py는 .env.local보다 이미 설정된 프로세스 환경변수를 우선한다.
    os.environ["EMBEDDING_PROVIDER"] = GEMINI_PROVIDER
    os.environ["GOOGLE_EMBEDDING_MODEL"] = GEMINI_MODEL
    os.environ["EMBEDDING_VERSION"] = GEMINI_VERSION
    sys.path.insert(0, str(ROOT))
    import rag7

    if (
        rag7.EMBEDDING_PROVIDER,
        rag7.EMBEDDING_MODEL_NAME,
        rag7.EMBEDDING_DIMENSIONS,
        rag7.EMBEDDING_VERSION,
    ) != (GEMINI_PROVIDER, GEMINI_MODEL, GEMINI_DIMENSIONS, GEMINI_VERSION):
        raise RuntimeError("rag7.py의 Gemini 임베딩 계약이 전환 도구와 다릅니다.")
    return rag7


def stage_command(
    backup: Path,
    document_ids: set[int] | None = None,
    limit: int | None = None,
) -> Path:
    backup_dir, backup_manifest, sources = require_backup_dir(backup)
    client = get_supabase()
    assert_live_baseline(client, backup_manifest)
    state_path, state = load_or_create_release_state(backup_dir, sources)
    rag7 = import_gemini_indexer()

    # 긴 OCR 작업 전에 키/모델/차원을 작은 실호출로 확인한다.
    probe = rag7.embeddings.embed_query("소방 구조 교육자료 검색 연결 점검")
    if len(probe) != GEMINI_DIMENSIONS:
        raise RuntimeError(f"Gemini 점검 벡터 차원 오류: {len(probe)}")
    print("Gemini RETRIEVAL_QUERY 실호출 및 1,024차원 확인 완료")

    selected = []
    for entry in state["entries"]:
        if document_ids and int(entry["document_id"]) not in document_ids:
            continue
        if entry.get("status") == "completed":
            try:
                rag7.validate_staged_ingestion(
                    entry["ingestion_id"],
                    entry["category"],
                    entry["year"],
                    entry["source"],
                    int(entry["chunk_count"]),
                )
                print(f"[건너뜀] 이미 검증된 스테이징: {entry['source']}")
                continue
            except Exception:
                entry["status"] = "pending"
                entry.pop("chunk_count", None)
        selected.append(entry)
    if limit is not None:
        selected = selected[: max(0, limit)]

    for index, entry in enumerate(selected, start=1):
        local_path = backup_dir / entry["local_path"]
        entry["status"] = "processing"
        entry["started_at"] = datetime.now(timezone.utc).isoformat()
        entry.pop("error", None)
        write_json(state_path, state)
        print(f"\n[{index:02d}/{len(selected):02d}] Gemini 스테이징: {entry['source']}")
        try:
            result = rag7.run_ingestion_pipeline(
                pdf_file=local_path,
                category_name=entry["category"],
                year_name=entry["year"],
                should_delete=False,
                register_source=False,
                preview_cb=lambda _preview: True,
                stage_only=True,
                source_name_override=entry["source"],
                document_id_override=entry["document_id"],
                file_hash_expected=entry["file_hash"],
                ingestion_id_override=entry["ingestion_id"],
            )
            preview = result["preview"]
            entry.update(
                {
                    "status": "completed",
                    "completed_at": datetime.now(timezone.utc).isoformat(),
                    "chunk_count": int(result["uploaded_chunks"]),
                    "parser": preview.parser_name,
                    "total_pages": int(preview.total_pages),
                    "extracted_pages": int(preview.extracted_pages),
                    "low_text_pages": list(preview.low_text_pages),
                    "total_characters": int(preview.total_characters),
                }
            )
            write_json(state_path, state)
        except Exception as error:
            entry["status"] = "failed"
            entry["failed_at"] = datetime.now(timezone.utc).isoformat()
            entry["error"] = str(error)
            write_json(state_path, state)
            raise

    completed = [entry for entry in state["entries"] if entry.get("status") == "completed"]
    if len(completed) == len(state["entries"]):
        state["status"] = "staged"
        state["expected_rows"] = sum(int(entry["chunk_count"]) for entry in completed)
        state["staged_at"] = datetime.now(timezone.utc).isoformat()
        write_json(state_path, state)
        print(
            f"전체 Gemini 스테이징 완료: 원본 {len(completed)}건, "
            f"청크 {state['expected_rows']:,}개"
        )
    else:
        print(f"부분 스테이징 완료: {len(completed)}/{len(state['entries'])}건")
    return state_path


def release_manifest(state: dict[str, Any]) -> list[dict[str, Any]]:
    entries = state.get("entries") or []
    if not entries or any(entry.get("status") != "completed" for entry in entries):
        raise RuntimeError("15개 원본의 Gemini 스테이징이 모두 완료되지 않았습니다.")
    return [
        {
            "ingestion_id": entry["ingestion_id"],
            "category": entry["category"],
            "year": entry["year"],
            "source": entry["source"],
            "document_id": int(entry["document_id"]),
            "file_hash": entry["file_hash"],
            "expected_count": int(entry["chunk_count"]),
        }
        for entry in entries
    ]


def release_contract(state: dict[str, Any]) -> dict[str, Any]:
    """릴리스 상태 파일에서 비교용 임베딩 계약을 만든다."""
    return {key: state[key] for key in EMBEDDING_CONTRACT_KEYS}


def read_live_embedding_contract(client) -> dict[str, Any]:
    """현재 운영 계약이 정확히 한 행인지 확인하고 비교 가능한 형태로 반환한다."""
    rows = (
        client.table(CONFIG_TABLE)
        .select("provider,model,dimensions,version")
        .eq("table_name", RAG_TABLE)
        .limit(2)
        .execute()
        .data
        or []
    )
    if len(rows) != 1 or not isinstance(rows[0], dict):
        raise RuntimeError(
            f"현재 {RAG_TABLE} 임베딩 계약이 정확히 하나가 아닙니다: {len(rows)}개"
        )
    return {key: rows[0].get(key) for key in EMBEDDING_CONTRACT_KEYS}


def verify_recorded_active_release(
    client,
    state: dict[str, Any],
    manifest: list[dict[str, Any]],
    expected_rows: int,
) -> dict[str, Any]:
    """상태 파일의 정확한 릴리스 ID가 DB에서도 유일한 active 릴리스인지 확인한다."""
    rows = (
        client.table(RELEASE_TABLE)
        .select(
            "id,provider,model,dimensions,version,manifest,expected_rows,state,activated_at"
        )
        .eq("id", state["release_id"])
        .eq("state", "active")
        .limit(2)
        .execute()
        .data
        or []
    )
    if len(rows) != 1 or not isinstance(rows[0], dict):
        raise RuntimeError(
            "상태 파일과 일치하는 활성 Gemini 릴리스 후보가 정확히 하나가 아닙니다: "
            f"{len(rows)}개"
        )

    release = rows[0]
    expected_contract = release_contract(state)
    if (
        str(release.get("id")) != str(state["release_id"])
        or release.get("state") != "active"
        or any(release.get(key) != expected_contract[key] for key in EMBEDDING_CONTRACT_KEYS)
        or release.get("expected_rows") != expected_rows
        or release.get("manifest") != manifest
    ):
        raise RuntimeError("활성 Gemini 릴리스가 로컬 상태/manifest와 정확히 일치하지 않습니다.")
    return release


def record_active_cutover(
    state_path: Path,
    state: dict[str, Any],
    verified: dict[str, Any],
    cutover_result: dict[str, Any],
    *,
    activated_at: Any = None,
) -> None:
    """검증된 활성 상태를 원자적으로 로컬 상태 파일에 기록한다."""
    state["status"] = "active"
    state["activated_at"] = (
        activated_at or state.get("activated_at") or datetime.now(timezone.utc).isoformat()
    )
    state["cutover_result"] = cutover_result
    state["verification"] = verified
    write_json(state_path, state)


def verify_active_release(client, state: dict[str, Any]) -> dict[str, Any]:
    expected_rows = int(state["expected_rows"])
    active_count = exact_count(
        client.table(RAG_TABLE)
        .select("id", count="exact", head=True)
        .eq("is_active", True)
    )
    contract_rows = (
        client.table(CONFIG_TABLE)
        .select("provider,model,dimensions,version")
        .eq("table_name", RAG_TABLE)
        .limit(1)
        .execute()
        .data
        or []
    )
    expected_contract = {
        "provider": state["provider"],
        "model": state["model"],
        "dimensions": state["dimensions"],
        "version": state["version"],
    }
    if active_count != expected_rows or contract_rows != [expected_contract]:
        raise RuntimeError(
            f"전환 후 검증 실패: 활성 {active_count}/{expected_rows}, 계약 {contract_rows}"
        )
    per_source = []
    for entry in state["entries"]:
        count = exact_count(
            client.table(RAG_TABLE)
            .select("id", count="exact", head=True)
            .eq("is_active", True)
            .eq("ingestion_id", entry["ingestion_id"])
        )
        if count != int(entry["chunk_count"]):
            raise RuntimeError(
                f"전환 후 원본별 청크 수 불일치: {entry['source']} "
                f"{count}/{entry['chunk_count']}"
            )
        per_source.append({"source": entry["source"], "chunk_count": count})
    return {
        "active_rows": active_count,
        "active_sources": len(per_source),
        "contract": expected_contract,
    }


def recover_active_cutover(
    client,
    state_path: Path,
    state: dict[str, Any],
    manifest: list[dict[str, Any]],
    expected_rows: int,
) -> dict[str, Any]:
    """DB가 완전히 Gemini로 전환됐을 때만 로컬 active 상태를 복구한다."""
    verified = verify_active_release(client, state)
    active_release = verify_recorded_active_release(
        client, state, manifest, expected_rows
    )
    recovered_result = {
        "release_id": str(state["release_id"]),
        # RPC의 activated_count는 이번 호출에서 바뀐 행 수가 아니라
        # 전환 후 해당 릴리스의 총 활성 행 수다.
        "activated_count": expected_rows,
        "provider": state["provider"],
        "model": state["model"],
        "version": state["version"],
        "recovered_from_database": True,
    }
    record_active_cutover(
        state_path,
        state,
        verified,
        recovered_result,
        activated_at=active_release.get("activated_at"),
    )
    return verified


def cutover_command(backup: Path) -> dict[str, Any]:
    backup_dir, backup_manifest, sources = require_backup_dir(backup)
    state_path, state = load_or_create_release_state(backup_dir, sources)
    manifest = release_manifest(state)
    expected_rows = sum(row["expected_count"] for row in manifest)
    if int(state.get("expected_rows") or 0) != expected_rows:
        raise RuntimeError("릴리스 전체 청크 수가 문서별 합계와 다릅니다.")

    # 상태/manifest 검증을 끝낸 뒤에만 운영 DB 상태를 판별한다. RPC가 커밋된 직후
    # 로컬 상태 파일 기록 전에 연결이 끊겼다면, Gemini 계약과 정확한 active 릴리스를
    # 재검증해 로컬 상태만 복구하고 릴리스 upsert/RPC를 반복하지 않는다.
    client = get_supabase()
    current_contract = read_live_embedding_contract(client)
    gemini_contract = release_contract(state)
    baseline_contract, _baseline_rows = baseline_expectations(backup_manifest)

    if current_contract == gemini_contract:
        verified = recover_active_cutover(
            client, state_path, state, manifest, expected_rows
        )
        print(
            "이미 커밋된 Gemini 코퍼스를 재검증해 로컬 상태를 복구했습니다: "
            f"원본 {verified['active_sources']}건, 활성 청크 {verified['active_rows']:,}개"
        )
        return verified

    if current_contract != baseline_contract:
        raise RuntimeError(
            "현재 DB 임베딩 계약이 백업 기준선 또는 대상 Gemini 계약과 다릅니다. "
            "혼합/제3 계약 상태에서는 전환을 진행하지 않습니다."
        )

    # 최초 전환은 현재 계약과 활성 행 수가 백업 기준선과 정확히 같을 때만 허용한다.
    assert_live_baseline(client, backup_manifest)

    release_row = {
        "id": state["release_id"],
        "label": state["label"],
        "provider": state["provider"],
        "model": state["model"],
        "dimensions": state["dimensions"],
        "version": state["version"],
        "manifest": manifest,
        "expected_rows": expected_rows,
        "state": "staged",
    }
    try:
        client.table(RELEASE_TABLE).upsert(release_row, on_conflict="id").execute()
    except Exception as error:
        raise RuntimeError(
            "코퍼스 릴리스 마이그레이션이 아직 적용되지 않았습니다. "
            "supabase/migrations/20260828032304_add_rag_corpus_release_switch.sql을 적용하세요."
        ) from error

    try:
        response = client.rpc(
            SWITCH_RPC, {"p_release_id": state["release_id"]}
        ).execute()
    except Exception as error:
        if not is_statement_timeout(error):
            raise
        try:
            contract_after_timeout = read_live_embedding_contract(client)
        except Exception as verification_error:
            message = statement_timeout_recovery_message(
                command="cutover",
                backup=backup_dir,
                release_id=state["release_id"],
                database_status=(
                    "현재 계약을 재조회하지 못해 전환 완료 여부를 확인할 수 없습니다."
                ),
            )
            raise RuntimeError(message) from verification_error

        if contract_after_timeout == gemini_contract:
            try:
                verified = recover_active_cutover(
                    client, state_path, state, manifest, expected_rows
                )
            except Exception as verification_error:
                message = statement_timeout_recovery_message(
                    command="cutover",
                    backup=backup_dir,
                    release_id=state["release_id"],
                    database_status=(
                        "Gemini 계약이 보이지만 활성 행·릴리스 전체 검증이 "
                        "끝나지 않았습니다."
                    ),
                )
                raise RuntimeError(message) from verification_error
            print(
                "PostgREST 57014 이후 DB의 Gemini 계약·활성 행·릴리스를 모두 "
                "재검증해 로컬 상태를 복구했습니다: "
                f"원본 {verified['active_sources']}건, 활성 청크 "
                f"{verified['active_rows']:,}개"
            )
            return verified

        database_status = (
            "백업 기준선 계약이 유지되고 있어 Gemini 전환 완료를 "
            "확인하지 못했습니다."
            if contract_after_timeout == baseline_contract
            else (
                "백업 기준선·Gemini 어느 쪽과도 다른 계약이라 "
                "자동 진행하지 않습니다."
            )
        )
        raise RuntimeError(
            statement_timeout_recovery_message(
                command="cutover",
                backup=backup_dir,
                release_id=state["release_id"],
                database_status=database_status,
            )
        ) from error

    rows = response.data or []
    if (
        len(rows) != 1
        or str(rows[0].get("release_id")) != str(state["release_id"])
        # activated_count는 delta가 아니라 전환 후 총 활성행 수이므로 항상 expected_rows다.
        or int(rows[0].get("activated_count") or 0) != expected_rows
    ):
        raise RuntimeError(f"코퍼스 전환 RPC 결과가 올바르지 않습니다: {rows}")

    verified = verify_active_release(client, state)
    record_active_cutover(state_path, state, verified, rows[0])
    print(
        f"Gemini 코퍼스 전환 완료: 원본 {verified['active_sources']}건, "
        f"활성 청크 {verified['active_rows']:,}개"
    )
    return verified


def verify_command(backup: Path) -> dict[str, Any]:
    backup_dir, _backup_manifest, sources = require_backup_dir(backup)
    _state_path, state = load_or_create_release_state(backup_dir, sources)
    if state.get("status") != "active":
        raise RuntimeError(f"Gemini 릴리스가 활성 상태가 아닙니다: {state.get('status')}")
    verified = verify_active_release(get_supabase(), state)
    print(json.dumps(verified, ensure_ascii=False, indent=2))
    return verified


def rollback_command(backup: Path) -> dict[str, Any]:
    """백업과 일치하는 기존 기준선 릴리스로 전체 코퍼스를 되돌린다."""
    backup_dir, backup_manifest, _sources = require_backup_dir(backup)
    client = get_supabase()
    baseline_release = find_baseline_release(client, backup_manifest)
    expected_contract, expected_rows = baseline_expectations(backup_manifest)

    current_contract = read_live_embedding_contract(client)
    if current_contract == expected_contract:
        verified = verify_rollback(client, baseline_release, backup_manifest)
        print(
            "이미 활성화된 기준선 코퍼스를 재검증했습니다: "
            f"활성 청크 {verified['active_rows']:,}개, "
            f"릴리스 상태 {verified['release_state']}"
        )
        return verified

    try:
        response = client.rpc(
            SWITCH_RPC, {"p_release_id": baseline_release["id"]}
        ).execute()
    except Exception as error:
        if not is_statement_timeout(error):
            raise RuntimeError("기준선 코퍼스 전환 RPC 실행에 실패했습니다.") from error
        try:
            contract_after_timeout = read_live_embedding_contract(client)
        except Exception as verification_error:
            message = statement_timeout_recovery_message(
                command="rollback",
                backup=backup_dir,
                release_id=baseline_release["id"],
                database_status=(
                    "현재 계약을 재조회하지 못해 롤백 완료 여부를 확인할 수 없습니다."
                ),
            )
            raise RuntimeError(message) from verification_error

        if contract_after_timeout == expected_contract:
            try:
                verified = verify_rollback(
                    client, baseline_release, backup_manifest
                )
            except Exception as verification_error:
                message = statement_timeout_recovery_message(
                    command="rollback",
                    backup=backup_dir,
                    release_id=baseline_release["id"],
                    database_status=(
                        "기준선 계약이 보이지만 활성 행·릴리스 전체 검증이 "
                        "끝나지 않았습니다."
                    ),
                )
                raise RuntimeError(message) from verification_error
            print(
                "PostgREST 57014 이후 기준선 계약·활성 행·릴리스를 모두 "
                "재검증해 롤백 완료를 확인했습니다: "
                f"활성 청크 {verified['active_rows']:,}개"
            )
            return verified

        raise RuntimeError(
            statement_timeout_recovery_message(
                command="rollback",
                backup=backup_dir,
                release_id=baseline_release["id"],
                database_status=(
                    "기준선 계약이 아직 활성화되지 않아 롤백 완료를 "
                    "확인하지 못했습니다."
                ),
            )
        ) from error

    rows = response.data or []
    if not isinstance(rows, list) or len(rows) != 1:
        raise RuntimeError("기준선 코퍼스 전환 RPC 응답이 올바르지 않습니다.")
    result = rows[0]
    if not isinstance(result, dict):
        raise RuntimeError("기준선 코퍼스 전환 RPC 결과가 올바르지 않습니다.")
    if (
        str(result.get("release_id")) != str(baseline_release["id"])
        or result.get("activated_count") != expected_rows
        or any(
            result.get(key) != expected_contract[key]
            for key in ("provider", "model", "version")
        )
    ):
        raise RuntimeError("기준선 코퍼스 전환 RPC 결과가 백업과 다릅니다.")

    verified = verify_rollback(client, baseline_release, backup_manifest)
    print(
        f"기존 기준선 코퍼스 롤백 완료: 활성 청크 {verified['active_rows']:,}개, "
        f"릴리스 상태 {verified['release_state']}"
    )
    return verified


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    backup_parser = subparsers.add_parser(
        "backup", help="DB 전체 행과 Storage 원본을 로컬에 백업합니다."
    )
    backup_parser.add_argument(
        "--output", type=Path, help="기본값: .rag-migration/backups/<UTC 타임스탬프>"
    )
    stage_parser = subparsers.add_parser(
        "stage", help="원본 15건을 Gemini로 임베딩해 비활성 상태로 적재합니다."
    )
    stage_parser.add_argument("--backup", type=Path, required=True)
    stage_parser.add_argument(
        "--document-id", type=int, action="append", dest="document_ids",
        help="점검용으로 특정 documents.id만 처리합니다. 여러 번 지정할 수 있습니다.",
    )
    stage_parser.add_argument(
        "--limit", type=int, help="아직 완료되지 않은 원본 중 앞에서 N건만 처리합니다."
    )
    cutover_parser = subparsers.add_parser(
        "cutover", help="스테이징된 전체 Gemini 코퍼스를 한 트랜잭션에서 활성화합니다."
    )
    cutover_parser.add_argument("--backup", type=Path, required=True)
    verify_parser = subparsers.add_parser(
        "verify", help="활성 Gemini 코퍼스의 계약·전체/문서별 행 수를 검증합니다."
    )
    verify_parser.add_argument("--backup", type=Path, required=True)
    rollback_parser = subparsers.add_parser(
        "rollback", help="백업과 일치하는 기존 기준선 코퍼스로 원자 롤백합니다."
    )
    rollback_parser.add_argument("--backup", type=Path, required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.command == "backup":
            backup_command(args.output)
            return 0
        if args.command == "stage":
            stage_command(
                args.backup,
                set(args.document_ids) if args.document_ids else None,
                args.limit,
            )
            return 0
        if args.command == "cutover":
            cutover_command(args.backup)
            return 0
        if args.command == "verify":
            verify_command(args.backup)
            return 0
        if args.command == "rollback":
            rollback_command(args.backup)
            return 0
        raise RuntimeError(f"지원하지 않는 명령입니다: {args.command}")
    except Exception as error:
        print(f"[오류] {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
