import { describe, expect, it } from "vitest";
import {
  buildRerankPrompt,
  MAX_RERANK_CANDIDATES,
  MAX_RERANK_EXCERPT_CHARS,
  MAX_RERANK_PROMPT_CHARS,
} from "@/lib/rag-rerank-prompt";

describe("튜터 재순위 원문 입력", () => {
  it("350자 이후의 핵심 설명과 뒤따르는 예외까지 일반 청크 전체를 전달한다", () => {
    const text = `${"교육 자료의 배경 설명입니다. ".repeat(35)}장비 점검은 지정된 환경에서 수행한다. 다만 적용 조건을 충족하지 않으면 이 설명을 그대로 적용할 수 없다.`;
    expect(text.indexOf("장비 점검")).toBeGreaterThan(350);
    expect(text.length).toBeLessThan(MAX_RERANK_EXCERPT_CHARS);
    const prompt = buildRerankPrompt("장비 점검 적용 조건", [{ label: "점검 교재 p.42", text }], 1);
    expect(prompt).toContain(`[0] 점검 교재 p.42\n${text}`);
    expect(prompt).not.toContain("[앞부분 생략]");
    expect(prompt).not.toContain("[뒷부분 생략]");
  });

  it("대형 legacy 청크는 중간의 질문 관련 구간과 그 앞뒤 조건을 연속 원문으로 전달한다", () => {
    const context = "이 절은 실내 교육 조건에 한해 적용한다. 특수장비 정밀점검은 해당 교육 조건을 확인한 뒤 실시한다. 다만 실외 현장에서는 별도 기준을 확인해야 한다.";
    const text = `${"배경 설명. ".repeat(700)}${context}${"별개 주제. ".repeat(700)}`;
    const prompt = buildRerankPrompt("특수장비 정밀점검", [{ label: "오래된 교재 p.12", text }], 1);
    expect(prompt).toContain(context);
    expect(prompt).toContain("[앞부분 생략]");
    expect(prompt).toContain("[뒷부분 생략]");
    expect(prompt).not.toContain(text);
  });

  it("대형 청크 끝에 있는 근거와 마지막 예외도 전달한다", () => {
    const ending = "별도 승인 조건이 충족되어야 한다. 정밀기구 고유점검의 세부 설명이다. 다만 승인 범위를 벗어나는 경우에는 적용하지 않는다.";
    const text = `${"관련 없는 서론. ".repeat(800)}${ending}`;
    const prompt = buildRerankPrompt("정밀기구 고유점검", [{ label: "교재 p.31", text }], 1);
    expect(prompt).toContain(ending);
    expect(prompt).toContain("[앞부분 생략]");
    expect(prompt).not.toContain("[뒷부분 생략]");
  });

  it("관련 단어를 찾지 못한 대형 청크는 앞부분을 유지하고 생략 사실을 명시한다", () => {
    const text = "원문 첫 부분. " + "기타 내용. ".repeat(800);
    const prompt = buildRerankPrompt("압력계", [{ label: "교재 p.2", text }], 1);
    expect(prompt).toContain(text.slice(0, MAX_RERANK_EXCERPT_CHARS));
    expect(prompt).not.toContain("[앞부분 생략]");
    expect(prompt).toContain("[뒷부분 생략]");
  });

  it("청크 길이와 관계없이 후보 순서와 자료 번호를 유지한다", () => {
    const candidates = [
      { label: "첫 교재 p.1", text: "첫 자료의 원문" },
      { label: "둘째 교재 p.2", text: "둘째 설명. ".repeat(900) },
      { label: "셋째 교재 p.3", text: "셋째 자료의 원문" },
    ];
    const prompt = buildRerankPrompt("둘째 설명", candidates, 2);
    expect([...prompt.matchAll(/^\[(\d+)\] (.+)$/gm)].map((match) => [match[1], match[2]])).toEqual([
      ["0", "첫 교재 p.1"], ["1", "둘째 교재 p.2"], ["2", "셋째 교재 p.3"],
    ]);
    expect(candidates[1].text.length).toBeGreaterThan(MAX_RERANK_EXCERPT_CHARS);
  });

  it("최대 후보·질문·긴 메타데이터 입력에서도 전체 프롬프트 상한을 지킨다", () => {
    const candidates = Array.from({ length: MAX_RERANK_CANDIDATES }, (_, index) => ({
      label: `교재 ${index} ` + "긴 제목 ".repeat(1_000),
      text: "큰 원문. ".repeat(10_000),
    }));
    const prompt = buildRerankPrompt("질문".repeat(4_000), candidates, 10);
    expect(prompt.length).toBeLessThanOrEqual(MAX_RERANK_PROMPT_CHARS);
    expect([...prompt.matchAll(/^\[(\d+)\] /gm)]).toHaveLength(MAX_RERANK_CANDIDATES);
    expect(prompt).toContain("[19] 교재 19");
  });

  it("허용 범위 밖 질문이나 후보를 조용히 잘라서 재순위하지 않는다", () => {
    const candidate = { label: "교재 p.1", text: "원문" };
    expect(() => buildRerankPrompt("가".repeat(8_001), [candidate], 1)).toThrow("질문 길이");
    expect(() => buildRerankPrompt("질문", Array.from({ length: 21 }, () => candidate), 1)).toThrow("후보 수");
  });
});
