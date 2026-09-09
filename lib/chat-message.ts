import type { UIMessage } from "ai";
import type { DocSource } from "@/lib/database.types";

/** DB와 화면의 기존 텍스트/출처 계약. SDK 전송 형식과 분리해 저장된 대화도 유지한다. */
export type ChatAnnotation = {
  messageId?: number | null;
  conversationId?: string;
  sources?: DocSource[];
  feedback?: number | null;
  degraded?: boolean;
  saveFailed?: boolean;
  clientRequestId?: string | null;
};
export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: Date;
  annotations?: ChatAnnotation[];
};
export type TutorUIMessage = UIMessage<ChatAnnotation & { createdAt?: string }, {
  conversationId: { value: string };
}>;

export function toTutorUIMessage(message: ChatMessage): TutorUIMessage {
  return {
    id: message.id, role: message.role, parts: [{ type: "text", text: message.content }],
    metadata: { ...Object.assign({}, ...message.annotations ?? []),
      ...(message.createdAt ? { createdAt: message.createdAt.toISOString() } : {}),
    },
  };
}

export function fromTutorUIMessage(message: TutorUIMessage): ChatMessage {
  return {
    id: message.id, role: message.role,
    content: message.parts.filter((part) => part.type === "text").map((part) => part.text).join(""),
    ...(message.metadata ? { annotations: [message.metadata],
      ...(message.metadata.createdAt ? { createdAt: new Date(message.metadata.createdAt) } : {}),
    } : {}),
  };
}
