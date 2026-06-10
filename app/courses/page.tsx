import { getUserAndProfile } from "@/lib/auth";
import { getLearningState } from "@/lib/learning";
import { Card, CardContent } from "@/components/ui/card";
import { CourseCard } from "@/components/learning/CourseCard";

export const dynamic = "force-dynamic";

export default async function CoursesPage() {
  const { user } = await getUserAndProfile();
  const state = user
    ? await getLearningState(user.id)
    : null;
  const courses = state?.courses ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-4 px-3 py-5 sm:px-4">
      <div>
        <h1 className="text-xl font-semibold">학습 과정</h1>
        <p className="text-sm text-muted-foreground">
          분야별 과정입니다. 자료를 학습하고 퀴즈에 합격하면 이수로 표시됩니다.
        </p>
      </div>

      {courses.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            아직 인덱싱된 자료가 없습니다. 자료를 올리면 과정이 자동 생성됩니다.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {courses.map((c) => (
            <CourseCard key={c.category} course={c} />
          ))}
        </div>
      )}
    </div>
  );
}
