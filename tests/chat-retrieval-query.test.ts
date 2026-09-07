import { describe, expect, it } from "vitest";
import {
  buildRetrievalQuestion,
  isContextDependentQuestion,
} from "@/lib/chat-retrieval-query";

const user = (content: string) => ({ role: "user", content });
const assistant = (content: string) => ({ role: "assistant", content });

describe("buildRetrievalQuestion", () => {
  it("짧은 후속 질문에 가장 최근의 독립 주제를 결합한다", () => {
    expect(
      buildRetrievalQuestion([
        user("인명구조사 2급 관련 정보?"),
        assistant("답변"),
        user("각 세부 사항은?"),
      ])
    ).toBe("인명구조사 2급 관련 정보?\n후속 질문: 각 세부 사항은?");
  });

  it("후속 질문이 연속되어도 최초의 기준 주제를 잃지 않는다", () => {
    expect(
      buildRetrievalQuestion([
        user("인명구조사 2급 관련 정보?"),
        assistant("답변"),
        user("각 세부 사항은?"),
        assistant("답변"),
        user("준비물은?"),
      ])
    ).toBe("인명구조사 2급 관련 정보?\n후속 질문: 준비물은?");
  });

  it("구체 주제가 들어간 새 질문은 이전 주제를 섞지 않는다", () => {
    expect(
      buildRetrievalQuestion([
        user("인명구조사 2급 관련 정보?"),
        assistant("답변"),
        user("그럼 인명구조사 1급은?"),
      ])
    ).toBe("그럼 인명구조사 1급은?");
  });

  it.each([
    "각 세부 사항은?", "준비물은?", "실격 기준도 알려줘", "감점 항목은?",
    "주의사항은?", "안전수칙도 알려줘", "다시 쉽게 설명해줘", "중단 기준은?",
  ])(
    "맥락 의존 질문을 판별한다: %s",
    (question) => expect(isContextDependentQuestion(question)).toBe(true)
  );

  it.each(["주의사항은?", "안전수칙도 알려줘", "다시 쉽게 설명해줘"])(
    "안전·설명 후속 질문을 같은 장비 근거에서 검색한다: %s",
    (question) => {
      expect(buildRetrievalQuestion([
        user("화학보호복 착용 절차를 알려줘"), assistant("착용 절차"), user(question),
      ])).toBe(`화학보호복 착용 절차를 알려줘\n후속 질문: ${question}`);
    }
  );

  it("변경한 등급을 검색문에 반영하고 그 다음 턴에도 유지한다", () => {
    const history = [user("인명구조사 2급 실기평가 기준은?"), assistant("2급 안내"), user("그럼 1급은?")];
    expect(buildRetrievalQuestion(history)).toBe("인명구조사 1급 실기평가 기준은?\n후속 질문: 그럼 1급은?");
    expect(buildRetrievalQuestion([...history, assistant("1급 안내"), user("준비물은?")]))
      .toBe("인명구조사 1급 실기평가 기준은?\n후속 질문: 준비물은?");
  });

  it.each(["그럼 소방드론 안전수칙은?", "공기호흡기 경보가 울리면 어떻게 하나요?", "오늘 점심 추천해줘"])(
    "새 대상이나 무관한 질문에 이전 보호복 주제를 섞지 않는다: %s",
    (question) => {
      expect(buildRetrievalQuestion([user("화학보호복 착용 절차"), assistant("답변"), user(question)]))
        .toBe(question);
    }
  );

  it("긴 이전 질문이어도 현재 후속 질문이 검색문에서 잘리지 않는다", () => {
    const result = buildRetrievalQuestion([user(`화학보호복 ${"착용 절차 ".repeat(120)}`), user("중단 기준은?")]);
    expect(result.length).toBeLessThanOrEqual(600);
    expect(result).toContain("화학보호복");
    expect(result).toMatch(/후속 질문: 중단 기준은\?$/);
  });

  it("불만·기능 문의를 거쳐도 원래 학습 주제로 이어서 검색한다", () => {
    const history = [
      user("너라면 구조기술평가 중에 어느것 부터 준비할래?"),
      assistant("관련 매뉴얼에서 확인되지 않습니다. 구조 매뉴얼 담당자에게 문의하세요."),
      user("너는 생각이 없니?"), assistant("거절"),
      user("너는 딱 RAG된 자료에서만 답변을 하는구나?"), assistant("거절"),
      user("파생되는 질문에 대한 답변을 못하는군"), assistant("거절"),
      user("준비물은?"),
    ];
    expect(buildRetrievalQuestion(history)).toBe("너라면 구조기술평가 중에 어느것 부터 준비할래?\n후속 질문: 준비물은?");
  });

  it.each([
    "그중 가장 중요한 것은 어떤 거야?",
    "너라면 뭘 먼저 준비하겠어?",
    "방금 설명한 내용을 내가 매일 어떻게 연습하면 좋을까?",
    "왜 그렇게 생각해?",
  ])("동사 활용이 다른 자연스러운 후속 질문도 앞 주제를 복원한다: %s", (question) => {
    expect(buildRetrievalQuestion([user("로프 기술의 기본을 알려줘"), assistant("답변"), user(question)]))
      .toBe(`로프 기술의 기본을 알려줘\n후속 질문: ${question}`);
  });

  it.each([
    "그럼 소방드론에서 가장 알아야 할 부분이 뭐야?",
    "처음 보는 미지장비X의 작동 방식은?",
    "이번에는 다른 주제로, 그걸 수중에서 사용해도 될까?",
  ])("명시적 새 대상·주제 전환과 불명확한 새 명사는 이전 대상에 묶지 않는다: %s", (question) => {
    expect(buildRetrievalQuestion([user("화학보호복 착용 절차"), user(question)])).toBe(question);
  });

  it("감사와 불만 뒤에도 바뀐 등급을 잃지 않는다", () => {
    expect(buildRetrievalQuestion([
      user("인명구조사 2급 실기평가 기준은?"), user("그럼 1급은?"), user("고마워요"),
      user("답변을 못하는군"), user("감점 항목은?"),
    ])).toBe("인명구조사 1급 실기평가 기준은?\n후속 질문: 감점 항목은?");
  });

  it("현재 메타 질문에는 학습 검색어를 억지로 덧붙이지 않는다", () => {
    const question = "너는 딱 RAG된 자료에서만 답변을 하는구나?";
    expect(buildRetrievalQuestion([user("로프 기술"), user(question)])).toBe(question);
  });

  it("부분 평가에 대한 조언은 이전 자격과 등급을 잇되 독립 기술 질문은 새 주제로 검색한다", () => {
    const current = "너라면 구조기술평가 중에 어느것 부터 준비할래?";
    const history = [user("인명구조사 2급을 준비하려고 해"), user(current)];
    expect(buildRetrievalQuestion(history)).toBe(`인명구조사 2급 구조기술평가\n후속 질문: ${current}`);
    expect(buildRetrievalQuestion([...history, user("너는 생각이 없니?"), user("준비물은?")]))
      .toBe("인명구조사 2급 구조기술평가\n후속 질문: 준비물은?");
    const newTopic = "로프기술중에 가장 알아야할 부분이 어떤게 있어?";
    expect(buildRetrievalQuestion([...history, user(newTopic)])).toBe(newTopic);
    expect(buildRetrievalQuestion([user("화학보호복 점검"), user(current)])).toBe(current);
  });
});
