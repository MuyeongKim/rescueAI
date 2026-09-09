import { createUIMessageStream, createUIMessageStreamResponse, type UIMessageStreamWriter } from "ai";
import type { TutorUIMessage } from "@/lib/chat-message";
import { safeServerError } from "@/lib/safe-server-error";

export type TutorStreamWriter = UIMessageStreamWriter<TutorUIMessage>;

/** 직접 안내와 모델 답변에 같은 SDK 5 메시지·오류·완료 계약을 적용한다. */
export function createChatStreamResponse(execute: (writer: TutorStreamWriter) => Promise<void>): Response {
  return createUIMessageStreamResponse({ stream: createUIMessageStream<TutorUIMessage>({
    execute: async ({ writer }) => {
      writer.write({ type: "start" });
      // execute는 HTTP 연결의 취소 신호를 모델에 전달하지 않는다. 서버 마감 시간 내
      // 답변 저장을 완료한 뒤 종료하므로 Stop/탭 닫기 이후에도 질문 복구를 유지한다.
      await execute(writer);
      writer.write({ type: "finish" });
    },
    onError: (error) => {
      console.error("[chat] stream error:", safeServerError(error));
      return "답변 생성 중 연결이 끊겼습니다. 잠시 후 같은 질문을 다시 시도해 주세요.";
    },
  }) });
}

export function writeChatText(writer: TutorStreamWriter, text: string): void {
  const id = crypto.randomUUID();
  writer.write({ type: "text-start", id });
  writer.write({ type: "text-delta", id, delta: text });
  writer.write({ type: "text-end", id });
}
