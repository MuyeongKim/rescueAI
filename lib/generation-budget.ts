export type TimedGenerationMaterialType = "plan" | "lesson" | "slides";

const PRO_DRAFT_CALL_MAX_MS: Record<TimedGenerationMaterialType, number> = {
  plan: 120_000,
  lesson: 150_000,
  slides: 180_000,
};

export function generationProDraftCallMaxMs(
  type: TimedGenerationMaterialType
): number {
  return PRO_DRAFT_CALL_MAX_MS[type];
}
