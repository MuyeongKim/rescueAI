"use client";

import { useState } from "react";
import type { Message } from "ai";
import { ThumbsUp, ThumbsDown, Flame, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { DocSource } from "@/lib/database.types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SourceBadge } from "@/components/chat/SourceBadge";
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
        <div className="max-w-[92%] rounded-md rounded-tl-sm bg-muted px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap wrap-break-word">
          {answerText ? (
            answerText
          ) : (
            <span className="text-muted-foreground">생각하는 중…</span>
          )}
        </div>

        {degraded && (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
            자료 검색이 일시적으로 원활하지 않아 근거가 제한적일 수 있습니다.
          </div>
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
            >
              <ThumbsDown className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
