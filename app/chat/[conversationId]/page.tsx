import { notFound } from "next/navigation";
import type { Message } from "ai";
import { createClient } from "@/lib/supabase/server";
import { ChatInterface } from "@/components/chat/ChatInterface";

export const dynamic = "force-dynamic";

export default async function ConversationPage({
  params,
}: {
  params: { conversationId: string };
}) {
  const conversationId = params.conversationId;
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

  return (
    <ChatInterface
      conversationId={conversationId}
      initialMessages={initialMessages}
    />
  );
}
