import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
  listMyMaterials: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({ DEMO: false, demoDocuments: [] }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/generated-materials", () => ({
  listMyMaterials: mocks.listMyMaterials,
}));
vi.mock("@/lib/rag-external", () => ({
  ragTableEnabled: () => false,
  listExternalRagCategories: vi.fn(),
}));
vi.mock("@/lib/courses", () => ({ COURSE_CATEGORIES: ["산악"] }));
vi.mock("@/lib/llm", () => ({ availableModels: () => [] }));
vi.mock("@/components/generate/GenerateForm", () => ({ GenerateForm: () => null }));
vi.mock("@/components/generate/SavedList", () => ({ SavedList: () => null }));
vi.mock("@/components/layout/OperationalHeader", () => ({
  OperationalHeader: () => null,
}));

import GeneratePage from "@/app/generate/page";

function makeDocumentsClient() {
  return {
    from: vi.fn(() => ({
      select: vi.fn().mockResolvedValue({
        data: [{ title: "산악구조 교범", category: "산악" }],
        error: null,
      }),
    })),
  };
}

function makeMaterialClient(userId: string | null = "user-1") {
  const eqs: Array<[string, unknown]> = [];
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((column: string, value: unknown) => {
      eqs.push([column, value]);
      return builder;
    }),
    maybeSingle: vi.fn().mockResolvedValue({
      data: { id: 17, kind: "plan", title: "산악구조 훈련계획", content: {} },
      error: null,
    }),
  };

  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: userId ? { id: userId } : null },
      }),
    },
    from: vi.fn(() => builder),
    eqs,
  };
}

describe("생성 자료 재편집 소유자 제한", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listMyMaterials.mockResolvedValue([]);
  });

  it("자료 id와 인증 user_id를 함께 조회 조건으로 사용한다", async () => {
    const materialClient = makeMaterialClient();
    mocks.createClient
      .mockResolvedValueOnce(makeDocumentsClient())
      .mockResolvedValueOnce(materialClient);

    await GeneratePage({ searchParams: { m: "17" } });

    expect(materialClient.auth.getUser).toHaveBeenCalledOnce();
    expect(materialClient.eqs).toEqual([
      ["id", 17],
      ["user_id", "user-1"],
    ]);
    expect(mocks.listMyMaterials).not.toHaveBeenCalled();
  });

  it("인증 사용자가 없으면 id 조회를 실행하지 않는다", async () => {
    const materialClient = makeMaterialClient(null);
    mocks.createClient
      .mockResolvedValueOnce(makeDocumentsClient())
      .mockResolvedValueOnce(materialClient);

    await GeneratePage({ searchParams: { m: "17" } });

    expect(materialClient.from).not.toHaveBeenCalled();
    expect(mocks.listMyMaterials).toHaveBeenCalledWith(5);
  });
});
