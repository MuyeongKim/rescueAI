import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ fetchRag: vi.fn(), fetchSop: vi.fn(), reader: vi.fn(), readerSop: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/generation-rag", () => ({ createGenerationRagReader: mocks.reader }));
vi.mock("@/lib/rag-external", () => ({
  ragTableEnabled: () => true,
  fetchExternalRagContext: mocks.fetchRag,
  fetchExternalSopContext: mocks.fetchSop,
}));

import {
  MAX_GENERATION_CONTEXT_UTF8_BYTES,
  fetchCategoryContext,
  limitGenerationContextText,
  type GenerationContextSupabaseClient,
} from "@/lib/generate-context";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;
beforeEach(() => { vi.clearAllMocks(); mocks.reader.mockReturnValue({ fetchSopContext: mocks.readerSop }); });

describe("생성 근거 체크포인트 예산", () => {
  it("현장 조건의 대원·보고 같은 공통어가 주제 밖 SOP를 채택하게 하지 않는다", async () => {
    const topic = "공기호흡기 점검과 착용";
    const conditions = "배포 검증용 초안. 대원 6명과 교관 1명. 이상 발견 시 중단·보고와 동료 확인";
    const appropriate = { document_id: 17, doc: "공기호흡기 SOP", page: 3 };
    const unrelated = { document_id: 17, doc: "출동지령 SOP", page: 51 };
    mocks.fetchRag.mockResolvedValue({ contextText: "[일반 교재 p.1]\n대원 및 교관의 현장 조건", sources: [], bindingSources: [], degraded: false });
    mocks.fetchSop.mockImplementation(async (_category, query) => {
      const selected = query === topic ? appropriate : unrelated;
      const label = `[${selected.doc} p.${selected.page}]`;
      return { contextText: `${label}\n해당 절차 원문`, sources: [selected], bindingSources: [selected], degraded: false, evidence: { status: "found", sourceLabels: [label] } };
    });
    const client = {} as GenerationContextSupabaseClient;
    const result = await fetchCategoryContext("화재", 40, topic, client, { conditions });
    expect(mocks.fetchRag.mock.calls[0][2]).toContain("대원 6명과 교관 1명");
    expect(mocks.fetchSop).toHaveBeenCalledWith("화재", topic, 4, client);
    expect(result.sopEvidence.sourceLabels).toEqual(["[공기호흡기 SOP p.3]"]);
    expect(result.bindingSources).not.toContainEqual(unrelated);
    expect(mocks.reader).not.toHaveBeenCalled();
  });

  it("세션 경로의 SOP만 제한된 reader로 조회하고 일반자료의 세션 RLS와 조건 검색은 유지한다", async () => {
    const source = { document_id: 17, doc: "공기호흡기 SOP", page: 3 };
    mocks.fetchRag.mockResolvedValue({ contextText: "[일반자료 p.1]\n현장 조건", sources: [], bindingSources: [], degraded: false });
    mocks.readerSop.mockResolvedValue({ contextText: "[공기호흡기 SOP p.3]\n착용 원문", sources: [source], bindingSources: [source], degraded: false, evidence: { status: "found", sourceLabels: ["[공기호흡기 SOP p.3]"] } });
    const result = await fetchCategoryContext("화재", 40, "공기호흡기 착용", undefined, { conditions: "동료 확인" });
    expect(mocks.fetchRag).toHaveBeenCalledWith("화재", 40, "동료 확인 공기호흡기 착용", undefined);
    expect(mocks.fetchSop).not.toHaveBeenCalled();
    expect(mocks.readerSop).toHaveBeenCalledWith("화재", "공기호흡기 착용", 4);
    expect(result.degraded).toBe(false);
    expect(result.sopEvidence.status).toBe("found");
  });

  it.each(["구성", "조회"])("SOP reader %s 실패를 미확인 또는 정상 상태로 숨기지 않는다", async (failure) => {
    mocks.fetchRag.mockResolvedValue({ contextText: "[일반자료 p.1]\n보존할 일반 원문", sources: [], bindingSources: [], degraded: false });
    if (failure === "구성") mocks.reader.mockImplementation(() => { throw new Error("reader configuration unavailable"); });
    else mocks.readerSop.mockRejectedValue(new Error("SOP read failed"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await fetchCategoryContext("화재", 40, "공기호흡기 착용");
      expect(result.contextText).toContain("보존할 일반 원문");
      expect(result.degraded).toBe(true);
      expect(result.sopEvidence).toEqual({ status: "degraded", sourceLabels: [] });
    } finally { log.mockRestore(); }
  });

  it("일반 교범과 SOP를 청크 경계로 제한하면서 SOP 예산을 보존한다", () => {
    const general = Array.from(
      { length: 30 },
      (_, index) => `[일반교범 p.${index + 1}]\n${"일반근거".repeat(4_000)}`
    ).join("\n\n---\n\n");
    const sop = Array.from(
      { length: 6 },
      (_, index) => `[현장SOP p.${index + 1}]\n${"안전절차".repeat(2_000)}`
    ).join("\n\n---\n\n");

    const limited = limitGenerationContextText(general, sop);

    expect(utf8Bytes(limited)).toBeLessThanOrEqual(MAX_GENERATION_CONTEXT_UTF8_BYTES);
    expect(limited).toContain("[일반교범 p.1]");
    expect(limited).toContain("=== 관련 SOP·현장지침 근거 ===");
    expect(limited).toContain("[현장SOP p.1]");
    expect(limited).not.toContain("[일반교범 p.30]");
  });

  it("예산 안의 근거는 내용과 순서를 바꾸지 않는다", () => {
    const general = "[교범 p.1]\n첫 근거\n\n---\n\n[교범 p.2]\n둘째 근거";
    const sop = "[SOP p.3]\n확인 절차";

    expect(limitGenerationContextText(general, sop)).toBe(
      `${general}\n\n=== 관련 SOP·현장지침 근거 ===\n${sop}`
    );
  });
});
