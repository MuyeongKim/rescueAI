import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ createClient: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: () => ({ ok: true }), tooManyRequests: vi.fn() }));
import { DELETE, POST } from "@/app/api/generate/drafts/route";
import type { GenerationDraftSnapshot } from "@/lib/generation-draft";

const draftKey = "local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const snapshot: GenerationDraftSnapshot = { version: 1, kind: "plan", context: { category: "산악", audience: "일반 대원", duration: "1시간", topic: "로프", focus: "", conditions: "", date: "", place: "", slideMode: "presenter" }, doc: { title: "편집 초안", sections: [{ heading: "훈련목표", content: "" }], sources: [] }, deck: null, nlm: null, materialId: null, materialRevision: null, saved: false };
type Row = { id: string; user_id?: string; draft_key: string; revision: number; updated_at: string; snapshot: GenerationDraftSnapshot };
function client(initial: Row | null = null, ownsMaterial = true) {
  let row = initial;
  const writes: Array<{ value: unknown; filters: Record<string, unknown> }> = [];
  return { writes, row: () => row, from: vi.fn((table: string) => {
    let action = "read"; let value: Record<string, unknown> = {}; let count = false;
    const filters: Record<string, unknown> = {};
    const result = () => {
      if (table !== "generation_drafts") return { data: ownsMaterial ? { id: 17 } : null, error: null };
      if (count) return { count: row ? 1 : 0, data: null, error: null };
      if (action === "read") return { data: row, error: null };
      writes.push({ value, filters });
      if (action === "delete") {
        if (!row || row.id !== filters.id || (row.user_id ?? "owner") !== filters.user_id || row.updated_at !== filters.updated_at) return { data: null, error: null };
        const removed = { id: row.id }; row = null; return { data: removed, error: null };
      }
      if (action === "insert" && row) return { data: null, error: { code: "23505" } };
      if (action === "update" && (!row || row.revision !== filters.revision)) return { data: null, error: null };
      row = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", draft_key: draftKey, revision: action === "insert" ? 1 : row!.revision + 1,
        updated_at: "2026-09-05T00:00:00Z", snapshot: value.snapshot as GenerationDraftSnapshot };
      return { data: row, error: null };
    };
    const builder = { select: (_columns?: string, options?: { head?: boolean }) => { count = Boolean(options?.head); return builder; },
      insert: (next: Record<string, unknown>) => { action = "insert"; value = next; return builder; },
      update: (next: Record<string, unknown>) => { action = "update"; value = next; return builder; },
      delete: () => { action = "delete"; return builder; },
      eq: (key: string, next: unknown) => { filters[key] = next; return builder; }, abortSignal: () => builder,
      maybeSingle: () => builder, then: (resolve: (value: unknown) => void) => Promise.resolve(result()).then(resolve) };
    return builder;
  }) };
}
function request(body: unknown, method = "POST") { return new Request("http://localhost/api/generate/drafts", { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }); }
beforeEach(() => { vi.clearAllMocks(); mocks.auth.mockResolvedValue({ ok: true, user: { id: "owner" } }); });
describe("개인 편집 초안 API", () => {
  it("인증 실패 시 본문이나 DB 자료를 조회하지 않는다", async () => {
    const db = client(); mocks.createClient.mockResolvedValue(db); mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await POST(request({}))).status).toBe(401); expect(db.from).not.toHaveBeenCalled();
  });
  it("빈 편집 중 본문을 보존하고 소유자 및 개정 번호로 갱신을 제한한다", async () => {
    const db = client({ id: "draft", draft_key: draftKey, revision: 4, updated_at: "now", snapshot }); mocks.createClient.mockResolvedValue(db);
    const next = { ...snapshot, doc: { ...snapshot.doc, title: "수정된 제목", imageData: "data:image/png;base64,secret" } };
    const response = await POST(request({ draftKey, revision: 4, snapshot: next }));
    expect(response.status).toBe(200); expect(db.writes[0].filters).toMatchObject({ user_id: "owner", draft_key: draftKey, revision: 4 });
    expect(db.row()?.snapshot.doc?.sections[0].content).toBe(""); expect(JSON.stringify(db.row())).not.toContain("imageData");
  });
  it("다른 탭의 개정이 앞서면 현재 서버 내용을 보존하고 충돌을 반환한다", async () => {
    const current = { ...snapshot, doc: { ...snapshot.doc!, title: "다른 탭 최신본" } };
    const db = client({ id: "draft", draft_key: draftKey, revision: 5, updated_at: "now", snapshot: current }); mocks.createClient.mockResolvedValue(db);
    const response = await POST(request({ draftKey, revision: 4, snapshot }));
    expect(response.status).toBe(409); expect((await response.json()).code).toBe("draft_revision_conflict");
    expect(db.row()?.snapshot.doc?.title).toBe("다른 탭 최신본");
  });
  it("응답 유실 재전송은 같은 스냅샷인 경우에만 기존 성공 결과를 반환한다", async () => {
    const db = client({ id: "draft", draft_key: draftKey, revision: 5, updated_at: "now", snapshot }); mocks.createClient.mockResolvedValue(db);
    const response = await POST(request({ draftKey, revision: 4, snapshot }));
    expect(response.status).toBe(200); expect((await response.json()).draft.revision).toBe(5);
  });
  it("타인의 저장본을 참조하는 초안을 만들지 못한다", async () => {
    const db = client(null, false); mocks.createClient.mockResolvedValue(db);
    const response = await POST(request({ draftKey: "material:17", revision: 0, snapshot: { ...snapshot, materialId: 17, materialRevision: 1 } }));
    expect(response.status).toBe(404); expect(db.writes).toHaveLength(0);
  });
  it("삭제도 인증 전에 본문이나 DB를 조회하지 않는다", async () => {
    const db = client(); mocks.createClient.mockResolvedValue(db); mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await DELETE(request({}, "DELETE"))).status).toBe(401); expect(db.from).not.toHaveBeenCalled();
  });
  it("선택한 본인 초안의 마지막 수정 시각이 같을 때 초안만 삭제한다", async () => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", updatedAt = "2026-09-05T00:00:00+00:00";
    const db = client({ id, draft_key: draftKey, revision: 4, updated_at: updatedAt, snapshot }); mocks.createClient.mockResolvedValue(db);
    expect((await DELETE(request({ id, updatedAt }, "DELETE"))).status).toBe(200);
    expect(db.row()).toBeNull(); expect(db.from).toHaveBeenCalledExactlyOnceWith("generation_drafts");
    expect(db.writes[0].filters).toEqual({ id, user_id: "owner", updated_at: updatedAt });
  });
  it.each(["newer", "other-owner"])("%s 초안은 삭제하지 않고 409로 최신 목록 확인을 안내한다", async (scenario) => {
    const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", updatedAt = "2026-09-05T00:00:00Z";
    const db = client({ id, user_id: scenario === "other-owner" ? "someone-else" : "owner", draft_key: draftKey, revision: 5,
      updated_at: scenario === "newer" ? "2026-09-05T00:01:00Z" : updatedAt, snapshot }); mocks.createClient.mockResolvedValue(db);
    const response = await DELETE(request({ id, updatedAt }, "DELETE"));
    expect(response.status).toBe(409); expect((await response.json()).error).toContain("최신 내용");
    expect(db.row()).not.toBeNull();
  });
  it("삭제 요청 본문은 2 KiB까지만 허용한다", async () => {
    const db = client(); mocks.createClient.mockResolvedValue(db);
    expect((await DELETE(request({ extra: "x".repeat(2049) }, "DELETE"))).status).toBe(413); expect(db.from).not.toHaveBeenCalled();
  });
});
