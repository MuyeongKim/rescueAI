import sys
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "indexing"))
import migrate_rag_to_gemini as migration  # noqa: E402


class FakeResponse:
    def __init__(self, data=None, count=None):
        self.data = data
        self.count = count


class FakePostgrestTimeout(Exception):
    code = "57014"


class FakeQuery:
    def __init__(self, client, table):
        self.client = client
        self.table = table
        self.columns = "*"
        self.filters = []
        self.count_mode = None
        self.head = False
        self.row_limit = None
        self.upsert_row = None
        self.upsert_conflict = None

    def select(self, columns, count=None, head=False):
        self.columns = columns
        self.count_mode = count
        self.head = head
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def limit(self, value):
        self.row_limit = value
        return self

    def upsert(self, row, on_conflict=None):
        self.upsert_row = row.copy()
        self.upsert_conflict = on_conflict
        return self

    def execute(self):
        if self.upsert_row is not None:
            rows = self.client.tables.setdefault(self.table, [])
            existing = next(
                (row for row in rows if row.get("id") == self.upsert_row.get("id")),
                None,
            )
            if existing is None:
                rows.append(self.upsert_row.copy())
            else:
                existing.update(self.upsert_row)
            self.client.upsert_calls.append(
                (self.table, self.upsert_row.copy(), self.upsert_conflict)
            )
            return FakeResponse(data=[self.upsert_row.copy()])

        rows = [
            row.copy()
            for row in self.client.tables.get(self.table, [])
            if all(row.get(column) == value for column, value in self.filters)
        ]
        if self.head:
            return FakeResponse(data=None, count=len(rows))
        if self.row_limit is not None:
            rows = rows[: self.row_limit]
        if self.columns != "*":
            selected = [column.strip() for column in self.columns.split(",")]
            rows = [{column: row.get(column) for column in selected} for row in rows]
        return FakeResponse(data=rows)


class FakeRpcQuery:
    def __init__(self, client, release_id):
        self.client = client
        self.release_id = release_id

    def execute(self):
        release = next(
            row
            for row in self.client.tables[migration.RELEASE_TABLE]
            if row["id"] == self.release_id
        )
        if self.client.rpc_error is not None and not self.client.rpc_error_after_transition:
            raise self.client.rpc_error
        if self.client.apply_rpc_transition:
            for row in self.client.tables[migration.RELEASE_TABLE]:
                if row.get("state") == "active":
                    row["state"] = "inactive"
            release["state"] = "active"
            self.client.tables[migration.CONFIG_TABLE] = [
                {
                    "table_name": migration.RAG_TABLE,
                    **{
                        key: release[key]
                        for key in migration.EMBEDDING_CONTRACT_KEYS
                    },
                }
            ]
            manifest = release.get("manifest") or []
            if manifest:
                ingestion_ids = {entry["ingestion_id"] for entry in manifest}
                for row in self.client.tables[migration.RAG_TABLE]:
                    row["is_active"] = row.get("ingestion_id") in ingestion_ids
            else:
                # 기존 롤백 단위 테스트의 간단한 기준선 릴리스 표현을 지원한다.
                for row in self.client.tables[migration.RAG_TABLE]:
                    row["is_active"] = True
        if self.client.rpc_error is not None:
            raise self.client.rpc_error
        return FakeResponse(
            data=[
                {
                    "release_id": release["id"],
                    "activated_count": release["expected_rows"],
                    "deactivated_count": 1,
                    "provider": release["provider"],
                    "model": release["model"],
                    "version": release["version"],
                }
            ]
        )


class FakeClient:
    def __init__(
        self,
        tables,
        *,
        apply_rpc_transition=True,
        rpc_error=None,
        rpc_error_after_transition=False,
    ):
        self.tables = tables
        self.apply_rpc_transition = apply_rpc_transition
        self.rpc_error = rpc_error
        self.rpc_error_after_transition = rpc_error_after_transition
        self.rpc_calls = []
        self.upsert_calls = []

    def table(self, name):
        return FakeQuery(self, name)

    def rpc(self, name, params):
        self.rpc_calls.append((name, params.copy()))
        return FakeRpcQuery(self, params["p_release_id"])


