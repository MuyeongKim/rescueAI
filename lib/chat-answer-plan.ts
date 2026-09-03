// 질문 유형에 맞는 답변 골격을 고른다. 검색 근거에 없는 항목을 채우라는 지시가 아니라,
// 확보된 근거를 사용자가 현장에서 찾기 쉬운 순서로 배열하기 위한 정적 가이드다.

export type ChatAnswerMode =
  | "qualification"
  | "chemical-incident"
  | "training"
  | "procedure"
  | "equipment"
  | "general";

export type ChatAnswerPlan = {
  mode: ChatAnswerMode;
  title: string;
  sections: string[];
};

export function buildChatAnswerPlan(question: string): ChatAnswerPlan {
  const normalized = question.replace(/\s+/g, " ").trim();

  if (/인명구조사|자격(?:시험|평가)?|실기평가|평가표/.test(normalized)) {
    return {
      mode: "qualification",
      title: "자격·실기평가 안내형",
      sections: [
        "평가 구성과 핵심 기준",
        "평가 종목·진행 방법",
        "종목별 준비물·장비",
        "수행 시 확인할 행동",
        "감점·실격·합격 기준",
      ],
    };
  }

  if (
    /암모니아|염소|황화수소|화학물질|유해물질|위험물/.test(normalized) &&
    /누출|누설|유출|폭발|사고|대응/.test(normalized)
  ) {
    return {
      mode: "chemical-incident",
      title: "화학사고 행동절차형",
      sections: [
        "물질 확인과 위험 특성",
        "필요 보호장비",
        "위험구역 설정과 접근 통제",
        "대원 행동절차와 누출원 차단",
        "제독·오염통제와 중단·보고 기준",
      ],
    };
  }

  if (/훈련|교육|숙달|교안/.test(normalized)) {
    return {
      mode: "training",
      title: "훈련 구성형",
      sections: [
        "훈련목표와 상황 설정",
        "팀 편성·역할",
        "준비 장비와 사전점검",
        "단계별 대원 행동절차",
        "안전통제와 중단 기준",
        "평가 기준과 종료 확인",
      ],
    };
  }

  if (/방법|절차|순서|어떻게|착용|탈의|운용|사용/.test(normalized)) {
    return {
      mode: "procedure",
      title: "현장 절차형",
      sections: [
        "준비·사전점검",
        "단계별 행동절차",
        "완료 후 확인",
        "주의사항과 중단·보고 기준",
      ],
    };
  }

  if (/장비|구성품|점검|규격|기능/.test(normalized)) {
    return {
      mode: "equipment",
      title: "장비 안내형",
      sections: [
        "용도와 구성",
        "사용 전 점검",
        "사용 방법",
        "이상 징후와 안전 유의사항",
      ],
    };
  }

  return {
    mode: "general",
    title: "일반 안내형",
    sections: ["핵심 답변", "세부 설명", "현장 확인사항", "안전 유의사항"],
  };
}

export function answerPlanGuidance(plan: ChatAnswerPlan): string {
  return `[답변 유형: ${plan.title}]
다음 순서로 답하되, 참고 자료에서 확인되는 항목만 작성하세요.
${plan.sections.map((section, index) => `${index + 1}. ${section}`).join("\n")}
근거가 없는 항목은 내용을 만들지 말고, 필요한 경우 해당 항목에 "자료에서 확인되지 않음"이라고 짧게 표시하세요.`;
}
