/**
 * SOP 근거 상태와 생성 결과 사이의 계약을 검사하는 순수 모듈.
 *
 * generate.ts의 생성 타입을 가져오지 않아 프롬프트/품질 검사 모듈이 이 계약을
 * 자유롭게 조합할 수 있고, 저장된 이전 결과도 최소 구조만 맞으면 재검사할 수 있다.
 */

export const SOP_APPLICATION_MARKER = "[관련 SOP 적용]";

export const SOP_NOT_FOUND_DISCLOSURE =
  "관련 SOP 근거를 참고 자료에서 확인하지 못했습니다. 교육 담당자가 시행 전 최신 SOP를 확인해야 합니다.";

export const SOP_DEGRADED_DISCLOSURE =
  "SOP 자료 검색 상태를 확인할 수 없습니다. SOP 번호·절차를 추정하지 말고 시행 전 다시 확인해야 합니다.";

export type SopEvidence = {
  status: "found" | "not_found" | "degraded";
  /** RAG가 SOP 근거로 판정한 정확한 출처 라벨만 전달한다. */
  sourceLabels: string[];
};

export type SopInspectionType = "plan" | "lesson" | "slides";

export type SopQualityIssueCode =
  | "missing_sop_application"
  | "missing_sop_reference"
  | "missing_sop_disclosure"
  | "invalid_sop_reference"
  | "unverified_sop_claim";

export type SopQualityIssue = {
  code: SopQualityIssueCode;
  path: string;
  message: string;
};

export type SopContractReport = {
  ok: boolean;
  issues: SopQualityIssue[];
};

export type SopInspectableSection = {
  heading: string;
  content: string;
};

export type SopInspectableDocument = {
  sections: readonly SopInspectableSection[];
};

export type SopInspectableSlide = {
  title?: string;
  bullets?: readonly string[];
  notes?: string;
  sourceRefs?: readonly string[];
};

export type SopInspectableSlideDeck = {
  slides: readonly SopInspectableSlide[];
};

export type SopInspectableResult = SopInspectableDocument | SopInspectableSlideDeck;

const SOP_SECTION_BY_TYPE = {
  plan: "훈련내용",
  lesson: "핵심이론",
} as const;

const INLINE_REFERENCE = /\[[^\[\]\r\n]{2,}\]/g;
const PROCEDURE_SOURCE_TERM =
  String.raw`(?:\bSOP\b|표준\s*(?:작전)?\s*절차|현장\s*(?:활동)?\s*지침|현장\s*대응\s*매뉴얼|재난\s*대응\s*매뉴얼)`;
const SOP_REFERENCE_CUE = new RegExp(PROCEDURE_SOURCE_TERM, "i");

// 미확인 상태에서 구체 SOP를 사실처럼 단정하는 대표적인 문장 형태만 보수적으로 잡는다.
// 단순히 "SOP를 확인한다"고 안내하는 문장은 포함하지 않는다.
const SOP_NUMBER_CLAIM = new RegExp(
  `${PROCEDURE_SOURCE_TERM}\\s*(?:제\\s*)?(?:[-–—:#]\\s*)?\\d{1,4}(?:\\s*호)?`,
  "i"
);
const SOP_NUMBER_VALUE = new RegExp(
  `${PROCEDURE_SOURCE_TERM}\\s*(?:제\\s*)?(?:[-–—:#]\\s*)?(\\d{1,4})(?!\\d)(?!\\s*년)(?:\\s*호)?`,
  "gi"
);
const SOP_NAMED_CLAIM = new RegExp(
  `${PROCEDURE_SOURCE_TERM}\\s*[:：]\\s*[^\\s.,;!?][^\\n.!?]{1,80}|(?:[「『“\"])[^」』”\"\\n]{2,80}(?:[」』”\"])\\s*${PROCEDURE_SOURCE_TERM}`,
  "i"
);
const QUOTED_SOP_NAME_VALUES = [
  new RegExp(
    `(?:[「『“"])([^」』”"\\n]{2,80})(?:[」』”"])\\s*${PROCEDURE_SOURCE_TERM}`,
    "gi"
  ),
  new RegExp(
    `${PROCEDURE_SOURCE_TERM}\\s*(?:[:：]\\s*)?(?:[「『“"])([^」』”"\\n]{2,80})(?:[」』”"])`,
    "gi"
  ),
] as const;
const SOP_PROCEDURE_CLAIM = new RegExp(
  `${PROCEDURE_SOURCE_TERM}(?:에|에서는|상|를|을)?\\s*(?:따라|따르면|근거로|기준으로|규정상|반드시|우선|금지|허용|실시|시행|수행|해야|한다)`,
  "i"
);

