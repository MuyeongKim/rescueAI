import { ChatInterface } from "@/components/chat/ChatInterface";

export const dynamic = "force-dynamic";

// 새 대화 화면. 미인증 사용자는 middleware가 /login 으로 보낸다.
// ?q=… 로 진입하면 입력창에 질문을 프리필한다 (SOP 카드 등에서 사용).
export default function ChatPage({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  return <ChatInterface initialInput={searchParams?.q?.slice(0, 200)} />;
}
