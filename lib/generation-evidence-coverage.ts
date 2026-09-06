import { z } from "zod";
import { extractSourceLabels } from "@/lib/generate";

export const MAX_OUTLINE_EVIDENCE_SEARCHES = 2;

/** 원문 연결을 확인하는 장치다. 인용 일치만으로 적용 타당성이나 사실성을 보증하지 않는다. */
export type OutlineEvidenceRequirement = {
  requirement: string;
  sourceRef: string | null;
  excerpt: string | null;
};

export type EvidenceOutlineItem = {
  sourceRefs?: string[];
  evidenceRequirements?: OutlineEvidenceRequirement[];
};

export type OutlineEvidenceGap = {
  itemIndex: number;
  requirementIndex: number;
  requirement: string;
};

export function outlineEvidenceRequirementsSchema(labels: [string, ...string[]]) {
  return z.array(z.object({
    requirement: z.string().min(4).max(160),
    sourceRef: z.enum(labels).nullable(),
    excerpt: z.string().min(12).max(360).nullable(),
  })).max(3);
}

function compact(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sourceSegments(contextText: string): Map<string, string[]> {
  const segments = new Map<string, string[]>();
  // 한 페이지에 여러 청크가 있어도 서로 떨어진 문장을 이어 붙여 인용을 승인하지 않는다.
  const pattern = /(?:^|\n)(\[[^\[\]\r\n]{2,}\])\r?\n/g;
  const matches = Array.from(contextText.matchAll(pattern));
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? contextText.length;
    const label = match[1].trim();
    const content = contextText.slice(start, end).split("\n\n---\n\n")[0];
    segments.set(label, [...(segments.get(label) ?? []), compact(content)]);
  });
  return segments;
}

export function hasOutlineEvidenceExcerpt(
  requirement: OutlineEvidenceRequirement,
  contextText: string,
): boolean {
  if (!requirement.sourceRef || !requirement.excerpt) return false;
  const excerpt = compact(requirement.excerpt);
  if (excerpt.length < 12) return false;
  return (sourceSegments(contextText).get(requirement.sourceRef) ?? [])
    .some((segment) => segment.includes(excerpt));
}

export function outlineEvidenceGaps(
  items: readonly EvidenceOutlineItem[],
  contextText: string,
): OutlineEvidenceGap[] {
  return items.flatMap((item, itemIndex) =>
    (item.evidenceRequirements ?? []).flatMap((requirement, requirementIndex) =>
      hasOutlineEvidenceExcerpt(requirement, contextText)
        ? []
        : [{ itemIndex, requirementIndex, requirement: requirement.requirement }]
    )
  );
}

/** 같은 부족 조건을 중복 검색하지 않고 전체 목차에서 최대 2개만 선별한다. */
export function outlineEvidenceSearchQueries(
  topic: string,
  gaps: readonly OutlineEvidenceGap[],
  conditions?: string,
): string[] {
  const requirements = new Set<string>();
  const queries: string[] = [];
  const conditionTerms = compact(conditions ?? "").match(/[가-힣a-zA-Z0-9]{2,}/g)?.filter((term) =>
    !/^(훈련|교육|대원|교관|실시|확인|필요|대상|포함|일반|계획|진행)$/.test(term)) ?? [];
  const priority = (gap: OutlineEvidenceGap) =>
    (conditionTerms.some((term) => gap.requirement.includes(term)) ? 100 : 0) +
    (/안전|위험|중단|금지|응급|잔압|경보|누출|누설|절단|낙하|관통|확보|추락/.test(gap.requirement) ? 10 : 0);
  const prioritized = gaps.map((gap, index) => ({ gap, index }))
    .sort((a, b) => priority(b.gap) - priority(a.gap) || a.index - b.index);
  for (const { gap } of prioritized) {
    const requirement = compact(gap.requirement);
    const key = requirement.replace(/\s/g, "");
    if (!key || requirements.has(key)) continue;
    requirements.add(key);
    // fetchExternalRagContext의 주제 길이 상한 안에 부족 조건을 먼저 보존한다.
    queries.push(`${requirement.slice(0, 72)} ${compact(topic).slice(0, 26)}`.slice(0, 100));
    if (queries.length === MAX_OUTLINE_EVIDENCE_SEARCHES) break;
  }
  return queries;
}

/** Keep explicit field conditions inside the retrieval service's 100-character query limit. */
export function generationRetrievalQuery(topic: string, conditions?: string): string {
  const condition = compact(conditions ?? "");
  return condition ? `${condition.slice(0, 45)} ${compact(topic).slice(0, 54)}` : compact(topic).slice(0, 100);
}

export function bindOutlineEvidence<T extends EvidenceOutlineItem>(
  item: T,
  contextText: string,
): T {
  const allowed = new Set(extractSourceLabels(contextText));
  const anchored = (item.evidenceRequirements ?? [])
    .filter((requirement) => hasOutlineEvidenceExcerpt(requirement, contextText))
    .map((requirement) => requirement.sourceRef!);
  return {
    ...item,
    // 새로 확인된 근거를 먼저 전달하되 기존 목차 근거도 보존한다.
    sourceRefs: Array.from(new Set([...anchored, ...(item.sourceRefs ?? [])]))
      .filter((label) => allowed.has(label)).slice(0, 4),
  };
}

export function outlineEvidenceGuidance(
  items: readonly EvidenceOutlineItem[],
  contextText: string,
): string {
  const gaps = outlineEvidenceGaps(items, contextText);
  if (gaps.length === 0) return "";
  return `\n[이번 묶음에서 원문 연결을 확인하지 못한 요구사항]\n${gaps
    .map((gap) => `- ${gap.itemIndex + 1}번째 항목: ${gap.requirement}`)
    .join("\n")}\n위 조건은 현재 조회한 근거에서 확인하지 못한 범위입니다. 전체 자료에 없다고 단정하지 마세요. 해당 기술 절차·수치·적용 조건을 추정해 채우지 말고 본문에 '자료에서 확인 필요'로 구분하세요. 서로 다른 조건의 원문을 합쳐 새 절차를 만들지 마세요.\n`;
}
