import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/llm", () => ({ getChatModel: () => ({}) }));
import { reviewGenerationGrounding } from "@/lib/generation-grounding-review";
const args = {
  draft: { title: "장비 점검", sections: [{ heading: "훈련내용", content: "장비 B의 압력은 30 MPa입니다." }], sources: [] },
  evidenceText: "장비 A의 압력은 30 MPa입니다.", request: { topic: "장비 B 점검", conditions: "실내 훈련장만 사용" },
};
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe("의미 검토 응답 신뢰 경계", () => {
  it("원문과 장비 조건이 다른 인용을 구조화된 오류로 전달한다", async () => {
    mocks.generateObject.mockResolvedValue({ object: { issues: [{ partIndex: 0, code: "unsupported_evidence_claim", excerpt: "장비 B의 압력은 30 MPa", message: "원문 수치는 장비 A에 대한 값으로 장비 B에 적용할 근거가 없습니다." }] } });
    expect(await reviewGenerationGrounding(args)).toMatchObject({ ok: false, issues: [{ path: "sections.0.content" }] });
    expect(mocks.generateObject.mock.calls[0][0].prompt).toContain(args.evidenceText);
  });
  it("내용에 없는 가짜 검토 인용이나 없는 섹션은 통과시키지 않는다", async () => {
    for (const issue of [
      { partIndex: 9, code: "unsupported_evidence_claim", excerpt: "장비 B의 압력", message: "유효하지 않은 위치입니다." },
      { partIndex: 0, code: "unsupported_evidence_claim", excerpt: "본문에는 없는 내용", message: "존재하지 않는 인용입니다." },
      { partIndex: 0, code: "unmet_training_condition", excerpt: "옥외 훈련장", message: "존재하지 않는 요청입니다." },
    ]) {
      mocks.generateObject.mockResolvedValue({ object: { issues: [issue] } });
      await expect(reviewGenerationGrounding(args)).rejects.toThrow("인용 위치");
    }
  });
  it("명시한 사용자 조건의 인용을 허용한다", async () => {
    mocks.generateObject.mockResolvedValue({ object: { issues: [{ partIndex: 0, code: "unmet_training_condition", excerpt: "실내 훈련장만 사용", message: "야외 시나리오가 사용 가능한 장소와 맞지 않습니다." }] } });
    expect((await reviewGenerationGrounding(args)).ok).toBe(false);
  });
  it("검토 실패나 지나치게 긴 원문을 성공으로 숨기지 않는다", async () => {
    mocks.generateObject.mockRejectedValue(new Error("review unavailable"));
    await expect(reviewGenerationGrounding(args)).rejects.toThrow("review unavailable");
    mocks.generateObject.mockClear();
    await expect(reviewGenerationGrounding({ ...args, evidenceText: "가".repeat(160_001) })).rejects.toThrow("분량");
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });

  it("저장 검토는 짧은 제한 시간을 쓰고 workflow 기본 65초는 유지한다", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    mocks.generateObject.mockResolvedValue({ object: { issues: [] } });
    await reviewGenerationGrounding({ ...args, timeoutMs: 35_000 });
    await reviewGenerationGrounding(args);
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([35_000, 65_000]);
    expect(mocks.generateObject.mock.calls.every(([call]) => call.maxRetries === 0)).toBe(true);
  });
});
