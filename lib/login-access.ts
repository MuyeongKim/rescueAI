import { kstDateStr, secondsUntilNextKstDay } from "@/lib/kst";

export const LOGIN_ACCESS_COOKIE = "rescueai-access-day";

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
