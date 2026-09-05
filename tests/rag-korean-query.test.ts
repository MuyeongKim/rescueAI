import { describe, expect, it } from "vitest";
import { expandKoreanSearchTerms, MAX_KOREAN_SEARCH_KEYWORDS } from "@/lib/rag-korean-query";

describe("expandKoreanSearchTerms", () => {
  it.each([
    "구조 대상자가 추락하면서 부러진 나뭇가지에 몸통이 관통 되어 공중에 떠 있는 경우 행동절차를 알려줘.",
    "나뭇가지에 몸이 꿰뚫려 땅에 발이 닿지 않는 구조대상자가 있어. 각 조건별로 자료에서 확인되는 범위를 설명해줘.",
    "나뭇가지에 몸이 꿰뚫린 구조대상자의 발이 땅에 닿지 않아",
    "환자가 철근에 꿰여 공중에 매달려 있어. 확인 가능한 범위만 알려줘.",
    "공중에 매달린 환자의 배에 나뭇가지가 박혔을 때",
    "공중에 매달린 환자의 나뭇가지에 관통된 몸통에 대한 자료",
  ])("실제 누락 사례와 같은 조건의 구어체를 매뉴얼 검색어에 연결한다: %s", (query) => {
    const result = expandKoreanSearchTerms(query);
    expect(result.keywords).toEqual(expect.arrayContaining(["관통상", "매달린"]));
    expect(result.explicitFacetIds).toEqual(["situation-impalement", "situation-suspension"]);
    expect(result.matches.every((match) => query.includes(match.sourceText))).toBe(true);
  });

  it.each([
    "관통상은 없고 요구조자가 로프에 매달려 있는 경우",
    "환자의 몸통이 관통 되지 않은 채 로프에 매달려 있어",
    "환자의 배에 나뭇가지가 박혀 있지 않은 상황에서 로프에 매달려 있어",
    "환자의 몸통에 관통상은 없는 상태이고 로프에 매달려 있어",
  ])("명시적으로 부정된 관통상을 긍정 상황으로 추가하지 않는다: %s", (query) => {
    const result = expandKoreanSearchTerms(query);
    expect(result.explicitFacetIds).toEqual(["situation-suspension"]);
    expect(result.keywords).not.toContain("관통상");
  });

  it.each([
    "환자는 공중에 매달려 있지 않아. 구조 절차를 알려줘",
    "관통상은 아니고 매달려 있는 사람도 없어",
    "나무를 관통하는 철물 구조 설명",
    "벽 관통상황에 필요한 장비",
    "환자가 벽에 박힌 철물을 보는 상황",
    "환자 접근을 위해 벽 관통 구조 절차",
    "환자의 몸통을 보호하기 위해 벽을 관통하는 방법",
    "나무에 매달린 벌집 제거 절차",
    "환자 접근로에 매달린 벌집을 제거하는 방법",
    "신규대원인데 드론이 공중에 떠 있는 경우 조종 방법",
    "환자가 로프에 매달려 있지 않은데 공중에 떠 있는 드론을 보고 있어",
    "드론이 나뭇가지에 꿰여 땅에 발이 닿지 않아",
    "사다리 위에 선 사람은 땅에 발이 닿지 않아",
    "수영 중인 환자의 발이 바닥에 닿지 않아",
    "환자의 관통상과 매달림은 제외하고 안내해줘",
  ])("부정·다른 대상·불충분한 조건은 독립 상황으로 만들지 않는다: %s", (query) => {
    expect(expandKoreanSearchTerms(query).explicitFacetIds).toEqual([]);
  });

  it("의식 부재를 매달림 부정으로 오인하지 않는다", () => {
    expect(expandKoreanSearchTerms("환자가 매달려 의식이 없는 상황").explicitFacetIds)
      .toEqual(["situation-suspension"]);
  });

  it("발이 안 닿는다는 조건 자체가 부정되면 매달림을 추가하지 않는다", () => {
    const result = expandKoreanSearchTerms("나뭇가지에 몸이 꿰뚫린 구조대상자의 발이 땅에 닿지 않는 게 아니야");
    expect(result.explicitFacetIds).toEqual(["situation-impalement"]);
  });

  it("기존 질문의 조건을 재작성하지 않고 조건문의 검색 단서만 반환한다", () => {
    const query = "환자의 몸에 철근이 박혔다면 확인해야 할 자료는? 매달려 있지는 않아.";
    const result = expandKoreanSearchTerms(query);
    expect(result.keywords).toEqual(["관통상"]);
    expect(result.matches[0].sourceText).toBe("몸에 철근이 박혔");
    expect(result).not.toHaveProperty("rewrittenQuery");
  });

  it("화학보호복 문맥의 구어체 입기·벗기·오염 제거를 기존 용어에 연결한다", () => {
    const result = expandKoreanSearchTerms("화학 보호복을 입는 순서와 벗는 방법, 화학보호복 오염을 씻어 내는 순서");
    expect(result.keywords).toEqual(["화학보호복", "착용", "탈의", "제독"]);
    expect(result.explicitFacetIds).toEqual([]);
  });

  it.each([
    ["SCBA 점검 방법", ["공기호흡기"]],
    ["scba 점검 방법", ["공기호흡기"]],
    ["공기 호흡기 잔압 확인", ["공기호흡기"]],
    ["산소통 사용 방법", []],
    ["의료용 호흡기 점검 방법", []],
    ["잠수복 입는 순서", []],
    ["화학보호복을 입는 법. 평상복 벗는 법", ["화학보호복", "착용"]],
    ["화학보호복이 아닌 일반 옷을 입는 법", []],
    ["화학보호복은 입는 게 아니라 벗는 순서를 설명해줘", ["화학보호복", "탈의"]],
  ])("약어·의복의 범위를 제한한다: %s", (query, expected) => {
    expect(expandKoreanSearchTerms(query).keywords).toEqual(expected);
  });

  it("같은 구어체가 반복되어도 별칭 수와 원문 검사 범위를 고정한다", () => {
    const query = "화학 보호복을 입는 순서와 벗는 방법 ".repeat(500);
    const result = expandKoreanSearchTerms(query);
    expect(result.keywords).toEqual(["화학보호복", "착용", "탈의"]);
    expect(result.matches.length).toBeLessThanOrEqual(MAX_KOREAN_SEARCH_KEYWORDS);
  });
});
