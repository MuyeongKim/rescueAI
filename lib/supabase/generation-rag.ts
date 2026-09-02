import "server-only";

import type { GeneratedDocSource } from "@/lib/generate";
import {
  fetchExternalSopContext,
  verifyExternalRagSourceProvenance,
} from "@/lib/rag-external";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * 인증된 자료 저장·공유 API가 생성 Workflow와 같은 RAG를 읽어 재검증하는 전용 창구.
 * raw service-role 클라이언트를 노출하지 않아 호출자가 사용자 데이터 쓰기에 재사용할 수 없다.
 */
export function createGenerationRagReader() {
  const client = createAdminClient();
  return Object.freeze({
    verifySourceProvenance(
      candidates: readonly GeneratedDocSource[],
      expectedCategory: string
    ) {
      return verifyExternalRagSourceProvenance(
        candidates,
        expectedCategory,
        client
      );
    },
    fetchSopContext(category: string, topic: string, limit = 4) {
      return fetchExternalSopContext(category, topic, limit, client);
    },
  });
}

export type GenerationRagReader = ReturnType<typeof createGenerationRagReader>;
