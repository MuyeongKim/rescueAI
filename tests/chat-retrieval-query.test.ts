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
});
