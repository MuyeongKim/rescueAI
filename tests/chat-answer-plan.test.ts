import { describe, expect, it } from "vitest";
import { answerPlanGuidance, buildChatAnswerPlan } from "@/lib/chat-answer-plan";

describe("AI 튜터 질문별 답변 계획", () => {
  it.each([
    ["인명구조사 2급 관련 정보?", "qualification", "감점·실격·합격 기준"],
    ["암모니아 누출 시 대응절차", "chemical-incident", "위험구역 설정과 접근 통제"],
    ["산악사고 대비 훈련 구성", "training", "평가 기준과 종료 확인"],
    ["공기호흡기 착용 방법", "procedure", "단계별 행동절차"],
    ["유압전개기 구성품", "equipment", "용도와 구성"],
  ] as const)("질문 '%s'에 적합한 답변 골격을 선택한다", (question, mode, section) => {
    const plan = buildChatAnswerPlan(question);
    expect(plan.mode).toBe(mode);
    expect(plan.sections).toContain(section);
  });

  it("근거 없는 항목을 만들지 말라는 경계를 답변 지침에 포함한다", () => {
    const guidance = answerPlanGuidance(buildChatAnswerPlan("암모니아 누출 시 대응"));
    expect(guidance).toContain("참고 자료에서 확인되는 항목만");
    expect(guidance).toContain("자료에서 확인되지 않음");
  });

  it.each(["로프는 무엇부터 공부하면 좋을까?", "인명구조사 2급 항목을 처음 공부하는데 읽는 순서를 추천해줘", "공기호흡기 구성품을 이해하고 복습하는 계획"])("학습 의도가 확인된 '%s'는 사실과 학습 순서 제안으로 나눈다", (question) => {
    const plan = buildChatAnswerPlan(question, { learningAdvice: true });
    expect(plan).toMatchObject({ mode: "learning", sections: ["자료에서 확인한 내용", "AI 학습 순서 제안"] });
    const guidance = answerPlanGuidance(plan);
    expect(guidance).toContain("자료에 공부 우선순위가 없다는 이유만으로 전체 답변을 거절하지 마세요");
    expect(guidance).toContain("공식 우선순위가 아니라 AI의 학습 제안");
    expect(guidance).toContain("새로운 수치·장비 조작·구조 실행절차");
    expect(guidance).toContain("확인 질문을 한 개만");
  });

  it.each([
    "암모니아 누출 시 대응절차를 공부하고 싶어",
    "불산 누출 사고 대응을 알려줘",
    "화학사고 대응을 공부하려는데 어디부터?",
    "지금 요구조자가 매달려 있어 어떻게 구조해야 해?",
    "현재 환자가 심정지야",
    "공기호흡기 경보는 몇 bar에서 울려? 공부용이야",
    "공기호흡기 충전 압력 기준은 얼마야?",
    "밸브를 얼마나 열어야 해?",
    "공기호흡기 착용 방법을 알려줘",
    "요구조자 처치 순서를 공부용으로 설명해줘",
  ])("학습 플래그가 잘못 전달돼도 '%s'를 일반 학습 조언으로 완화하지 않는다", (question) => {
    expect(buildChatAnswerPlan(question, { learningAdvice: true }).mode).not.toBe("learning");
  });

  it("학습 플래그가 없거나 false이면 기존 질문별 계획을 유지한다", () => {
    expect(buildChatAnswerPlan("인명구조사 2급을 공부하고 싶어").mode).toBe("qualification");
    expect(buildChatAnswerPlan("산악사고 대비 훈련 구성", { learningAdvice: false }).mode).toBe("training");
  });
});
