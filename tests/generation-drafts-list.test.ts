import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/demo-flag", () => ({ DEMO: false }));
import { listMyGenerationDrafts } from "@/lib/generation-drafts-server";

function client() {
  const filters: Array<[string, unknown]> = [];
  const columns: string[] = [];
  const builder = {
    select: (value: string) => { columns.push(value); return builder; },
    eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
    order: () => builder, limit: () => builder, abortSignal: () => builder,
    then: (resolve: (value: unknown) => void) => Promise.resolve({ error: null, data: [
      { id: "draft", draft_key: "material:1", kind: "plan", updated_at: "2026-09-08", doc_title: "저장 완료 초안", saved: "true" },
    ] }).then(resolve),
  };
  return { filters, columns, auth: { getUser: async () => ({ data: { user: { id: "owner" } } }) }, from: () => builder };
}

beforeEach(() => vi.clearAllMocks());
describe("편집 초안 보관함 목록 범위", () => {
  it("기본 목록은 본인 미저장 초안만 조회하고 본문을 가져오지 않는다", async () => {
    const db = client(); mocks.createClient.mockResolvedValue(db);
    await listMyGenerationDrafts();
    expect(db.filters).toEqual([["user_id", "owner"], ["snapshot->>saved", "false"]]);
    expect(db.columns[0].split(",")).not.toContain("snapshot");
  });
  it("명시적으로 포함하면 소유권은 유지하면서 완료 사본의 삭제에 필요한 ID·수정시각을 반환한다", async () => {
    const db = client(); mocks.createClient.mockResolvedValue(db);
    expect(await listMyGenerationDrafts(50, { includeSaved: true })).toEqual([{
      id: "draft", draftKey: "material:1", kind: "plan", updatedAt: "2026-09-08", title: "저장 완료 초안", saved: true,
    }]);
    expect(db.filters).toEqual([["user_id", "owner"]]);
  });
});
