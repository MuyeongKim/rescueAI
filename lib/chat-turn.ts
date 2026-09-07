// 질문 목적을 구분하는 순수 fallback. 모르는 표현은 자료 확인 경로로 보낸다.
// 직접 응답은 고정 안내뿐이며, 자유 생성 모델이나 검색 가드의 우회로가 아니다.
export type ChatTurnKind = "service" | "feedback" | "social" | "learning" | "grounded";
export type ChatTurnMessage = { role: string; content?: unknown };

const SUBJECT = /인명\s*구조사|구조\s*기술\s*평가|기본\s*(?:역량|능력)\s*평가|공통\s*기술\s*평가|전문\s*기술\s*평가|구조\s*훈련|실기\s*평가|자격\s*(?:시험|평가)|로프|매듭|공기\s*호흡기|화학\s*보호복|방화복|구명조끼|구조정|소방\s*드론|드론|소방\s*헬기|사다리|삼각대|들것|도르래|카라비너|확보물|산악|수난|화재|구급|일반\s*구조|교통\s*사고|붕괴|밀폐\s*공간|맨홀|잠수|급류|암모니아|염소|황화수소|유해\s*물질|위험물|화학\s*물질|심폐\s*소생|CPR|AED|SCBA|SOP/i;
const EVALUATION_SUBTOPIC = /(?:구조\s*기술|기본\s*(?:역량|능력)|공통\s*기술|전문\s*기술)\s*평가/g;
// 교육이라는 단어가 붙어도 조작·수치·급박 상황의 근거 경계는 유지한다.
const OPERATIONAL = /긴급|응급|출동\s*중|구조\s*중|구조\s*(?:대상자|대상|작업|현장)|요구조자|환자|관통|추락|매달|감전|출혈|의식|호흡\s*없|경보|잔압|압력|기압|하중|장력|하강|인양|결속|절단|분리|밀착|기밀|누설|누출|차단|진입|철수|중단\s*기준|감압|체결|해제|작동\s*(?:법|방법|방식|절차)|운용\s*(?:법|방법|절차)|착용\s*(?:법|방법|절차|순서)|사용\s*(?:법|방법|절차)|조작\s*(?:법|방법|절차)|수행\s*(?:방법|절차)|\d+(?:\.\d+)?\s*(?:bar|m?pa|kpa|psi|kn|kg|kgf|뉴턴|킬로그램|기압|바|볼트|암페어|℃|°c)(?:\b|(?=[가-힣]))/i;
const SENSITIVE_OR_BYPASS = /비밀번호|주민\s*등록|주민번호|개인정보|API\s*키|api[_ -]?key|시스템\s*(?:프롬프트|지침)|system\s*prompt|다른\s*(?:사람|사용자|계정).{0,20}(?:정보|대화|자료)|(?:규칙|지침|제한|안전장치|근거\s*확인).{0,15}(?:무시|해제|우회|풀어|생략)/i;
const LEARNING_INTENT = /(?:어느\s*(?:것|걸|부분|항목)?|어떤\s*(?:것|걸|부분|항목)?|무엇|뭐|뭘|어디).{0,12}부터|(?:공부|학습|연습|준비|익힐|배울|배우는)\s*(?:순서|우선순위|방향|계획|요령)|(?:가장|제일|먼저|우선).{0,22}(?:중요|알아야|배워|배울|익혀|익힐|준비|연습|공부|알면)|(?:기본|기초|핵심).{0,15}(?:익히|익혀|배우|배워|알아야|정리|알려)|(?:학습|공부|교육|훈련).{0,20}(?:추천|조언|계획|준비)|초보.{0,15}(?:시작|준비|공부|배워)/;
const SERVICE_INTENT = /(?:너|넌|당신|AI|튜터|플랫폼|서비스|챗봇).{0,30}(?:무엇|뭐|어떤|어떻게|무슨).{0,20}(?:할\s*수|도와|기능|사용|이용|답변)|(?:너|넌|당신|AI|튜터|플랫폼|서비스|챗봇).{0,35}(?:역할|기능|사용법|이용법|한계)|(?:RAG|임베딩|검색|매뉴얼|자료).{0,30}(?:만|기반|근거).{0,30}(?:답|설명|말)|(?:답변|답|설명).{0,25}(?:어디서|어떤\s*자료|무슨\s*자료|어떻게\s*찾)|(?:근거|출처).{0,20}(?:어떻게|어디서).{0,12}(?:보|확인)|^(?:여기|이\s*(?:플랫폼|서비스|사이트|튜터)|구조\s*AI).{0,20}(?:사용|이용|무엇|뭐|어떤\s*기능)/i;
const FEEDBACK_INTENT = /(?:생각|이해|판단)(?:이|을|도|은)?\s*(?:없|못|안\s*하)|(?:너|넌|당신).{0,15}(?:생각|의견).{0,15}(?:없|못)|(?:답변|대답|답|설명|질문).{0,25}(?:못하|못하는|못\s*하|안\s*하|반복|똑같|틀렸|틀린|도움.{0,5}안|답답|실망|이해.{0,8}못)|(?:같은|똑같은).{0,10}(?:답|말).{0,15}(?:반복|계속)|^\s*(?:답답하|도움이\s*안\s*되|이해를\s*못하)/;
const SOCIAL_ONLY = /^(?:안녕(?:하세요|하십니까)?|반가워(?:요)?|좋은\s*(?:아침|하루)(?:입니다|이에요)?|고마워(?:요)?|감사(?:합니다|해요)|수고(?:했어|하셨습니다|하세요)|잘\s*알겠(?:어|어요|습니다)|알겠(?:어|어요|습니다)|좋아(?:요)?|네|응)[.!?~\s]*$/;