def source_fixture(document_id=16):
    file_hash = "a" * 64
    return {
        "source": "화학사고 대응훈련 실무가이드.pdf",
        "category": "화학사고",
        "year": "2026",
        "document_id": document_id,
        "file_hash": file_hash,
        "storage_bucket": "documents",
        "storage_path": f"rag/aa/{file_hash}.pdf",
        "original_filename": "화학사고 대응훈련 실무가이드.pdf",
        "local_filename": f"{document_id:03d}_화학사고 대응훈련 실무가이드.pdf",
        "local_path": f"source-pdfs/{document_id:03d}_화학사고 대응훈련 실무가이드.pdf",
        "chunk_count": 12,
        "ingestion_ids": ["2112e8c5-39ce-4711-ab18-54cc2812a5ea"],
    }


def backup_manifest_fixture(active_row_count=3):
    return {
        "format_version": 1,
        "table_name": migration.RAG_TABLE,
        "rag_row_count": active_row_count,
        "active_row_count": active_row_count,
        "active_source_count": 0,
        "embedding_contract": {
            "table_name": migration.RAG_TABLE,
            "provider": "ollama",
            "model": "bge-m3:latest",
            "dimensions": 1024,
            "version": "bge-m3-raw-v1",
            "updated_at": "2026-08-28T00:00:00+00:00",
        },
    }


def release_fixture(
    release_id="11111111-1111-4111-8111-111111111111",
    *,
    state="inactive",
    expected_rows=3,
):
    contract = backup_manifest_fixture(expected_rows)["embedding_contract"]
    return {
        "id": release_id,
        "provider": contract["provider"],
        "model": contract["model"],
        "dimensions": contract["dimensions"],
        "version": contract["version"],
        "expected_rows": expected_rows,
        "state": state,
    }


def write_backup_dir(tmp_path, manifest):
    migration.write_json(tmp_path / "backup_manifest.json", manifest)
    migration.write_json(tmp_path / "source_manifest.json", [])
    return tmp_path


def fake_tables(baseline, *, active_rows=0, contract=None, other_releases=None):
    config = contract or {
        "table_name": migration.RAG_TABLE,
        "provider": "google",
        "model": migration.GEMINI_MODEL,
        "dimensions": 1024,
        "version": migration.GEMINI_VERSION,
    }
    releases = [baseline, *(other_releases or [])]
    return {
        migration.RELEASE_TABLE: releases,
        migration.CONFIG_TABLE: [config],
        migration.RAG_TABLE: [
            {"id": f"row-{index}", "is_active": index < active_rows}
            for index in range(int(baseline["expected_rows"]))
        ],
    }


def cutover_case(tmp_path, *, baseline_rows=3, gemini_rows=2):
    source = source_fixture()
    backup_manifest = backup_manifest_fixture(baseline_rows)
    backup_manifest["active_source_count"] = 1
    migration.write_json(tmp_path / "backup_manifest.json", backup_manifest)
    migration.write_json(tmp_path / "source_manifest.json", [source])

    state = migration.new_release_state([source])
    state["entries"][0].update(status="completed", chunk_count=gemini_rows)
    state["status"] = "staged"
    state["expected_rows"] = gemini_rows
    migration.write_json(tmp_path / migration.RELEASE_STATE_FILE, state)

    baseline = release_fixture(state="active", expected_rows=baseline_rows)
    baseline_contract = {
        "table_name": migration.RAG_TABLE,
        **{
            key: backup_manifest["embedding_contract"][key]
            for key in migration.EMBEDDING_CONTRACT_KEYS
        },
    }
    tables = {
        migration.RELEASE_TABLE: [baseline],
        migration.CONFIG_TABLE: [baseline_contract],
        migration.RAG_TABLE: [
            {
                "id": f"baseline-{index}",
                "ingestion_id": f"baseline-ingestion-{index}",
                "is_active": True,
            }
            for index in range(baseline_rows)
        ]
        + [
            {
                "id": f"gemini-{index}",
                "ingestion_id": state["entries"][0]["ingestion_id"],
                "is_active": False,
            }
            for index in range(gemini_rows)
        ],
    }
    return tmp_path, backup_manifest, state, tables


