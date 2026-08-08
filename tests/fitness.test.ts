import { describe, it, expect } from "vitest";
import {
  BACKDATE_MAX_DAYS,
  calcPoints,
  calcStreak,
  calcWeekly,
  checkPerformedOn,
  isCalendarDate,
  DAILY_POINT_CAP,
} from "@/lib/fitness";

function fmt(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return fmt(d);
}

describe("calcPoints", () => {
  it("운동 1분 = 1점으로 적립한다", () => {
    expect(calcPoints(40, 0)).toBe(40);
  });

  it("일일 상한을 넘기지 않는다", () => {
    expect(calcPoints(200, 0)).toBe(DAILY_POINT_CAP);
    expect(calcPoints(60, 100)).toBe(DAILY_POINT_CAP - 100);
    expect(calcPoints(30, DAILY_POINT_CAP)).toBe(0);
  });

  it("잘못된 입력은 0점 처리한다", () => {
    expect(calcPoints(0, 0)).toBe(0);
    expect(calcPoints(-10, 0)).toBe(0);
    expect(calcPoints(NaN, 0)).toBe(0);
  });
});

describe("calcStreak", () => {
  it("오늘부터 이어진 연속 일수를 센다", () => {
    expect(calcStreak([daysAgo(0), daysAgo(1), daysAgo(2)])).toBe(3);
  });

  it("오늘 기록이 없으면 어제부터 센다", () => {
    expect(calcStreak([daysAgo(1), daysAgo(2)])).toBe(2);
  });

  it("중간에 빈 날이 있으면 거기서 끊는다", () => {
    expect(calcStreak([daysAgo(0), daysAgo(2), daysAgo(3)])).toBe(1);
  });

  it("기록이 없거나 이틀 전이 마지막이면 0이다", () => {
    expect(calcStreak([])).toBe(0);
    expect(calcStreak([daysAgo(2)])).toBe(0);
  });
});

describe("calcWeekly", () => {
  it("최근 8주 버킷을 만들고 이번 주 기록을 합산한다", () => {
    const weekly = calcWeekly([
      { performed_on: daysAgo(0), points: 30 },
      { performed_on: daysAgo(60), points: 50 }, // 8주 범위 밖
    ]);
    expect(weekly).toHaveLength(8);
    expect(weekly[7].points).toBe(30); // 마지막 버킷 = 이번 주
    expect(weekly.reduce((s, w) => s + w.points, 0)).toBe(30);
  });

  it("기록이 없으면 전부 0이다", () => {
    const weekly = calcWeekly([]);
    expect(weekly.every((w) => w.points === 0)).toBe(true);
  });
});

describe("checkPerformedOn (소급 입력 제한)", () => {
  const today = "2026-08-08";

  it("오늘과 최근 14일 이내는 허용한다", () => {
    expect(checkPerformedOn(today, today)).toEqual({ ok: true });
    expect(checkPerformedOn("2026-08-01", today)).toEqual({ ok: true });
    expect(checkPerformedOn("2026-07-25", today)).toEqual({ ok: true }); // 정확히 14일 전
  });

  it("허용 경계가 BACKDATE_MAX_DAYS 상수를 따른다", () => {
    const boundary = new Date(`${today}T00:00:00Z`);
    boundary.setUTCDate(boundary.getUTCDate() - BACKDATE_MAX_DAYS);
    const justOutside = new Date(boundary);
    justOutside.setUTCDate(justOutside.getUTCDate() - 1);

    expect(checkPerformedOn(boundary.toISOString().slice(0, 10), today).ok).toBe(true);
    expect(checkPerformedOn(justOutside.toISOString().slice(0, 10), today).ok).toBe(false);
  });

  it("14일보다 오래된 날짜를 막는다", () => {
    // 하한이 없으면 과거 날짜를 흩뿌려 일일 상한(120점)을 무한히 우회할 수 있다.
    expect(checkPerformedOn("2026-07-24", today)).toEqual({ ok: false, reason: "too-old" });
    expect(checkPerformedOn("2020-01-01", today)).toEqual({ ok: false, reason: "too-old" });
  });

  it("미래 날짜를 막는다", () => {
    expect(checkPerformedOn("2026-08-09", today)).toEqual({ ok: false, reason: "future" });
  });

  it("달력에 없는 날짜·형식 오류를 막는다 (DB 까지 내려가 500 나던 값들)", () => {
    for (const bad of ["2026-13-45", "2026-02-30", "20260808", "2026-8-8", "abc", ""]) {
      expect(checkPerformedOn(bad, today)).toEqual({ ok: false, reason: "format" });
    }
  });

  it("월·연 경계를 넘어도 일수로 판정한다", () => {
    expect(checkPerformedOn("2025-12-28", "2026-01-05")).toEqual({ ok: true });
    expect(checkPerformedOn("2025-12-21", "2026-01-05")).toEqual({ ok: false, reason: "too-old" });
  });
});

describe("isCalendarDate", () => {
  it("실제 존재하는 날짜만 통과시킨다", () => {
    expect(isCalendarDate("2026-02-28")).toBe(true);
    expect(isCalendarDate("2024-02-29")).toBe(true); // 윤년
    expect(isCalendarDate("2026-02-29")).toBe(false); // 평년
    expect(isCalendarDate("2026-00-10")).toBe(false);
  });
});
