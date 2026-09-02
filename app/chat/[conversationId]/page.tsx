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

  const { data: msgs } = await supabase
    .from("messages")
    .select("id, role, content, sources, feedback")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  const initialMessages: Message[] = (msgs ?? []).map((m) => ({
    id: String(m.id),
    role: m.role as Message["role"],
    content: m.content,
    ...(m.role === "assistant"
      ? {
          annotations: [
            {
              messageId: m.id,
              sources: m.sources ?? [],
              feedback: m.feedback ?? null,
            },
          ],
        }
      : {}),
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
