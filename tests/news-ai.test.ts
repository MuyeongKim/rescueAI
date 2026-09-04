import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ generateObject: vi.fn(), getChatModel: vi.fn(() => "test-model") }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/llm", () => ({ getChatModel: mocks.getChatModel }));
import { summarizeHeadlines } from "@/lib/news-ai";

const headlines = [{ title: "소방서, 수난구조 장비 도입", source: "지역신문" }, { title: "Fire department receives rescue drone" }];
const items = [{ summary: "소방서가 수난구조 장비를 도입했다.", region: "전국", category: "수난" }, { summary: "소방서가 구조용 드론을 받았다.", region: "해외", category: "드론" }];
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(console, "error").mockImplementation(() => undefined); vi.spyOn(console, "warn").mockImplementation(() => undefined); });
afterEach(() => vi.restoreAllMocks());

describe("뉴스 헤드라인 배치 요약", () => {
  it("12초 취소 신호와 재시도 금지·출력 상한으로 호출하고 입력 순서의 결과를 반환한다", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mocks.generateObject.mockResolvedValue({ object: { items } });
    expect(await summarizeHeadlines(headlines)).toEqual(items);
    expect(timeout).toHaveBeenCalledExactlyOnceWith(12_000);
    expect(mocks.generateObject).toHaveBeenCalledWith(expect.objectContaining({ abortSignal: controller.signal, maxRetries: 0, maxTokens: 2_048 }));
    const prompt = mocks.generateObject.mock.calls[0][0].prompt;
    expect(prompt).toContain("기사 본문은 제공되지 않았습니다");
    expect(prompt).toContain("기술 성능·수치, 도입 효과");
    expect(prompt).toContain("숫자·단위·고유명사와 불확실성 표현을 유지");
  });
  it.each([0, 1, 3])("결과가 입력과 다른 %i개이면 대응 관계를 추측하지 않고 제목 수집으로 돌아간다", async (count) => {
    mocks.generateObject.mockResolvedValue({ object: { items: Array.from({ length: count }, () => items[0]) } });
    expect(await summarizeHeadlines(headlines)).toEqual([]);
  });
  it("기한 초과에 의한 취소도 빈 결과를 반환해 제목 수집을 막지 않는다", async () => {
    const controller = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    mocks.generateObject.mockImplementation(({ abortSignal }: { abortSignal: AbortSignal }) => new Promise((_, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    }));
    const pending = summarizeHeadlines(headlines);
    controller.abort(new DOMException("deadline", "TimeoutError"));
    expect(await pending).toEqual([]); expect(mocks.generateObject).toHaveBeenCalledTimes(1);
  });
  it("제공자 오류도 빈 결과로 반환한다", async () => {
    mocks.generateObject.mockRejectedValue(new Error("provider unavailable"));
    expect(await summarizeHeadlines(headlines)).toEqual([]);
  });
  it("입력이 없으면 모델을 호출하지 않는다", async () => {
    expect(await summarizeHeadlines([])).toEqual([]); expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});
