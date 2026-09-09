import { DefaultChatTransport } from "ai";
import { fetchChat } from "@/lib/chat-request";
import { fromTutorUIMessage, type TutorUIMessage } from "@/lib/chat-message";

export function createTutorChatTransport() {
  return new DefaultChatTransport<TutorUIMessage>({
    api: "/api/chat", fetch: fetchChat,
    prepareSendMessagesRequest: ({ messages, body }) => ({ body: {
      ...body,
      // SDK가 보관하는 parts/metadata/첨부·도구 정보를 서버의 모델 입력으로 넘기지 않는다.
      messages: messages.map((message) => {
        const { role, content } = fromTutorUIMessage(message);
        return { role, content };
      }),
    } }),
  });
}
