import { ArrowDownToLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { USER_GUIDE_QUESTION_EXAMPLE, USER_GUIDE_QUESTION_PARTS } from "@/lib/user-guide-content";

export function QuestionGuide({ onUseExample, hasInput, isLoading }: {
  onUseExample: () => void;
  hasInput: boolean;
  isLoading: boolean;
}) {
  return (
    <div className="space-y-5">
      <dl className="divide-y divide-border border-y border-border sm:grid sm:grid-cols-3 sm:divide-x sm:divide-y-0">
        {USER_GUIDE_QUESTION_PARTS.map((part) => (
          <div key={part.title} className="px-3 py-3 sm:py-4">
            <dt className="text-sm font-bold text-primary">{part.title}</dt>
            <dd className="mt-1 text-base leading-6 text-foreground">{part.text}</dd>
          </div>
        ))}
      </dl>
      <div className="border-l-4 border-primary bg-muted/50 px-4 py-4">
        <p className="text-sm font-semibold text-muted-foreground">하나의 질문으로 연결하면</p>
        <p className="mt-2 text-base font-medium leading-7 text-foreground">{USER_GUIDE_QUESTION_EXAMPLE}</p>
        <Button type="button" variant="outline"
          className="mt-4 min-h-12 w-full gap-2 bg-background sm:w-auto"
          disabled={hasInput || isLoading} onClick={onUseExample}>
          <ArrowDownToLine className="h-4 w-4" aria-hidden /> 예시를 입력창에 넣기
        </Button>
        <p className="mt-2 text-sm leading-6 text-muted-foreground" role="status">
          {hasInput ? "작성 중인 질문을 보내거나 지우면 예시를 넣을 수 있어요."
            : isLoading ? "답변이 끝나면 예시를 넣을 수 있어요."
              : "내 상황에 맞게 고친 뒤 전송하세요."}
        </p>
      </div>
      <p className="text-sm leading-6 text-muted-foreground">답변을 받은 뒤에는 함께 표시된 출처도 확인하세요.</p>
    </div>
  );
}
