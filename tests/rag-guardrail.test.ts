import { describe, it, expect, vi } from "vitest";

// 서버 로직만 단위 검증하므로 Next 빌드의 server-only 경계 마커만 대체한다.
vi.mock("server-only", () => ({}));

import { buildSystemPrompt, NOT_FOUND_MESSAGE, DEFAULT_TOP_K } from "@/lib/rag";

// 이 앱의 존재 이유에 가장 가까운 규칙 — "근거 없으면 지어내지 않는다".
// 시스템 프롬프트는 lib/rag.ts 단일 출처이므로, 문구가 조용히 사라지면 여기서 잡힌다.
describe("buildSystemPrompt (환각 가드레일)", () => {
  it("부족 조건을 항목별로 전달하되 단어 일치를 적용 타당성으로 취급하지 않는다", () => {
    const prompt = buildSystemPrompt("관통상에 관한 개별 원문", "", ["관통상", "매달림"], {
      requested: ["관통상", "매달림"], missing: ["매달림"], supplementalQueries: 1,
    });
    expect(prompt).toContain("최종 참고 자료에서 검색 단서가 부족한 항목: 매달림");
    expect(prompt).toContain("적용 가능성이나 사실성 검증이 아닙니다");
    expect(prompt).toContain("코퍼스 전체의 판정으로 바꾸지 마세요");
    expect(prompt).toContain("결합 상황의 전용 절차가 확인됐다는 뜻은 아닙니다");
  });
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

  it("복합 조건의 개별 근거를 완성된 행동절차로 결합하지 않는다", () => {
    const prompt = buildSystemPrompt("서로 다른 상황을 다루는 개별 자료");

    expect(prompt).toContain("개별 조건의 근거와 모든 조건이 동시에 성립하는 상황의 근거를 구분");
    expect(prompt).toContain("'확인된 범위'와 '추가 확인이 필요한 범위'");
    expect(prompt).toContain("각 자료의 적용 대상·전제·예외");
    expect(prompt).toContain("표준 문구로 전체 답변을 대체하지 마세요");
    expect(prompt).toContain("서로 다른 상황의 절차를 임의로 이어 붙여");
    expect(prompt).toContain("적용 여부가 불확실한 절차는 수행하도록 권하지 말고");
  });

  it("복합 상황에서는 기본 절차 골격과 질문별 절차 지침을 모두 근거 범위 안내로 바꾼다", () => {
    const procedureGuidance = "[답변 유형: 현장 절차형]\n1. 준비·사전점검\n2. 단계별 행동절차";
    const prompt = buildSystemPrompt("각 상황의 개별 자료", procedureGuidance, [
      "관통상 관련 개별 근거", "매달린 요구조자 관련 개별 근거",
    ]);

    expect(prompt).toContain("[답변 유형: 복합 상황의 근거 범위 안내형]");
    expect(prompt).toContain("위 주제 목록은 검색된 근거가 있다는 보증이 아닙니다");
    expect(prompt).toContain("적용 차이: 자료의 대상·전제·예외와 질문 상황의 차이");
    expect(prompt).toContain("전용 절차가 없다는 단서를 붙인 뒤 통합 행동절차를 제시하는 방식도 금지");
    expect(prompt).not.toContain(procedureGuidance);
    expect(prompt).not.toContain("절차가 있으면 번호(1. 2. 3.)로 구분");
  });

  it("독립 조건이 하나이거나 중복이면 기존 질문별 절차 지침을 유지한다", () => {
    const guidance = "[답변 유형: 현장 절차형]\n1. 준비·사전점검\n2. 단계별 행동절차";
    for (const topics of [[], ["관통상"], ["관통상", " 관통상 ", ""]]) {
      const prompt = buildSystemPrompt("자료", guidance, topics);
      expect(prompt).toContain(guidance);
      expect(prompt).not.toContain("[답변 유형: 복합 상황의 근거 범위 안내형]");
    }
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

  it("본문 인라인 출처를 금지하고 검색 참고 자료는 마지막 영역에 한 번만 맡긴다", () => {
    const prompt = buildSystemPrompt("자료");

    expect(prompt).toContain("출처 라벨이나 문서명·페이지를 직접 쓰지 마세요");
    expect(prompt).toContain("답변 맨 아래의 '근거 자료' 영역");
    expect(prompt).toContain("중복 없이 한 번만 자동 표시");
    expect(prompt).toContain("별도의 출처 목록도 작성하지 말고");
    expect(prompt).not.toContain("핵심 주장이나 절차 뒤에는");
    expect(prompt).toContain("실제 인용 여부를 별도로 검증한 결과가 아닙니다");
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
  it("기본 검색량은 충분한 근거를 제공하되 컨텍스트를 제한한다", () => {
    expect(DEFAULT_TOP_K).toBeGreaterThanOrEqual(8);
    expect(DEFAULT_TOP_K).toBeLessThanOrEqual(10);
  });
});
