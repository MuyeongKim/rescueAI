export type GenerationErrorInfo = {
  status: number;
  name: string;
  message: string;
  authentication: boolean;
  rateLimited: boolean;
  timedOut: boolean;
  serverFailure: boolean;
  networkFailure: boolean;
  invalidOutput: boolean;
};

type ErrorLike = {
  statusCode?: unknown;
  status?: unknown;
  name?: unknown;
  message?: unknown;
  lastError?: unknown;
  cause?: unknown;
  errors?: unknown;
};

/** AI SDK RetryError가 감싼 마지막 provider 오류까지 제한된 깊이로 안전하게 펼친다. */
export function generationErrorInfo(error: unknown): GenerationErrorInfo {
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  const statuses: number[] = [];
  const names: string[] = [];
  const messages: string[] = [];

  while (queue.length > 0 && seen.size < 16) {
    const value = queue.shift();
    if ((!value || (typeof value !== "object" && typeof value !== "function")) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    const candidate = value as ErrorLike;
    const status = Number(candidate.statusCode ?? candidate.status);
    if (Number.isFinite(status) && status > 0) statuses.push(status);
    if (candidate.name != null) names.push(String(candidate.name).toLowerCase());
    if (candidate.message != null) messages.push(String(candidate.message).toLowerCase());
    if (candidate.lastError) queue.push(candidate.lastError);
    if (candidate.cause) queue.push(candidate.cause);
    if (Array.isArray(candidate.errors)) queue.push(...candidate.errors.slice(-8));
  }

  const status = statuses.at(-1) ?? 0;
  const name = names.join(" ");
  const message = messages.join(" ");
  const hasStatus = (...values: number[]) => statuses.some((value) => values.includes(value));
  return {
    status,
    name,
    message,
    authentication:
      hasStatus(401, 403, 404) ||
      message.includes("api key") ||
      message.includes("unauthorized") ||
      message.includes("permission denied") ||
      message.includes("model not found"),
    rateLimited:
      hasStatus(429) || message.includes("rate limit") || message.includes("resource exhausted"),
    timedOut:
      name.includes("aborterror") ||
      name.includes("timeouterror") ||
      message.includes("timed out") ||
      message.includes("timeout"),
    serverFailure: statuses.some((value) => value >= 500 && value <= 599),
    networkFailure:
      message.includes("fetch failed") ||
      message.includes("network") ||
      message.includes("econnreset") ||
      message.includes("socket") ||
      message.includes("connection reset"),
    invalidOutput:
      name.includes("noobjectgenerated") ||
      name.includes("jsonparse") ||
      message.includes("no object generated") ||
      message.includes("did not match schema") ||
      message.includes("invalid json"),
  };
}
