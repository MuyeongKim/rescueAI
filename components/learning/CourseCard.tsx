import Link from "next/link";
import { CheckCircle2, BookOpen } from "lucide-react";
import type { Course } from "@/lib/courses";
import { categoryStyle } from "@/lib/category";
import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProgressBar } from "@/components/learning/ProgressBar";

export function CourseCard({ course }: { course: Course }) {
  const s = categoryStyle(course.category);
  return (
    <Link
      href={`/courses/${encodeURIComponent(course.category)}`}
      className="block focus:outline-hidden"
    >
      <Card className="h-full overflow-hidden transition-colors hover:border-primary/50 hover:bg-accent/40">
        {/* 시그니처: 분야 색 안전 테이프 스트라이프 */}
        <div className={cn("hazard-stripe h-1.5 w-full opacity-70", s.text)} aria-hidden />
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl text-xl",
                  s.tint
                )}
                aria-hidden
              >
                {course.emoji}
              </span>
              <div>
                <div className="flex items-center gap-1.5 font-semibold">
                  {course.category}
                  {course.certified && (
                    <CheckCircle2 className={cn("h-4 w-4", s.text)} />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {course.description}
                </p>
              </div>
            </div>
            {course.certified ? (
              <Badge className="shrink-0">이수</Badge>
            ) : course.passedQuiz ? (
              <Badge variant="secondary" className="shrink-0">
                퀴즈 합격
              </Badge>
            ) : null}
          </div>

          <ProgressBar value={course.progress} indicatorClassName={s.dot} />

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <BookOpen className="h-3.5 w-3.5" />
              레슨 {course.completed}/{course.total}
            </span>
            <span>{course.progress}%</span>
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}