function uniqueTrimmed(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function inlineReferences(text: string): string[] {
  return (
    text
      .match(INLINE_REFERENCE)
      ?.map((reference) => reference.trim())
      .filter((reference) => reference !== SOP_APPLICATION_MARKER) ?? []
  );
}

function isDocument(result: SopInspectableResult): result is SopInspectableDocument {
  return "sections" in result && Array.isArray(result.sections);
}

function sectionTarget(
  type: "plan" | "lesson",
  result: SopInspectableResult
): { text: string; references: string[]; path: string } | null {
  if (!isDocument(result)) return null;
  const heading = SOP_SECTION_BY_TYPE[type];
  const index = result.sections.findIndex((section) => section.heading.trim() === heading);
  if (index < 0) return null;
  const content = result.sections[index].content;
  return {
    text: content,
    references: inlineReferences(content),
    path: `sections.${index}.content`,
  };
}

function slideTargets(
  result: SopInspectableResult
): Array<{ text: string; references: string[]; path: string }> {
  if (!("slides" in result) || !Array.isArray(result.slides)) return [];
  return result.slides.map((slide, index) => {
    const text = [slide.title ?? "", ...(slide.bullets ?? []), slide.notes ?? ""].join("\n");
    return {
      text,
      references: uniqueTrimmed([...(slide.sourceRefs ?? []), ...inlineReferences(text)]),
      path: `slides.${index}`,
    };
  });
}

function designatedTargets(
  type: SopInspectionType,
  result: SopInspectableResult
): Array<{ text: string; references: string[]; path: string }> {
  if (type === "slides") return slideTargets(result);
  const target = sectionTarget(type, result);
  return target ? [target] : [];
}

function allResultTargets(
  result: SopInspectableResult
): Array<{ text: string; references: string[]; path: string }> {
  if (isDocument(result)) {
    return result.sections.map((section, index) => ({
      text: `${section.heading}\n${section.content}`,
      references: inlineReferences(section.content),
      path: `sections.${index}.content`,
    }));
  }
  return slideTargets(result);
}

function expectedDisclosure(status: SopEvidence["status"]): string | null {
  if (status === "not_found") return SOP_NOT_FOUND_DISCLOSURE;
  if (status === "degraded") return SOP_DEGRADED_DISCLOSURE;
  return null;
}

function withoutDisclosure(text: string, disclosure: string): string {
  return text.split(disclosure).join(" ");
}

function hasUnverifiedSopClaim(text: string, disclosure: string): boolean {
  // 대괄호 출처는 invalid_sop_reference가 별도로 판정한다. 출처 문서명이나 번호를
  // 본문 절차 단정으로 중복 오인하지 않도록 주장 검사에서는 제거한다.
  const claimText = withoutDisclosure(text, disclosure)
    .replaceAll(SOP_APPLICATION_MARKER, " ")
    .replace(INLINE_REFERENCE, " ");
  return (
    SOP_NUMBER_CLAIM.test(claimText) ||
    SOP_NAMED_CLAIM.test(claimText) ||
    SOP_PROCEDURE_CLAIM.test(claimText)
  );
}

function normalizedClaim(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ko-KR")
    .replace(/[^0-9a-z가-힣]/gi, "");
}

function normalizedSopNumber(value: string): string {
  return value.replace(/^0+(?=\d)/, "");
}

/**
 * SOP 번호는 문서명 전체의 숫자가 아니라 `SOP 123`, `표준작전절차 제123호`
 * 처럼 절차 표식 바로 뒤에 있는 식별자만 추출한다. 그렇지 않으면 개정년도나
 * `p.7` 같은 페이지 번호가 잘못된 SOP 주장의 근거로 승격될 수 있다.
 */
function sopIdentifierNumbers(text: string): string[] {
  const pattern = new RegExp(SOP_NUMBER_VALUE.source, SOP_NUMBER_VALUE.flags);
  return Array.from(text.matchAll(pattern), (match) =>
    normalizedSopNumber(match[1] ?? "")
  ).filter(Boolean);
}

/**
 * 따옴표로 명시한 값만 특정 SOP 명칭 주장으로 본다. `표준작전절차:
 * 재난현장에서 ...한다` 같은 콜론 뒤 설명문은 고유명이 아니므로 제외한다.
 */
function quotedSopNames(text: string): string[] {
  return QUOTED_SOP_NAME_VALUES.flatMap((template) => {
    const pattern = new RegExp(template.source, template.flags);
    return Array.from(text.matchAll(pattern), (match) => match[1] ?? "");
  });
}

/** 확인된 상태에서도 라벨에 없는 SOP 번호·명칭을 진짜 근거처럼 붙이지 못하게 한다. */
function hasUnverifiedSpecificSopClaim(
  text: string,
  allowedLabels: readonly string[]
): boolean {
  // 대괄호 안 값은 아래 invalid_sop_reference 검사에서 별도로 판정한다. 본문 주장과
  // 출처 라벨을 분리해야, 잘못된 라벨 하나에 같은 오류가 중복으로 표시되지 않는다.
  const claimText = text.replaceAll(SOP_APPLICATION_MARKER, " ").replace(INLINE_REFERENCE, " ");
  const normalizedLabels = allowedLabels.map(normalizedClaim);
  const allowedNumbers = new Set(allowedLabels.flatMap(sopIdentifierNumbers));
  for (const number of sopIdentifierNumbers(claimText)) {
    if (!allowedNumbers.has(number)) return true;
  }

  for (const claimedName of quotedSopNames(claimText)) {
    const name = normalizedClaim(claimedName);
    if (name.length >= 2 && !normalizedLabels.some((label) => label.includes(name))) return true;
  }
  return false;
}

/**
 * 생성 유형별 지정 위치에서 SOP 표식·근거·고정 안내문을 검사한다.
 *
 * - plan: `훈련내용` 섹션의 표식 + 문서 맨 뒤에 서버가 연결하는 SOP 근거
 * - lesson: `핵심이론` 섹션의 표식 + 문서 맨 뒤에 서버가 연결하는 SOP 근거
 * - slides: 동일 슬라이드 안의 표식과 sourceRefs(또는 본문 인라인 라벨)
 *
 * 허용 라벨은 `SopEvidence.sourceLabels`의 정확한 값만 인정한다. 따라서 일반 문서
 * 라벨이나 다른 결과에서 가져온 SOP 라벨은 근거로 승격되지 않는다.
 */
export function inspectSopContract(
  type: SopInspectionType,
  result: SopInspectableResult,
  evidence: SopEvidence
): SopContractReport {
  const issues: SopQualityIssue[] = [];
  const designated = designatedTargets(type, result);
  const allTargets = allResultTargets(result);
  const allowedLabels = new Set(uniqueTrimmed(evidence.sourceLabels));
  const documentMode = type !== "slides";

  if (evidence.status === "found") {
    const applicationTargets = designated.filter((target) =>
      target.text.includes(SOP_APPLICATION_MARKER)
    );
    if (applicationTargets.length === 0) {
      issues.push({
        code: "missing_sop_application",
        path: type === "slides" ? "slides" : designated[0]?.path ?? "sections",
        message: `지정 위치에 ${SOP_APPLICATION_MARKER} 표식을 포함해야 합니다.`,
      });
    }

    const hasGroundedApplication = documentMode
      ? allowedLabels.size > 0
      : applicationTargets.some((target) =>
          target.references.some((reference) => allowedLabels.has(reference))
        );
    if (!hasGroundedApplication) {
      issues.push({
        code: "missing_sop_reference",
        path: applicationTargets[0]?.path ?? designated[0]?.path ?? (type === "slides" ? "slides" : "sections"),
        message: documentMode
          ? "문서 맨 뒤의 근거 자료 및 출처 목록에 확인된 SOP 출처를 연결해야 합니다."
          : "SOP 적용 표식과 같은 슬라이드의 sourceRefs에 확인된 SOP 출처 라벨을 연결해야 합니다.",
      });
    }

    for (const target of allTargets) {
      const hasAllowedReference = target.references.some((reference) =>
        allowedLabels.has(reference)
      );
      const proceduralClaimWithoutLocalReference =
        !documentMode && SOP_PROCEDURE_CLAIM.test(target.text) && !hasAllowedReference;
      if (
        !proceduralClaimWithoutLocalReference &&
        !hasUnverifiedSpecificSopClaim(target.text, Array.from(allowedLabels))
      ) {
        continue;
      }
      issues.push({
        code: "unverified_sop_claim",
        path: target.path,
        message:
          "SOP 번호·명칭·절차를 단정한 위치에는 그 주장과 일치하는 확인된 SOP 출처가 필요합니다.",
      });
    }
  } else {
    const disclosure = expectedDisclosure(evidence.status) as string;
    if (!designated.some((target) => target.text.includes(disclosure))) {
      issues.push({
        code: "missing_sop_disclosure",
        path: type === "slides" ? "slides" : designated[0]?.path ?? "sections",
        message: `지정 위치에 다음 안내문을 정확히 포함해야 합니다: ${disclosure}`,
      });
    }

    for (const target of allTargets) {
      if (!hasUnverifiedSopClaim(target.text, disclosure)) continue;
      issues.push({
        code: "unverified_sop_claim",
        path: target.path,
        message: "SOP 근거가 확인되지 않은 상태에서 번호·명칭·절차를 단정할 수 없습니다.",
      });
    }
  }

  const seenInvalidReferences = new Set<string>();
  for (const target of allTargets) {
    for (const reference of target.references) {
      if (!SOP_REFERENCE_CUE.test(reference) || allowedLabels.has(reference)) continue;
      const issueKey = `${target.path}\u0000${reference}`;
      if (seenInvalidReferences.has(issueKey)) continue;
      seenInvalidReferences.add(issueKey);
      issues.push({
        code: "invalid_sop_reference",
        path: target.path,
        message: `SOP 출처 '${reference}'는 확인된 SOP 근거 목록에 없습니다.`,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}
