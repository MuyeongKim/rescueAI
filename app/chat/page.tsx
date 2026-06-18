import { ChatInterface } from "@/components/chat/ChatInterface";
import { listChatCategories } from "@/lib/categories-server";
import { availableModels } from "@/lib/llm";

export const dynamic = "force-dynamic";

// 새 대화 화면. 미인증 사용자는 middleware가 /login 으로 보낸다.
// ?q=… 로 진입하면 입력창에 질문을 프리필한다.
export default async function ChatPage({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  const categories = await listChatCategories();
  return (
    <ChatInterface
      initialInput={searchParams?.q?.slice(0, 200)}
      categories={categories}
      models={availableModels()}
    />
  );
}
