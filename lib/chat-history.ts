// 챗봇에 보낼 대화 히스토리 정리 — 순수 함수(서버 전용 의존 없음, 테스트 가능).
//
// 클라이언트가 보내는 messages 는 신뢰할 수 없다:
//  · 상한이 없으면 인증만 통과한 스크립트가 수 MB 히스토리를 그대로 LLM 으로 밀어넣는다
//    (레이트리밋 30회/분만으로는 비용 방어가 안 된다).
//  · system/tool 역할을 끼워 서버 가드레일(lib/rag.ts buildSystemPrompt)을 덮어쓰려 할 수 있다.
//  · 위조한 assistant 답변을 잔뜩 넣어 "이전에 이렇게 답했다"고 모델을 끌고 갈 수 있다.
// 역할을 user/assistant 로 제한하고, 최근 것부터 개수·길이 상한 안에서만 남긴다.

/** 모델에 전달할 최근 메시지 개수(약 10턴) */
export const MAX_HISTORY_MESSAGES = 20;
/** 메시지 1개 길이 상한(자) */
export const MAX_MESSAGE_CHARS = 8_000;
/** 히스토리 합계 길이 상한(자) — 최신 것부터 채운다 */
export const MAX_TOTAL_CHARS = 24_000;

type ChatRole = string;
type WithRoleAndContent = { role: ChatRole; content?: unknown };

export function trimChatHistory<T extends WithRoleAndContent>(messages: unknown): T[] {
  const list = Array.isArray(messages) ? (messages as T[]) : [];

  // 서버가 단독으로 넣는 system 프롬프트를 클라이언트가 덮어쓰지 못하게 역할을 제한한다.
  const conversational = list.filter(
    (m) => m && (m.role === "user" || m.role === "assistant")
  );

  const recent = conversational.slice(-MAX_HISTORY_MESSAGES);
  const kept: T[] = [];
  let total = 0;

  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const content = String(m.content ?? "").slice(0, MAX_MESSAGE_CHARS);
    if (!content) continue;
    // 최신 메시지 하나는 총량을 넘겨도 반드시 남긴다 — 질문 자체가 사라지면 안 된다.
    if (total + content.length > MAX_TOTAL_CHARS && kept.length > 0) break;
    total += content.length;
    kept.unshift({ ...m, content });
  }

  return kept;
}
