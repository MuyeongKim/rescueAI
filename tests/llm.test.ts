import { describe, expect, it } from "vitest";

import { normalizeOpenAICompatRequestBody } from "@/lib/llm";

describe("normalizeOpenAICompatRequestBody", () => {
  it("GLM-5.3 요청에 필수 thinking과 저강도 추론 기본값을 적용한다", () => {
    const normalized = normalizeOpenAICompatRequestBody(
      JSON.stringify({ model: "glm-5.3", messages: [{ role: "user", content: "테스트" }] }),
    );

    expect(JSON.parse(normalized)).toMatchObject({
      model: "glm-5.3",
      thinking: { type: "enabled" },
      reasoning_effort: "low",
    });
  });

  it("GLM-5.3의 명시적 추론 강도는 유지하고 비활성 thinking은 교정한다", () => {
    const normalized = normalizeOpenAICompatRequestBody(
      JSON.stringify({
        model: "glm-5.3",
        thinking: { type: "disabled", preserve_me: true },
        reasoning_effort: "high",
      }),
    );

    expect(JSON.parse(normalized)).toMatchObject({
      thinking: { type: "enabled", preserve_me: true },
      reasoning_effort: "high",
    });
  });

  it("이전 GLM에는 기존 thinking 비활성화 기본값을 유지한다", () => {
    const normalized = normalizeOpenAICompatRequestBody(JSON.stringify({ model: "glm-5.2" }));

    expect(JSON.parse(normalized)).toEqual({
      model: "glm-5.2",
      thinking: { type: "disabled" },
    });
  });

  it("GLM이 아닌 모델과 잘못된 JSON은 변경하지 않는다", () => {
    const qwenBody = JSON.stringify({ model: "qwen3.5", thinking: { type: "enabled" } });

    expect(normalizeOpenAICompatRequestBody(qwenBody)).toBe(qwenBody);
    expect(normalizeOpenAICompatRequestBody("not-json")).toBe("not-json");
  });
});
