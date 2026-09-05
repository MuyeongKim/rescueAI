import { describe, expect, it } from "vitest";
import { scoreTutorEvalAnswer, tutorEvalCaseSchema } from "@/eval/scoring";

const definition = {
  question: "나뭇가지 관통과 공중에 매달린 상태가 함께 있는 상황에서 확인할 수 있는 범위는?",
  expect: "partial" as const,
  keywordGroups: [
    { label: "관통상 문서의 범위", anyOf: ["관통 물체", "관통한 물체"] },
    { label: "접근 문서의 범위", anyOf: ["아래에서 위로 접근", "상향 접근"] },
  ],
  requiredEvidence: [
    { label: "관통상 원문", anyOf: ["관통한 물체"] },
    { label: "접근 원문", anyOf: ["아래에서 위로 접근"] },
  ],
  missingScope: [{ label: "통합 절차", anyOf: ["통합 절차", "동시에 발생한 상황"] }],
  forbidden: ["두 절차를 그대로 결합하면 됩니다"],
};
const item = tutorEvalCaseSchema.parse(definition);
// 채점기의 계약을 검증하는 축약 fixture다. 운영 코퍼스의 존재 여부를 검증하지 않는다.
const retrieval = {
  contextText: "[관통상 p.270]\n관통한 물체를 고정시키는 내용과 예외가 있다.\n[접근 p.706]\n아래에서 위로 접근하는 방법을 다룬다.",
  matched: 2,
  degraded: false,
  retrievalQuestion: item.question,
};
const supported = "관통상 관련 문서는 관통 물체의 고정과 예외 조건을 다룹니다. 별도 로프 구조 문서는 아래에서 위로 접근하는 경우의 어려움과 접근 방법을 설명합니다.";
const missing = "두 조건을 함께 다루는 통합 절차는 제공된 원문에서 확인되지 않습니다.";

describe("튜터 부분 답변 자동 기준 점검", () => {
  it("확인 가능한 설명, 검색 본문, 특정 미확인 범위를 별도로 점검한다", () => {
    const result = scoreTutorEvalAnswer(item, `${supported}\n${missing}`, retrieval);
    expect(result.passed).toBe(true);
    expect(result.checks).toContainEqual({ label: "미확인 범위 명시: 통합 절차", passed: true });
    expect(result.checks).not.toContainEqual({ label: "답변 가능 질문을 통째로 거절하지 않음", passed: false });
  });

  it("문항에서 허용한 미확인 범위의 대체 표현도 같은 문장에 있으면 인정한다", () => {
    expect(scoreTutorEvalAnswer(item,
      `${supported}\n동시에 발생한 상황의 근거가 부족하여 추가 확인이 필요합니다.`, retrieval).passed).toBe(true);
  });

  it.each([
    "",
    `${item.question}\n관련 매뉴얼에서 확인되지 않습니다. 구조 매뉴얼 담당자에게 문의하세요.`,
    `관통 물체와 아래에서 위로 접근하는 방법을 안내할 수 없습니다. ${missing}`,
  ])("미확인 문장에 필수 단어만 나열한 답변은 설명으로 인정하지 않는다", (answer) => {
    expect(scoreTutorEvalAnswer(item, answer, retrieval).passed).toBe(false);
  });

  it.each([
    supported,
    `${supported} 장비 점검 일정은 확인되지 않습니다.`,
    `${supported} 통합 절차를 적용합니다. 그 밖의 내용은 확인되지 않습니다.`,
  ])("특정 조건의 미확인 표시가 없으면 일반 거절 표현으로 대체할 수 없다", (answer) => {
    expect(scoreTutorEvalAnswer(item, answer, retrieval).passed).toBe(false);
  });

  it("미확인 범위가 여러 개면 모든 범위를 각각 명시해야 한다", () => {
    const multiple = tutorEvalCaseSchema.parse({ ...definition, missingScope: [
      ...definition.missingScope, { label: "절단 순서", anyOf: ["절단 순서"] },
    ] });
    expect(scoreTutorEvalAnswer(multiple, `${supported} ${missing}`, retrieval).passed).toBe(false);
    expect(scoreTutorEvalAnswer(multiple,
      `${supported} ${missing} 절단 순서는 자료에서 확인할 수 없습니다.`, retrieval).passed).toBe(true);
  });

  it("필수 설명 항목이 하나 빠지면 다른 항목과 미확인 안내로 통과하지 않는다", () => {
    expect(scoreTutorEvalAnswer(item,
      `관통 물체의 고정과 예외 조건을 확인한 원문에서 별도로 설명하고 있습니다. 관련 문서의 적용 상황을 따로 검토해야 합니다. ${missing}`, retrieval).passed).toBe(false);
  });

  it.each([
    { ...retrieval, matched: 0 },
    { ...retrieval, degraded: true },
    { ...retrieval, contextText: "[관통한 물체 아래에서 위로 접근 p.1]\n일반적인 구조 교육자료입니다." },
    { ...retrieval, contextText: "관통한 물체를 다루는 원문만 있다." },
  ])("검색 장애나 실제 검색 본문의 필수 항목 누락을 통과시키지 않는다", (evidence) => {
    expect(scoreTutorEvalAnswer(item, `${supported} ${missing}`, evidence).passed).toBe(false);
  });

  it("부분 답변에도 금지한 통합 단정을 허용하지 않는다", () => {
    expect(scoreTutorEvalAnswer(item,
      `${supported} ${missing} 두 절차를 그대로 결합하면 됩니다.`, retrieval).passed).toBe(false);
  });

  it("기존 answer 문항은 부분 답변으로 자동 완화하지 않는다", () => {
    const answerItem = tutorEvalCaseSchema.parse({ ...definition, expect: "answer", missingScope: undefined });
    expect(scoreTutorEvalAnswer(answerItem, `${supported} ${missing}`, retrieval).passed).toBe(false);
  });

  it("여러 문장인 현재·이전 질문을 반복해도 확인된 설명으로 인정하지 않는다", () => {
    const multiSentence = tutorEvalCaseSchema.parse({
      ...definition,
      question: "관통 물체와 아래에서 위로 접근하는 방법을 각각 알려줘. 적용 조건을 구별해서 자세하고 충분하게 설명해줘.",
      history: [{ role: "user", content: "관통 물체와 상향 접근이 함께 있는 상황입니다. 예외와 제한을 구별해서 자세하고 충분하게 설명해줘." }],
    });
    const echo = `${multiSentence.question}\n${multiSentence.history[0].content}\n${missing}`;
    expect(scoreTutorEvalAnswer(multiSentence, echo, retrieval).passed).toBe(false);
  });

  it.each([
    { ...definition, keywordGroups: undefined },
    { ...definition, requiredEvidence: undefined },
    { ...definition, missingScope: undefined },
    { ...definition, missingScope: [] },
    { ...definition, expect: "answer" },
  ])("설명·근거·미확인 범위의 기대값이 빠지거나 잘못 지정되면 문항을 거부한다", (candidate) => {
    expect(tutorEvalCaseSchema.safeParse(candidate).success).toBe(false);
  });
});
