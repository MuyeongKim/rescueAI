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
  it("선택한 장의 원래 번호와 실제 글머리 위치를 유지하고 연결 출처만 검토한다", async () => {
    const draft = { title: "장비 점검", sources: [], slides: [
      { title: "도입", bullets: ["교육 목표"], notes: "목표 설명" },
      { title: "장비 B", bullets: ["장비 B의 압력은 30 MPa입니다."], notes: "실제 장비 B 원문을 확인합니다.", sourceRefs: ["[장비 B p.4]"] },
    ] };
    mocks.generateObject.mockResolvedValue({ object: { issues: [{ partIndex: 1, code: "unsupported_evidence_claim",
      excerpt: "장비 B의 압력은 30 MPa", message: "연결된 원문은 장비 B의 압력을 20 MPa로 설명합니다." }] } });
    expect(await reviewGenerationGrounding({ ...args, draft, partIndices: [1],
      evidenceText: "[장비 A p.3]\n장비 A의 압력은 30 MPa.\n\n---\n\n[장비 B p.4]\n장비 B의 압력은 20 MPa." }))
      .toMatchObject({ ok: false, issues: [{ path: "slides.1.bullets.0" }] });
    const input = JSON.parse(mocks.generateObject.mock.calls[0][0].prompt);
    expect(input.parts).toHaveLength(1);
    expect(input.parts[0].partIndex).toBe(1);
    expect(input.evidenceGroups[0]).toContain("장비 B의 압력은 20 MPa");
    expect(input.evidenceGroups.join(" ")).not.toContain("장비 A의 압력");
  });
  it("요청하지 않은 장의 검토 응답은 실제 인용이 있어도 거절한다", async () => {
    const draft = { ...args.draft, sections: [...args.draft.sections, { heading: "다른 항목", content: "장비 B의 압력은 30 MPa입니다." }] };
    mocks.generateObject.mockResolvedValue({ object: { issues: [{ partIndex: 0, code: "unsupported_evidence_claim",
      excerpt: "장비 B의 압력은 30 MPa", message: "요청하지 않은 항목의 검토 결과입니다." }] } });
    await expect(reviewGenerationGrounding({ ...args, draft, partIndices: [1] })).rejects.toThrow("인용 위치");
    await expect(reviewGenerationGrounding({ ...args, partIndices: [2] })).rejects.toThrow("대상 위치");
  });
  it("여러 장의 출처 묶음이 겹쳐도 동일 원문을 한 번만 검토 입력에 넣는다", async () => {
    const common = `[공통 교범 p.1]\n${"공통 근거 ".repeat(3000)}`;
    const evidenceText = [common, ...Array.from({ length: 12 }, (_, i) => `[개별 교범 p.${i + 2}]\n${"개별 설명 ".repeat(200)}`)].join("\n\n---\n\n");
    const draft = { title: "겹치는 출처", sources: [], slides: Array.from({ length: 12 }, (_, i) => ({
      title: "원문 확인", bullets: ["확인 항목을 설명합니다."], notes: "설명", sourceRefs: ["[공통 교범 p.1]", `[개별 교범 p.${i + 2}]`],
    })) };
    mocks.generateObject.mockResolvedValue({ object: { issues: [] } });
    await expect(reviewGenerationGrounding({ ...args, draft, evidenceText })).resolves.toEqual({ ok: true, issues: [] });
    const input = JSON.parse(mocks.generateObject.mock.calls[0][0].prompt);
    expect(input.evidenceGroups).toHaveLength(13);
    expect(input.parts.every((part: { evidenceIndices: number[] }) => part.evidenceIndices[0] === 0)).toBe(true);
    expect(mocks.generateObject.mock.calls[0][0].prompt.length).toBeLessThan(evidenceText.length + 5000);
  });
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
