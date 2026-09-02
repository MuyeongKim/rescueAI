import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 내구성 자료제작 전용 service-role 클라이언트.
 *
 * 호출 경계는 반드시 requireApiUser()로 인증한 작업 생성/재시도 API이거나,
 * 그 API가 발급한 job id + 회전 가능한 run token을 검증하는 Workflow step이어야 한다.
 * 브라우저 코드에서 import하지 않으며 generation_jobs/RAG 조회 범위를 벗어나 사용하지 않는다.
 */
export function createGenerationWorkerClient() {
  return createAdminClient();
}
