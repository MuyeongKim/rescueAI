import { describe, it, expect, vi } from "vitest";

// 서버 로직만 단위 검증하므로 Next 빌드의 server-only 경계 마커만 대체한다.
vi.mock("server-only", () => ({}));

import { buildSystemPrompt, NOT_FOUND_MESSAGE, MAX_SOURCES, DEFAULT_TOP_K } from "@/lib/rag";

// 이 앱의 존재 이유에 가장 가까운 규칙 — "근거 없으면 지어내지 않는다".
// 시스템 프롬프트는 lib/rag.ts 단일 출처이므로, 문구가 조용히 사라지면 여기서 잡힌다.
describe("buildSystemPrompt (환각 가드레일)", () => {
  it("검색된 참고 자료를 프롬프트에 그대로 싣는다", () => {
    const context = "[공기호흡기 착용 절차 p.3]\n면체 밀착 확인 후 양압을 개방한다.";
    const prompt = buildSystemPrompt(context);
    expect(prompt).toContain(context);
    expect(prompt).toContain("[참고 자료]");
  });

  it("근거 없음 표준 문구를 규칙에 명시한다", () => {
    const prompt = buildSystemPrompt("자료 본문");
    expect(prompt).toContain(NOT_FOUND_MESSAGE);
  });

  it("자료가 비면 '검색되지 않았음'을 알리고 빈 근거로 두지 않는다", () => {
    for (const empty of ["", "   ", "\n\t "]) {
      const prompt = buildSystemPrompt(empty);
      expect(prompt).toContain("(관련 자료가 검색되지 않았습니다.)");
      expect(prompt).toContain(NOT_FOUND_MESSAGE);
    }
  });

  it("지어내기 금지·부분 답변·의학 판단 회피 규칙이 모두 살아 있다", () => {
    const prompt = buildSystemPrompt("자료");
    expect(prompt).toContain("지어내지 마세요");
    expect(prompt).toContain("자료에서 확인되지 않음");
    expect(prompt).toContain("119 의료지도");
  });

  it("구체적이고 풍부한 튜터 답변 구조를 요구한다", () => {
    const prompt = buildSystemPrompt("자료");
    expect(prompt).toContain("단답으로 끝내지 말고");
    expect(prompt).toContain("핵심 답변");
    expect(prompt).toContain("세부 설명");
    expect(prompt).toContain("현장 확인사항");
    expect(prompt).toContain("안전 유의사항");
    expect(prompt).toContain("문서명·페이지");
  });

  it("본문 인라인 출처를 금지하고 검증 출처는 마지막 영역에 한 번만 맡긴다", () => {
    const prompt = buildSystemPrompt("자료");

    expect(prompt).toContain("출처 라벨이나 문서명·페이지를 직접 쓰지 마세요");
    expect(prompt).toContain("답변 맨 아래의 '근거 자료' 영역");
    expect(prompt).toContain("중복 없이 한 번만 자동 표시");
    expect(prompt).toContain("별도의 출처 목록도 작성하지 말고");
    expect(prompt).not.toContain("핵심 주장이나 절차 뒤에는");
  });

  it("답변 분량을 늘리더라도 근거 밖 내용을 보태지 못하게 한다", () => {
    const prompt = buildSystemPrompt("자료");
    expect(prompt).toContain("일반 상식이나 추측을 덧붙이지 마세요");
    expect(prompt).toContain("참고 자료에 없는 문서명·페이지는 만들지 마세요");
  });

  it("질문별 답변 구성은 참고자료 앞에 두되 기존 근거 경계를 유지한다", () => {
    const guidance = "[답변 유형: 현장 절차형]\n1. 준비·사전점검\n2. 단계별 행동절차";
    const prompt = buildSystemPrompt("자료 본문", guidance);

    expect(prompt).toContain(`[질문별 답변 구성]\n${guidance}`);
    expect(prompt.indexOf("[질문별 답변 구성]")).toBeLessThan(
      prompt.indexOf("[참고 자료]")
    );
    expect(prompt).toContain("지어내지 마세요");
  });

  it("표준 문구가 실수로 비워지지 않았다", () => {
    expect(NOT_FOUND_MESSAGE.trim().length).toBeGreaterThan(10);
    expect(NOT_FOUND_MESSAGE).toContain("확인되지 않습니다");
  });
});

describe("검색 상수", () => {
  it("출처 노출 개수는 검색 결과 수를 넘지 않는다", () => {
    expect(MAX_SOURCES).toBeGreaterThan(0);
    expect(MAX_SOURCES).toBeLessThanOrEqual(DEFAULT_TOP_K);
  });
});
