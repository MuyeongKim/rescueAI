"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import type { Message } from "ai";
import { ThumbsUp, ThumbsDown, Flame } from "lucide-react";
import { toast } from "sonner";
import type { DocSource } from "@/lib/database.types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SourceBadge } from "@/components/chat/SourceBadge";

// 답변 본문의 인용 표기(예: "[근거: 공기호흡기 착용 절차 p.3]")를 sources와
// 매칭해 원본 자료 해당 페이지로 가는 링크로 바꾼다. 매칭 실패 시 원문 유지.
const CITATION_RE =
  /\[\s*(?:(?:근거|출처)\s*:\s*)?([^[\]]+?)\s+p\.?\s*(\d+)(?:\s*[-–~,]\s*\d+)*\s*\]/g;

function linkifyCitations(content: string, sources: DocSource[]): ReactNode {
  if (sources.length === 0 || !content.includes("[")) return content;

  const nodes: ReactNode[] = [];
  let last = 0;
  for (const m of Array.from(content.matchAll(CITATION_RE))) {
    const [full, title, pageStr] = m;
    const page = parseInt(pageStr, 10);
    const src = sources.find(
      (s) =>
        (s.page == null || s.page === page) &&
        (title.includes(s.doc) || s.doc.includes(title.trim()))
    );
    if (!src) continue;

    const idx = m.index ?? 0;
    if (idx > last) nodes.push(content.slice(last, idx));
    nodes.push(
      <Link
        key={`cite-${idx}`}
        href={`/docs/${src.document_id}?page=${page}`}
        className="text-primary underline underline-offset-2 hover:text-primary/80"
      >
        {full}
      </Link>
    );
    last = idx + full.length;
  }
  if (nodes.length === 0) return content;
  if (last < content.length) nodes.push(content.slice(last));
  return nodes;
}

type ChatAnnotation = {
  messageId: number | null;
  conversationId?: string;
  sources?: DocSource[];
  feedback?: number | null;
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
  const sources = annotation?.sources ?? [];
  const messageId = annotation?.messageId ?? null;

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
        body: JSON.stringify({ messageId, feedback: next ?? value }),
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
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-base leading-relaxed text-primary-foreground whitespace-pre-wrap wrap-break-word">
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
        <div className="max-w-[92%] rounded-2xl rounded-tl-sm bg-muted px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap wrap-break-word">
          {message.content ? (
            linkifyCitations(message.content, sources)
          ) : (
            <span className="text-muted-foreground">생각하는 중…</span>
          )}
        </div>

        {sources.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">근거</span>
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
                "h-9 w-9 text-muted-foreground",
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
                "h-9 w-9 text-muted-foreground",
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
