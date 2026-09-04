"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useChat } from "ai/react";
import type { Message } from "ai";
import {
  ArrowRight,
  AlertTriangle,
  Loader2,
  RefreshCw,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Square,
} from "lucide-react";

import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { MessageBubble } from "@/components/chat/MessageBubble";
import { ConversationList } from "@/components/chat/ConversationList";
import { COURSE_CATEGORIES } from "@/lib/courses";
import { ChatRequestError, chatErrorMessage, fetchChat } from "@/lib/chat-request";

const DEFAULT_CATEGORIES = [...COURSE_CATEGORIES];

// 인기 질문이 없을 때(집계 부족) 폴백으로 보여줄 기본 예시
const FALLBACK_EXAMPLES = [
  "공기호흡기 착용 전 점검 절차를 알려줘",
  "수난 구조 시 요구조자 접근 방법은?",
  "유압전개기 안전 사용 수칙",
];

const RESPONSE_LABELS: Record<string, string> = {
  "빠른 처리": "빠른 답변",
  "정밀 처리": "자세한 답변",
  "심층 처리": "심층 답변",
  "대체 처리": "대체 답변",
};

function responseLabel(label: string): string {
  return RESPONSE_LABELS[label] ?? label;
}

export function ChatInterface({
  conversationId,
  initialMessages = [],
  initialInput,
  categories,
  models = [],
  popular = [],
}: {
  conversationId?: string;
  initialMessages?: Message[];
  /** 입력창 프리필 (예: /chat?q=…) */
  initialInput?: string;
  /** 분야 필터 선택지 ("자동" 제외) — 서버에서 실제 자료 기준으로 전달 */
  categories?: string[];
  /** 사용 가능한 LLM 모델(자격증명 있는 것만) — 서버 availableModels() */
  models?: { key: string; label: string; note?: string }[];
  /** 인기 질문(대원들이 자주 묻는 것) — 없으면 기본 예시로 폴백 */
  popular?: string[];
}) {
  const [category, setCategory] = useState<string>("자동");
  const [model, setModel] = useState<string>(models[0]?.key ?? "");
  const convIdRef = useRef<string | undefined>(conversationId);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasSubmittedRef = useRef(false);
  const stoppedRef = useRef(false);
  const questionRef = useRef<HTMLInputElement>(null);
  const lastRequestRef = useRef<Record<string, unknown> | null>(null);
  const requestStartedAtRef = useRef(0);
  const [retryAt, setRetryAt] = useState(0);
  const [retrySeconds, setRetrySeconds] = useState(0);

  const {
    messages,
    input,
    handleInputChange,
    handleSubmit,
    append,
    isLoading,
    stop,
    data,
    error,
    reload,
    setInput,
  } = useChat({
    api: "/api/chat",
    initialMessages,
    initialInput,
    fetch: fetchChat,
    keepLastMessageOnError: true,
    onError: (failure) => {
      if (failure instanceof ChatRequestError && failure.retryAfterSeconds > 0) {
        setRetryAt(Date.now() + failure.retryAfterSeconds * 1000);
        setRetrySeconds(failure.retryAfterSeconds);
      } else if (!(failure instanceof ChatRequestError)) {
        // 연결이 끊겨도 서버가 답변 저장을 마칠 수 있다. 서버 실행 상한(60초)이
        // 지나기 전 같은 생성 작업을 겹쳐 시작하지 않는다.
        const remaining = Math.max(0, Math.ceil((requestStartedAtRef.current + 65_000 - Date.now()) / 1000));
        if (remaining > 0) {
          setRetryAt(Date.now() + remaining * 1000);
          setRetrySeconds(remaining);
        }
      }
    },
  });

  useEffect(() => {
    const last = initialMessages.at(-1);
    if (last?.role !== "user" || !last.createdAt) return;
    const until = new Date(last.createdAt).getTime() + 65_000;
    if (until > Date.now()) {
      setRetryAt(until);
      setRetrySeconds(Math.ceil((until - Date.now()) / 1000));
    }
  }, [initialMessages]);

  useEffect(() => {
    if (!retryAt) return;
    const update = () => {
      const remaining = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
      setRetrySeconds(remaining);
      if (remaining === 0) setRetryAt(0);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

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

  // 새 메시지/토큰마다 하단으로 스크롤 — 단, 사용자가 위로 올려 읽는 중이면 방해하지 않는다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) {
      const reduceMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      bottomRef.current?.scrollIntoView({
        behavior: reduceMotion ? "auto" : "smooth",
      });
    }
  }, [messages]);

  const requestBody = () => ({
    conversationId: convIdRef.current,
    category: category === "자동" ? null : category,
    model: model || undefined,
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!input.trim() || isLoading || retrySeconds > 0) return;
    // 복원한 질문을 전송 버튼으로 보내도 같은 요청/말풍선을 재사용한다.
    if ((error || unansweredSavedQuestion) && input.trim() === lastQuestion.trim()) {
      setInput("");
      retryLastQuestion();
      return;
    }
    hasSubmittedRef.current = true;
    stoppedRef.current = false;
    const body = { ...requestBody(), clientRequestId: crypto.randomUUID() };
    lastRequestRef.current = body;
    requestStartedAtRef.current = Date.now();
    handleSubmit(e, { body });
  }

  function askExample(q: string) {
    if (isLoading || retrySeconds > 0) return;
    hasSubmittedRef.current = true;
    stoppedRef.current = false;
    const body = { ...requestBody(), clientRequestId: crypto.randomUUID() };
    lastRequestRef.current = body;
    requestStartedAtRef.current = Date.now();
    append({ role: "user", content: q }, { body });
  }

  function retryLastQuestion() {
    if (isLoading || retrySeconds > 0) return;
    hasSubmittedRef.current = true;
    stoppedRef.current = false;
    // reload가 마지막 미완성 답변만 교체하므로 같은 질문 말풍선을 추가하지 않는다.
    const restoredRequestId = initialMessages.at(-1)?.annotations?.find(
      (annotation) => annotation && typeof annotation === "object" && "clientRequestId" in annotation
    ) as { clientRequestId?: string } | undefined;
    const body = {
      ...(lastRequestRef.current ?? requestBody()),
      conversationId: convIdRef.current,
      clientRequestId: lastRequestRef.current?.clientRequestId ?? restoredRequestId?.clientRequestId ?? crypto.randomUUID(),
    };
    lastRequestRef.current = body;
    requestStartedAtRef.current = Date.now();
    void reload({ body });
  }

  const empty = messages.length === 0;
  const examples = popular.length > 0 ? popular : FALLBACK_EXAMPLES;
  const examplesTitle = popular.length > 0 ? "대원들이 자주 묻는 질문" : "이렇게 물어보세요";
  const unansweredSavedQuestion = !hasSubmittedRef.current && messages.at(-1)?.role === "user";
  const lastQuestion = [...messages].reverse().find((message) => message.role === "user")?.content ?? "";
  const assistantStatus = hasSubmittedRef.current
    ? isLoading
      ? "AI가 교육자료를 검색하고 답변을 작성하는 중입니다."
      : error
        ? "답변을 가져오지 못했습니다. 오류 안내에서 다시 시도할 수 있습니다."
      : stoppedRef.current
        ? "AI 답변 생성을 중지했습니다."
        : messages[messages.length - 1]?.role === "assistant"
        ? "AI 답변 작성이 완료되었습니다."
        : ""
    : "";

  return (
    <div className="flex h-full flex-col">
      {/* 상단 바: 대화목록 + 카테고리 필터 */}
      <div className="border-b-2 border-ops-signal bg-ops-sidebar px-3 py-2 text-white sm:px-4">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <ConversationList activeId={convIdRef.current} />
          <h1 className="mr-auto flex items-center gap-2 text-sm font-bold">
            <span className="h-4 w-0.5 bg-ops-signal-bright" aria-hidden /> AI 튜터
          </h1>
          <div className="hidden items-center gap-2 sm:flex">
            <span className="ml-1 text-xs text-slate-400">분야</span>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger
                className="h-10 w-28 border-slate-600 bg-ops-navy-deep text-white"
                aria-label="분야 선택"
              >
                <SelectValue placeholder="자동" />
              </SelectTrigger>
              <SelectContent>
                {["자동", ...(categories?.length ? categories : DEFAULT_CATEGORIES)].map(
                  (c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>

            {models.length > 1 && (
              <>
                <span className="ml-1 text-xs text-slate-400">답변 유형</span>
                <Select value={model} onValueChange={setModel}>
                  <SelectTrigger
                    className="h-10 w-36 border-slate-600 bg-ops-navy-deep text-white"
                    aria-label="답변 유형 선택"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((m) => (
                      <SelectItem key={m.key} value={m.key}>
                        {responseLabel(m.label)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>

          <Sheet>
            <SheetTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-12 w-12 sm:hidden"
                aria-label="AI 튜터 설정"
              >
                <SlidersHorizontal className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="bottom" className="rounded-none border-t-4 border-t-primary">
              <SheetHeader className="text-left">
                <p className="text-xs font-bold text-primary">AI 튜터</p>
                <SheetTitle className="text-xl font-extrabold">질문 설정</SheetTitle>
                <SheetDescription>
                  분야는 질문 내용에 맞춰 자동으로 찾으며, 필요할 때만 직접 바꿀 수 있습니다.
                </SheetDescription>
              </SheetHeader>
              <div className="mt-5 space-y-4">
                <div className="space-y-2">
                  <span id="mobile-chat-category-label" className="text-sm font-semibold">
                    분야
                  </span>
                  <Select value={category} onValueChange={setCategory}>
                    <SelectTrigger
                      className="h-12 w-full"
                      aria-labelledby="mobile-chat-category-label"
                    >
                      <SelectValue placeholder="자동" />
                    </SelectTrigger>
                    <SelectContent>
                      {["자동", ...(categories?.length ? categories : DEFAULT_CATEGORIES)].map(
                        (c) => (
                          <SelectItem key={c} value={c}>
                            {c}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>

                {models.length > 1 && (
                  <div className="space-y-2">
                    <span id="mobile-chat-model-label" className="text-sm font-semibold">
                      답변 유형
                    </span>
                    <Select value={model} onValueChange={setModel}>
                      <SelectTrigger
                        className="h-12 w-full"
                        aria-labelledby="mobile-chat-model-label"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {models.map((m) => (
                          <SelectItem key={m.key} value={m.key}>
                          {responseLabel(m.label)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      {/* 메시지 목록 */}
      <div
        ref={scrollRef}
        id="chat-messages"
        role="region"
        aria-label="대화 내용"
        aria-busy={isLoading}
        className="flex-1 overflow-y-auto"
      >
        <div className="mx-auto max-w-3xl px-3 py-4 sm:px-4">
          {empty ? (
            <div className="mx-auto max-w-2xl py-8 sm:py-12">
              <div className="flex flex-col gap-4 border-b border-slate-300 pb-6 sm:flex-row sm:items-start sm:justify-between dark:border-slate-700">
                <div>
                  <p className="flex items-center gap-2 text-[11px] font-bold text-primary">
                    <span className="h-0.5 w-7 bg-primary" aria-hidden /> 근거 검색 대기
                  </p>
                  <h2 className="mt-2 text-2xl font-extrabold">무엇을 도와드릴까요?</h2>
                  <p className="mt-2 text-base leading-6 text-muted-foreground sm:text-sm">
                    교육자료에 근거해 답하고, 출처는 답변 마지막에 모아 보여드립니다.
                    근거가 없으면 추측하지 않습니다.
                  </p>
                </div>
                <span className="flex min-h-10 shrink-0 items-center gap-2 self-start border border-slate-300 bg-white px-3 text-xs font-semibold text-emerald-700 dark:border-slate-700 dark:bg-slate-900 dark:text-emerald-400">
                  <ShieldCheck className="h-4 w-4" aria-hidden /> 출처 확인 모드
                </span>
              </div>
              <div className="mt-6 flex w-full flex-col gap-2">
                <p className="mb-1 text-left text-xs font-bold text-slate-700 dark:text-slate-200">
                  {examplesTitle}
                </p>
                {examples.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => askExample(q)}
                    className="group flex min-h-[52px] touch-manipulation items-center gap-3 border border-slate-300 bg-card px-4 text-left text-base font-medium transition-colors motion-reduce:transition-none hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-slate-700"
                  >
                    <span className="min-w-0 flex-1">{q}</span>
                    <ArrowRight
                      className="h-4 w-4 shrink-0 text-slate-400 transition-transform motion-reduce:transition-none motion-reduce:group-hover:translate-x-0 group-hover:translate-x-1 group-hover:text-primary"
                      aria-hidden
                    />
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
                    <Loader2
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden
                    />
                    자료를 찾고 있습니다…
                  </div>
                )}
            </div>
          )}
          {(error || unansweredSavedQuestion) && !isLoading && (
            <div className="mt-4 space-y-3 rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-950 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100">
              <p role="alert" className="flex items-start gap-2 leading-relaxed">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                {error ? chatErrorMessage(error) : "이 질문의 답변이 아직 저장되지 않았습니다. 잠시 후 대화를 다시 열거나 같은 질문을 재시도할 수 있습니다."}
              </p>
              {retrySeconds > 0 && !(error instanceof ChatRequestError) && (
                <p className="leading-relaxed">서버가 기존 답변을 저장 중일 수 있어 잠시 기다린 뒤 재시도합니다.</p>
              )}
              <div className="flex flex-wrap gap-2">
                {error instanceof ChatRequestError && (error.status === 401 || error.status === 403) ? (
                  <Button asChild variant="outline" className="min-h-12 bg-background">
                    <Link href="/login">로그인 확인</Link>
                  </Button>
                ) : (
                  <Button type="button" variant="outline" className="min-h-12 gap-2 bg-background" onClick={retryLastQuestion} disabled={retrySeconds > 0}>
                    <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    {retrySeconds > 0 ? `${retrySeconds}초 후 재시도` : "같은 질문 다시 시도"}
                  </Button>
                )}
                <Button type="button" variant="ghost" className="min-h-12" onClick={() => {
                  setInput(lastQuestion);
                  questionRef.current?.focus();
                }}>질문을 입력창에 가져오기</Button>
                {convIdRef.current && (
                  <Button type="button" variant="ghost" className="min-h-12" onClick={() => window.location.assign(`/chat/${convIdRef.current}`)}>
                    저장된 대화 확인
                  </Button>
                )}
              </div>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {assistantStatus}
      </p>

      {/* 입력창 (하단 고정) */}
      <div className="border-t-2 border-slate-300 bg-background px-3 py-3 sm:px-4 dark:border-slate-700">
        <form
          onSubmit={onSubmit}
          className="mx-auto flex max-w-3xl items-center gap-2"
          aria-label="AI 튜터에게 질문하기"
        >
          <label htmlFor="chat-question" className="sr-only">
            질문
          </label>
          <Input
            id="chat-question"
            ref={questionRef}
            value={input}
            onChange={handleInputChange}
            placeholder="질문을 입력하세요"
            className="h-12 flex-1 text-base"
            disabled={isLoading}
            autoComplete="off"
            enterKeyHint="send"
            aria-controls="chat-messages"
            aria-describedby="chat-safety-notice"
          />
          {isLoading ? (
            <Button
              type="button"
              variant="secondary"
              className="h-12 w-12 shrink-0 p-0"
              onClick={() => {
                stoppedRef.current = true;
                stop();
              }}
              aria-label="답변 생성 중지"
            >
              <Square className="h-5 w-5" aria-hidden />
            </Button>
          ) : (
            <Button
              type="submit"
              className="h-12 w-12 shrink-0 p-0"
              disabled={!input.trim() || retrySeconds > 0}
              aria-label="질문 전송"
            >
              <Send className="h-5 w-5" aria-hidden />
            </Button>
          )}
        </form>
        <p
          id="chat-safety-notice"
          className="mx-auto mt-2 max-w-3xl text-center text-base leading-5 text-muted-foreground sm:text-sm"
        >
          AI 답변은 참고용입니다. 긴급 상황은 현장 지휘관·119 의료지도를
          따르세요.
        </p>
      </div>
    </div>
  );
}
