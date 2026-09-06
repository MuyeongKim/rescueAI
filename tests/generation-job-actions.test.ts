import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), worker: vi.fn(), client: vi.fn(), dispatch: vi.fn(), dispatchFailed: vi.fn(), cancel: vi.fn(), limited: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.client }));
vi.mock("@/lib/supabase/generation-worker", () => ({ createGenerationWorkerClient: mocks.worker }));
vi.mock("@/lib/generation-job-dispatch", () => ({ dispatchGenerationJob: mocks.dispatch, markGenerationDispatchFailed: mocks.dispatchFailed }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: mocks.limited, tooManyRequests: () => new Response(null, { status: 429 }) }));
vi.mock("workflow/api", () => ({ getRun: () => ({ cancel: mocks.cancel }) }));

import { POST as REVIEW } from "@/app/api/generate/jobs/[id]/review/route";
import { POST as CANCEL } from "@/app/api/generate/jobs/[id]/cancel/route";
import { POST as RETRY } from "@/app/api/generate/jobs/[id]/retry/route";
import { projectGenerationOutline } from "@/lib/generation-job-review";

const jobId = "10000000-0000-4000-8000-000000000001";
const owner = "20000000-0000-4000-8000-000000000002";
const token = "30000000-0000-4000-8000-000000000003";
const source = "[훈련 교범 p.1]";
function fixture() {
  return {
    id: jobId, user_id: owner, status: "awaiting_review", stage: "목차 확인", progress: 28, attempt: 0,
    estimated_seconds: 420, quality_passed: false, result: null, error_message: null, workflow_run_id: "old-run",
    run_token: token, revision: 3, created_at: "2026-09-06T00:00:00Z", updated_at: "2026-09-06T00:01:00Z", started_at: "2026-09-06T00:00:00Z", completed_at: null,
    request: { type: "plan", category: "화재", audience: "일반 대원", duration: "1시간", topic: "공기호흡기 점검", reviewOutline: true },
    checkpoint: {
      version: 1, privateMarker: "never-public", context: { contextText: `${source}\n공기호흡기 결합부 손상 여부를 확인한다.`, sources: [{ document_id: 1, doc: "훈련 교범", page: 1 }], sopEvidence: { status: "not_found", sourceLabels: [] } },
      documentOutline: { title: "공기호흡기 점검 훈련", sections: [
        { heading: "훈련목표", purpose: "올바른 점검 절차를 설명한다", keyPoints: ["점검"], actionRequirements: ["순서를 설명한다"], sourceRefs: [source], minutes: null },
        { heading: "훈련내용", purpose: "결합부 상태를 직접 점검한다", keyPoints: ["결합부"], actionRequirements: ["손상을 확인한다"], sourceRefs: [source], minutes: 60 },
      ] },
      draft: { title: "공기호흡기 점검 훈련", sections: [] },
      groundingReview: { signature: "old-review-signature" },
    },
  };
}
type Job = Record<string, unknown>;
let job: Job;
let patches: Job[];
let filters: Array<[string, unknown]>;
let conflict: boolean;
function client() {
  return { from() {
    const predicates: Array<(row: Job) => boolean> = [];
    let patch: Job | undefined;
    const builder = {
      select: () => builder,
      eq: (field: string, value: unknown) => { filters.push([field, value]); predicates.push((row) => row[field] === value); return builder; },
      in: (field: string, values: unknown[]) => { predicates.push((row) => values.includes(row[field])); return builder; },
      update: (value: Job) => { patch = value; return builder; },
      maybeSingle: async () => {
        if (patch && conflict) { job.revision = Number(job.revision) + 1; conflict = false; }
        if (!predicates.every((predicate) => predicate(job))) return { data: null, error: null };
        if (patch) { patches.push(structuredClone(patch)); job = { ...job, ...structuredClone(patch), revision: Number(job.revision) + 1 }; }
        return { data: structuredClone(job), error: null };
      },
    };
    return builder;
  } };
}
const context = { params: Promise.resolve({ id: jobId }) };
const request = (body: unknown) => new Request(`http://localhost/api/generate/jobs/${jobId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
beforeEach(() => {
  vi.clearAllMocks(); job = fixture(); patches = []; filters = []; conflict = false;
  mocks.auth.mockResolvedValue({ ok: true, user: { id: owner } }); mocks.limited.mockReturnValue({ ok: true });
  mocks.client.mockResolvedValue(client()); mocks.worker.mockReturnValue(client()); mocks.dispatch.mockResolvedValue(null); mocks.cancel.mockResolvedValue(undefined);
});

describe("사용자가 제어하는 생성 작업", () => {
  it.each([REVIEW, CANCEL, RETRY])("인증 실패는 원장 조회·변경 전에 차단한다", async (route) => {
    mocks.auth.mockResolvedValue({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await route(request({ revision: 3 }), context)).status).toBe(401);
    expect(mocks.worker).not.toHaveBeenCalled(); expect(patches).toEqual([]);
  });
  it.each([REVIEW, CANCEL, RETRY])("다른 사용자 작업 존재·초안·실행 토큰을 노출하지 않는다", async (route) => {
    job.user_id = "other-user";
    expect((await route(request({ revision: 3 }), context)).status).toBe(404);
    expect(filters).toContainEqual(["user_id", owner]); expect(patches).toEqual([]);
  });
  it("동일 목차 승인은 기존 근거를 보존하고 실행권을 바꿔 한 번만 시작한다", async () => {
    const response = await REVIEW(request({ revision: 3 }), context);
    expect(response.status).toBe(202); expect(job.status).toBe("queued"); expect(job.run_token).not.toBe(token);
    expect(job.checkpoint).toMatchObject({ outlineApproved: true, groundingReview: { signature: "old-review-signature" } });
    expect(mocks.dispatch).toHaveBeenCalledOnce();
    expect(JSON.stringify(await response.json())).not.toMatch(/never-public|run_token|contextText/);
    expect((await REVIEW(request({ revision: 3 }), context)).status).toBe(409);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
  it("수정 목차는 출처를 만들어내지 않고 변경 항목의 근거 재확인을 예약한다", async () => {
    const projected = projectGenerationOutline(job.checkpoint, "plan")!;
    const outline = { title: projected.title, items: projected.items.map(({ title, purpose, keyPoints, actionRequirements, minutes }) => ({ title, purpose, keyPoints, actionRequirements, minutes })) };
    outline.items[1].actionRequirements = ["야간에 결합부 손상을 확인한다"];
    expect((await REVIEW(request({ revision: 3, outline }), context)).status).toBe(202);
    const saved = job.checkpoint as ReturnType<typeof fixture>["checkpoint"];
    expect(saved.documentOutline.sections[1].sourceRefs).toEqual([source]);
    expect(saved.documentOutline.sections[1]).toHaveProperty("evidenceRequirements", expect.arrayContaining([expect.objectContaining({ sourceRef: null, excerpt: null })]));
    expect(saved).not.toHaveProperty("groundingReview");
  });
  it("시간 합계·필수 항목 변조는 실행 전에 거절한다", async () => {
    const projected = projectGenerationOutline(job.checkpoint, "plan")!;
    const outline = { title: projected.title, items: projected.items.map(({ title, purpose, keyPoints, actionRequirements, minutes }) => ({ title, purpose, keyPoints, actionRequirements, minutes })) };
    outline.items[1].minutes = 15;
    expect((await REVIEW(request({ revision: 3, outline }), context)).status).toBe(422);
    expect(mocks.dispatch).not.toHaveBeenCalled(); expect(patches).toEqual([]);
  });
  it.each([REVIEW, CANCEL])("개정 CAS 충돌 시 새 실행·중단 효과를 적용하지 않는다", async (route) => {
    conflict = true;
    expect((await route(request({ revision: 3 }), context)).status).toBe(409);
    expect(patches).toEqual([]); expect(mocks.dispatch).not.toHaveBeenCalled(); expect(mocks.cancel).not.toHaveBeenCalled();
  });
  it("중단은 먼저 실행 토큰을 폐기하며 provider 중단 실패에도 체크포인트를 보존한다", async () => {
    job.status = "drafting";
    const original = structuredClone(job.checkpoint);
    mocks.cancel.mockRejectedValue(new Error("provider unavailable"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await CANCEL(request({ revision: 3 }), context);
      expect(response.status).toBe(200); expect(job.status).toBe("cancelled"); expect(job.run_token).not.toBe(token);
      expect(job.checkpoint).toEqual(original); expect(job.quality_passed).toBe(false); expect(job.result).toBeNull();
      expect((await CANCEL(request({ revision: 3 }), context)).status).toBe(200);
      expect(mocks.cancel).toHaveBeenCalledOnce();
    } finally { log.mockRestore(); }
  });
  it("수정 초안 재시도는 원문·SOP를 보존하고 옛 통과 서명을 폐기한다", async () => {
    job.status = "needs_attention";
    const checkpoint = job.checkpoint as ReturnType<typeof fixture>["checkpoint"];
    checkpoint.draft.sections = [{ heading: "훈련목표", content: "기존 내용" }] as never;
    const response = await RETRY(request({ revision: 3, repairIndices: [0], reviewDraft: {
      title: "수정한 공기호흡기 훈련", sections: [{ heading: "훈련목표", content: "점검 순서와 손상을 정확히 설명한다." }],
      sources: [{ doc: "위조 자료", page: 999 }], sopEvidence: { status: "found" },
    } }), context);
    expect(response.status).toBe(202);
    expect(job.checkpoint).toMatchObject({ selectedRepairIndices: [0], draft: { title: "수정한 공기호흡기 훈련" }, context: { sopEvidence: { status: "not_found" } } });
    expect(job.checkpoint).not.toHaveProperty("groundingReview");
    expect(JSON.stringify(job.checkpoint)).not.toContain("위조 자료");
    expect(job.result).toBeNull(); expect(job.quality_passed).toBe(false);
    expect(mocks.dispatch).toHaveBeenCalledOnce();
  });
  it("초안 수정은 revision이 없으면 거절해 다른 탭 내용을 덮지 않는다", async () => {
    job.status = "needs_attention";
    expect((await RETRY(request({ reviewDraft: { title: "수정 제목" } }), context)).status).toBe(400);
    expect(patches).toEqual([]);
  });
});
