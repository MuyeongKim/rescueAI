// 질문 유형에 맞는 답변 골격을 고른다. 검색 근거에 없는 항목을 채우라는 지시가 아니라,
// 확보된 근거를 사용자가 현장에서 찾기 쉬운 순서로 배열하기 위한 정적 가이드다.

export type ChatAnswerMode =
  | "learning"
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

export type ChatAnswerPlanOptions = { learningAdvice?: boolean };

/** 학습 표현이 섞여도 사고 대응이나 조작 기준을 일반 학습 조언으로 완화하지 않는다. */
function sourceBoundActionQuestion(question: string): boolean {
  const urgentSituation = /긴급|급박|즉시|응급|심정지|현장\s*대응|출동\s*중|구조\s*중/.test(question)
    || (/지금|현재|현장/.test(question) && /환자|요구조자|부상자|구조\s*대상자|화재|추락|매달|익수|붕괴|출혈|호흡|누출|사고/.test(question));
  const operatingValue = /(?:압력|유량|하중|농도|온도|토크|회전수|충전량|안전거리|진입거리|bar|MPa|kPa|ppm|킬로|리터|미터)/i.test(question)
    && /몇|얼마|수치|기준|설정|조절|맞추|열어|닫아|진입|퇴출|경보|허용|최대|최소/.test(question);
  const directOperation = /밸브|레버|스위치|버튼|조절기|공급기/.test(question)
    && /열어|닫아|돌려|누르|누르면|조작|설정|조절/.test(question);
  const executionProcedure = /(?:행동|구조|처치|이송|진입|대피|착용|탈의|해체|조립|결속)\s*(?:방법|절차|순서)|어떻게\s*(?:구조|처치|이송)/.test(question);
  return urgentSituation || operatingValue || directOperation || executionProcedure;
}

export function buildChatAnswerPlan(question: string, options: ChatAnswerPlanOptions = {}): ChatAnswerPlan {
  const normalized = question.replace(/\s+/g, " ").trim();
  const chemicalIncident = /암모니아|염소|황화수소|불산|황산|질산|불화수소|화학\s*사고|화학물질|유해물질|위험물|유독가스|독성가스/.test(normalized)
    && /누출|누설|유출|폭발|사고|대응/.test(normalized);

  if (options.learningAdvice && !chemicalIncident && !sourceBoundActionQuestion(normalized)) {
    return {
      mode: "learning",
      title: "자료 기반 학습 조언형",
      sections: ["자료에서 확인한 내용", "AI 학습 순서 제안"],
    };
  }

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
    chemicalIncident
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
  if (plan.mode === "learning") {
    return `[답변 유형: ${plan.title}]
아래 두 라벨을 사용해 자료의 사실과 AI의 제안을 분리하세요.
1. 자료에서 확인한 내용: 질문 주제와 관련된 항목·개념·평가 또는 점검 내용을 실제 참고 자료 범위에서 요약하세요.
2. AI 학습 순서 제안: 확인된 항목을 무엇부터 읽고, 어떻게 이해하고, 무엇을 복습할지 제안하세요. 이 순서는 자료에 적힌 공식 우선순위가 아니라 AI의 학습 제안임을 밝히세요.
자료에 공부 우선순위가 없다는 이유만으로 전체 답변을 거절하지 마세요. 다만 새로운 수치·장비 조작·구조 실행절차를 학습 제안에 넣거나 공식 기준처럼 제시하지 마세요.
학습 대상자의 수준이나 사용할 시간이 꼭 필요하면 확인 질문을 한 개만 덧붙이세요. 이미 대화에서 알려준 정보는 다시 묻지 마세요.`;
  }
  return `[답변 유형: ${plan.title}]
다음 순서로 답하되, 참고 자료에서 확인되는 항목만 작성하세요.
${plan.sections.map((section, index) => `${index + 1}. ${section}`).join("\n")}
근거가 없는 항목은 내용을 만들지 말고, 필요한 경우 해당 항목에 "자료에서 확인되지 않음"이라고 짧게 표시하세요.`;
}