def committed_gemini_release(state):
    return {
        "id": state["release_id"],
        "label": state["label"],
        **migration.release_contract(state),
        "manifest": migration.release_manifest(state),
        "expected_rows": state["expected_rows"],
        "state": "active",
        "activated_at": "2026-08-28T03:30:00+00:00",
    }


def mark_gemini_committed(state, tables):
    for row in tables[migration.RAG_TABLE]:
        row["is_active"] = row.get("ingestion_id") == state["entries"][0]["ingestion_id"]
    tables[migration.CONFIG_TABLE] = [
        {"table_name": migration.RAG_TABLE, **migration.release_contract(state)}
    ]
    for release in tables[migration.RELEASE_TABLE]:
        release["state"] = "inactive"
    tables[migration.RELEASE_TABLE].append(committed_gemini_release(state))


def test_build_source_manifest_preserves_document_and_file_contract():
    source = source_fixture()
    metadata = {
        "source": source["source"],
        "category": source["category"],
        "edu_category": source["category"],
        "year": source["year"],
        "document_id": source["document_id"],
        "file_hash": source["file_hash"],
    }
    rag_rows = [
        {
            "id": "655a588c-0d23-4b01-b895-c851590e0ddb",
            "metadata": metadata,
            "ingestion_id": source["ingestion_ids"][0],
            "is_active": True,
        }
    ]
    documents = [
        {
            "id": source["document_id"],
            "file_url": source["storage_path"],
            "original_filename": source["source"],
        }
    ]

    manifest = migration.build_source_manifest(rag_rows, documents)

    assert len(manifest) == 1
    assert manifest[0]["document_id"] == source["document_id"]
    assert manifest[0]["file_hash"] == source["file_hash"]
    assert manifest[0]["category"] == source["category"]
    assert manifest[0]["year"] == source["year"]


def test_release_state_uses_distinct_deterministic_ingestion_ids():
    sources = [source_fixture(15), source_fixture(16)]
    state = migration.new_release_state(sources)

    ids = [entry["ingestion_id"] for entry in state["entries"]]
    assert len(ids) == len(set(ids)) == 2
    assert all(entry["status"] == "pending" for entry in state["entries"])


def test_release_manifest_contains_full_source_contract():
    state = migration.new_release_state([source_fixture()])
    entry = state["entries"][0]
    entry.update(status="completed", chunk_count=141)

    manifest = migration.release_manifest(state)

    assert manifest == [
        {
            "ingestion_id": entry["ingestion_id"],
            "category": "화학사고",
            "year": "2026",
            "source": "화학사고 대응훈련 실무가이드.pdf",
            "document_id": 16,
            "file_hash": "a" * 64,
            "expected_count": 141,
        }
    ]


def test_release_manifest_rejects_partial_corpus():
    state = migration.new_release_state([source_fixture()])

    with pytest.raises(RuntimeError, match="모두 완료"):
        migration.release_manifest(state)


def test_cutover_validates_state_and_manifest_before_live_db(monkeypatch, tmp_path):
    backup_dir, _backup_manifest, state, _tables = cutover_case(tmp_path)
    state["entries"][0]["status"] = "pending"
    migration.write_json(backup_dir / migration.RELEASE_STATE_FILE, state)
    monkeypatch.setattr(
        migration,
        "get_supabase",
        lambda: pytest.fail("manifest 검증 전에 DB에 접근하면 안 됩니다."),
    )

    with pytest.raises(RuntimeError, match="모두 완료"):
        migration.cutover_command(backup_dir)


def test_cutover_first_run_requires_backup_contract_and_activates_total_rows(
    monkeypatch, tmp_path
):
    backup_dir, _backup_manifest, state, tables = cutover_case(tmp_path)
    client = FakeClient(tables)
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    result = migration.cutover_command(backup_dir)

    assert client.rpc_calls == [
        (migration.SWITCH_RPC, {"p_release_id": state["release_id"]})
    ]
    assert len(client.upsert_calls) == 1
    assert result["active_rows"] == state["expected_rows"]
    saved = migration.read_json(backup_dir / migration.RELEASE_STATE_FILE)
    assert saved["status"] == "active"
    assert saved["cutover_result"]["release_id"] == state["release_id"]
    # RPC activated_count는 변경 delta가 아니라 전환 후 총 활성 행 수다.
    assert saved["cutover_result"]["activated_count"] == state["expected_rows"]


