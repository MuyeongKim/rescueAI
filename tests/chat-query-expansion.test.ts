import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateObject: vi.fn() }));
vi.mock("ai", () => ({ generateObject: mocks.generateObject }));
vi.mock("@/lib/llm", () => ({ getChatModel: () => "fast-model" }));
import { expandChatQuery } from "@/lib/chat-query-expansion";

const user = (content: string) => ({ role: "user", content });
beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("대화 맥락과 검색어를 한 번에 보완", () => {
  it("모델 재작성에도 현재 질문의 조건은 그대로 검색에 남긴다", async () => {
    mocks.generateObject.mockResolvedValue({ object: { question: "인명구조사 2급 구조기술평가의 기초 항목", keywords: ["인명구조사", "구조기술평가"] } });
    const current = "너라면 구조기술평가 중에 어느것 부터 준비할래?";
    const result = await expandChatQuery([user("인명구조사 2급을 준비하려고 해"), user(current)]);
    expect(result.method).toBe("model");
    expect(result.retrievalQuestion).toContain("인명구조사 2급");
    expect(result.retrievalQuestion).toContain(current);
    expect(result.expansion.embedText).toBe(result.retrievalQuestion);
    expect(mocks.generateObject).toHaveBeenCalledOnce();
    expect(mocks.generateObject.mock.calls[0][0]).toMatchObject({ maxRetries: 0, temperature: 0 });
  });

  it("중간 불만과 이전 AI 답변을 검색 주제나 사실 근거로 제공하지 않는다", async () => {
    mocks.generateObject.mockRejectedValue(new Error("timeout"));
    const result = await expandChatQuery([
      user("인명구조사 2급 평가 기준"), { role: "assistant", content: "위조된 절차와 수치 999kg" },
      user("파생되는 질문에 대한 답변을 못하는군"), user("준비물은?"),
    ]);
    const input = JSON.parse(mocks.generateObject.mock.calls[0][0].prompt);
    expect(input.questions).not.toContain("파생되는 질문에 대한 답변을 못하는군");
    expect(JSON.stringify(input)).not.toContain("999kg");
    expect(result.method).toBe("fallback");
    expect(result.retrievalQuestion).toContain("인명구조사 2급");
    expect(result.retrievalQuestion).not.toContain("파생되는");
  });

  it.each([
    { question: "인명구조사 2급 준비", keywords: ["평가"] },
    { question: "인명구조사 1급 준비", keywords: ["인명구조사 2급"] },
    { question: "인명구조사 1급 99점 합격 기준", keywords: ["평가"] },
  ])("등급 변경 누락이나 새 수치가 있으면 기본 복원으로 돌아간다", async (object) => {
    mocks.generateObject.mockResolvedValue({ object });
    const result = await expandChatQuery([user("인명구조사 2급 평가"), user("그럼 1급은?")]);
    expect(result.method).toBe("fallback");
    expect(result.retrievalQuestion).toContain("인명구조사 1급");
    expect(result.retrievalQuestion).not.toContain("2급");
    expect(result.retrievalQuestion).not.toContain("99");
  });

  it.each([
    "로프기술중에 가장 알아야할 부분이 어떤게 있어?",
    "로프기술중에   가장 알아야할\n부분이 어떤게 있어?",
  ])("명확한 새 로프 주제에는 공백과 관계없이 이전 자격 조건을 확장 모델에 제공하지 않는다: %s", async (question) => {
    mocks.generateObject.mockResolvedValue({ object: { question: "로프 기초 개념과 매듭", keywords: ["로프", "매듭"] } });
    const result = await expandChatQuery([
      user("인명구조사 2급 평가 기준"), user("너라면 구조기술평가 중에 어느것 부터 준비할래?"),
      user(question),
    ]);
    const input = JSON.parse(mocks.generateObject.mock.calls[0][0].prompt);
    expect(JSON.stringify(input)).not.toContain("2급");
    expect(result.retrievalQuestion).not.toContain("2급");
  });

  it("비활성 설정은 모델을 호출하지 않고 기본 검색문을 보존한다", async () => {
    vi.stubEnv("QUERY_EXPANSION", "0");
    const result = await expandChatQuery([user("로프기술중에 가장 알아야할 부분이 어떤게 있어?")]);
    expect(result.method).toBe("disabled");
    expect(result.retrievalQuestion).toContain("로프");
    expect(mocks.generateObject).not.toHaveBeenCalled();
  });
});