export function normalizeChatQuestion(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

export function hasExplicitChatSubject(question: string): boolean {
  return SUBJECT.test(normalizeChatQuestion(question));
}

function directIntent(text: string): ChatTurnKind | null {
  if (SERVICE_INTENT.test(text)) return "service";
  if (FEEDBACK_INTENT.test(text)) return "feedback";
  if (SOCIAL_ONLY.test(text)) return "social";
  return null;
}

export function classifyChatTurn(question: string): ChatTurnKind {
  const text = normalizeChatQuestion(question);
  if (!text || SENSITIVE_OR_BYPASS.test(text)) return "grounded";
  // 플랫폼 자체의 사용 문의는 장비 사용 요청과 구분한다.
  const platformUseOnly = /^(?:구조\s*AI|AI\s*튜터|이\s*(?:플랫폼|서비스|사이트))\s*(?:의\s*)?(?:사용법|이용법)(?:을|이|은)?\s*(?:알려줘|알려주세요|뭐야|어떻게\s*되나요)?[.!?]*$/i.test(text);
  if (platformUseOnly) return "service";
  if (OPERATIONAL.test(text)) return "grounded";
  // 섞인 요청에서는 기술 주제가 먼저다. 기능 문의를 붙여도 자료 조회를 건너뛰지 않는다.
  if (SUBJECT.test(text)) return LEARNING_INTENT.test(text) ? "learning" : "grounded";
  if (LEARNING_INTENT.test(text)) return "learning";
  const kind = directIntent(text);
  if (!kind) return "grounded";
  const clauses = text.replace(/((?:답|답변|설명)(?:하니|하냐|하나요|하는구나))\s+(?=\S)/g, "$1?").split(/[.!?。！？;；]+|\s+(?:그런데|그리고|그럼|또|그러면)\s+/).map((part) => part.trim()).filter(Boolean);
  // 메타 문의와 생소한 새 요청이 섞이면 고정 안내로 전체 질문을 삼키지 않는다.
  if (clauses.some((clause) => !directIntent(clause))) return "grounded";
  return kind;
}

const FOLLOW_UP_WORDS = new Set([
  "각", "각각", "그", "그거", "그것", "그럼", "그리고", "관련", "구체적", "기준", "내용",
  "더", "방법", "방금", "사항", "상세", "세부", "실격", "앞", "알려줘", "어떻게", "위",
  "이거", "이것", "자세히", "절차", "정보", "준비물", "평가", "항목", "감점", "주의사항",
  "유의사항", "안전", "안전수칙", "위험", "중단", "철수", "보고", "다시", "쉽게", "간단히",
  "간단하게", "짧게", "천천히", "설명", "설명해줘", "설명해주세요", "알려주세요", "말해줘",
  "요약", "요약해줘", "정리", "정리해줘", "표로", "예시", "예를", "들어줘", "차이", "차이점",
  "비교", "비교해줘",
]);

function normalizedToken(token: string): string {
  return token.replace(/[^0-9a-z가-힣]/gi, "")
    .replace(/(?:으로|에서|에게|부터|까지|처럼|하고|이며|이고|과|와|을|를|은|는|이|가|의|도|만)$/u, "");
}

/** 확실한 지시어·요청 형태만 이어 붙인다. 생소한 새 명사는 원문 그대로 검색한다. */
export function isChatContextFollowUp(question: string): boolean {
  const text = normalizeChatQuestion(question);
  if (!text || text.length > 220 || SUBJECT.test(text) || SENSITIVE_OR_BYPASS.test(text)) return false;
  const kind = classifyChatTurn(text);
  if (kind === "service" || kind === "feedback" || kind === "social") return false;
  const tokens = text.split(/[\s,.()[\]{}:;!?~·…/\\—-]+/).map(normalizedToken).filter(Boolean);
  if (tokens.length > 0 && tokens.length <= 8 && tokens.every((token) => FOLLOW_UP_WORDS.has(token) || /^\d+급$/.test(token))) return true;
  if (/다른\s*주제|주제(?:를)?\s*바꿔|이번에는|이번엔|별개로/.test(text)) return false;
  // 동사의 활용이 달라도 앞 답변을 가리키는 요청임을 읽는다. 명시적 새 대상은 우선한다.
  if (/(?:그게|그걸|그건|그거|그것|그중|그\s*중|그렇게|이걸|이것|이\s*내용|해당\s*(?:내용|항목|부분)|방금\s*(?:말|설명|알려)|앞서\s*(?:말|설명|알려)|위에서\s*(?:말|설명|알려))/.test(text)) return true;
  // 대상이 생략된 학습 순서 질문만 앞 주제에 잇는다. 새 명사로 시작하는 질문은
  // 삼키지 않으며 더 정밀한 해석은 서버 질의 계획에서 수행한다.
  return kind === "learning" && /^(?:(?:그럼|그러면|그렇다면)\s*)?(?:너라면|처음|먼저|우선|무엇|뭐|뭘|어느|어떤|어디|제일|가장)/.test(text);
}

function updatedGrade(topic: string, question: string): string {
  const grades = [...new Set(question.match(/[1-9]급/g) ?? [])];
  if (grades.length !== 1) return topic;
  return /[1-9]급/.test(topic) ? topic.replace(/[1-9]급/g, grades[0]) : `${topic} ${grades[0]}`;
}

function qualificationSubtopic(question: string, topic: string): string | null {
  if (!/인명\s*구조사/.test(topic) || /다른\s*주제|주제(?:를)?\s*바꿔|별개로/.test(question)) return null;
  const subtopics = [...new Set(question.match(EVALUATION_SUBTOPIC) ?? [])];
  if (subtopics.length !== 1 || SUBJECT.test(question.replace(EVALUATION_SUBTOPIC, ""))) return null;
  return subtopics[0];
}

/** 부분 평가명을 앞 자격 질문과 연결하되 새로운 장비·기술명은 섞지 않는다. */
export function continuesLearningTopic(question: string, topic: string): boolean {
  return isChatContextFollowUp(question) || qualificationSubtopic(question, topic) !== null;
}

/** assistant 답변은 사실 근거로 쓰지 않고 사용자가 말한 최근 실질 주제만 복원한다. */
export function latestLearningTopic(messages: readonly ChatTurnMessage[]): string {
  let topic = "";
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const question = normalizeChatQuestion(message.content);
    if (!question || SENSITIVE_OR_BYPASS.test(question)) continue;
    const kind = classifyChatTurn(question);
    if (kind === "service" || kind === "feedback" || kind === "social") continue;
    if (continuesLearningTopic(question, topic)) {
      if (topic) {
        const subtopic = qualificationSubtopic(question, topic);
        if (subtopic) {
          // 이전 평가명이 남아 새 부분 평가의 검색을 흐리지 않게 자격·등급을 복원한다.
          const qualification = topic.match(/인명\s*구조사/)![0];
          const grades = [...new Set(topic.match(/[1-9]급/g) ?? [])];
          topic = [qualification, grades.join("·"), subtopic].filter(Boolean).join(" ");
        }
        topic = updatedGrade(topic, question);
      }
      continue;
    }
    // 해당 새 턴 자체에는 이전 주제를 붙이지 않되, 잡담이 교육 주제를 대신하지 않게 한다.
    if (/점심|저녁\s*메뉴|맛집|주식|코인|운세|오늘\s*날씨/.test(question) && !SUBJECT.test(question)) continue;
    topic = question;
  }
  return topic;
}

