import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationDraftSnapshot } from "@/lib/generation-draft";

// 비동기 보관 콜백만 실행한다. 브라우저 이벤트/렌더링은 실제 화면 검증에서 다룬다.
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  useRef: (value: unknown) => ({ current: value }),
  useState: (value: unknown) => [value, vi.fn()],
}));
const notifications = vi.hoisted(() => ({ error: vi.fn<(message: string, options?: { description?: string; duration?: number }) => string>(() => "failure-toast"), dismiss: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
import { useGenerationDraft } from "@/components/generate/useGenerationDraft";

const snapshot: GenerationDraftSnapshot = {
  version: 1, kind: "plan", context: { category: "산악", audience: "일반 대원", duration: "1시간", topic: "로프", focus: "", conditions: "", date: "", place: "", slideMode: "presenter" },
  doc: { title: "편집 초안", sections: [{ heading: "훈련목표", content: "" }], sources: [] },
  deck: null, nlm: null, materialId: null, materialRevision: null, saved: false,
};
const success = () => Response.json({ draft: { id: "draft-id", revision: 1 } });
const DraftHarness = () => useGenerationDraft({ enabled: true, draftKey: "local:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", snapshot });
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
describe("편집 초안 보관 실패 안내", () => {
  it("정상 보관에는 실패 안내를 띄우지 않고 중복 flush도 다시 쓰지 않는다", async () => {
    const fetcher = vi.fn().mockResolvedValue(success()); vi.stubGlobal("fetch", fetcher);
    const draft = DraftHarness();
    expect(await draft.flush()).toBe(true); expect(await draft.flush()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(notifications.error).not.toHaveBeenCalled();
  });
  it("연결 실패가 반복되면 화면 유지 안내를 한 번만 띄우고 재보관 성공 시 해제한다", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("offline")); vi.stubGlobal("fetch", fetcher);
    const draft = DraftHarness();
    expect(await draft.flush()).toBe(false); expect(await draft.flush()).toBe(false);
    expect(notifications.error).toHaveBeenCalledTimes(1);
    expect(notifications.error.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ description: expect.stringContaining("현재 화면을 유지") }));
    fetcher.mockResolvedValue(success()); expect(await draft.flush()).toBe(true);
    expect(notifications.dismiss).toHaveBeenCalledWith("failure-toast"); expect(notifications.error).toHaveBeenCalledTimes(1);
  });
  it("CAS 충돌은 자동 재시도로 다른 탭의 결과를 덮어쓰지 않는다", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ code: "draft_revision_conflict", error: "다른 화면의 편집이 먼저 저장되었습니다." }, { status: 409 }));
    vi.stubGlobal("fetch", fetcher); const draft = DraftHarness();
    expect(await draft.flush()).toBe(false); expect(await draft.flush()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(notifications.error).toHaveBeenCalledTimes(1);
  });
});
