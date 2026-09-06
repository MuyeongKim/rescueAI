import type {
  GeneratedDoc,
  GeneratedSlideDeck,
  GenerationQualityIssue,
  GenerationQualityReport,
} from "@/lib/generate";
import { slideDiagramText } from "@/lib/slide-diagram";

export type GroundingRequest = {
  topic?: string;
  focus?: string;
  conditions?: string;
  audience?: string;
  duration?: string;
};

// 교육 시간·인원·장비 수량과 기술 한계값은 구분한다. 단위가 명시된 기술 수치만
// 결정론적으로 대조하며, 같은 수치의 적용 조건·행동 순서는 별도 의미 검토가 담당한다.
const NUMBER = "-?\\d+(?:,\\d{3})*(?:\\.\\d+)?";
const TECHNICAL_VALUE = new RegExp(
  `(${NUMBER})\\s*(?:[~∼–-]\\s*(${NUMBER})\\s*)?(MPa|kPa|Pa|bar|바|psi|kN|N|kg|mm|cm|m|ppm|%|℃|°\\s*C)(?![a-zA-Z])`,
  "gi"
);
const UNITS: Record<string, [string, number]> = {
  MPa: ["pressure", 1e6], mPa: ["pressure", 0.001], kPa: ["pressure", 1e3], Pa: ["pressure", 1],
  bar: ["pressure", 1e5], "바": ["pressure", 1e5], psi: ["pressure", 6894.757293],
  kN: ["force", 1e3], N: ["force", 1], kg: ["mass", 1],
  mm: ["length", 0.001], cm: ["length", 0.01], m: ["length", 1],
  ppm: ["ppm", 1], "%": ["percent", 1], "℃": ["temperature", 1], "°C": ["temperature", 1],
};

type TechnicalValue = { dimension: string; value: number; label: string };
export function technicalValues(text: string): TechnicalValue[] {
  return Array.from(text.normalize("NFKC").replace(/−/g, "-").matchAll(TECHNICAL_VALUE)).flatMap((match) => {
    const rawUnit = match[3].replace(/\s/g, "");
    const unit = UNITS[rawUnit] ? rawUnit : Object.keys(UNITS).find((key) => key.toLowerCase() === rawUnit.toLowerCase())!;
    const [dimension, scale] = UNITS[unit];
    return [match[1], match[2]].filter(Boolean).map((number) => ({
      dimension,
      value: Number(number.replace(/,/g, "")) * scale,
      label: `${number} ${unit}`,
    }));
  });
}

export function generationTextParts(draft: GeneratedDoc | GeneratedSlideDeck) {
  const parts = "slides" in draft
    ? draft.slides.map((slide, index) => ({
      path: `slides.${index}.notes`,
      text: [slide.title, ...slide.bullets, ...(slide.steps ?? []), slide.notes,
        slide.visual?.caption, slide.visual?.altText, slideDiagramText(slide)].filter(Boolean).join("\n"),
    }))
    : draft.sections.map((section, index) => ({
      path: `sections.${index}.content`, text: `${section.heading}\n${section.content}`,
    }));
  // 의미 검토/보완에서 쓰는 기존 partIndex와 path를 유지하면서 전체 제목도 검토한다.
  if (parts.length === 0) return [{ path: "title", text: draft.title }];
  parts[0].text = `${draft.title}\n${parts[0].text}`;
  return parts;
}

/** A review still addresses one authored part, but an actionable issue points to its actual input. */
export function generationFieldForExcerpt(
  draft: GeneratedDoc | GeneratedSlideDeck, partIndex: number, excerpt: string
): string {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const part = generationTextParts(draft)[partIndex];
  if (!part) throw new Error("근거 검토 위치를 확인하지 못했습니다.");
  if (!("slides" in draft)) return part.path;
  const slide = draft.slides[partIndex];
  if (!slide) return part.path;
  const fields = [
    { path: `slides.${partIndex}.title`, text: slide.title },
    ...slide.bullets.map((text, i) => ({ path: `slides.${partIndex}.bullets.${i}`, text })),
    ...(slide.steps ?? []).map((text, i) => ({ path: `slides.${partIndex}.steps.${i}`, text })),
    { path: `slides.${partIndex}.notes`, text: slide.notes },
    { path: `slides.${partIndex}.visual.caption`, text: slide.visual?.caption ?? "" },
    { path: `slides.${partIndex}.visual.altText`, text: slide.visual?.altText ?? "" },
  ];
  return fields.find(({ text }) => normalize(text).includes(normalize(excerpt)))?.path ?? part.path;
}

/** Labeled evidence is scoped strictly: a missing selected label cannot fall back to another page. */
export function generationEvidenceForPart(
  draft: GeneratedDoc | GeneratedSlideDeck, partIndex: number, evidenceText: string
): string {
  return generationEvidenceBlocks(draft, partIndex, evidenceText).join("\n\n");
}

/** Independent source blocks can be shared by several slides without multiplying review input. */
export function generationEvidenceBlocks(
  draft: GeneratedDoc | GeneratedSlideDeck, partIndex: number, evidenceText: string
): string[] {
  if (!("slides" in draft)) return [evidenceText];
  const refs = draft.slides[partIndex]?.sourceRefs ?? [];
  const key = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
  const knownLabels = new Set([
    ...draft.sources.map((source) => `[${source.doc.trim()}${source.page == null ? "" : ` p.${source.page}`}]`),
  ].map(key));
  const headers = Array.from(evidenceText.matchAll(/(?:^|\n)(\[[^\[\]\r\n]{2,}\])(?=\r?\n)/g))
    .filter((header) => knownLabels.has(key(header[1])) || /\bp\.\s*\d+\]$/i.test(header[1]));
  // Old stored material and native unlabelled context retain their original contract.
  if (headers.length === 0) return [evidenceText];
  const selected = new Set(refs.map(key));
  const prefix = evidenceText.slice(0, headers[0].index).trim();
  return [...(refs.length === 0 && prefix ? [prefix] : []), ...headers.flatMap((header, index) => refs.length === 0 || selected.has(key(header[1]))
    ? [evidenceText.slice(header.index, headers[index + 1]?.index ?? evidenceText.length).trim()]
    : [])];
}

