// 짧은 후속 질문을 검색할 때만 이전의 기준 주제를 복원한다.
// 모델에 전달하는 대화 원문은 바꾸지 않고 RAG 검색문만 보강하므로, 사용자가
// "각 세부 사항은?", "준비물은?"처럼 자연스럽게 이어 물어도 주제가 사라지지 않는다.

type RetrievalMessage = { role: string; content?: unknown };

const MAX_RETRIEVAL_QUERY_CHARS = 600;

const FOLLOW_UP_WORDS = new Set([
  "각",
  "각각",
  "그",
  "그거",
  "그것",
  "그럼",
  "그리고",
  "관련",
  "구체적",
  "기준",
  "내용",
  "더",
  "방법",
  "방금",
  "사항",
  "상세",
  "세부",
  "실격",
  "앞",
  "알려줘",
  "어떻게",
  "위",
  "이거",
  "이것",
  "자세히",
  "절차",
  "정보",
  "준비물",
  "평가",
  "항목",
  "감점",
]);

function normalizeToken(token: string): string {
  return token
    .replace(/[^0-9a-z가-힣]/gi, "")
    .replace(/(?:으로|에서|에게|부터|까지|처럼|하고|이며|이고|과|와|을|를|은|는|이|가|의|도|만)$/u, "");
}

export function isContextDependentQuestion(question: string): boolean {
  const normalized = question.replace(/\s+/g, " ").trim();
  if (!normalized) return false;

  const tokens = normalized
    .split(/[\s,.()[\]{}:;!?~·…/\\—-]+/)
    .map(normalizeToken)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 8) return false;

  // 숫자 등급만으로는 기준 주제가 되지 않는다. 반대로 "인명구조사", "화학보호복"처럼
  // 목록에 없는 구체 명사가 하나라도 있으면 새 독립 질문으로 취급한다.
  return tokens.every(
    (token) => FOLLOW_UP_WORDS.has(token) || /^\d+급$/.test(token)
  );
}

export function buildRetrievalQuestion(messages: readonly RetrievalMessage[]): string {
  const userMessages = messages
    .filter((message) => message?.role === "user")
    .map((message) => String(message.content ?? "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const current = userMessages.at(-1) ?? "";
  if (!current || !isContextDependentQuestion(current)) return current;

  const baseTopic = userMessages
    .slice(0, -1)
    .reverse()
    .find((question) => !isContextDependentQuestion(question));
  if (!baseTopic) return current;

  return `${baseTopic}\n후속 질문: ${current}`.slice(0, MAX_RETRIEVAL_QUERY_CHARS);
}
