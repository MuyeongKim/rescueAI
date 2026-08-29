import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import {
  countMyMaterials,
  listMyMaterials,
  listSharedMaterials,
} from "@/lib/generated-materials";

function makeClient({
  userId = "user-1",
  rows = [],
  count = 0,
}: {
  userId?: string | null;
  rows?: unknown[];
  count?: number;
} = {}) {
  const eqs: Array<[string, unknown]> = [];
  const result = { data: rows, count, error: null };
  const builder: Record<string, unknown> & {
    then?: (resolveResult: (value: typeof result) => unknown) => Promise<unknown>;
  } = {};

  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn((column: string, value: unknown) => {
    eqs.push([column, value]);
    return builder;
  });
  builder.order = vi.fn(() => builder);
  builder.limit = vi.fn().mockResolvedValue(result);
  builder.then = (resolveResult) => Promise.resolve(result).then(resolveResult);

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

describe("개인 생성 자료 소유자 제한", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("내 자료 목록과 개수는 인증 user_id로 명시적으로 제한한다", async () => {
    const listClient = makeClient({ rows: [{ id: 1 }] });
    const countClient = makeClient({ count: 7 });
    mocks.createClient
      .mockResolvedValueOnce(listClient)
      .mockResolvedValueOnce(countClient);

    await expect(listMyMaterials(5)).resolves.toEqual([{ id: 1 }]);
    await expect(countMyMaterials()).resolves.toBe(7);

    expect(listClient.eqs).toContainEqual(["user_id", "user-1"]);
    expect(countClient.eqs).toContainEqual(["user_id", "user-1"]);
  });

  it("인증 사용자가 없으면 개인 자료 쿼리를 실행하지 않는다", async () => {
    const listClient = makeClient({ userId: null });
    const countClient = makeClient({ userId: null });
    mocks.createClient
      .mockResolvedValueOnce(listClient)
      .mockResolvedValueOnce(countClient);

    await expect(listMyMaterials()).resolves.toEqual([]);
    await expect(countMyMaterials()).resolves.toBe(0);

    expect(listClient.from).not.toHaveBeenCalled();
    expect(countClient.from).not.toHaveBeenCalled();
  });

  it("공유 갤러리는 shared 조건만 유지하고 개인 user_id로 좁히지 않는다", async () => {
    const client = makeClient({ rows: [{ id: 2, shared: true }] });
    mocks.createClient.mockResolvedValue(client);

    await expect(listSharedMaterials()).resolves.toEqual([{ id: 2, shared: true }]);

    expect(client.auth.getUser).not.toHaveBeenCalled();
    expect(client.eqs).toContainEqual(["shared", true]);
    expect(client.eqs.some(([column]) => column === "user_id")).toBe(false);
  });
});
