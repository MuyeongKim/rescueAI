import "server-only";
import { createClient } from "@/lib/supabase/server";

export type AiUsageAction = "chat" | "generate" | "generate-section" | "generate-focus"
  | "generate-category" | "generate-evidence" | "generate-job" | "generate-job-retry"
  | "generate-job-review" | "grounding-review" | "news-summary" | "news-refresh";
type Client = Awaited<ReturnType<typeof createClient>>;
type UsageResult = { ok: boolean; retry_after_seconds: number; limit_kind?: string };

function usageResponse(data: unknown): Response | null {
  if (!data || typeof data !== "object" || typeof (data as UsageResult).ok !== "boolean") {
    throw new Error("Invalid AI usage response");
  }
  const result = data as UsageResult;
  if (result.ok) return null;
  const seconds = Math.max(1, Math.min(86400, Math.ceil(Number(result.retry_after_seconds) || 60)));
  const daily = result.limit_kind === "account_daily" || result.limit_kind === "global_daily";
  const error = daily
    ? "오늘의 AI 생성 사용 한도에 도달했습니다. 공용 계정은 함께 사용하는 분들의 요청이 합산됩니다. 한국시간 자정 이후 다시 이용하거나 관리자에게 문의해 주세요."
    : `AI 요청이 잠시 많습니다. 공용 계정은 함께 사용하는 분들의 요청이 합산됩니다. ${seconds}초 후 다시 시도해 주세요.`;
  return Response.json({ code: "ai_usage_limited", error, scope: result.limit_kind, retryAfterSec: seconds }, {
    status: 429, headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" },
  });
}

function unavailable(): Response {
  return Response.json({ code: "ai_usage_unavailable", error: "AI 사용 한도를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요." }, {
    status: 503, headers: { "Cache-Control": "no-store" },
  });
}

/** 세션의 auth.uid()만 사용한다. caller가 사용자·상한을 지정하거나 메모리로 폴백하지 않는다. */
export async function guardAiUsage(action: AiUsageAction, client?: Client): Promise<Response | null> {
  try {
    const supabase = client ?? await createClient();
    const { data, error } = await supabase.rpc("consume_ai_budget", { p_action: action })
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(error.code ?? "AI usage query failed");
    return usageResponse(data);
  } catch (error) {
    console.error("[ai-usage] limit unavailable", error instanceof Error ? error.message : "unknown");
    return unavailable();
  }
}

/** Bearer CRON_SECRET 검증을 완료한 뉴스 GET만 기존 관리자 client로 사용한다. */
export async function guardNewsCronUsage(client: Client): Promise<Response | null> {
  try {
    const { data, error } = await client.rpc("consume_news_cron_budget")
      .abortSignal(AbortSignal.timeout(5_000));
    if (error) throw new Error(error.code ?? "Cron AI usage query failed");
    return usageResponse(data);
  } catch (error) {
    console.error("[ai-usage] cron limit unavailable", error instanceof Error ? error.message : "unknown");
    return unavailable();
  }
}
