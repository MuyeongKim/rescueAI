import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enabled: vi.fn(), fetchRag: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/rag-external", () => ({
  ragTableEnabled: mocks.enabled,
  fetchExternalRagContext: mocks.fetchRag,
  fetchExternalSopContext: vi.fn(),
}));

import {
  MAX_GENERATION_CONTEXT_UTF8_BYTES,
  supplementGenerationContext,
  type GenerationContext,
  type GenerationContextSupabaseClient,
} from "@/lib/generate-context";

const source = { document_id: 1, doc: "교범", page: 1 };
const sop = { document_id: 2, doc: "현장SOP", page: 2 };
const extra = { document_id: 1, doc: "교범", page: 3 };
const client = {} as GenerationContextSupabaseClient;
const initial: GenerationContext = {
  contextText: "[교범 p.1]\n기존 일반 근거\n\n=== 관련 SOP·현장지침 근거 ===\n[현장SOP p.2]\n기존 SOP 근거",
  sources: [source, sop], bindingSources: [source, sop], degraded: false,
  sopEvidence: { status: "found", sourceLabels: ["[현장SOP p.2]"] },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.fetchRag.mockResolvedValue({
    contextText: "[교범 p.3]\n추가로 찾은 조건별 근거", sources: [extra], bindingSources: [extra], degraded: false,
  });
});

describe("자료제작 부족 근거 추가 조회", () => {
  it("인증된 worker reader와 분야 제한을 재사용하고 범주 전체 폴백을 요청하지 않는다", async () => {
    const result = await supplementGenerationContext(initial, "화재", "저압 경고 대응", client);
    expect(mocks.fetchRag).toHaveBeenCalledWith("화재", 24, "저압 경고 대응", client, { allowCategoryFallback: false });
    expect(result.contextText).toContain("[교범 p.3]");
    expect(result.bindingSources).toContainEqual(extra);
    expect(result.contextText).toContain("[교범 p.1]\n기존 일반 근거");
    expect(result.contextText.endsWith("[현장SOP p.2]\n기존 SOP 근거")).toBe(true);
    expect(result.sopEvidence).toEqual(initial.sopEvidence);
  });

  it("추가 데이터가 없으면 기존 근거와 정상 검색 상태를 그대로 유지한다", async () => {
    mocks.fetchRag.mockResolvedValue({ contextText: "", sources: [], bindingSources: [], degraded: false });
    expect(await supplementGenerationContext(initial, "화재", "미확인 조건", client)).toEqual(initial);
  });

  it("검색 장애는 자료가 없다는 판정 대신 degraded로 남긴다", async () => {
    mocks.fetchRag.mockResolvedValue({ contextText: "", sources: [], bindingSources: [], degraded: true });
    const result = await supplementGenerationContext(initial, "화재", "미확인 조건", client);
    expect(result.contextText).toBe(initial.contextText);
    expect(result.degraded).toBe(true);
    expect(result.sopEvidence).toEqual(initial.sopEvidence);
  });

  it("동일 청크를 중복 저장하지 않고 기존 SOP와 원문 예산을 유지한다", async () => {
    const context = { ...initial, contextText: initial.contextText.replace("기존 일반 근거", "가".repeat(70_000)) };
    mocks.fetchRag.mockResolvedValue({
      contextText: `[교범 p.1]\n${"가".repeat(70_000)}\n\n---\n\n[교범 p.3]\n${"나".repeat(60_000)}`,
      sources: [source, extra], bindingSources: [source, extra], degraded: false,
    });
    const result = await supplementGenerationContext(context, "화재", "추가 조건", client);
    expect(new TextEncoder().encode(result.contextText).byteLength).toBeLessThanOrEqual(MAX_GENERATION_CONTEXT_UTF8_BYTES);
    expect(result.contextText.match(/\[교범 p.1\]/g)).toHaveLength(1);
    expect(result.contextText).toContain("가".repeat(70_000));
    expect(result.contextText).toContain("[현장SOP p.2]\n기존 SOP 근거");
    expect(result.bindingSources).not.toContainEqual(extra); // 공간이 없어 잘린 추가 원문은 출처에서도 제외
  });

  it("주제 검색이 없는 레거시 경로에서는 같은 범주를 반복 조회하지 않는다", async () => {
    mocks.enabled.mockReturnValue(false);
    expect(await supplementGenerationContext(initial, "화재", "추가 조건", client)).toBe(initial);
    expect(mocks.fetchRag).not.toHaveBeenCalled();
  });
});