def test_statement_timeout_detection_supports_postgrest_code_and_payload():
    assert migration.is_statement_timeout(FakePostgrestTimeout("statement timeout"))
    assert migration.is_statement_timeout(
        Exception({"code": "57014", "message": "canceling statement"})
    )
    assert not migration.is_statement_timeout(Exception("network unavailable"))


def test_cutover_timeout_on_baseline_prints_exact_sql_and_keeps_staged_state(
    monkeypatch, tmp_path
):
    backup_dir, _backup_manifest, state, tables = cutover_case(tmp_path)
    client = FakeClient(
        tables,
        rpc_error=FakePostgrestTimeout(
            "canceling statement due to statement timeout"
        ),
    )
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    with pytest.raises(RuntimeError) as caught:
        migration.cutover_command(backup_dir)

    message = str(caught.value)
    assert "57014 statement timeout" in message
    assert "부분 성공을 가정하지 않았습니다" in message
    assert "백업 기준선 계약이 유지" in message
    assert (
        "select * from public.switch_rag_rescue_corpus("
        f"'{state['release_id']}'::uuid);"
    ) in message
    assert "migrate_rag_to_gemini.py cutover --backup" in message
    saved = migration.read_json(backup_dir / migration.RELEASE_STATE_FILE)
    assert saved["status"] == "staged"
    staged_release = next(
        row
        for row in tables[migration.RELEASE_TABLE]
        if row["id"] == state["release_id"]
    )
    assert staged_release["state"] == "staged"


def test_cutover_timeout_recovers_only_after_full_database_verification(
    monkeypatch, tmp_path
):
    backup_dir, _backup_manifest, state, tables = cutover_case(tmp_path)
    client = FakeClient(
        tables,
        rpc_error=FakePostgrestTimeout("57014"),
        rpc_error_after_transition=True,
    )
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    result = migration.cutover_command(backup_dir)

    assert result["active_rows"] == state["expected_rows"]
    saved = migration.read_json(backup_dir / migration.RELEASE_STATE_FILE)
    assert saved["status"] == "active"
    assert saved["cutover_result"]["recovered_from_database"] is True


def test_cutover_timeout_never_accepts_target_contract_without_full_verification(
    monkeypatch, tmp_path
):
    backup_dir, _backup_manifest, state, tables = cutover_case(tmp_path)
    client = FakeClient(
        tables,
        rpc_error=FakePostgrestTimeout("57014"),
        rpc_error_after_transition=True,
    )
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    def reject_partial_state(*_args, **_kwargs):
        raise RuntimeError("활성 행 검증 실패")

    monkeypatch.setattr(migration, "verify_active_release", reject_partial_state)

    with pytest.raises(RuntimeError) as caught:
        migration.cutover_command(backup_dir)

    assert "전체 검증이 끝나지 않았습니다" in str(caught.value)
    saved = migration.read_json(backup_dir / migration.RELEASE_STATE_FILE)
    assert saved["status"] == "staged"
    assert "cutover_result" not in saved
    assert state["release_id"] in str(caught.value)


def test_cutover_rerun_recovers_local_state_without_upsert_or_rpc(monkeypatch, tmp_path):
    backup_dir, _backup_manifest, state, tables = cutover_case(tmp_path)
    mark_gemini_committed(state, tables)
    client = FakeClient(tables, apply_rpc_transition=False)
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    result = migration.cutover_command(backup_dir)

    assert client.upsert_calls == []
    assert client.rpc_calls == []
    assert result["active_rows"] == state["expected_rows"]
    saved = migration.read_json(backup_dir / migration.RELEASE_STATE_FILE)
    assert saved["status"] == "active"
    assert saved["activated_at"] == "2026-08-28T03:30:00+00:00"
    assert saved["cutover_result"] == {
        "release_id": state["release_id"],
        "activated_count": state["expected_rows"],
        "provider": migration.GEMINI_PROVIDER,
        "model": migration.GEMINI_MODEL,
        "version": migration.GEMINI_VERSION,
        "recovered_from_database": True,
    }


