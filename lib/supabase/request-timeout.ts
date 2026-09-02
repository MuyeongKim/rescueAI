/**
 * Supabase/PostgREST builder에 실제 fetch 취소 신호를 붙인다.
 * 단위 테스트의 최소 builder처럼 abortSignal이 없는 객체는 그대로 돌려준다.
 */
export function withSupabaseRequestTimeout<T>(request: T, timeoutMs: number): T {
  const abortable = request as T & {
    abortSignal?: (signal: AbortSignal) => T;
  };
  return typeof abortable.abortSignal === "function"
    ? abortable.abortSignal(AbortSignal.timeout(timeoutMs))
    : request;
}
