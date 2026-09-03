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
});
