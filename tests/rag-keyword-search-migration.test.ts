import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "supabase/migrations/20260905124809_rank_rag_keyword_candidates.sql"),
  "utf8"
);
const rowId = (value: number) => `00000000-0000-4000-8000-${value.toString().padStart(12, "0")}`;

type KeywordRow = { id: string; content: string; metadata: Record<string, unknown>; keyword_rank: number };

describe("키워드 후보 관련성 정렬 migration의 PostgreSQL 계약", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    await db.waitReady;
    // 이 RPC는 vector를 읽지 않는다. 실제 칼럼 타입·본문 GIN·호출자 RLS를 재현한다.
    await db.exec(`
      create role anon;
      create role authenticated;
      create role service_role bypassrls;
      create table public.rag_rescue (
        id uuid primary key,
        content text,
        metadata jsonb default '{}'::jsonb,
        is_active boolean not null default false
      );
      create index rag_rescue_active_content_fts_idx on public.rag_rescue
        using gin (to_tsvector('simple', content)) where is_active;
      alter table public.rag_rescue enable row level security;
      create policy authenticated_read on public.rag_rescue
        for select to authenticated using (is_active);
      grant usage on schema public to anon, authenticated, service_role;
      grant select on public.rag_rescue to authenticated, service_role;
    `);
    await db.exec(migration);
    await db.exec(migration);
  });

  beforeEach(async () => {
    await db.exec("reset role; truncate public.rag_rescue;");
  });

  afterAll(async () => { await db?.close(); });

  const insertRow = async (
    id: number,
    content: string | null,
    metadata: Record<string, unknown> = {},
    active = true
  ) => db.query(
    "insert into public.rag_rescue (id, content, metadata, is_active) values ($1, $2, $3, $4)",
    [rowId(id), content, JSON.stringify(metadata), active]
  );

  const search = async (query: string | null, count: number | null = 48, filter: unknown = {}) => (
    await db.query<KeywordRow>(
      "select * from public.search_rag_rescue_keywords($1, $2, $3)",
      [query, count, filter === null ? null : JSON.stringify(filter)]
    )
  ).rows;

  it("기존 LIMIT 밖에 적재된 더 관련성 높은 청크를 전체 일치 후보에서 찾아 반환한다", async () => {
    for (let id = 1; id <= 60; id++) {
      await insertRow(id, `로프 ${"기타 ".repeat(60)}하강`);
    }
    await insertRow(100, "로프 하강 로프 하강 로프 하강");
    await db.exec("set role authenticated;");
    const legacy = await db.query<{ id: string }>(`
      select id from public.rag_rescue where is_active
      and to_tsvector('simple', content) @@ websearch_to_tsquery('simple', '로프 하강')
      limit 48
    `);
    expect(legacy.rows.map((row) => row.id)).not.toContain(rowId(100));
    const rows = await search("로프 하강", 1);
    expect(rows.map((row) => row.id)).toEqual([rowId(100)]);
    expect(rows[0].keyword_rank).toBeGreaterThan(0);
    expect(Object.keys(rows[0]).sort()).toEqual(["content", "id", "keyword_rank", "metadata"]);
  });

  it("분야와 전달된 metadata 조건을 먼저 적용하며 비활성 청크는 반환하지 않는다", async () => {
    await insertRow(1, "로프 하강", { edu_category: "산악", version: "current" });
    await insertRow(2, "로프 하강 로프 하강", { edu_category: "수난", version: "current" });
    await insertRow(3, "로프 하강 로프 하강 로프 하강", { edu_category: "산악", version: "old" });
    await insertRow(4, "로프 하강 로프 하강", { edu_category: "산악", version: "current" }, false);
    await db.exec("set role authenticated;");
    expect((await search("로프 하강", 1, { edu_category: "산악", version: "current" })).map((row) => row.id))
      .toEqual([rowId(1)]);
    await db.exec("set role service_role;");
    expect((await search("로프 하강", 100)).map((row) => row.id)).not.toContain(rowId(4));
  });

  it("동점은 UUID 오름차순으로 안정화하고 개수는 0..100으로 제한한다", async () => {
    await db.exec(`
      insert into public.rag_rescue (id, content, is_active)
        select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, '로프 하강', true
        from generate_series(110, 1, -1) as n;
    `);
    expect((await search("로프", 3)).map((row) => row.id)).toEqual([rowId(1), rowId(2), rowId(3)]);
    expect(await search("로프", 0)).toEqual([]);
    expect(await search("로프", -1)).toEqual([]);
    expect(await search("로프", 100000)).toHaveLength(100);
    expect(await search("로프", null)).toHaveLength(48);
  });

  it("websearch의 구문·OR·제외어 의미를 유지한다", async () => {
    await insertRow(1, "로프 하강");
    await insertRow(2, "로프 상승");
    await insertRow(3, "수난 구조");
    await db.exec("set role authenticated;");
    expect((await search('"로프 하강"')).map((row) => row.id)).toEqual([rowId(1)]);
    expect((await search("로프 -상승")).map((row) => row.id)).toEqual([rowId(1)]);
    expect((await search("로프 OR 수난")).map((row) => row.id).sort()).toEqual([rowId(1), rowId(2), rowId(3)]);
  });

  it("빈·구두점·제외어만 있는 쿼리는 전체 자료를 조회하지 않는다", async () => {
    await insertRow(1, "로프 하강");
    await insertRow(2, null);
    for (const query of [null, "", " \t\n ", '"!?"', "-수난"]) {
      expect(await search(query)).toEqual([]);
    }
    expect(await search("없는자료")).toEqual([]);
  });

  it("과도한 쿼리·잘못된 필터를 자르거나 검색 범위를 넓히지 않고 거절한다", async () => {
    await expect(search("가".repeat(2049))).rejects.toMatchObject({ code: "22023" });
    await expect(search("로프", 1, [])).rejects.toMatchObject({ code: "22023" });
    await expect(search("로프", 1, "산악")).rejects.toMatchObject({ code: "22023" });
    await expect(search("로프", 1, { value: "가".repeat(4096) })).rejects.toMatchObject({ code: "22023" });
    await insertRow(1, "로프 하강");
    expect(await search("로프", 1, null)).toHaveLength(1);
  });

  it("익명 실행을 막고 호출자에게 적용되는 RLS를 우회하지 않는다", async () => {
    const contract = await db.query<{ prosecdef: boolean; proconfig: string[] }>(`
      select prosecdef, proconfig from pg_proc
      where oid = 'public.search_rag_rescue_keywords(text,integer,jsonb)'::regprocedure
    `);
    expect(contract.rows[0].prosecdef).toBe(false);
    expect(contract.rows[0].proconfig).toContain('search_path=""');
    await insertRow(1, "로프 하강", { restricted: false });
    await insertRow(2, "로프 하강 로프 하강", { restricted: true });
    await db.exec(`
      create policy restricted_evidence on public.rag_rescue as restrictive
        for select to authenticated using (metadata->>'restricted' <> 'true');
      set role authenticated;
    `);
    expect((await search("로프 하강")).map((row) => row.id)).toEqual([rowId(1)]);
    await db.exec("set role service_role;");
    expect(await search("로프 하강")).toHaveLength(2);
    await db.exec("set role anon;");
    await expect(search("로프 하강")).rejects.toMatchObject({ code: "42501" });
    await db.exec("reset role; drop policy restricted_evidence on public.rag_rescue;");
  });
});