function sameValue(left: TechnicalValue, right: TechnicalValue) {
  return left.dimension === right.dimension &&
    Math.abs(left.value - right.value) <= Math.max(1e-8, Math.abs(left.value) * 0.00001);
}

function contextualValues(text: string) {
  // 소수점은 보존한다. 예외는 해당 문장/행 안에서만 판단해 다른 항목의 교육 문구로
  // 뒤에 나오는 기술 수치를 허용하지 않는다.
  return text.normalize("NFKC").split(/[!?。;\n]|\.(?!\d)/).flatMap((context) =>
    technicalValues(context).map((value) => ({ ...value, context }))
  );
}

const TECHNICAL_CONTEXT = /농도|포화|산소|압력|온도|기온|하중|습도|경사|기울기|부하|출력|충전|배터리|체적|용적|혼합|가연|폭발|중량|질량|안전율|강도|독성|밀도|팽창|수위|유량|인장|내압|허용|한계/;
const TECHNICAL_LENGTH_CONTEXT = /최소|최대|최저|최고|안전\s*거리|이격|추락|절연|수심|수압|침수|높이|고도|진입|접근|방수|살수|붕괴|낙하|낙석|발파|위험\s*(?:거리|반경)|로프|호스|사다리/;

function isTrainingPlaceLength(value: TechnicalValue & { context: string }) {
  return value.dimension === "length" && value.value > 0 &&
    !TECHNICAL_CONTEXT.test(value.context) && !TECHNICAL_LENGTH_CONTEXT.test(value.context) &&
    /(?:훈련장|실습장)\s*(?:의\s*)?(?:길이|너비|폭|가로|세로|크기|구간|코스|규모)/.test(value.context);
}

function isEducationalDesignValue(
  claim: TechnicalValue & { context: string },
  trainingPlaceConditions: Array<TechnicalValue & { context: string }>
) {
  if (TECHNICAL_CONTEXT.test(claim.context)) return false;
  if (claim.dimension === "percent") {
    return claim.value >= 0 && claim.value <= 100 &&
      /체크리스트|정답률|평가\s*(?:점수|항목)|수행\s*평가/.test(claim.context) &&
      /통과|합격/.test(claim.context);
  }
  if (claim.dimension !== "length" || claim.value <= 0 || TECHNICAL_LENGTH_CONTEXT.test(claim.context)) return false;
  if (/(?:가상|모의)\s*(?:훈련|실습|시나리오)/.test(claim.context) && /구간|코스/.test(claim.context)) return true;
  return /훈련장|실습장/.test(claim.context) && trainingPlaceConditions.some((value) => sameValue(claim, value));
}

export function inspectTechnicalGrounding(
  draft: GeneratedDoc | GeneratedSlideDeck,
  evidenceText: string,
  request: GroundingRequest = {}
): GenerationQualityReport {
  // 사용자 요청은 장비 압력/농도/온도/하중 등의 근거가 아니다. 명시한 훈련장
  // 평면 크기만 장소 조건으로 사용할 수 있으며, 기술 안전 기준은 원문이 필요하다.
  const trainingPlaceConditions = contextualValues(request.conditions ?? "").filter(isTrainingPlaceLength);
  const issues: GenerationQualityIssue[] = [];
  for (const [partIndex, part] of generationTextParts(draft).entries()) {
    const supported = technicalValues(generationEvidenceForPart(draft, partIndex, evidenceText));
    const separateTitle = "slides" in draft && partIndex === 0 && draft.slides.length > 0;
    const bodyText = separateTitle ? part.text.slice(draft.title.length + 1) : part.text;
    const claims = [
      ...contextualValues(bodyText).map((claim) => ({ ...claim, supported })),
      ...(separateTitle ? contextualValues(draft.title).map((claim) => ({ ...claim, supported: technicalValues(evidenceText) })) : []),
    ];
    const seen = new Set<string>();
    for (const claim of claims) {
      const key = `${claim.dimension}:${claim.value}`;
      if (seen.has(key)) continue;
      const found = claim.supported.some((value) => sameValue(claim, value)) ||
        isEducationalDesignValue(claim, trainingPlaceConditions);
      if (found) continue;
      // 허용된 평가율/가상 구간과 같은 수치가 실제 기술 기준에도 쓰이면 검사한다.
      seen.add(key);
      issues.push({
        code: "unsupported_technical_value", path: part.path,
        message: `기술 수치 '${claim.label}'를 연결된 원문에서 확인하지 못했습니다. 근거를 확인하거나 수치를 제거해 주세요.`,
        excerpt: claim.label,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

export function mergeGroundingQuality(
  quality: GenerationQualityReport,
  ...additional: GenerationQualityReport[]
): GenerationQualityReport {
  const unique = new Map<string, GenerationQualityIssue>();
  for (const issue of [quality, ...additional].flatMap((item) => item.issues)) {
    unique.set(JSON.stringify([issue.code, issue.path, issue.excerpt ?? issue.message]), issue);
  }
  const issues = [...unique.values()];
  return { ok: issues.length === 0, issues };
}
