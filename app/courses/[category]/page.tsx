import Link from "next/link";
import { ArrowLeft, FileText, ChevronRight, Award, HelpCircle } from "lucide-react";

import { getUserAndProfile } from "@/lib/auth";
import { getLearningState } from "@/lib/learning";
import { categoryStyle } from "@/lib/category";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ProgressBar } from "@/components/learning/ProgressBar";
import { CompleteButton } from "@/components/learning/CompleteButton";

export const dynamic = "force-dynamic";

export default async function CourseDetailPage({
  params,
}: {
  params: { category: string };
}) {
  const category = decodeURIComponent(params.category);
  const { user } = await getUserAndProfile();
  const state = user ? await getLearningState(user.id) : null;
  const course = state?.courses.find((c) => c.category === category);

  return (
    <div className="mx-auto max-w-3xl space-y-4 px-3 py-5 sm:px-4">
      <div className="flex items-center gap-2">
        <Link href="/courses">
          <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="과정 목록">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <span
            className={cn(
              "flex h-9 w-9 items-center justify-center rounded-lg text-lg",
              categoryStyle(category).tint
            )}
            aria-hidden
          >
            {course?.emoji ?? "📘"}
          </span>
          {category} 과정
        </h1>
      </div>

      {!course || course.total === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            이 분야에 등록된 자료가 없습니다.
          </CardContent>
        </Card>
      ) : (
        <>
          {/* 진도 + 이수 */}
          <Card className="overflow-hidden">
            {/* 시그니처: 분야 색 안전 테이프 스트라이프 */}
            <div
              className={cn("hazard-stripe h-1.5 w-full opacity-70", categoryStyle(category).text)}
              aria-hidden
            />
            <CardContent className="space-y-3 p-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">{course.description}</p>
                {course.certified && (
                  <Badge className="gap-1">
                    <Award className="h-3.5 w-3.5" /> 이수
                  </Badge>
                )}
              </div>
              <ProgressBar
                value={course.progress}
                indicatorClassName={categoryStyle(category).dot}
              />
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  레슨 {course.completed}/{course.total} · {course.progress}%
                </span>
                <span className="text-muted-foreground">
                  퀴즈 {course.passedQuiz ? "합격" : "미응시/미합격"}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* 레슨 목록 */}
          <div className="overflow-hidden rounded-md border">
            <ul className="divide-y">
              {course.lessons.map((l) => (
                <li key={l.id} className="flex items-center gap-2 p-3">
                  <CompleteButton
                    documentId={l.id}
                    initialCompleted={l.completed}
                    variant="icon"
                  />
                  <Link
                    href={`/docs/${l.id}`}
                    className="flex min-w-0 flex-1 items-center gap-2"
                  >
                    <span className="w-6 shrink-0 text-center text-sm text-muted-foreground">
                      {l.order}
                    </span>
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-base">
                      {l.title}
                    </span>
                    {l.difficulty && (
                      <Badge variant="outline" className="shrink-0 text-xs font-normal">
                        {l.difficulty}
                      </Badge>
                    )}
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* 퀴즈 */}
          <Card>
            <CardContent className="flex flex-col items-center gap-3 p-5 text-center">
              <HelpCircle className="h-8 w-8 text-primary" />
              <div>
                <p className="font-medium">이수 퀴즈</p>
                <p className="text-sm text-muted-foreground">
                  자료 기반 5문항. 60% 이상이면 합격(이수)입니다.
                </p>
              </div>
              <Link href={`/quiz/${encodeURIComponent(category)}`}>
                <Button className="h-11 gap-2">
                  {course.passedQuiz ? "퀴즈 다시 풀기" : "퀴즈 풀기"}
                </Button>
              </Link>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
