// 현재 계정에서 반복한 질문만 조회한다. 다른 계정의 질문 원문은 공유하지 않는다.
import { createClient } from "@/lib/supabase/server";
import { DEMO, demoPopularQuestions } from "@/lib/demo";

export async function getPopularQuestions(): Promise<string[]> {
  if (DEMO) return demoPopularQuestions;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("popular_questions", {
    days: 30,
    min_count: 2,
    max_rows: 8,
  });
  if (error) {
    console.error("[popular] 인기 질문 조회 실패:", error.message);
    return [];
  }
  return (data ?? []).map((r) => r.question);
}
