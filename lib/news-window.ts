import { kstDateStr } from "@/lib/kst";

const DAY_MS = 24 * 60 * 60 * 1000;

/** 실행 환경의 시간대와 무관한 한국 날짜(YYYY-MM-DD). 수집·조회가 함께 사용한다. */
export function toKstDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError("유효한 날짜가 필요합니다.");
  return kstDateStr(date);
}

/** 한국시간 오늘을 포함한 최근 30일. from/to 모두 포함하는 날짜 범위다. */
export function getNewsDateWindow(now: Date = new Date()): { from: string; to: string } {
  return {
    from: toKstDate(new Date(now.getTime() - 29 * DAY_MS)),
    to: toKstDate(now),
  };
}