function topicContinuation(messages: readonly ChatTurnMessage[]): string {
  const topic = latestLearningTopic(messages);
  if (!topic) return " 궁금한 교육 주제나 준비 중인 평가를 알려주시면 그에 맞춰 도와드리겠습니다.";
  // 사용자 입력을 Markdown 명령이나 원문 인용처럼 표시하지 않는다.
  const label = topic.replace(/[<>\[\]`*_#\\]/g, "").slice(0, 90).replace(/[.!?]+$/, "");
  return ` 앞서 질문하신 ‘${label}’에 이어서 질문하셔도 됩니다.`;
}

export function buildDirectChatReply(kind: ChatTurnKind, messages: readonly ChatTurnMessage[]): string | null {
  if (kind !== "service" && kind !== "feedback" && kind !== "social") return null;
  const current = normalizeChatQuestion([...messages].reverse().find((message) => message?.role === "user")?.content);
  if (classifyChatTurn(current) !== kind) return null;
  if (kind === "service") return "등록된 교육자료를 찾아 설명하고, 그 근거를 바탕으로 비교하거나 학습 순서를 제안할 수 있습니다. 자료에서 확인한 내용과 학습을 위한 제안은 구분합니다. 자료에 없는 장비 수치나 구조 절차를 만들어 답하지는 않습니다." + topicContinuation(messages);
  if (kind === "feedback" && /파생|후속|이어/.test(current)) return "이어지는 질문도 앞의 주제를 바탕으로 답할 수 있습니다. 확인된 내용을 비교하거나 쉽게 풀어 설명하고, 학습 순서도 제안합니다. 질문에 필요한 내용이 부족하면 어떤 부분을 더 확인해야 하는지 말씀드리겠습니다." + topicContinuation(messages);
  if (kind === "feedback") return "원하신 방식으로 이어 답하지 못했습니다. 자료의 문장을 그대로 찾는 것뿐 아니라, 확인된 내용을 비교하고 쉽게 풀어 설명하거나 학습 순서를 제안할 수 있습니다. 다만 실제 구조 절차와 수치는 자료 확인이 필요합니다." + topicContinuation(messages);
  return /고마|감사|수고/.test(current)
    ? "필요한 내용이 더 있으면 이어서 질문해 주세요. 다른 교육 주제를 물어보셔도 됩니다."
    : "안녕하세요. 구조·훈련에 관해 궁금한 내용이나 준비 중인 교육 주제를 알려주세요.";
}
