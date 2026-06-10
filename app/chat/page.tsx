import { ChatInterface } from "@/components/chat/ChatInterface";

// 새 대화 화면. 미인증 사용자는 middleware가 /login 으로 보낸다.
export default function ChatPage() {
  return <ChatInterface />;
}
