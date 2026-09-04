/** HTTP 실패 내용을 그대로 노출하지 않고 사용자가 취할 행동으로 변환한다. */
export class ChatRequestError extends Error {
  constructor(message: string, readonly status: number, readonly retryAfterSeconds = 0) {
    super(message);
    this.name = "ChatRequestError";
  }
}

export async function fetchChat(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (response.ok) return response;
  const retryAfter = Number(response.headers.get("retry-after"));
  const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 0;
  const message = response.status === 429
    ? `질문 요청이 잠시 몰렸습니다.${seconds ? ` ${seconds}초 후` : " 잠시 후"} 같은 질문을 다시 시도해 주세요.`
    : response.status === 401 || response.status === 403
      ? "로그인 상태를 확인해 주세요. 질문은 이 화면에 남아 있습니다."
      : response.status === 400
        ? "질문 내용을 확인해 주세요. 질문을 수정한 뒤 다시 보낼 수 있습니다."
        : response.status === 409
          ? "이 질문의 요청 정보가 달라졌습니다. 대화를 다시 열어 확인해 주세요."
          : "답변을 가져오지 못했습니다. 잠시 후 같은 질문을 다시 시도해 주세요.";
  throw new ChatRequestError(message, response.status, seconds);
}

export function chatErrorMessage(error: Error): string {
  return error instanceof ChatRequestError
    ? error.message
    : "답변 연결이 끊겼습니다. 질문은 남아 있으며, 일부 답변은 완성되지 않았을 수 있습니다. 연결을 확인한 뒤 다시 시도해 주세요.";
}
