import "server-only";

import { DEMO } from "@/lib/demo-flag";
import { createClient } from "@/lib/supabase/server";

export type LoginAccessStatsData = {
  today: number | null;
  total: number | null;
};

const UNAVAILABLE_STATS: LoginAccessStatsData = {
  today: null,
  total: null,
};

/** 로그인 화면과 앱 사이드바가 함께 사용하는 공개 접속 통계 조회. */
export async function getLoginAccessStats(): Promise<LoginAccessStatsData> {
  if (DEMO) return UNAVAILABLE_STATS;

  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .rpc("get_login_access_stats")
      .abortSignal(AbortSignal.timeout(1_200));
    const stats = data?.[0];

    if (error || !stats) return UNAVAILABLE_STATS;

    return {
      today: Math.max(0, stats.today_access),
      total: Math.max(0, stats.total_access),
    };
  } catch {
    // 통계 장애가 로그인이나 서비스 화면 렌더링을 막아서는 안 된다.
    return UNAVAILABLE_STATS;
  }
}
