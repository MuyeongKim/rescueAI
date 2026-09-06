import type { GeneratedDocSource, GeneratedSection } from "@/lib/generate";
import type { DocumentSectionEvidence } from "@/lib/document-evidence";

const COMMON_WORDS = new Set(["교관", "대원", "훈련", "교육", "자료", "내용", "확인", "통해", "대한", "경우", "위해", "한다", "있는", "있다", "수행", "각각", "다음"]);

/** 관련 구절 탐색용 어휘 점수다. 문장별 사실 검증이나 인용 생성에는 사용하지 않는다. */
export function findDocumentSectionEvidence(
  section: GeneratedSection,
  chunks: readonly { source: GeneratedDocSource; content: string }[],
): DocumentSectionEvidence[] {
  const terms = [...new Set(`${section.heading} ${section.content}`.toLocaleLowerCase()
    .split(/[^가-힣a-z0-9]+/)
    .map((word) => word.replace(/(?:에서|으로|에게|에는|하고|하는|한다|을|를|은|는|이|가|의|에|와|과)$/, ""))
    .filter((word) => word.length >= 2 && !COMMON_WORDS.has(word) && !/^\d+$/.test(word)))];
  const ranked = chunks.flatMap((chunk) => {
    // 항상 한 원문 청크의 연속 구간을 보여 준다. 떨어진 문장을 합쳐 새 인용을 만들지 않는다.
    const lower = chunk.content.toLocaleLowerCase();
    const matches = terms.flatMap((term) => {
      const index = lower.indexOf(term);
      return index < 0 ? [] : [{ index, weight: Math.min(term.length, 6) }];
    });
    if (matches.length < 2) return [];
    const center = matches.reduce((best, match) => match.weight > best.weight ? match : best);
    const start = Math.max(0, center.index - 90);
    return [{ source: chunk.source, excerpt: chunk.content.slice(start, start + 500),
      score: matches.reduce((sum, match) => sum + match.weight, 0) }];
  }).sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return ranked.filter((item) => {
    const key = `${item.source.document_id}:${item.source.page ?? "-"}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4).map(({ source, excerpt }) => ({ source, excerpt, matchKind: "text-overlap" }));
}
