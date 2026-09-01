import {
  TRAINING_FOCUS_CONCEPT_OVERLAP_THRESHOLD,
  TRAINING_FOCUS_SIMILARITY_THRESHOLD,
  normalizeTrainingFocusText,
  trainingFocusConceptOverlap,
  trainingFocusSimilarity,
  type SimilarTrainingMaterial,
  type TrainingFocusOption,
} from "@/lib/generate-focus";

export const MAX_RELEVANT_TRAINING_FOCUSES = 20;
export const MAX_SIMILAR_TRAINING_MATERIALS = 5;

export type StoredTrainingMaterialRow = {
  id: number;
  kind: string;
  category: string | null;
  topic: string | null;
  title: string | null;
  focus: string | null;
  created_at: string;
};

const SUPPORTED_KINDS = new Set<SimilarTrainingMaterial["kind"]>([
  "plan",
  "lesson",
  "slides",
]);
const TOPIC_STOP_WORDS = new Set([
  "관련",
  "대비",
  "대응",
  "교육",
  "훈련",
  "방법",
  "절차",
  "종합",
  "전반",
]);
const GENERIC_SUFFIXES = ["관련", "대비", "대응", "교육", "훈련", "방법", "절차"] as const;

function normalizeTopicTerm(value: string): string {
  let term = value.replace(/누설|유출/g, "누출");
  if (term.endsWith("시") && term.length >= 3) term = term.slice(0, -1);
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of GENERIC_SUFFIXES) {
      if (term.endsWith(suffix) && term.length - suffix.length >= 2) {
        term = term.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  return term;
}

/** 같은 상위 훈련 주제를 찾기 위한 화면 비노출 정규화 토큰. */
export function trainingTopicFamilyTerms(topic: string): string[] {
  return Array.from(
    new Set(
      normalizeTrainingFocusText(topic)
        .replace(/누설|유출/g, "누출")
        .replace(/누출시/g, "누출")
        .split(" ")
        .map(normalizeTopicTerm)
        .filter((term) => term.length >= 2 && !TOPIC_STOP_WORDS.has(term))
    )
  ).sort();
}

/**
 * 동일 문구뿐 아니라 ‘암모니아 누출시 대응’과 ‘암모니아 누출 대응’처럼
 * 조사·일반 목적어만 다른 저장본도 같은 상위 주제로 묶는다.
 */
export function isSameTrainingTopicFamily(left: string, right: string): boolean {
  const normalizedLeft = normalizeTrainingFocusText(left);
  const normalizedRight = normalizeTrainingFocusText(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;

  const leftTerms = trainingTopicFamilyTerms(left);
  const rightTerms = trainingTopicFamilyTerms(right);
  if (leftTerms.length === 0 || rightTerms.length === 0) return false;
  if (leftTerms.join("|") === rightTerms.join("|")) return true;

  const rightSet = new Set(rightTerms);
  const matched = leftTerms.filter((term) => rightSet.has(term)).length;
  const overlap = matched / Math.min(leftTerms.length, rightTerms.length);
  if (Math.min(leftTerms.length, rightTerms.length) >= 2 && overlap >= 0.8) {
    return true;
  }

  return trainingFocusSimilarity(left, right) >= 0.82;
}

function storedFocus(row: StoredTrainingMaterialRow): string {
  if (typeof row.focus === "string" && row.focus.trim().length >= 2) {
    return row.focus.trim().slice(0, 100);
  }
  if (typeof row.topic === "string" && row.topic.trim().length >= 2) {
    return row.topic.trim().slice(0, 100);
  }
  return typeof row.title === "string" ? row.title.trim().slice(0, 100) : "";
}

function isSupportedKind(value: string): value is SimilarTrainingMaterial["kind"] {
  return SUPPORTED_KINDS.has(value as SimilarTrainingMaterial["kind"]);
}

export function selectTrainingTopicHistory(
  rows: readonly StoredTrainingMaterialRow[],
  topic: string
): {
  comparisonFocuses: string[];
  similarMaterials: SimilarTrainingMaterial[];
} {
  const relevant = rows.filter(
    (row) =>
      typeof row.topic === "string" &&
      isSameTrainingTopicFamily(row.topic, topic) &&
      isSupportedKind(row.kind)
  );
  const comparisonFocuses = Array.from(
    new Set(relevant.map(storedFocus).filter((value) => value.length >= 2))
  ).slice(0, MAX_RELEVANT_TRAINING_FOCUSES);
  const similarMaterials: SimilarTrainingMaterial[] = [];
  const seenKindAndFocus = new Set<string>();
  for (const row of relevant) {
    if (similarMaterials.length >= MAX_SIMILAR_TRAINING_MATERIALS) break;
    if (
      !Number.isSafeInteger(row.id) ||
      row.id <= 0 ||
      typeof row.title !== "string" ||
      row.title.trim().length === 0 ||
      row.title.length > 200 ||
      typeof row.created_at !== "string" ||
      !Number.isFinite(Date.parse(row.created_at))
    ) {
      continue;
    }
    const focus = storedFocus(row);
    const dedupeKey = `${row.kind}:${normalizeTrainingFocusText(focus)}`;
    if (seenKindAndFocus.has(dedupeKey)) continue;
    seenKindAndFocus.add(dedupeKey);
    similarMaterials.push({
      id: row.id,
      title: row.title.trim(),
      topic: row.topic!.trim().slice(0, 100),
      focus,
      kind: row.kind as SimilarTrainingMaterial["kind"],
      createdAt: row.created_at,
    });
  }

  return { comparisonFocuses, similarMaterials };
}

function overlapsStoredFocus(title: string, comparisons: readonly string[]): boolean {
  return comparisons.some(
    (comparison) =>
      trainingFocusSimilarity(title, comparison) >= TRAINING_FOCUS_SIMILARITY_THRESHOLD ||
      trainingFocusConceptOverlap(title, comparison) >=
        TRAINING_FOCUS_CONCEPT_OVERLAP_THRESHOLD
  );
}

/** 저장 이력과 유사한 후보를 없애지 않고 뒤로 보내 사용자의 선택권을 보존한다. */
export function prioritizeTrainingFocusOptions(
  options: readonly TrainingFocusOption[],
  comparisonFocuses: readonly string[]
): TrainingFocusOption[] {
  return options
    .map((option, index) => ({
      ...option,
      historyOverlap: overlapsStoredFocus(option.title, comparisonFocuses)
        ? ("similar" as const)
        : ("low" as const),
      originalIndex: index,
    }))
    .sort((left, right) => {
      if (left.historyOverlap === right.historyOverlap) {
        return left.originalIndex - right.originalIndex;
      }
      return left.historyOverlap === "low" ? -1 : 1;
    })
    .map(({ id, title, description, sourceRefs, historyOverlap }) => ({
      id,
      title,
      description,
      sourceRefs,
      historyOverlap,
    }));
}
