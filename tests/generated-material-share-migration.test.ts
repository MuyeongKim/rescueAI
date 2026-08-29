import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260829052407_protect_generated_material_sharing.sql",
  ),
  "utf8",
);
const RLS_TEST = readFileSync(
  resolve(
    process.cwd(),
    "supabase/tests/generated_materials_sharing_rls_test.sql",
  ),
  "utf8",
);
const CLASSIFICATION_MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260829140500_classify_rag_procedure_sources.sql",
  ),
  "utf8",
);
const COMMON_SOP_MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260829160624_allow_common_sop_generation_evidence.sql",
  ),
  "utf8",
);
const GENERATE_CONTEXT = readFileSync(
  resolve(process.cwd(), "lib/generate-context.ts"),
  "utf8",
);
const SETUP_SQL = readFileSync(
  resolve(process.cwd(), "supabase/setup_new_project.sql"),
  "utf8",
);

describe("generated_materials 공유 DB 보호", () => {
  it("직접 INSERT·공유 전환·공유 본문 변경을 같은 트리거에서 검사한다", () => {
    expect(MIGRATION).toContain(
      "create trigger enforce_generated_material_share_contract",
    );
    expect(MIGRATION).toContain("before insert or update of");
    expect(MIGRATION).toContain("content, shared, author_name");
    expect(MIGRATION).toContain("generated_material_share_contract_invalid");

    expect(RLS_TEST).toContain("미검증 shared=true 직접 INSERT");
    expect(RLS_TEST).toContain("shared/author_name 직접 UPDATE");
    expect(RLS_TEST).toContain("이미 공유된 행의 본문");
  });

  it("클라이언트가 SOP 상태를 속이지 못하고 실제 같은 분야 RAG 근거와 비교한다", () => {
    expect(MIGRATION).toContain(
      "metadata ->> 'document_type' in ('sop', 'operational_guidance')",
    );
    expect(MIGRATION).toContain("v_matching_labels");
    expect(MIGRATION).toContain("if v_status = 'degraded' then");
    expect(RLS_TEST).toContain(
      "관련 활성 SOP가 있으면 not_found 상태로 속여 공유할 수 없다",
    );
    expect(RLS_TEST).toContain("그 라벨에 없는 SOP 번호");
  });

  it("요청 분야에는 일반 원문을 유지하되 공통 범위는 SOP·현장지침만 허용한다", () => {
    expect(COMMON_SOP_MIGRATION).toContain(
      "create or replace function public.generated_material_rag_scope_valid(",
    );
    expect(COMMON_SOP_MIGRATION).toContain(
      "p_metadata ->> 'edu_category' = p_category",
    );
    expect(COMMON_SOP_MIGRATION).toMatch(
      /p_metadata ->> 'edu_category' = '현장지휘·공통'[\s\S]*p_metadata ->> 'document_type' in \('sop', 'operational_guidance'\)/,
    );
    expect(COMMON_SOP_MIGRATION).toMatch(
      /generated_material_source_provenance_valid\([\s\S]*generated_material_rag_scope_valid\(rag\.metadata, p_category\)/,
    );
    expect(COMMON_SOP_MIGRATION).toMatch(
      /into v_matching_labels[\s\S]*generated_material_rag_scope_valid\(rag\.metadata, p_category\)[\s\S]*metadata ->> 'document_type' in \('sop', 'operational_guidance'\)/,
    );
    expect(COMMON_SOP_MIGRATION).toContain(
      "revoke all on function public.generated_material_rag_scope_valid(jsonb, text)",
    );
    expect(RLS_TEST).toContain(
      "현장지휘·공통의 SOP 분류 원문은 산악 자료의 출처와 SOP 근거로 공유할 수 있다",
    );
    expect(RLS_TEST).toContain(
      "현장지휘·공통의 training_material은 다른 분야 content.sources로 공유할 수 없다",
    );
    expect(RLS_TEST).toContain(
      "현장지휘·공통이 아닌 타 분야 SOP는 요청 분야 근거로 공유할 수 없다",
    );
  });

  it("공통 SOP 계약 전환 시 기존 공식 공유본은 본문을 보존한 채 재검증 대상으로 돌린다", () => {
    const exclusiveLockIndex = COMMON_SOP_MIGRATION.indexOf(
      "select pg_catalog.pg_advisory_xact_lock(",
    );
    const invalidationIndex = COMMON_SOP_MIGRATION.indexOf(
      "update public.generated_materials",
    );
    expect(exclusiveLockIndex).toBeGreaterThan(-1);
    expect(COMMON_SOP_MIGRATION.slice(exclusiveLockIndex, invalidationIndex)).toContain(
      "pg_catalog.hashtextextended('rag_rescue_corpus_switch', 0)",
    );
    expect(invalidationIndex).toBeGreaterThan(exclusiveLockIndex);
    expect(COMMON_SOP_MIGRATION).toMatch(
      /update public\.generated_materials\s+set shared = false,\s+author_name = null\s+where shared\s+and kind <> 'notebooklm';/s,
    );
    expect(COMMON_SOP_MIGRATION).not.toContain(
      "delete from public.generated_materials",
    );
  });

  it("PGlite에서 후속 마이그레이션을 실행해 공식 공유만 원자적으로 무효화한다", async () => {
    const db = new PGlite();
    await db.waitReady;
    try {
      await db.exec(`
        create role anon;
        create role authenticated;
        create table public.rag_rescue (
          id text primary key,
          content text,
          metadata jsonb,
          is_active boolean not null default true
        );
        create table public.documents (
          id bigint primary key,
          category text,
          title text,
          status text
        );
        create table public.chunks (
          id bigint primary key,
          document_id bigint,
          page_num integer
        );
        create table public.generated_materials (
          id bigint generated always as identity primary key,
          kind text not null,
          shared boolean not null default false,
          author_name text,
          content jsonb not null default '{}'::jsonb
        );
        create function public.generated_material_source_label(p_metadata jsonb)
        returns text language sql immutable set search_path = ''
        as $$ select '[stub]'::text $$;
        create function public.generated_material_focus_terms(p_topic text, p_focus text)
        returns text[] language sql immutable set search_path = ''
        as $$ select array['stub']::text[] $$;
        create function public.generated_material_rag_row_supports(
          p_content text, p_metadata jsonb, p_terms text[]
        ) returns boolean language sql immutable set search_path = ''
        as $$ select false $$;
        create function public.generated_material_compact_text(p_value text)
        returns text language sql immutable set search_path = ''
        as $$ select coalesce(p_value, '') $$;
        insert into public.generated_materials(kind, shared, author_name, content)
        values
          ('plan', true, '검증 대원', '{"preserved":true}'::jsonb),
          ('notebooklm', true, '검증 대원', '{"prompt":"충분히 긴 NotebookLM 프롬프트"}'::jsonb);
      `);

      // advisory lock 함수까지 포함한 실제 후속 SQL 전체가 PostgreSQL에서 실행돼야 한다.
      await db.exec(COMMON_SOP_MIGRATION);
      const result = await db.query<{
        kind: string;
        shared: boolean;
        author_name: string | null;
        content: Record<string, unknown>;
      }>(`
        select kind, shared, author_name, content
        from public.generated_materials
        order by kind
      `);

      expect(result.rows).toEqual([
        {
          kind: "notebooklm",
          shared: true,
          author_name: "검증 대원",
          content: { prompt: "충분히 긴 NotebookLM 프롬프트" },
        },
        {
          kind: "plan",
          shared: false,
          author_name: null,
          content: { preserved: true },
        },
      ]);
    } finally {
      await db.close();
    }
  });

  it("DB SOP 식별자는 페이지 숫자를 번호 근거로 쓰지 않고 따옴표 명칭만 정확 비교한다", async () => {
    const db = new PGlite();
    await db.waitReady;
    try {
      await db.exec(`
        create role anon;
        create role authenticated;
        create table public.rag_rescue (
          id text primary key,
          content text,
          metadata jsonb,
          is_active boolean not null default true
        );
        create table public.documents (
          id bigint primary key,
          category text,
          title text,
          status text
        );
        create table public.chunks (
          id bigint primary key,
          document_id bigint,
          page_num integer
        );
        create table public.generated_materials (
          id bigint generated always as identity primary key,
          kind text not null,
          shared boolean not null default false,
          author_name text,
          content jsonb not null default '{}'::jsonb
        );
        create function public.generated_material_source_label(p_metadata jsonb)
        returns text language sql immutable set search_path = ''
        as $$ select p_metadata ->> 'label' $$;
        create function public.generated_material_focus_terms(p_topic text, p_focus text)
        returns text[] language sql immutable set search_path = ''
        as $$ select array['산악']::text[] $$;
        create function public.generated_material_rag_row_supports(
          p_content text, p_metadata jsonb, p_terms text[]
        ) returns boolean language sql immutable set search_path = ''
        as $$ select true $$;
        create function public.generated_material_compact_text(p_value text)
        returns text language sql immutable set search_path = ''
        as $$
          select pg_catalog.regexp_replace(
            pg_catalog.lower(coalesce(p_value, '')),
            '[^0-9a-z가-힣]+',
            '',
            'g'
          )
        $$;
        insert into public.rag_rescue(id, content, metadata, is_active)
        values (
          'sop-page',
          '산악 현장 안전 절차',
          '{
            "edu_category":"산악",
            "document_type":"sop",
            "document_id":"1",
            "page_num":"7",
            "label":"[산악 SOP 123 p.7]"
          }'::jsonb,
          true
        );
      `);
      await db.exec(COMMON_SOP_MIGRATION);

      const contentFor = (claim: string) => ({
        sections: [
          {
            heading: "훈련내용",
            content: `[관련 SOP 적용] ${claim} [산악 SOP 123 p.7]`,
          },
        ],
        sopEvidence: {
          status: "found",
          sourceLabels: ["[산악 SOP 123 p.7]"],
        },
      });
      const check = async (claim: string) => {
        const result = await db.query<{ valid: boolean }>(
          `select public.generated_material_share_contract_valid(
            'plan', '산악', '일반 대원', '1시간', '산악 안전', '계획', $1::jsonb
          ) as valid`,
          [JSON.stringify(contentFor(claim))]
        );
        return result.rows[0]?.valid;
      };

      await expect(check("SOP 123에 따라 안전구역을 확인한다.")).resolves.toBe(true);
      await expect(check("SOP 7에 따라 안전구역을 확인한다.")).resolves.toBe(false);
      await expect(
        check("표준작전절차: 재난현장에서 보호구를 확인하고 안전구역을 통제한다.")
      ).resolves.toBe(true);
      await expect(
        check("“허구 산악 절차” 표준작전절차에 따라 안전구역을 확인한다.")
      ).resolves.toBe(false);
    } finally {
      await db.close();
    }
  });

  it("기존 공식 공유본은 재검증 전 모두 비공개로 되돌리고 본문은 보존한다", () => {
    expect(MIGRATION).toMatch(
      /update public\.generated_materials\s+set shared = false,\s+author_name = null\s+where shared\s+and kind <> 'notebooklm';/s,
    );
    expect(MIGRATION).toMatch(
      /where shared\s+and kind = 'notebooklm'\s+and \([\s\S]*jsonb_typeof\(content -> 'prompt'\) is distinct from 'string'[\s\S]*char_length\(category\), 0\) > 100/,
    );
    expect(MIGRATION).not.toContain("delete from public.generated_materials");
  });

  it("직접 대용량 JSON으로 SECURITY DEFINER 검사를 소진하지 못하게 상한을 둔다", () => {
    expect(MIGRATION).toContain(
      "pg_catalog.pg_column_size(p_content) > 262144",
    );
    expect(MIGRATION).toContain(
      "pg_catalog.octet_length(p_content::text) > 131072",
    );
    expect(MIGRATION).toContain(
      "jsonb_array_length(p_content -> 'slides') not between 1 and 20",
    );
    expect(MIGRATION).toContain(
      "coalesce(pg_catalog.char_length(p_category), 0) > 100",
    );
    expect(MIGRATION).toContain(
      "coalesce(pg_catalog.char_length(p_audience), 0) > 50",
    );
    expect(MIGRATION).toContain(
      "coalesce(pg_catalog.char_length(p_duration), 0) > 20",
    );
    expect(MIGRATION).toContain(
      "coalesce(pg_catalog.char_length(p_topic), 0) > 100",
    );
    expect(RLS_TEST).toContain("앱 상한보다 긴 topic");
    expect(RLS_TEST).toContain("NotebookLM 조기 반환");
    expect(RLS_TEST).toContain("앱 상한보다 긴 audience");
    expect(RLS_TEST).toContain("앱 상한보다 긴 duration");
  });

  it("JS SOP 검사와 같은 지정 위치·참조·문자열 타입 경계를 강제한다", () => {
    expect(MIGRATION).toContain("v_target_count <> 1");
    expect(MIGRATION).toContain("v_refs_by_chunk");
    expect(MIGRATION).toContain(
      "jsonb_typeof(v_item -> 'content') is distinct from 'string'",
    );
    expect(MIGRATION).toContain(
      "jsonb_typeof(p_content -> 'prompt') = 'string'",
    );
    expect(RLS_TEST).toContain("중복 지정 섹션의 마지막 값");
    expect(RLS_TEST).toContain("슬라이드 sourceRefs에만 둔 SOP 안내문");
    expect(RLS_TEST).toContain("대괄호가 없는 허위 SOP sourceRefs");
    expect(RLS_TEST).toContain("공유 UI를 깨뜨리는 비문자 섹션 본문");
  });

  it("모든 문서형 생성물 출처를 외부 RAG 또는 내부 processed 원본과 대조한다", () => {
    expect(MIGRATION).toContain("generated_material_normalize_ocr");
    expect(MIGRATION).toContain("'((오염도|시간|압력|농도)[[:space:]]*)축정'");
    expect(MIGRATION).toContain(
      "'2인[[:space:]]*7조([[:space:]]*(상의|하의)[[:space:]]*[>→])'",
    );
    expect(MIGRATION).toContain("jsonb_array_elements(p_content -> 'sources')");
    expect(MIGRATION).toContain(
      "create or replace function public.generated_material_source_provenance_valid(",
    );
    expect(MIGRATION).toContain(
      "where not public.generated_material_source_provenance_valid(source.value, p_category)",
    );
    expect(MIGRATION).toContain(
      "v_visual_mode in ('source-page', 'source-crop')",
    );
    expect(MIGRATION).toContain("from public.rag_rescue as rag");
    expect(MIGRATION).toContain("rag.metadata ->> 'edu_category' = p_category");
    expect(MIGRATION).toContain("from public.documents as document");
    expect(MIGRATION).toContain(
      "join public.chunks as chunk on chunk.document_id = document.id",
    );
    expect(MIGRATION).toContain("document.status = 'processed'");
    expect(MIGRATION).toContain("document.category = p_category");
    expect(MIGRATION).toContain("not between 1 and 9007199254740991");
    expect(MIGRATION).toContain("and chunk.page_num is null");
    expect(MIGRATION).toContain("= pg_catalog.btrim(v_visual ->> 'sourceRef')");
    expect(RLS_TEST).toContain("축정→측정 OCR 교정");
    expect(RLS_TEST).toContain("active RAG 원문과 같으면 공유한다");
    expect(RLS_TEST).toContain("active RAG 원문과 다르면 공유를 차단한다");
    expect(RLS_TEST).toContain("visual에 쓰지 않은 content.sources");
    expect(RLS_TEST).toContain("다른 분야의 실제 active RAG 페이지");
    expect(RLS_TEST).toContain("일반 sourceRefs도 검증된 content.sources 라벨");
    expect(RLS_TEST).toContain("processed documents 제목·분야와 chunks 페이지");
    expect(RLS_TEST).toContain("plan의 내부 processed 문서·청크 exact 출처");
    expect(RLS_TEST).toContain("lesson의 내부 processed 문서·청크 exact 출처");
    expect(RLS_TEST).toContain("plan sources의 위조 제목");
    expect(RLS_TEST).toContain("lesson sources의 위조 페이지");
    expect(RLS_TEST).toContain("실제 chunks.page_num이 NULL인 출처");
    expect(RLS_TEST).toContain("실제 rag_rescue page_num이 NULL인 출처");
    expect(RLS_TEST).toContain(
      "실제 NULL 페이지 청크가 없는 sources page:null",
    );
  });

  it("활성 RAG 코퍼스 변경을 statement 단위로 감지해 기존 공식 공유를 해제한다", () => {
    const contractStart = MIGRATION.indexOf(
      "create or replace function public.generated_material_share_contract_valid(",
    );
    const statementLockStart = MIGRATION.indexOf(
      "create or replace function public.lock_generated_material_share_validation()",
    );
    const contractDefinition = MIGRATION.slice(
      contractStart,
      statementLockStart,
    );

    expect(contractStart).toBeGreaterThan(-1);
    expect(statementLockStart).toBeGreaterThan(contractStart);
    expect(contractDefinition).not.toContain("pg_advisory_xact_lock_shared");
    expect(MIGRATION).toContain(
      "create trigger lock_generated_material_share_validation",
    );
    expect(MIGRATION).toMatch(
      /create trigger lock_generated_material_share_validation[\s\S]*before insert or update of[\s\S]*for each statement execute function public\.lock_generated_material_share_validation\(\)/,
    );
    expect(MIGRATION).toContain(
      "create or replace function public.unshare_generated_materials_on_rag_change()",
    );
    expect(MIGRATION).toContain("referencing new table as new_rag_rows");
    expect(MIGRATION).toContain("referencing old table as old_rag_rows");
    expect(MIGRATION).toContain(
      "referencing old table as old_rag_rows new table as new_rag_rows",
    );
    expect(MIGRATION).toContain("before truncate on public.rag_rescue");
    expect(MIGRATION.match(/for each statement/g)).toHaveLength(11);
    expect(MIGRATION).toContain("pg_advisory_xact_lock_shared");
    expect(MIGRATION).toMatch(
      /update public\.generated_materials\s+set shared = false,\s+author_name = null\s+where shared\s+and kind <> 'notebooklm';/s,
    );
    expect(RLS_TEST).toContain("활성 RAG bulk 전환");
    expect(RLS_TEST).toContain("비활성 RAG 행을 준비 적재");
    expect(RLS_TEST).toContain("활성 RAG 행 INSERT");
    expect(RLS_TEST).toContain("활성 RAG 행 DELETE");
    expect(RLS_TEST).toContain("활성 RAG 전체 TRUNCATE");
    expect(RLS_TEST).toContain(
      "statement trigger가 행 잠금 전에 공유 advisory lock을 획득",
    );
    expect(MIGRATION).toContain(
      "create or replace function public.unshare_generated_materials_on_native_source_change()",
    );
    expect(MIGRATION).toContain(
      "unshare_generated_materials_on_documents_update",
    );
    expect(MIGRATION).toContain(
      "unshare_generated_materials_on_documents_delete",
    );
    expect(MIGRATION).toContain(
      "unshare_generated_materials_on_documents_truncate",
    );
    expect(MIGRATION).toContain("unshare_generated_materials_on_chunks_update");
    expect(MIGRATION).toContain("unshare_generated_materials_on_chunks_delete");
    expect(MIGRATION).toContain(
      "unshare_generated_materials_on_chunks_truncate",
    );
    expect(MIGRATION).not.toContain(
      "unshare_generated_materials_on_documents_insert",
    );
    expect(MIGRATION).not.toContain(
      "unshare_generated_materials_on_chunks_insert",
    );
    expect(RLS_TEST).toContain(
      "native documents/chunks INSERT는 기존 exact 공유",
    );
    expect(RLS_TEST).toContain("native document 제목 UPDATE");
    expect(RLS_TEST).toContain("native document 상태 UPDATE");
    expect(RLS_TEST).toContain("native chunk 페이지 UPDATE");
    expect(RLS_TEST).toContain("native chunk DELETE");
    expect(RLS_TEST).toContain("native chunks TRUNCATE");
    expect(RLS_TEST).toContain("native documents TRUNCATE");
  });

  it("내부 생성 컨텍스트도 processed 문서만 후보로 사용한다", () => {
    expect(GENERATE_CONTEXT).toMatch(
      /\.from\("documents"\)[\s\S]*\.eq\("category", category\)[\s\S]*\.eq\("status", "processed"\)/,
    );
  });

  it("SOP FTS 후보 열에도 공유 계약과 같은 OCR 정규화를 적용한다", () => {
    expect(CLASSIFICATION_MIGRATION).toContain(
      "add column if not exists sop_search_vector tsvector",
    );
    expect(CLASSIFICATION_MIGRATION).toMatch(
      /to_tsvector\([\s\S]*generated_material_normalize_ocr\([\s\S]*metadata ->> 'Header 2'[\s\S]*coalesce\(content, ''\)[\s\S]*metadata ->> 'source'/,
    );
    expect(CLASSIFICATION_MIGRATION).toContain(
      "metadata ->> 'document_type' in ('sop', 'operational_guidance')",
    );
    expect(CLASSIFICATION_MIGRATION).toContain(
      "grant execute on function public.generated_material_normalize_ocr(text, text)",
    );
    expect(CLASSIFICATION_MIGRATION).toContain("to service_role;");
    expect(RLS_TEST).toContain(
      "generated FTS 열의 OCR 함수는 service_role에만 실행권",
    );
    expect(RLS_TEST).toContain(
      "service_role RAG INSERT는 generated OCR 함수 권한 오류 없이 성공",
    );
    expect(RLS_TEST).toContain(
      "service_role RAG UPDATE도 generated OCR 함수 권한 오류 없이 성공",
    );
    expect(RLS_TEST).toContain("OCR 축정을 정규화한 FTS 열이 측정 검색");
  });

  it("새 프로젝트 통합 SQL에도 공유 보호를 분류 백필보다 먼저 포함한다", () => {
    const bodyMarker = (filename: string) =>
      `\n-- ${"=".repeat(76)}\n-- ${filename}\n-- ${"=".repeat(76)}\n`;
    const protectionIndex = SETUP_SQL.indexOf(
      bodyMarker("20260829052407_protect_generated_material_sharing.sql"),
    );
    const classificationIndex = SETUP_SQL.indexOf(
      bodyMarker("20260829140500_classify_rag_procedure_sources.sql"),
    );
    const commonSopIndex = SETUP_SQL.indexOf(
      bodyMarker("20260829160624_allow_common_sop_generation_evidence.sql"),
    );
    expect(protectionIndex).toBeGreaterThan(-1);
    expect(classificationIndex).toBeGreaterThan(protectionIndex);
    expect(commonSopIndex).toBeGreaterThan(classificationIndex);
    expect(SETUP_SQL).toContain(
      "create trigger enforce_generated_material_share_contract",
    );
    expect(SETUP_SQL).toContain("generated_material_normalize_ocr");
    expect(SETUP_SQL).toContain("unshare_generated_materials_on_rag_update");
    expect(SETUP_SQL).toContain(
      "unshare_generated_materials_on_documents_update",
    );
    expect(SETUP_SQL).toContain("unshare_generated_materials_on_chunks_delete");
    expect(SETUP_SQL).toContain(
      "add column if not exists sop_search_vector tsvector",
    );
    expect(SETUP_SQL).toMatch(
      /add column if not exists sop_search_vector tsvector[\s\S]*generated_material_normalize_ocr\(/,
    );
    expect(SETUP_SQL).toContain(
      "create or replace function public.generated_material_rag_scope_valid(",
    );
  });
});
