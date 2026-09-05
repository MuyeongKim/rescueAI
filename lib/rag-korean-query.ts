/**
 * 실제 검색 누락 질문과 적재 매뉴얼의 용어를 연결하는 작은 검색 사전.
 * 원문을 다시 쓰거나 상황의 사실성·근거 적용 가능성을 판정하지 않는다.
 * 원문에서 직접 찾은 단서만 반환하며, 모델 확장어는 입력받지 않는다.
 */
export type KoreanSearchTermMatch = {
  id: string;
  canonicalTerm: string;
  /** 원문에 존재하는 검색 단서. 답변의 근거 인용으로 사용하지 않는다. */
  sourceText: string;
};

export type KoreanSearchExpansion = {
  keywords: string[];
  matches: KoreanSearchTermMatch[];
  explicitFacetIds: Array<"situation-impalement" | "situation-suspension">;
};

export const MAX_KOREAN_SEARCH_KEYWORDS = 8;

const PERSON = "(?:구조\\s*대상자|요구조자|대상자|환자|사람|구조대원|대원)";
const BODY = "(?:몸통|신체|흉부|복부|가슴|옆구리|(?:몸|배|팔|다리|목)(?=[이가은는을를에]))";
const INJURY = "(?:관통(?:상(?!황)|당|되어|된|한|되)?(?!상황)|꿰뚫(?:려|린|렸|어)?|꿰여|꿰였|꿰인|꿰어진|박힌|박혀|박혔)";
const PASSIVE_INJURY = "(?:관통당|관통되어|관통된|꿰뚫려|꿰뚫린|꿰여|꿰인|꿰어진)";
const SUSPENSION = "(?:매달려\\s*있는|매달려|매달린|매달렸|(?:공중|허공)에?\\s*(?:떠|뜬)\\s*(?:있는|있고|있어)?)";
// 사람을 언급한 문장에서 주변 물체만 매달린 것을 인명 상황으로 바꾸지 않는다.
const HUMAN_GAP = "(?:(?!벌집|드론|풍선|물건|장비가|장비는|장비를|철물이|철물은|로프가|로프는|접근로|벽을|구조물을)[^.!?;\\n,])";
const NOT_HANGING_OBJECT = "(?!\\s*(?:있는\\s*|있던\\s*|상태인\\s*)?(?:벌집|드론|풍선|물건|장비|로프가|로프는))";

const IMPALEMENT_PATTERNS = [
  /(관통상)(?!황)/u,
  new RegExp(`${BODY}${HUMAN_GAP}{0,32}(${INJURY})`, "u"),
  new RegExp(`(${PASSIVE_INJURY})\\s*(?:있는\\s*)?${BODY}`, "u"),
  new RegExp(`${PERSON}(?:가|는|이|은|를)${HUMAN_GAP}{0,28}(${PASSIVE_INJURY})`, "u"),
  new RegExp(`(${PASSIVE_INJURY})\\s*(?:있는\\s*|상태인\\s*)?${PERSON}`, "u"),
];
const SUSPENSION_PATTERNS = [
  new RegExp(`(${SUSPENSION})\\s*(?:상태인\\s*|채인\\s*)?${PERSON}`, "u"),
  new RegExp(`${PERSON}(?:가|는|이|은|를|인데|의)${HUMAN_GAP}{0,100}(${SUSPENSION})${NOT_HANGING_OBJECT}`, "u"),
];

