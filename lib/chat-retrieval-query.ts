// 대화 원문은 바꾸지 않고 검색문만 복원한다. 서비스 문의·불만은 실질 주제를 덮지 않는다.
import {
  continuesLearningTopic,
  isChatContextFollowUp,
  latestLearningTopic,
  normalizeChatQuestion,
  type ChatTurnMessage,
} from "@/lib/chat-turn";

const MAX_RETRIEVAL_QUERY_CHARS = 600;

/** 기존 호출·테스트와의 호환을 유지한다. */
export function isContextDependentQuestion(question: string): boolean {
  return isChatContextFollowUp(question);
}

export function buildRetrievalQuestion(messages: readonly ChatTurnMessage[]): string {
  let currentIndex = messages.length - 1;
  while (currentIndex >= 0 && messages[currentIndex]?.role !== "user") currentIndex -= 1;
  const current = normalizeChatQuestion(messages[currentIndex]?.content);
  const previousTopic = latestLearningTopic(messages.slice(0, currentIndex));
  if (!current || !continuesLearningTopic(current, previousTopic)) return current;
  const topic = latestLearningTopic(messages);
  if (!topic) return current;
  const followUp = `\n후속 질문: ${current.slice(0, 200)}`;
  return `${topic.slice(0, MAX_RETRIEVAL_QUERY_CHARS - followUp.length)}${followUp}`;
}
