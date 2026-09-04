import { notFound } from "next/navigation";
import type { Message } from "ai";
import { createClient } from "@/lib/supabase/server";
import {
  DEMO,
  demoConversations,
  demoChatAnswer,
  demoChatSources,
} from "@/lib/demo";
import { ChatInterface } from "@/components/chat/ChatInterface";
import { listChatCategories } from "@/lib/categories-server";
import { availableModels } from "@/lib/llm";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;

  if (DEMO) {
    const conv = demoConversations.find((c) => c.id === conversationId);
    if (!conv) notFound();
    const initialMessages: Message[] = [
      { id: `${conversationId}-q`, role: "user", content: conv.title },
      {
        id: `${conversationId}-a`,
        role: "assistant",
        content: demoChatAnswer,
        annotations: [
          { messageId: 0, sources: demoChatSources, feedback: null },
        ],
      },
    ];
    return (
      <ChatInterface
        conversationId={conversationId}
        initialMessages={initialMessages}
      />
    );
  }

  const supabase = await createClient();

  // RLS로 본인 대화만 보임 — 없으면 404
  const { data: conv } = await supabase
    .from("conversations")
    .select("id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conv) notFound();

  const { data: msgs, error: messagesError } = await supabase
    .from("messages")
    .select("id, role, content, sources, feedback, retrieval_degraded, client_request_id, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (messagesError) {
    console.error("[chat] 대화 기록 조회 실패:", messagesError.message);
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <h1 className="text-xl font-bold">대화 기록을 불러오지 못했습니다</h1>
        <p role="alert" className="text-base leading-relaxed text-muted-foreground">저장된 내용이 없는 상태와 구분해 안내합니다. 잠시 후 다시 열어 주세요.</p>
        <a href={`/chat/${conversationId}`} className="inline-flex min-h-12 items-center rounded-md border bg-background px-4 font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">대화 다시 불러오기</a>
      </div>
    );
  }

  const initialMessages: Message[] = (msgs ?? []).map((m) => ({
    id: String(m.id),
    role: m.role as Message["role"],
    content: m.content,
    createdAt: new Date(m.created_at),
    ...(m.role === "assistant"
      ? {
          annotations: [
            {
              messageId: m.id,
              sources: m.sources ?? [],
              feedback: m.feedback ?? null,
              degraded: m.retrieval_degraded,
            },
          ],
        }
      : { annotations: [{ clientRequestId: m.client_request_id }] }),
  }));

  const categories = await listChatCategories();

  return (
    <ChatInterface
      conversationId={conversationId}
      initialMessages={initialMessages}
      categories={categories}
      models={availableModels()}
    />
  );
}