function hasImmediateNegation(text: string, eventStart: number, eventEnd: number): boolean {
  if (/(?:^|[\s,(])(?:안|못)\s*$/u.test(text.slice(Math.max(0, eventStart - 8), eventStart))) {
    return true;
  }
  const tail = text.slice(eventEnd, eventEnd + 32);
  if (/^(?:\s*(?:과|와|및)\s*(?:관통상|매달림|매달린\s*상황))?\s*(?:은|는|을|를)?\s*제외/u.test(tail)) return true;
  // '매달려 의식이 없는'의 의식 부재까지 부정으로 보지 않도록 연결 표현만 허용한다.
  return /^(?:\s*(?:상태|상황|경우|것|게|건|채|있지|있는|있|되어|되지|된|되|하지|입지|지|이|가|은|는|을|를|도|고|였|었))*\s*(?:않|없|아니|아닌|아닐|아님|못|제외)/u
    .test(tail);
}

function positiveMatch(text: string, patterns: readonly RegExp[]): string | undefined {
  for (const pattern of patterns) {
    for (const match of text.matchAll(new RegExp(pattern.source, pattern.ignoreCase ? "giu" : "gu"))) {
      const event = match[1] ?? match[0];
      const eventStart = match.index + match[0].lastIndexOf(event);
      if (hasImmediateNegation(text, eventStart, eventStart + event.length)) continue;
      // '매달려 있는 사람이 없다'처럼 뒤따르는 주체까지 부정된 경우도 제외한다.
      const matchEnd = match.index + match[0].length;
      if (matchEnd > eventStart + event.length && hasImmediateNegation(text, matchEnd, matchEnd)) continue;
      return match[0];
    }
  }
  return undefined;
}

/** 고정된 소수 별칭만 추가한다. 원문·부정·조건문은 호출자가 그대로 유지해야 한다. */
export function expandKoreanSearchTerms(query: string): KoreanSearchExpansion {
  const text = query.slice(0, 4_000);
  const matches: KoreanSearchTermMatch[] = [];
  const explicitFacetIds: KoreanSearchExpansion["explicitFacetIds"] = [];
  const add = (id: string, canonicalTerm: string, sourceText: string | undefined) => {
    if (sourceText) matches.push({ id, canonicalTerm, sourceText });
  };

  const impalement = positiveMatch(text, IMPALEMENT_PATTERNS);
  if (impalement) {
    add("situation-impalement", "관통상", impalement);
    explicitFacetIds.push("situation-impalement");
  }

  let suspension = positiveMatch(text, SUSPENSION_PATTERNS);
  if (!suspension && impalement) {
    // 실제 누락 질문: '나뭇가지에 몸이 꿰뚫려 땅에 발이 닿지 않는 구조대상자'.
    // 단순히 발이 안 닿는 수영·사다리 상황을 매달림으로 확대하지 않는다.
    const clauses = text.split(/[.!?;\n,]/u);
    suspension = clauses.find((clause) =>
      positiveMatch(clause, IMPALEMENT_PATTERNS) &&
      /나뭇가지|철근|철봉/u.test(clause) &&
      new RegExp(PERSON, "u").test(clause) &&
      /(?:(?:땅|지면|바닥)에?\s*(?:두\s*)?발이?|(?:두\s*)?발이?\s*(?:땅|지면|바닥)에)\s*(?:닿지\s*않|안\s*닿)/u.test(clause) &&
      !/(?:닿지\s*않는|안\s*닿는)\s*(?:것|건|게|상태)?(?:이|은|는)?\s*아니/u.test(clause) &&
      !/수영|헤엄|사다리|발판|서\s*있/u.test(clause)
    );
  }
  if (suspension) {
    add("situation-suspension", "매달린", suspension.trim());
    explicitFacetIds.push("situation-suspension");
  }

  // 공기호흡기를 산소통·일반 의료용 호흡기와 동일시하지 않는다.
  add("equipment-scba", "공기호흡기", positiveMatch(text, [/(공기\s+호흡기|\bSCBA\b)/iu]));
  const chemicalSuit = positiveMatch(text, [/(화학\s*보호복)/u]);
  if (chemicalSuit) {
    add("equipment-chemical-suit", "화학보호복", chemicalSuit);
    // 보호복과 같은 절에 나온 입기·벗기만 연결해 일반 의복 질문으로 확장하지 않는다.
    const suitClauses = text.split(/[.!?;\n,]/u).filter((clause) =>
      positiveMatch(clause, [/(화학\s*보호복)/u])
    );
    for (const clause of suitClauses) {
      add("donning", "착용", positiveMatch(clause, [/(입기|입는|입을\s*때|입어야)/u]));
      add("doffing", "탈의", positiveMatch(clause, [/(벗기|벗는|벗을\s*때|벗어야)/u]));
      add("decontamination", "제독", positiveMatch(clause, [/(오염(?:을|물질을|물질)?\s*(?:씻어\s*내|씻는|제거))/u]));
    }
  }

  const unique = matches.filter((match, index) =>
    matches.findIndex((other) => other.id === match.id && other.canonicalTerm === match.canonicalTerm) === index
  ).slice(0, MAX_KOREAN_SEARCH_KEYWORDS);
  return {
    keywords: Array.from(new Set(unique.map((match) => match.canonicalTerm))),
    matches: unique,
    explicitFacetIds,
  };
}
