import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(
  resolve(
    process.cwd(),
    "supabase/migrations/20260903082326_optimize_unfiltered_rag_vector_search.sql"
  ),
  "utf8"
);

describe("분야 자동 RAG 벡터 검색 마이그레이션", () => {
  it("빈 필터를 metadata 포함 조건과 분리하고 거리순 제한을 먼저 적용한다", () => {
    expect(SQL).toContain("if coalesce(filter, '{}'::jsonb) = '{}'::jsonb then");
    expect(SQL).toMatch(/where r\.is_active\s+order by r\.embedding[\s\S]+limit bounded_count/);
    expect(SQL).toContain("and r.metadata @> filter");
    expect(SQL).toContain("where ranked.similarity >= bounded_threshold");
  });

  it("함수 실행 권한을 공개하지 않고 인증 사용자와 서비스 역할에만 준다", () => {
    expect(SQL).toMatch(/revoke all on function[\s\S]+from public, anon, authenticated/);
    expect(SQL).toMatch(/grant execute on function[\s\S]+to authenticated, service_role/);
  });
});
