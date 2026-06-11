import { createClient } from "@/lib/supabase/server";
import { buildCourses, type Course, type LessonDoc } from "@/lib/courses";
import { DEMO, getDemoLearningState } from "@/lib/demo";

export type LearningState = {
  courses: Course[];
  completedIds: Set<number>;
  totalLessons: number;
  totalCompleted: number;
  overallProgress: number;
};

// 현재 사용자의 학습 상태(과정·진도·이수)를 한 번에 조립한다. RLS로 본인 데이터만.
export async function getLearningState(userId: string): Promise<LearningState> {
  if (DEMO) return getDemoLearningState();
  const supabase = await createClient();

  const [docsRes, progRes] = await Promise.all([
    supabase
      .from("documents")
      .select("id, title, category, difficulty, publish_date"),
    supabase.from("lesson_progress").select("document_id").eq("user_id", userId),
  ]);

  const docs = (docsRes.data ?? []) as LessonDoc[];
  const completedIds = new Set<number>(
    (progRes.data ?? [])
      .map((p) => p.document_id)
      .filter((x): x is number => x != null)
  );

  const courses = buildCourses(docs, completedIds);
  const totalLessons = courses.reduce((s, c) => s + c.total, 0);
  const totalCompleted = courses.reduce((s, c) => s + c.completed, 0);
  const overallProgress =
    totalLessons > 0 ? Math.round((totalCompleted / totalLessons) * 100) : 0;

  return {
    courses,
    completedIds,
    totalLessons,
    totalCompleted,
    overallProgress,
  };
}
