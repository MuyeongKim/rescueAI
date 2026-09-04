import type {
  GeneratedDoc,
  GeneratedSlideDeck,
  GenerationQualityIssue,
  GenerationQualityReport,
} from "@/lib/generate";

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
  `(${NUMBER})\\s*(?:[~∼–]\\s*(${NUMBER})\\s*)?(MPa|kPa|Pa|bar|psi|kN|N|kg|mm|cm|m|ppm|%|℃|°\\s*C)(?![a-zA-Z])`,
  "g"
);
const UNITS: Record<string, [string, number]> = {
  MPa: ["pressure", 1e6], kPa: ["pressure", 1e3], Pa: ["pressure", 1],
  bar: ["pressure", 1e5], psi: ["pressure", 6894.757293],
  kN: ["force", 1e3], N: ["force", 1], kg: ["mass", 1],
  mm: ["length", 0.001], cm: ["length", 0.01], m: ["length", 1],
  ppm: ["ppm", 1], "%": ["percent", 1], "℃": ["temperature", 1], "°C": ["temperature", 1],
};

type TechnicalValue = { dimension: string; value: number; label: string };
export function technicalValues(text: string): TechnicalValue[] {
  return Array.from(text.normalize("NFKC").replace(/−/g, "-").matchAll(TECHNICAL_VALUE)).flatMap((match) => {
    const unit = match[3].replace(/\s/g, "");
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
        slide.visual?.caption, slide.visual?.altText].filter(Boolean).join("\n"),
    }))
    : draft.sections.map((section, index) => ({
      path: `sections.${index}.content`, text: `${section.heading}\n${section.content}`,
    }));
  // 의미 검토/보완에서 쓰는 기존 partIndex와 path를 유지하면서 전체 제목도 검토한다.
  if (parts.length === 0) return [{ path: "title", text: draft.title }];
  parts[0].text = `${draft.title}\n${parts[0].text}`;
  return parts;
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
  const supported = technicalValues(evidenceText);
  // 사용자 요청은 장비 압력/농도/온도/하중 등의 근거가 아니다. 명시한 훈련장
  // 평면 크기만 장소 조건으로 사용할 수 있으며, 기술 안전 기준은 원문이 필요하다.
  const trainingPlaceConditions = contextualValues(request.conditions ?? "").filter(isTrainingPlaceLength);
  const issues: GenerationQualityIssue[] = [];
  for (const part of generationTextParts(draft)) {
    const seen = new Set<string>();
    for (const claim of contextualValues(part.text)) {
      const key = `${claim.dimension}:${claim.value}`;
      if (seen.has(key)) continue;
      const found = supported.some((value) => sameValue(claim, value)) ||
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
