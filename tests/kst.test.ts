import { describe, it, expect } from "vitest";
import { kstDate, kstDateStr, kstMonthStartStr } from "@/lib/kst";

// 한국은 고정 UTC+9(서머타임 없음). 실행 환경 TZ 와 무관하게 KST 벽시계가 나와야 한다.
describe("kst 헬퍼", () => {
  it("UTC 자정 근처를 KST 날짜로 넘긴다", () => {
    // 2026-07-08 16:30Z = KST 07-09 01:30
    expect(kstDateStr(new Date("2026-07-08T16:30:00Z"))).toBe("2026-07-09");
    // 2026-07-08 14:00Z = KST 07-08 23:00
    expect(kstDateStr(new Date("2026-07-08T14:00:00Z"))).toBe("2026-07-08");
  });

  it("월말 경계에서 이번 달을 KST 로 판정한다", () => {
    // 2026-06-30 15:30Z = KST 07-01 00:30 → 7월
    expect(kstMonthStartStr(new Date("2026-06-30T15:30:00Z"))).toBe("2026-07-01");
    // 2026-06-30 14:00Z = KST 06-30 23:00 → 6월
    expect(kstMonthStartStr(new Date("2026-06-30T14:00:00Z"))).toBe("2026-06-01");
  });

  it("요일을 KST 로 계산한다(2026-07-08 KST = 수요일)", () => {
    expect(kstDate(new Date("2026-07-08T03:00:00Z")).getUTCDay()).toBe(3);
  });
});
