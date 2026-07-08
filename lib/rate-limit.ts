// 경량 인메모리 레이트리미터 (슬라이딩 윈도).
// 목적: 세션을 가진 스크립트가 LLM 엔드포인트를 반복 호출해 비용이 폭증하는 것을 막는다.
//
// 한계: Vercel 서버리스에서는 인스턴스마다 별도 메모리라 인스턴스 수만큼 상한이 곱해진다(best-effort).
//       내부망 단일 프로세스 배포에서는 정확히 동작한다. 엄격한 전역 상한이 필요하면
//       Redis/Upstash 나 DB 기반 카운터로 교체할 것(현재는 PoC·소규모 내부 사용 기준).
const buckets = new Map<string, number[]>();
const MAX_KEYS = 5000; // 메모리 폭주 방지(초과 시 오래된 절반 정리)

export type RateLimitResult = { ok: boolean; retryAfterSec: number };

export function rateLimit(key: string, limit: number, windowMs: number): RateLimitResult {
  const now = Date.now();

  if (buckets.size > MAX_KEYS) {
    // 오래된 절반 정리(iterator 다운레벨 이슈 회피 위해 Array.from 사용)
    Array.from(buckets.keys())
      .slice(0, Math.floor(MAX_KEYS / 2))
      .forEach((k) => buckets.delete(k));
  }

  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - hits[0])) / 1000));
    buckets.set(key, hits);
    return { ok: false, retryAfterSec };
  }

  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfterSec: 0 };
}

// 429 응답 헬퍼 — Retry-After 헤더 포함.
export function tooManyRequests(retryAfterSec: number): Response {
  return new Response(
    `요청이 너무 잦습니다. ${retryAfterSec}초 후 다시 시도해 주세요.`,
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  );
}
