// 챗봇 인기 질문 (서버 전용). popular_questions RPC(집계만 반환)를 호출한다.
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
