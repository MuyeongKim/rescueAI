// 챗봇 분야 필터 선택지 — 데이터 출처(데모/rag_2026/documents)에 따라 동적으로 구한다.
import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";
import { ragTableEnabled, listRag2026Categories } from "@/lib/rag2026";
import { COURSE_CATEGORIES } from "@/lib/courses";

export async function listChatCategories(): Promise<string[]> {
  if (DEMO) return [...COURSE_CATEGORIES];
  if (ragTableEnabled()) return Object.keys(await listRag2026Categories());

  const supabase = await createClient();
  const { data } = await supabase.from("documents").select("category");
  const cats = new Set(
    (data ?? []).map((d) => d.category).filter((c): c is string => !!c)
  );
  return [
    ...COURSE_CATEGORIES.filter((c) => cats.has(c)),
    ...Array.from(cats).filter(
      (c) => !COURSE_CATEGORIES.includes(c as (typeof COURSE_CATEGORIES)[number])
    ),
  ];
}
