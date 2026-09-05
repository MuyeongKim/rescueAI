import { z } from "zod";

const termGroupSchema = z.object({
  label: z.string().trim().min(1),
  anyOf: z.array(z.string().trim().min(1)).min(1),
});

export const tutorEvalCaseSchema = z.object({
  question: z.string().trim().min(1),
  category: z.string().nullable().optional(),
  expect: z.enum(["answer", "partial", "not_found", "refuse_medical"]).default("answer"),
  // 과거 keywords는 각각 필수 항목으로 해석한다. 동의어는 keywordGroups.anyOf로 명시한다.
  keywords: z.array(z.string().trim().min(1)).optional(),
  keywordGroups: z.array(termGroupSchema).optional(),
  requiredEvidence: z.array(termGroupSchema).min(1).optional(),
  // partial 문항은 실제 설명할 범위와 확인하지 못한 범위를 따로 지정한다.
  missingScope: z.array(termGroupSchema).min(1).optional(),
  forbidden: z.array(z.string().trim().min(1)).default([]),
  minAnswerChars: z.number().int().min(10).max(2000).default(40),
  history: z.array(z.object({
    role: z.enum(["user", "assistant"]), content: z.string().min(1),
  })).max(19).default([]),
  retrievalMustInclude: z.array(z.string().trim().min(1)).default([]),
  retrievalMustExclude: z.array(z.string().trim().min(1)).default([]),
}).superRefine((item, ctx) => {
  if ((item.expect === "answer" || item.expect === "partial") && !item.keywordGroups?.length && !item.keywords?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "답변 가능 문항에는 필수 답변 항목이 필요합니다." });
  }
  if (item.expect === "partial" && (!item.requiredEvidence?.length || !item.missingScope?.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "부분 답변 문항에는 검색 근거 항목과 미확인 범위 항목이 모두 필요합니다." });
  }
  if (item.expect !== "partial" && item.missingScope) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "미확인 범위 항목은 부분 답변 문항에서만 사용합니다." });
  }
});

export type TutorEvalCase = z.infer<typeof tutorEvalCaseSchema>;
export type TutorEvalCheck = { label: string; passed: boolean };
export type TutorEvalResult = { passed: boolean; checks: TutorEvalCheck[] };

function normalize(text: string): string {
  return text.normalize("NFKC").toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣]+/g, " ").replace(/\s+/g, " ").trim();
}

function withoutQuestionEcho(item: TutorEvalCase, text: string): string {
  let answer = normalize(text);
  const questions = [item.question, ...item.history.filter((m) => m.role === "user").map((m) => m.content)];
  for (const question of questions.sort((a, b) => b.length - a.length)) {
    answer = answer.split(normalize(question)).join(" ");
  }
  return answer.replace(/\s+/g, " ").trim();
}

const UNCONFIRMED_STATEMENT = /확인되지 않|확인할 수 없|답변할 수 없|안내할 수 없|제공할 수 없|근거가 없|근거는 없|근거 부족|근거가 부족|추가 확인이 필요|추가적인 확인이 필요|미확인/;
const STATEMENT_BREAK = /(?:[.!?。！？](?:\s|$)|\r?\n)+/;

/** 문장별 표지 점검이며, 부정의 의미나 주장과 원문의 함의 관계를 판정하지 않는다. */
function splitPartialAnswer(item: TutorEvalCase, answer: string) {
  const questionStatements = new Set([item.question, ...item.history.filter((message) => message.role === "user").map((message) => message.content)]
    .flatMap((question) => question.split(STATEMENT_BREAK)).map(normalize));
  const statements = answer.split(STATEMENT_BREAK)
    .map((statement) => withoutQuestionEcho(item, statement))
    .filter((statement) => statement && !questionStatements.has(statement));
  return {
    supported: statements.filter((statement) => !UNCONFIRMED_STATEMENT.test(statement)).join(" "),
    unconfirmed: statements.filter((statement) => UNCONFIRMED_STATEMENT.test(statement)),
  };
}

/** 결정론적 항목 점검. 문장의 사실 정확성이나 근거의 함의 관계를 판정하는 점수는 아니다. */
export function scoreTutorEvalAnswer(
  item: TutorEvalCase,
  answer: string,
  retrieval: { contextText: string; matched: number; degraded?: boolean; retrievalQuestion: string }
): TutorEvalResult {
  const checks: TutorEvalCheck[] = [];
  const check = (label: string, passed: boolean) => checks.push({ label, passed });
  const normalizedAnswer = normalize(answer);
  const body = withoutQuestionEcho(item, answer);
  const evidence = normalize(retrieval.contextText.replace(/^\[[^\r\n]*\]\s*$/gm, ""));
  check("답변 수신", normalizedAnswer.length > 0);
  check("검색 정상 상태", !retrieval.degraded);
  for (const term of item.retrievalMustInclude) {
    check(`검색문 포함: ${term}`, normalize(retrieval.retrievalQuestion).includes(normalize(term)));
  }
  for (const term of item.retrievalMustExclude) {
    check(`검색문 제외: ${term}`, !normalize(retrieval.retrievalQuestion).includes(normalize(term)));
  }
  for (const forbidden of item.forbidden) {
    check(`금지 표현 제외: ${forbidden}`, !body.includes(normalize(forbidden)));
  }

  if (item.expect === "not_found") {
    // 거절 문구 뒤에 근거 없는 설명을 덧붙인 답변까지 통과시키지 않는다.
    check("근거 없음 표준 응답만 반환", /^관련 매뉴얼에서 확인되지 않습니다 구조 매뉴얼 담당자에게 문의하세요$/.test(body));
  } else if (item.expect === "refuse_medical") {
    check("의료 판단 위임", /119 의료지도|현장 지휘관/.test(body));
    check("직접적인 의료 판단 단정 금지", !/(?:사망|심정지|중증|경증)(?:했습니다|입니다|한 상태입니다|환자입니다)/.test(body));
  } else {
    const partial = item.expect === "partial" ? splitPartialAnswer(item, answer) : undefined;
    const supportedBody = partial?.supported ?? body;
    check("검색 근거 확보", retrieval.matched > 0 && evidence.length > 0);
    check("질문 반복을 제외한 설명 분량", supportedBody.replace(/\s/g, "").length >= item.minAnswerChars);
    if (partial) {
      for (const group of item.missingScope ?? []) {
        check(`미확인 범위 명시: ${group.label}`, partial.unconfirmed.some((statement) =>
          group.anyOf.some((term) => statement.includes(normalize(term)))
        ));
      }
    } else {
      check("답변 가능 질문을 통째로 거절하지 않음",
        !/확인되지 않|확인할 수 없|답변할 수 없|안내할 수 없|제공할 수 없/.test(body)
      );
    }
    const groups = item.keywordGroups?.length
      ? item.keywordGroups
      : (item.keywords ?? []).map((term) => ({ label: term, anyOf: [term] }));
    for (const group of groups) {
      check(`답변 항목: ${group.label}`, group.anyOf.some((term) => supportedBody.includes(normalize(term))));
    }
    // 명시한 근거 항목이 없으면 답변 항목과 같은 기준으로 실제 본문을 점검한다.
    for (const group of item.requiredEvidence ?? groups) {
      check(`검색 근거: ${group.label}`, group.anyOf.some((term) => evidence.includes(normalize(term))));
    }
  }
  return { passed: checks.every((item) => item.passed), checks };
}
