"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useChat } from "ai/react";
import type { Message } from "ai";
import { Send, Square, Loader2, Home } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ConversationList } from "@/components/chat/ConversationList";

const CATEGORIES = ["전체", "산악", "수난", "화재", "구급"] as const;

const EXAMPLES = [
  "공기호흡기 착용 전 점검 절차를 알려줘",
  "수난 구조 시 요구조자 접근 방법은?",
  "유압전개기 안전 사용 수칙",
];

export function ChatInterface({
  conversationId,
  initialMessages = [],
  initialInput,
}: {
  conversationId?: string;
  initialMessages?: Message[];
  /** 입력창 프리필 (예: SOP 카드의 "AI 튜터에게 묻기" → /chat?q=…) */
  initialInput?: string;
}) {
  const [category, setCategory] = useState<string>("전체");
  const convIdRef = useRef<string | undefined>(conversationId);
  const bottomRef = useRef<HTMLDivElement>(null);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    append,
    isLoading,
    stop,
    data,
  } = useChat({
    api: "/api/chat",
    initialMessages,
    initialInput,
  });

  // 스트림에서 conversationId 추출 → URL 갱신(브라우저 스토리지 미사용, 히스토리만 교체)
  useEffect(() => {
    if (!data || data.length === 0) return;
    for (let i = data.length - 1; i >= 0; i--) {
      const d = data[i] as { type?: string; value?: string } | null;
      if (d && typeof d === "object" && d.type === "conversationId" && d.value) {
        if (d.value !== convIdRef.current) {
          convIdRef.current = d.value;
          window.history.replaceState(null, "", `/chat/${d.value}`);
        }
        break;
      }
    }
  }, [data]);

  // 새 메시지마다 하단으로 스크롤
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const requestBody = () => ({
    conversationId: convIdRef.current,
    category: category === "전체" ? null : category,
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    handleSubmit(e, { body: requestBody() });
  }

  function askExample(q: string) {
    if (isLoading) return;
    append({ role: "user", content: q }, { body: requestBody() });
  }

  const empty = messages.length === 0;

  return (
    <div className="flex h-full flex-col">
      {/* 상단 바: 대화목록 + 카테고리 필터 */}
      <div className="border-b bg-background/80 px-3 py-2 sm:px-4">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <Link href="/home" className="md:hidden" aria-label="홈으로">
            <Button variant="ghost" size="icon" className="h-10 w-10">
              <Home className="h-5 w-5" />
            </Button>
          </Link>
          <ConversationList activeId={conversationId} />
          <span className="ml-1 text-sm text-muted-foreground">분야</span>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger className="h-10 w-28">
              <SelectValue placeholder="전체" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* 메시지 목록 */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-3 py-4 sm:px-4">
          {empty ? (
            <div className="flex flex-col items-center gap-6 py-10 text-center">
              <div>
                <h1 className="text-xl font-semibold">무엇을 도와드릴까요?</h1>
                <p className="mt-1 text-sm text-muted-foreground">
                  교육자료에 근거해 출처와 함께 답합니다. 근거가 없으면 추측하지
                  않습니다.
                </p>
              </div>
              <div className="flex w-full flex-col gap-2">
                {EXAMPLES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => askExample(q)}
                    className="rounded-lg border bg-card px-4 py-3 text-left text-base transition-colors hover:bg-accent"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} />
              ))}
              {isLoading &&
                messages[messages.length - 1]?.role === "user" && (
                  <div className="flex items-center gap-2 pl-11 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> 자료를 찾고
                    있습니다…
                  </div>
                )}
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* 입력창 (하단 고정) */}
      <div className="border-t bg-background px-3 py-3 sm:px-4">
        <form onSubmit={onSubmit} className="mx-auto flex max-w-3xl items-center gap-2">
          <Input
            value={input}
            onChange={handleInputChange}
            placeholder="질문을 입력하세요"
            className="h-12 flex-1 text-base"
            disabled={isLoading}
            autoComplete="off"
            enterKeyHint="send"
          />
          {isLoading ? (
            <Button
              type="button"
              variant="secondary"
              className="h-12 w-12 shrink-0 p-0"
              onClick={() => stop()}
              aria-label="중지"
            >
              <Square className="h-5 w-5" />
            </Button>
          ) : (
            <Button
              type="submit"
              className="h-12 w-12 shrink-0 p-0"
              disabled={!input.trim()}
              aria-label="전송"
            >
              <Send className="h-5 w-5" />
            </Button>
          )}
        </form>
        <p className="mx-auto mt-2 max-w-3xl text-center text-xs text-muted-foreground">
          AI 답변은 참고용입니다. 긴급 상황은 현장 지휘관·119 의료지도를
          따르세요.
        </p>
      </div>
    </div>
  );
}
