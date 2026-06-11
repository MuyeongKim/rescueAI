// 과정(코스) 자동 편성 + 진도 계산 (순수 함수).
// 과정 = 카테고리, 레슨 = 해당 카테고리의 documents.

export const COURSE_CATEGORIES = ["산악", "수난", "화재", "구급"] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number];

export const COURSE_META: Record<
  string,
  { description: string; emoji: string }
> = {
  산악: { description: "로프·하강·산악 인명구조", emoji: "⛰️" },
  수난: { description: "수난 구조·구명·잠수 기초", emoji: "🌊" },
  화재: { description: "화재 진압·공기호흡기·내화", emoji: "🔥" },
  구급: { description: "응급처치·구급 장비 운용", emoji: "🚑" },
};

const DIFF_RANK: Record<string, number> = { 초급: 0, 중급: 1, 고급: 2 };

export type LessonDoc = {
  id: number;
  title: string;
  category: string | null;
  difficulty: string | null;
  publish_date: string | null;
};

export type Lesson = LessonDoc & { completed: boolean; order: number };

export type Course = {
  category: string;
  description: string;
  emoji: string;
  lessons: Lesson[];
  total: number;
  completed: number;
  progress: number; // 0~100
  certified: boolean; // 모든 레슨 완료 = 이수
};

function sortLessons(a: LessonDoc, b: LessonDoc): number {
  const ra = DIFF_RANK[a.difficulty ?? ""] ?? 9;
  const rb = DIFF_RANK[b.difficulty ?? ""] ?? 9;
  if (ra !== rb) return ra - rb;
  const da = a.publish_date ?? "";
  const db = b.publish_date ?? "";
  if (da !== db) return da.localeCompare(db);
  return a.title.localeCompare(b.title);
}

export function buildCourses(
  docs: LessonDoc[],
  completedIds: Set<number>
): Course[] {
  const byCat = new Map<string, LessonDoc[]>();
  for (const d of docs) {
    if (!d.category) continue;
    if (!byCat.has(d.category)) byCat.set(d.category, []);
    byCat.get(d.category)!.push(d);
  }

  // 정의된 카테고리 우선, 그 외 카테고리도 뒤에 노출
  const cats = [
    ...COURSE_CATEGORIES.filter((c) => byCat.has(c)),
    ...Array.from(byCat.keys()).filter(
      (c) => !COURSE_CATEGORIES.includes(c as CourseCategory)
    ),
  ];

  return cats.map((category) => {
    const lessonsRaw = (byCat.get(category) ?? []).slice().sort(sortLessons);
    const lessons: Lesson[] = lessonsRaw.map((d, i) => ({
      ...d,
      order: i + 1,
      completed: completedIds.has(d.id),
    }));
    const total = lessons.length;
    const completed = lessons.filter((l) => l.completed).length;
    const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
    return {
      category,
      description: COURSE_META[category]?.description ?? "구조 교육 과정",
      emoji: COURSE_META[category]?.emoji ?? "📘",
      lessons,
      total,
      completed,
      progress,
      certified: total > 0 && completed === total,
    };
  });
}
