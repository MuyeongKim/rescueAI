import { randomUUID } from "node:crypto";
import { z } from "zod";
import { GENERATION_JOB_STATUSES, isTerminalGenerationJobStatus } from "@/lib/generation-job";
import type { MaterialGenerationPilotCase } from "./material-generation-pilot";

const jobSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(GENERATION_JOB_STATUSES),
  stage: z.string().optional(),
  qualityPassed: z.boolean(),
  result: z.record(z.unknown()).nullable(),
});
type PilotJob = z.infer<typeof jobSchema>;
type PilotInput = Pick<MaterialGenerationPilotCase, "type" | "category" | "topic" | "focus" | "audience" | "duration">;

export type DurableMaterialPilotOptions = {
  enabled: boolean;
  baseUrl?: string;
  sessionCookie?: string;
  input: PilotInput;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onProgress?: (event: { jobId: string; status: string; elapsedMs: number }) => void;
};

export type DurableMaterialPilotResult =
  | { status: "skipped"; reason: string }
  | { status: "completed"; job: PilotJob; elapsedMs: number };

/** 명시적 실행 + 실제 사용자 쿠키로만 작업 API를 호출한다. 인증·레이트리밋을 대체하지 않는다. */
export async function runDurableMaterialPilot(options: DurableMaterialPilotOptions): Promise<DurableMaterialPilotResult> {
  if (!options.enabled) return { status: "skipped", reason: "RUN_MATERIAL_PILOT_JOBS=1 명시 실행이 필요합니다." };
  const cookie = options.sessionCookie?.trim();
  if (!cookie) return { status: "skipped", reason: "MATERIAL_PILOT_SESSION_COOKIE가 없어 사용자 인증 경로 평가를 건너뜁니다." };
  if (!options.baseUrl?.trim()) return { status: "skipped", reason: "MATERIAL_PILOT_BASE_URL이 없습니다." };
  const base = new URL(options.baseUrl);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && local)) || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
    throw new Error("평가 주소는 HTTPS 사이트 원점 또는 로컬 HTTP 원점이어야 합니다.");
  }
  if (/[\r\n]/.test(cookie)) throw new Error("사용자 세션 쿠키 형식을 확인하세요.");

  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const startedAt = now();
  const timeoutMs = Math.min(60 * 60_000, Math.max(1000, options.timeoutMs ?? 30 * 60_000));
  const intervalMs = Math.min(30_000, Math.max(100, options.pollIntervalMs ?? 5000));
  const deadline = startedAt + timeoutMs;
  const jobId = randomUUID();
  const clientRequestId = randomUUID();
  options.onProgress?.({ jobId, status: "submitting", elapsedMs: 0 });

  const request = async (path: string, method: "POST" | "GET", body?: unknown): Promise<PilotJob> => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`작업 ${jobId} 평가 대기시간을 초과했습니다. 작업을 재생성하지 말고 상태를 확인하세요.`);
    let response: Response;
    try {
      response = await fetcher(new URL(path, base.origin), {
        method,
        headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: "error", cache: "no-store",
        signal: AbortSignal.timeout(Math.min(30_000, remaining)),
      });
    } catch {
      // POST 응답 유실 시 새 ID로 재생성하지 않는다. 실행 여부가 불명확한 작업 ID를 보존한다.
      throw new Error(`작업 ${jobId} ${method} 응답을 확인하지 못했습니다. 같은 작업의 상태를 확인하세요.`);
    }
    if (!response.ok) throw new Error(`작업 ${jobId} ${method} 요청 실패: HTTP ${response.status}`);
    const payload: unknown = await response.json();
    const parsed = z.object({ job: jobSchema }).safeParse(payload);
    if (!parsed.success || parsed.data.job.id !== jobId) {
      throw new Error(`작업 ${jobId}의 상태 응답 계약이 일치하지 않습니다.`);
    }
    return parsed.data.job;
  };

  let job = await request("/api/generate/jobs", "POST", { ...options.input, jobId, clientRequestId });
  let lastStatus: string | undefined;
  while (true) {
    if (job.status !== lastStatus) {
      options.onProgress?.({ jobId, status: job.status, elapsedMs: now() - startedAt });
      lastStatus = job.status;
    }
    if (isTerminalGenerationJobStatus(job.status)) {
      if (job.status !== "completed" || !job.qualityPassed || !job.result) {
        throw new Error(`작업 ${jobId}이 완성본 기준을 충족하지 못했습니다: ${job.status}`);
      }
      return { status: "completed", job, elapsedMs: now() - startedAt };
    }
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`작업 ${jobId} 평가 대기시간을 초과했습니다. 작업을 재생성하지 말고 상태를 확인하세요.`);
    await sleep(Math.min(intervalMs, remaining));
    job = await request(`/api/generate/jobs/${jobId}`, "GET");
  }
}
