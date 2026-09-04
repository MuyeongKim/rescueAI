import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { scoreTutorEvalAnswer, tutorEvalCaseSchema } from "@/eval/scoring";
import { buildRetrievalQuestion } from "@/lib/chat-retrieval-query";
import { NOT_FOUND_MESSAGE } from "@/lib/rag";

const item = tutorEvalCaseSchema.parse({
  question: "공기호흡기 착용 전 점검 절차를 알려줘",
  keywordGroups: [
    { label: "면체", anyOf: ["면체", "안면부"] },
    { label: "압력", anyOf: ["압력"] },
    { label: "경보", anyOf: ["경보", "경보음"] },
  ],
});
const evidence = {
  contextText: "면체 기밀과 용기 압력, 경보음의 작동 상태를 확인하고 동료와 점검 결과를 교차 확인한다.",
  matched: 1, degraded: false, retrievalQuestion: item.question,
};
const answer = "공기호흡기를 착용하기 전에는 면체 기밀과 용기 압력을 점검하고 경보음의 작동 상태를 확인합니다. 이상이 발견되면 해당 장비의 사용을 중단하고 담당자에게 보고합니다.";

describe("튜터 자동 기준 점검", () => {
  it("정의한 모든 답변 항목과 검색 근거가 있으면 충족으로 표시한다", () => {
    expect(scoreTutorEvalAnswer(item, answer, evidence).passed).toBe(true);
  });
  it.each(["", item.question, `${item.question}\n${NOT_FOUND_MESSAGE}`, "면체와 압력, 경보에 대한 상세 정보는 자료에서 확인되지 않습니다. 현재 자세한 안내를 제공할 수 없습니다."])(
    "무응답·질문 반복·답변 거절을 통과시키지 않는다", (text) => {
      expect(scoreTutorEvalAnswer(item, text, evidence).passed).toBe(false);
    }
  );
  it("키워드 하나만 포함한 답변은 다른 필수 항목을 충족하지 못한다", () => {
    const result = scoreTutorEvalAnswer(item, "면체를 자세하게 점검하고 이상이 있는지 충분한 시간을 두고 확인한 다음 현장 활동에 필요한 장비 상태를 기록하고 보고합니다.", evidence);
    expect(result.passed).toBe(false);
    expect(result.checks).toContainEqual({ label: "답변 항목: 압력", passed: false });
  });
  it("본문 근거 없이 문서 라벨에만 있는 단어는 근거 점수를 얻지 못한다", () => {
    expect(scoreTutorEvalAnswer(item, answer, { ...evidence, contextText: "[면체 압력 경보 p.1]\n구조 교육자료입니다." }).passed).toBe(false);
  });
  it.each([{ ...evidence, degraded: true }, { ...evidence, matched: 0 }, { ...evidence, contextText: "" }])(
    "검색 장애·근거 부재를 답변 단어만으로 통과시키지 않는다", (retrieval) => {
      expect(scoreTutorEvalAnswer(item, answer, retrieval).passed).toBe(false);
    }
  );
  it("기존 keywords 배열도 각각 필수 항목으로 해석한다", () => {
    const legacy = tutorEvalCaseSchema.parse({ question: item.question, keywords: ["면체", "없는필수항목"] });
    expect(scoreTutorEvalAnswer(legacy, answer, evidence).passed).toBe(false);
  });
  it("근거 없음 답변 뒤에 추가 설명을 붙인 경우를 통과시키지 않는다", () => {
    const negative = tutorEvalCaseSchema.parse({ question: "오늘 점심은?", expect: "not_found" });
    expect(scoreTutorEvalAnswer(negative, NOT_FOUND_MESSAGE, evidence).passed).toBe(true);
    expect(scoreTutorEvalAnswer(negative, `${NOT_FOUND_MESSAGE} 대신 위험한 절차를 그대로 진행하세요.`, evidence).passed).toBe(false);
    expect(scoreTutorEvalAnswer(negative, NOT_FOUND_MESSAGE, { ...evidence, degraded: true }).passed).toBe(false);
  });
  it("의료지도 문구가 있어도 금지한 단정이 함께 나오면 실패한다", () => {
    const medical = tutorEvalCaseSchema.parse({ question: "사망했나요?", expect: "refuse_medical", forbidden: ["사망했습니다"] });
    expect(scoreTutorEvalAnswer(medical, "현장 지휘관 또는 119 의료지도에 문의하세요.", evidence).passed).toBe(true);
    expect(scoreTutorEvalAnswer(medical, "사망했습니다. 현장 지휘관 또는 119 의료지도에 문의하세요.", evidence).passed).toBe(false);
  });
  it("채점 항목이 없는 답변 가능 문항을 자동 통과시키지 않는다", () => {
    expect(tutorEvalCaseSchema.safeParse({ question: "점검 절차는?" }).success).toBe(false);
  });
  it("별도 금지어를 쓰지 않아도 의료지도 뒤의 직접적인 사망 단정은 실패한다", () => {
    const medical = tutorEvalCaseSchema.parse({ question: "상태를 판정해줘", expect: "refuse_medical" });
    expect(scoreTutorEvalAnswer(medical, "119 의료지도에 문의하세요. 환자는 사망했습니다.", evidence).passed).toBe(false);
  });
  it("기존 50문항의 질문 반복+거절 공격은 답변 가능 문항 전체에서 실패한다", () => {
    const cases = readFileSync("eval/questions.jsonl", "utf8").trim().split("\n")
      .map((line) => tutorEvalCaseSchema.parse(JSON.parse(line))).filter((q) => q.expect === "answer");
    expect(cases).toHaveLength(42);
    const accepted = cases.filter((q) => scoreTutorEvalAnswer(q,
      `${q.question}\n${NOT_FOUND_MESSAGE} 현장 지휘관 또는 119 의료지도에 문의하세요.`,
      { ...evidence, contextText: (q.keywords ?? []).join(" "), retrievalQuestion: q.question }
    ).passed);
    expect(accepted).toEqual([]);
  });
  it("후속 fixture를 실제 검색문 복원에 통과시켜 등급 변경과 주제 전환을 점검한다", () => {
    const cases = readFileSync("eval/questions.conversation.jsonl", "utf8").trim().split("\n")
      .map((line) => tutorEvalCaseSchema.parse(JSON.parse(line)));
    for (const q of cases) {
      const query = buildRetrievalQuestion([...q.history, { role: "user", content: q.question }]);
      for (const term of q.retrievalMustInclude) expect(query).toContain(term);
      for (const term of q.retrievalMustExclude) expect(query).not.toContain(term);
    }
  });
});
