import { describe, expect, it } from "vitest";
import {
  bindOutlineEvidence,
  hasOutlineEvidenceExcerpt,
  outlineEvidenceGaps,
  outlineEvidenceGuidance,
  outlineEvidenceSearchQueries,
  type OutlineEvidenceRequirement,
} from "@/lib/generation-evidence-coverage";

const label = "[공기호흡기 교범 p.8]";
const secondLabel = "[안전 교범 p.3]";
const excerpt = "사용 전 외관과 결합부의 손상 여부를 확인한다.";
const context = `${label}\n${excerpt}\n\n---\n\n${secondLabel}\n이상 발생 시 작업을 중단하고 안전담당자에게 보고한다.`;
const anchored: OutlineEvidenceRequirement = { requirement: "공기호흡기 사용 전 점검", sourceRef: label, excerpt };

describe("목차별 원문 연결 확인", () => {
  it("원문에 있는 연속 인용은 연결하되 실제 적용 타당성 판단과 구분한다", () => {
    expect(hasOutlineEvidenceExcerpt(anchored, context)).toBe(true);
    // 이 검사는 '무엇을 뒷받침하나'의 의미 판정이 아님을 명시하는 계약이다.
    expect(hasOutlineEvidenceExcerpt({ ...anchored, requirement: "의미 검토가 별도로 필요한 다른 조건" }, context)).toBe(true);
  });

  it("다른 출처의 문장·제목만 인용하거나 떨어진 청크를 이어 붙이면 연결하지 않는다", () => {
    expect(hasOutlineEvidenceExcerpt({ ...anchored, sourceRef: secondLabel }, context)).toBe(false);
    expect(hasOutlineEvidenceExcerpt({ ...anchored, excerpt: label }, context)).toBe(false);
    const chunks = `${label}\n사용 전 외관을 점검한다.\n\n---\n\n${label}\n결합부의 손상 여부를 확인한다.`;
    expect(hasOutlineEvidenceExcerpt({ ...anchored, excerpt: "사용 전 외관을 점검한다. 결합부의 손상 여부를 확인한다." }, chunks)).toBe(false);
  });

  it("같은 청크의 줄바꿈은 허용하되 생략 표시나 만들어 낸 인용은 거절한다", () => {
    expect(hasOutlineEvidenceExcerpt(anchored, context.replace("외관과 결합부", "외관과\n결합부"))).toBe(true);
    expect(hasOutlineEvidenceExcerpt({ ...anchored, excerpt: "사용 전 외관과 … 손상 여부를 확인한다." }, context)).toBe(false);
    expect(hasOutlineEvidenceExcerpt({ ...anchored, excerpt: "해당 장비는 어떤 환경에서도 안전하게 사용할 수 있다." }, context)).toBe(false);
  });

  it("정상 목차와 과거 체크포인트에는 추가 검색을 만들지 않는다", () => {
    expect(outlineEvidenceGaps([{ sourceRefs: [label], evidenceRequirements: [anchored] }], context)).toEqual([]);
    expect(outlineEvidenceGaps([{ sourceRefs: [label] }], context)).toEqual([]);
    expect(outlineEvidenceSearchQueries("공기호흡기", [])).toEqual([]);
  });

  it("전체 목차에서 중복 조건을 제외한 최대 두 검색만 만들고 검색 길이를 제한한다", () => {
    const missing = ["저압 경보 발생 시 대응", "저압  경보 발생 시 대응", "공기 누설 확인", "부상자 이동"];
    const gaps = outlineEvidenceGaps(missing.map((requirement) => ({
      evidenceRequirements: [{ requirement, sourceRef: null, excerpt: null }],
    })), context);
    const queries = outlineEvidenceSearchQueries("공기호흡기 점검 훈련 ".repeat(50), gaps);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatch(/^저압 경보 발생 시 대응/);
    expect(queries[1]).toMatch(/^공기 누설 확인/);
    expect(queries.every((query) => query.length <= 100)).toBe(true);
  });

  it("새로 연결된 실제 출처를 본문에 우선 전달하고 미해결 조건은 추정하지 않도록 남긴다", () => {
    const item = { sourceRefs: [secondLabel, "[없는 출처 p.1]"], evidenceRequirements: [anchored, {
      requirement: "공중 관통 상황의 구조 순서", sourceRef: null, excerpt: null,
    }] };
    expect(bindOutlineEvidence(item, context).sourceRefs).toEqual([label, secondLabel]);
    const guidance = outlineEvidenceGuidance([item], context);
    expect(guidance).toContain("공중 관통 상황의 구조 순서");
    expect(guidance).not.toContain(anchored.requirement);
    expect(guidance).toContain("전체 자료에 없다고 단정하지 마세요");
    expect(guidance).toContain("추정해 채우지 말고");
  });
});