def test_cutover_rerun_rejects_ambiguous_active_release(monkeypatch, tmp_path):
    backup_dir, _backup_manifest, state, tables = cutover_case(tmp_path)
    mark_gemini_committed(state, tables)
    tables[migration.RELEASE_TABLE].append(committed_gemini_release(state))
    client = FakeClient(tables, apply_rpc_transition=False)
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    with pytest.raises(RuntimeError, match="후보가 정확히 하나"):
        migration.cutover_command(backup_dir)

    assert client.upsert_calls == []
    assert client.rpc_calls == []


def test_cutover_rejects_third_embedding_contract_before_mutation(monkeypatch, tmp_path):
    backup_dir, _backup_manifest, _state, tables = cutover_case(tmp_path)
    tables[migration.CONFIG_TABLE] = [
        {
            "table_name": migration.RAG_TABLE,
            "provider": "openai",
            "model": "text-embedding-3-large",
            "dimensions": 1024,
            "version": "openai-raw-v1",
        }
    ]
    client = FakeClient(tables, apply_rpc_transition=False)
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    with pytest.raises(RuntimeError, match="혼합/제3 계약"):
        migration.cutover_command(backup_dir)

    assert client.upsert_calls == []
    assert client.rpc_calls == []


def test_parse_args_accepts_rollback_backup():
    args = migration.parse_args(["rollback", "--backup", "/tmp/backup"])

    assert args.command == "rollback"
    assert args.backup == Path("/tmp/backup")


def test_rollback_switches_unique_backup_baseline_and_verifies(monkeypatch, tmp_path):
    manifest = backup_manifest_fixture()
    backup_dir = write_backup_dir(tmp_path, manifest)
    baseline = release_fixture()
    current_release = {
        "id": "22222222-2222-4222-8222-222222222222",
        "provider": "google",
        "model": migration.GEMINI_MODEL,
        "dimensions": 1024,
        "version": migration.GEMINI_VERSION,
        "expected_rows": 4,
        "state": "active",
    }
    client = FakeClient(fake_tables(baseline, other_releases=[current_release]))
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    result = migration.rollback_command(backup_dir)

    assert client.rpc_calls == [
        (migration.SWITCH_RPC, {"p_release_id": baseline["id"]})
    ]
    assert result == {
        "release_id": baseline["id"],
        "release_state": "active",
        "active_rows": 3,
        "contract": {
            "provider": "ollama",
            "model": "bge-m3:latest",
            "dimensions": 1024,
            "version": "bge-m3-raw-v1",
        },
    }


def test_rollback_rerun_verifies_active_baseline_without_rpc(monkeypatch, tmp_path):
    manifest = backup_manifest_fixture()
    backup_dir = write_backup_dir(tmp_path, manifest)
    baseline = release_fixture(state="active")
    previous_release = {
        "id": "22222222-2222-4222-8222-222222222222",
        "provider": "google",
        "model": migration.GEMINI_MODEL,
        "dimensions": 1024,
        "version": migration.GEMINI_VERSION,
        "expected_rows": 4,
        "state": "inactive",
    }
    baseline_contract = {
        "table_name": migration.RAG_TABLE,
        **{
            key: manifest["embedding_contract"][key]
            for key in migration.EMBEDDING_CONTRACT_KEYS
        },
    }
    client = FakeClient(
        fake_tables(
            baseline,
            active_rows=manifest["active_row_count"],
            contract=baseline_contract,
            other_releases=[previous_release],
        ),
        apply_rpc_transition=False,
    )
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    result = migration.rollback_command(backup_dir)

    assert result["active_rows"] == manifest["active_row_count"]
    assert client.rpc_calls == []


