import { describe, it, expect } from "vitest";
import {
  calcPoints,
  calcStreak,
  calcWeekly,
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
