import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireApiAdmin } from "@/lib/auth";
import { summarizeHeadlines } from "@/lib/news-ai";
import { collectRecentNews } from "@/lib/news-feed";

// 구조 동향 자동 수집(B): 최근 30일 Google News RSS → AI 제목 요약/분류 → 중복 제외 저장.
// 호출 권한: Vercel Cron(Authorization: Bearer CRON_SECRET) 또는 관리자(수동 버튼).
// 헤드라인만 가져오므로 요약은 제목 기반(가벼움). 관리자가 검수(숨김/고정/삭제) 가능.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_NEW = 8;

// 길이 노출까지 막을 필요는 없지만, 바이트 단위 조기 종료로 비밀값을 유추당하지 않도록
// 상수 시간 비교를 쓴다. 길이가 다르면 비교 없이 false.
function secretMatches(header: string | null, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

async function authorize(req: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET;
  if (secret && secretMatches(req.headers.get("authorization"), secret)) return true;
  const auth = await requireApiAdmin();
  return auth.ok;
}

async function refresh() {
  const admin = createAdminClient();
  const { candidates, feedFailures, period } = await collectRecentNews();
  const result = { added: 0, scanned: candidates.length, feedFailures, summariesMissing: 0, period };
  if (candidates.length === 0) return result;

  // URL 중복은 과거·수동 기사까지 확인한다. 긴 RSS URL은 8개씩 나누고
  // 최대 3개 조회만 병렬 실행해 요청 URL 길이와 DB 부하를 제한한다.
  // 이미 저장된 상위 후보가 신규 8개 한도를 소진하지 않게 다음 후보로 진행한다.
  const fresh: typeof candidates = [];
  for (let offset = 0; offset < candidates.length && fresh.length < MAX_NEW; offset += 24) {
    const batch = candidates.slice(offset, offset + 24);
    const reads = await Promise.all([0, 8, 16].filter((start) => start < batch.length).map((start) =>
      admin.from("news").select("url").in("url", batch.slice(start, start + 8).map((item) => item.url))
        .abortSignal(AbortSignal.timeout(3_000))
    ));
    if (reads.some(({ error }) => error)) throw new Error("기존 뉴스 확인에 실패했습니다. 잠시 후 다시 수집하세요.");
    const seen = new Set(reads.flatMap(({ data }) => (data ?? []).map((item) => item.url)));
    fresh.push(...batch.filter((item) => !seen.has(item.url)).slice(0, MAX_NEW - fresh.length));
  }
  if (fresh.length === 0) return result;
  const summaries = await summarizeHeadlines(fresh.map(({ title, source }) => ({ title, source })));

  // news_url_uniq는 WHERE url IS NOT NULL인 부분 인덱스이므로
  // ON CONFLICT (url) upsert는 42P10으로 실패한다. 행별 INSERT 후 실제 URL 중복만 건너뛴다.
  // Cron과 수동 실행이 겹쳐도 다른 신규 기사의 저장은 계속한다.
  for (const [index, item] of fresh.entries()) {
    const summary = summaries[index];
    const { data: inserted, error } = await admin.from("news").insert({
      title: item.title, summary: summary?.summary ?? null, source: item.source || "Google News",
      url: item.url, region: summary?.region ?? null, category: summary?.category ?? null,
      published_on: item.date, auto: true, hidden: false,
    }).select("id").abortSignal(AbortSignal.timeout(3_000));
    if (error?.code === "23505" && error.message.includes("news_url_uniq")) continue;
    if (error) {
      console.error("[news/refresh] insert 실패:", error.code, error.message);
      throw new Error("뉴스 저장에 실패했습니다. 다시 수집하면 이미 저장된 기사는 건너뜁니다.");
    }
    result.added += inserted?.length ?? 0;
    if (!summary?.summary) result.summariesMissing += inserted?.length ?? 0;
  }
  console.info("[news/refresh] 완료", result);
  return result;
}

export async function GET(req: Request) {
  if (!(await authorize(req))) return new Response("Forbidden", { status: 403 });
  try {
    const r = await refresh();
    return Response.json({ ok: true, ...r });
  } catch (e) {
    return new Response(e instanceof Error ? e.message : "수집 실패", { status: 500 });
  }
}

// 관리자 수동 버튼은 POST로도 호출 가능
export async function POST(req: Request) {
  return GET(req);
}
