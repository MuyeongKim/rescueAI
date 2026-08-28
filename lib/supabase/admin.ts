import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// 서비스 롤(관리자) 클라이언트 — RLS를 우회한다. **서버에서만** 사용할 것.
// 용도: 관리자 통계 집계처럼 전체 데이터 접근이 필요하고, 호출 전 role='admin' 검증이 끝난 경우.
export function createAdminClient() {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceKey) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY 가 설정되지 않았습니다.");
  }
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    serviceKey,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );
}
