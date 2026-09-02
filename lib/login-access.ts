import { kstDateStr, secondsUntilNextKstDay } from "@/lib/kst";

export const LOGIN_ACCESS_COOKIE = "rescueai-access-day";

// 운영 집계 원장을 실제로 생성한 날짜. 이 날짜 이전 기록은 소급 집계하지 않는다.
export const LOGIN_ACCESS_TRACKING_STARTED_ON = "2026-09-02";

/** 운영 화면에 표시할 모호하지 않은 한국식 집계 시작일. */
export function loginAccessTrackingStartLabel(): string {
  const [year, month, day] = LOGIN_ACCESS_TRACKING_STARTED_ON.split("-");
  return `${year}. ${Number(month)}. ${Number(day)}.`;
}

export function loginAccessDay(base: Date = new Date()): string {
  return kstDateStr(base);
}

export function shouldRecordLoginAccess(
  recordedDay: string | undefined,
  base: Date = new Date()
): boolean {
  return recordedDay !== loginAccessDay(base);
}

export function loginAccessCookieMaxAge(base: Date = new Date()): number {
  return secondsUntilNextKstDay(base);
}
