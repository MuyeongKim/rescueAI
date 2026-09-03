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

  it.each(["각 세부 사항은?", "준비물은?", "실격 기준도 알려줘", "감점 항목은?"])(
    "맥락 의존 질문을 판별한다: %s",
    (question) => expect(isContextDependentQuestion(question)).toBe(true)
  );
});
