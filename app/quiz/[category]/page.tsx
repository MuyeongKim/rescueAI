import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { QuizRunner } from "@/components/learning/QuizRunner";

export const dynamic = "force-dynamic";

export default function QuizPage({
  params,
}: {
  params: { category: string };
}) {
  const category = decodeURIComponent(params.category);

  return (
    <div className="mx-auto max-w-2xl px-3 py-5 sm:px-4">
      <div className="mb-4 flex items-center gap-2">
        <Link href={`/courses/${encodeURIComponent(category)}`}>
          <Button variant="ghost" size="icon" className="h-10 w-10" aria-label="과정으로">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        </Link>
        <h1 className="text-xl font-semibold">{category} 이수 퀴즈</h1>
      </div>
      <QuizRunner category={category} />
    </div>
  );
}
