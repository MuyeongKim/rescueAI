import { describe, expect, it } from "vitest";
import { getNewsDateWindow, toKstDate } from "@/lib/news-window";

describe("구조 동향 최근 30일 날짜 정책", () => {
  it("오늘과 29일 전 날짜를 모두 포함한다", () => {
    expect(getNewsDateWindow(new Date("2026-09-05T03:00:00Z"))).toEqual({ from: "2026-08-07", to: "2026-09-05" });
  });

  it("한국시간 자정에서 조회와 수집 날짜가 함께 바뀐다", () => {
    const before = new Date("2026-09-04T14:59:59.999Z");
    const after = new Date("2026-09-04T15:00:00.000Z");
    expect(toKstDate(before)).toBe("2026-09-04");
    expect(toKstDate(after)).toBe("2026-09-05");
    expect(getNewsDateWindow(before)).toEqual({ from: "2026-08-06", to: "2026-09-04" });
    expect(getNewsDateWindow(after)).toEqual({ from: "2026-08-07", to: "2026-09-05" });
  });

  it.each([
    ["2026-01-01T00:00:00+09:00", "2025-12-03", "2026-01-01"],
    ["2024-03-01T12:00:00+09:00", "2024-02-01", "2024-03-01"],
    ["2025-03-01T12:00:00+09:00", "2025-01-31", "2025-03-01"],
  ])("달·해·윤년을 넘어도 30개 날짜만 포함한다: %s", (instant, from, to) => {
    const now = new Date(instant);
    const original = now.getTime();
    expect(getNewsDateWindow(now)).toEqual({ from, to });
    expect(now.getTime()).toBe(original);
  });

  it("유효하지 않은 날짜를 조회 필터나 수집 날짜로 만들지 않는다", () => {
    expect(() => toKstDate(new Date("invalid"))).toThrow(RangeError);
    expect(() => getNewsDateWindow(new Date("invalid"))).toThrow(RangeError);
  });
});
