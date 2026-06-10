// 체력단련 마일리지 — 현재 사용자 현황 조립 (서버 전용). 규칙·타입은 lib/fitness.ts.
import { createClient } from "@/lib/supabase/server";
import { DEMO, getDemoFitnessState } from "@/lib/demo";
import {
  calcStreak,
  calcWeekly,
  type FitnessState,
  type LeaderboardEntry,
  type WorkoutLog,
} from "@/lib/fitness";

function monthStart(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

// 현재 사용자의 마일리지 현황 + 이번 달 리더보드를 한 번에 조립한다. RLS로 본인 기록만.
export async function getFitnessState(userId: string): Promise<FitnessState> {
  if (DEMO) return getDemoFitnessState();
  const supabase = await createClient();
  const since = monthStart();

  const [logsRes, lbRes] = await Promise.all([
    supabase
      .from("workout_logs")
      .select("id, activity, duration_min, note, points, performed_on")
      .eq("user_id", userId)
      .order("performed_on", { ascending: false })
      .order("id", { ascending: false })
      .limit(200),
    supabase.rpc("fitness_leaderboard", { since }),
  ]);

  const logs = (logsRes.data ?? []) as WorkoutLog[];
  const totalPoints = logs.reduce((s, l) => s + (l.points ?? 0), 0);
  const monthPoints = logs
    .filter((l) => l.performed_on >= since)
    .reduce((s, l) => s + (l.points ?? 0), 0);

  const leaderboard = (lbRes.data ?? []) as LeaderboardEntry[];
  const idx = leaderboard.findIndex((e) => e.user_id === userId);

  return {
    totalPoints,
    monthPoints,
    monthRank: idx >= 0 ? idx + 1 : null,
    streakDays: calcStreak(logs.map((l) => l.performed_on)),
    weekly: calcWeekly(logs),
    recent: logs.slice(0, 20),
    leaderboard,
  };
}
