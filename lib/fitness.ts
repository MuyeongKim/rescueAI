// 체력단련 마일리지 규칙·타입 (순수 — 클라이언트/서버 공용).
// 사용자 현황 조립(서버 전용)은 lib/fitness-server.ts 참고.
// 마일리지는 반드시 서버에서 계산해 저장한다(클라이언트 값 신뢰 금지).

export const ACTIVITIES = [
  "달리기",
  "근력운동",
  "등산",
  "수영",
  "자전거",
  "기타",
] as const;

/** 운동 1분 = 1 마일리지, 하루 적립 상한 */
export const DAILY_POINT_CAP = 120;
/** 1회 입력 가능한 최대 운동 시간(분) — DB check 제약과 동일 */
export const MAX_DURATION_MIN = 360;

/** 오늘 이미 적립한 점수를 반영해 이번 기록의 적립 마일리지를 계산한다. */
export function calcPoints(durationMin: number, todayAwarded: number): number {
  if (!Number.isFinite(durationMin) || durationMin < 1) return 0;
  const remaining = Math.max(0, DAILY_POINT_CAP - todayAwarded);
  return Math.min(Math.floor(durationMin), remaining);
}

export type WorkoutLog = {
  id: number;
  activity: string;
  duration_min: number;
  note: string | null;
  points: number;
  performed_on: string;
};

export type LeaderboardEntry = {
  user_id: string;
  full_name: string | null;
  division: string | null;
  total_points: number;
};

export type WeeklyPoint = { week: string; points: number };

export type FitnessState = {
  totalPoints: number;
  monthPoints: number;
  monthRank: number | null; // 이번 달 리더보드 내 순위(20위 밖이면 null)
  streakDays: number; // 연속 운동 일수(오늘 기록 없으면 어제까지 기준)
  weekly: WeeklyPoint[]; // 최근 8주 주간 적립 추이(월요일 시작)
  recent: WorkoutLog[];
  leaderboard: LeaderboardEntry[];
};

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** 연속 운동 일수. 오늘 기록이 없으면 어제부터 거꾸로 센다. */
export function calcStreak(performedDates: Iterable<string>): number {
  const days = new Set(performedDates);
  const cur = new Date();
  if (!days.has(fmtDate(cur))) cur.setDate(cur.getDate() - 1);
  let streak = 0;
  while (days.has(fmtDate(cur))) {
    streak++;
    cur.setDate(cur.getDate() - 1);
  }
  return streak;
}

/** 최근 8주(월요일 시작) 주간 적립 마일리지 추이. */
export function calcWeekly(
  logs: Pick<WorkoutLog, "performed_on" | "points">[]
): WeeklyPoint[] {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const weekly: WeeklyPoint[] = [];
  for (let i = 7; i >= 0; i--) {
    const start = new Date(monday);
    start.setDate(monday.getDate() - i * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 7);
    const s = fmtDate(start);
    const e = fmtDate(end);
    const points = logs
      .filter((l) => l.performed_on >= s && l.performed_on < e)
      .reduce((sum, l) => sum + (l.points ?? 0), 0);
    weekly.push({ week: `${start.getMonth() + 1}/${start.getDate()}`, points });
  }
  return weekly;
}
