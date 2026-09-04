"use client";

import { useState } from "react";
import type { Message } from "ai";
import { ThumbsUp, ThumbsDown, Flame, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { DocSource } from "@/lib/database.types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SourceBadge } from "@/components/chat/SourceBadge";
import { ChatMarkdown } from "@/components/chat/ChatMarkdown";
import {
  CHAT_SOURCE_SECTION_TITLE,
  prepareChatAnswerText,
  uniqueChatSources,
} from "@/lib/chat-answer";

type ChatAnnotation = {
  messageId: number | null;
  conversationId?: string;
  sources?: DocSource[];
  feedback?: number | null;
  degraded?: boolean; // 검색 인프라 장애로 근거가 제한적일 수 있음
  saveFailed?: boolean;
};

function extractAnnotation(message: Message): ChatAnnotation | null {
  const anns = message.annotations as ChatAnnotation[] | undefined;
  if (!Array.isArray(anns)) return null;
  for (const a of anns) {
    if (a && typeof a === "object" && "messageId" in a) return a;
  }
  return null;
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const annotation = extractAnnotation(message);
  const sources = uniqueChatSources(annotation?.sources ?? []);
  const messageId = annotation?.messageId ?? null;
  const degraded = annotation?.degraded ?? false;
  const answerText = prepareChatAnswerText(message.content);

  const [feedback, setFeedback] = useState<number | null>(
    annotation?.feedback ?? null
  );
  const [submitting, setSubmitting] = useState(false);

  async function sendFeedback(value: number) {
    if (messageId == null) {
      toast.error("아직 답변이 저장되지 않았습니다.");
      return;
    }
    setSubmitting(true);
    const next = feedback === value ? null : value;
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // next===null 이면 0(취소)을 보내 서버가 평가를 지운다
        body: JSON.stringify({ messageId, feedback: next ?? 0 }),
      });
      if (!res.ok) throw new Error(await res.text());
      setFeedback(next);
      toast.success(next === 1 ? "도움이 됨으로 평가됨" : next === -1 ? "도움 안 됨으로 평가됨" : "평가 취소됨");
    } catch (e) {
      toast.error("피드백 저장 실패", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-md rounded-br-sm bg-primary px-4 py-2.5 text-base leading-relaxed text-primary-foreground whitespace-pre-wrap wrap-break-word">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10">
        <Flame className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="max-w-full rounded-md rounded-tl-sm bg-muted px-4 py-2.5 text-base leading-relaxed wrap-break-word sm:max-w-[92%]">
          {answerText ? (
            <ChatMarkdown text={answerText} />
          ) : (
            <span className="text-muted-foreground">생각하는 중…</span>
          )}
        </div>

        {degraded && (
          <div role="note" className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            자료 검색이 일시적으로 원활하지 않아 근거가 제한적일 수 있습니다.
          </div>
        )}
        {annotation?.saveFailed && (
          <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
            답변을 저장하지 못했습니다. 이 화면을 닫으면 답변이 사라질 수 있으니 필요한 내용을 먼저 복사해 주세요.
          </p>
        )}

        {sources.length > 0 && (
          <div
            aria-label={CHAT_SOURCE_SECTION_TITLE}
            className="flex flex-wrap items-center gap-1.5"
          >
            <span className="text-xs font-semibold text-muted-foreground">
              {CHAT_SOURCE_SECTION_TITLE}
            </span>
            {sources.map((s, i) => (
              <SourceBadge key={`${s.document_id}-${s.page}-${i}`} source={s} />
            ))}
          </div>
        )}

        {messageId != null && (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-12 w-12 text-muted-foreground md:h-9 md:w-9",
                feedback === 1 && "text-primary"
              )}
              disabled={submitting}
              onClick={() => sendFeedback(1)}
              aria-label="도움이 됨"
              aria-pressed={feedback === 1}
            >
              <ThumbsUp className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-12 w-12 text-muted-foreground md:h-9 md:w-9",
                feedback === -1 && "text-destructive"
              )}
              disabled={submitting}
              onClick={() => sendFeedback(-1)}
              aria-label="도움 안 됨"
              aria-pressed={feedback === -1}
            >
              <ThumbsDown className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