def test_rollback_timeout_prints_exact_baseline_sql(monkeypatch, tmp_path):
    manifest = backup_manifest_fixture()
    backup_dir = write_backup_dir(tmp_path, manifest)
    baseline = release_fixture()
    current_release = {
        "id": "22222222-2222-4222-8222-222222222222",
        "provider": "google",
        "model": migration.GEMINI_MODEL,
        "dimensions": 1024,
        "version": migration.GEMINI_VERSION,
        "expected_rows": 4,
        "state": "active",
    }
    client = FakeClient(
        fake_tables(baseline, other_releases=[current_release]),
        rpc_error=FakePostgrestTimeout("57014"),
    )
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    with pytest.raises(RuntimeError) as caught:
        migration.rollback_command(backup_dir)

    message = str(caught.value)
    assert "57014 statement timeout" in message
    assert (
        "select * from public.switch_rag_rescue_corpus("
        f"'{baseline['id']}'::uuid);"
    ) in message
    assert "migrate_rag_to_gemini.py rollback --backup" in message


def test_rollback_timeout_recovers_only_after_full_database_verification(
    monkeypatch, tmp_path
):
    manifest = backup_manifest_fixture()
    backup_dir = write_backup_dir(tmp_path, manifest)
    baseline = release_fixture()
    current_release = {
        "id": "22222222-2222-4222-8222-222222222222",
        "provider": "google",
        "model": migration.GEMINI_MODEL,
        "dimensions": 1024,
        "version": migration.GEMINI_VERSION,
        "expected_rows": 4,
        "state": "active",
    }
    client = FakeClient(
        fake_tables(baseline, other_releases=[current_release]),
        rpc_error=FakePostgrestTimeout("57014"),
        rpc_error_after_transition=True,
    )
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    result = migration.rollback_command(backup_dir)

    assert result["release_id"] == baseline["id"]
    assert result["active_rows"] == manifest["active_row_count"]


def test_rollback_rejects_ambiguous_baseline_before_rpc(monkeypatch, tmp_path):
    manifest = backup_manifest_fixture()
    backup_dir = write_backup_dir(tmp_path, manifest)
    first = release_fixture()
    second = release_fixture("33333333-3333-4333-8333-333333333333")
    client = FakeClient(fake_tables(first, other_releases=[second]))
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    with pytest.raises(RuntimeError, match="후보가 2개"):
        migration.rollback_command(backup_dir)

    assert client.rpc_calls == []


def test_rollback_rejects_missing_baseline_before_rpc(monkeypatch, tmp_path):
    manifest = backup_manifest_fixture()
    backup_dir = write_backup_dir(tmp_path, manifest)
    different_count = release_fixture(expected_rows=2)
    client = FakeClient(fake_tables(different_count))
    monkeypatch.setattr(migration, "get_supabase", lambda: client)

    with pytest.raises(RuntimeError, match="찾지 못했습니다"):
        migration.rollback_command(backup_dir)

    assert client.rpc_calls == []


@pytest.mark.parametrize(
    ("failure", "message"),
    [
        ("active_rows", "활성 RAG 행 수"),
        ("contract", "DB 임베딩 계약"),
        ("release_state", "기준선 릴리스가 활성 상태"),
    ],
)
def test_verify_rollback_checks_rows_contract_and_release_state(failure, message):
    manifest = backup_manifest_fixture()
    baseline = release_fixture()
    expected_contract = {
        "table_name": migration.RAG_TABLE,
        "provider": "ollama",
        "model": "bge-m3:latest",
        "dimensions": 1024,
        "version": "bge-m3-raw-v1",
    }
    active_rows = 3
    releases = []
    if failure == "active_rows":
        active_rows = 2
        baseline["state"] = "active"
    elif failure == "contract":
        expected_contract["model"] = "wrong-model"
        baseline["state"] = "active"
    else:
        releases.append(
            {
                "id": "22222222-2222-4222-8222-222222222222",
                "provider": "google",
                "model": migration.GEMINI_MODEL,
                "dimensions": 1024,
                "version": migration.GEMINI_VERSION,
                "expected_rows": 3,
                "state": "active",
            }
        )
    client = FakeClient(
        fake_tables(
            baseline,
            active_rows=active_rows,
            contract=expected_contract,
            other_releases=releases,
        ),
        apply_rpc_transition=False,
    )

    with pytest.raises(RuntimeError, match=message):
        migration.verify_rollback(client, baseline, manifest)
