// 한국 표준시(KST) 날짜 헬퍼 — 순수·공용.
// 한국은 서머타임이 없는 고정 UTC+9. 절대시각(getTime)에 +9h 를 더한 Date 를
// getUTC* 로 읽으면 실행 환경 TZ(서버=Vercel UTC 등)와 무관하게 KST 벽시계가 나온다.
// ⚠️ 반환 Date 는 반드시 getUTC*/setUTC* 로만 읽고 쓸 것(로컬 getter 는 다시 어긋난다).
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** KST 벽시계를 담은 Date. getUTC·setUTC 계열로만 다룬다. */
export function kstDate(base: Date = new Date()): Date {
  return new Date(base.getTime() + KST_OFFSET_MS);
}

/** KST 기준 "YYYY-MM-DD". */
export function kstDateStr(base: Date = new Date()): string {
  const d = kstDate(base);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate()
  ).padStart(2, "0")}`;
}

/** KST 기준 이번 달 1일 "YYYY-MM-01". */
export function kstMonthStartStr(base: Date = new Date()): string {
  return kstDateStr(base).slice(0, 7) + "-01";
}
