import type { Duration, GenType } from "@/lib/generate";

export type TimedGenerationType = Exclude<GenType, "notebooklm">;

const GENERATION_ESTIMATE_SECONDS: Record<
  TimedGenerationType,
  number | Record<Duration, number>
> = {
  plan: 7 * 60,
  lesson: 9 * 60,
  slides: {
    "1시간": 12 * 60,
    "2시간": 16 * 60,
    "4시간": 20 * 60,
  },
};

/** 서버의 생성 예산을 바탕으로 한 보수적 완료 예상값. 실제 생성은 더 빨리 끝날 수 있다. */
export function generationEstimateSeconds(
  type: TimedGenerationType,
  duration: Duration
): number {
  const estimate = GENERATION_ESTIMATE_SECONDS[type];
  return typeof estimate === "number" ? estimate : estimate[duration];
}

export function formatElapsedSeconds(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3_600);
  const minutes = Math.floor((safeSeconds % 3_600) / 60);
  const seconds = safeSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatApproximateDuration(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.ceil(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  if (minutes === 0) return `${seconds}초`;
  return seconds === 0 ? `${minutes}분` : `${minutes}분 ${seconds}초`;
}

/** API가 스트리밍 진행률을 제공하지 않으므로 시간대별 단계는 반드시 '예상'으로만 표시한다. */
export function estimatedGenerationStage(
  elapsedSeconds: number,
  estimatedSeconds: number
): string {
  if (elapsedSeconds < 20) return "관련 교범과 SOP를 찾는 중";
  if (elapsedSeconds < estimatedSeconds * 0.82) return "정밀 모델이 초안을 작성하는 중";
  return "구성·분량·출처를 점검하는 중";
}
