import { requireApiUser } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { DEMO } from "@/lib/demo";
import { normalizeTrainingPlanHwpx } from "@/lib/hwpx-template";
import {
  appendDocumentSources,
  prepareGeneratedDocForPlainTextExport,
} from "@/lib/document-export";
import { normalizeHwpxCellText } from "@/lib/hwpx-format";
import { claimedGeneratedSources } from "@/lib/source-provenance";
import { z } from "zod";
import { LimitedJsonBodyError, readLimitedJsonBody } from "@/lib/generated-material-save";
import { fetchHwpBytes, HWP_FILE_MAX_BYTES, HWP_METADATA_MAX_BYTES, HWP_REQUEST_MAX_BYTES } from "@/lib/hwp-upstream";
import { safeServerError } from "@/lib/safe-server-error";

// 한글(hwpx) 파일 생성 — 미니서버(hwp-writer-api)에 서버 대 서버로 중계한다.
// API 키는 서버 env 에만 두고, 생성→다운로드 2단계를 여기서 처리해 크기를 확인한 파일만 반환.
// 미설정(501)/장애(502) 시 클라이언트(lib/hwpx-download.ts)가 로컬 생성(lib/hwpx.ts)으로 폴백한다.
//
// 두 경로:
//  - template === "training_plan": 전북소방 표준 훈련계획 양식(training_plan.hwpx) 자리표시자 채움.
//  - 그 외: 제목 + 섹션 본문을 /generate/plain 으로 단순 생성.
export const maxDuration = 60;

type Section = { heading?: string; content?: string };
const optionalMeta = z.string().max(1000).optional();
const hwpRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  sections: z.array(z.object({
    heading: z.string().max(300).optional(),
    content: z.string().max(60_000).optional(),
  })).min(1).max(50),
  sources: z.unknown(),
  template: z.string().max(50).optional(),
  plan: z.object({ topic: optionalMeta, datetime: optionalMeta, formType: optionalMeta,
    method: optionalMeta, duration: optionalMeta, target: optionalMeta, place: optionalMeta,
  }).optional(),
});

// 고정 제목 섹션에서 값 찾기(제목에 키워드 포함 여부로 확정 매핑)
function pick(sections: Section[], keyword: string): string {
  const s = sections.find((x) => (x.heading ?? "").includes(keyword));
  return (s?.content ?? "").trim();
}

export async function POST(req: Request) {
  const base = process.env.HWP_WRITER_API_URL?.replace(/\/$/, "");
  const key = process.env.HWP_WRITER_API_KEY;
  if (DEMO || !base || !key) {
    return Response.json({ error: "한글 작성 서버가 설정되지 않았습니다." }, { status: 501 });
  }

  // 아래 미니서버 인증 헤더(auth)와 이름이 겹치지 않게 session 으로 받는다.
  const session = await requireApiUser();
  if (!session.ok) return session.response;

  // 외부 미니서버에 최대 20초씩 2회 붙는 경로라 동시 남용을 막는다 (분당 15회/사용자).
  const rl = rateLimit(`hwp:${session.user.id}`, 15, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  let body: z.infer<typeof hwpRequestSchema>;
  try {
    body = hwpRequestSchema.parse(await readLimitedJsonBody(req, HWP_REQUEST_MAX_BYTES));
  } catch (error) {
    return Response.json({ error: error instanceof LimitedJsonBodyError && error.status === 413
      ? "한글 변환 요청은 256KiB 이하로 줄여 주세요." : "한글 문서의 제목과 본문 형식을 확인해 주세요." },
    { status: error instanceof LimitedJsonBodyError ? error.status : 400 });
  }

  const { title, sections: rawSections } = body;
  const claimedSources = claimedGeneratedSources({ sources: body.sources });
  if (!claimedSources.ok || claimedSources.sources.length === 0) {
    return Response.json(
      {
        code: "source_provenance_invalid",
        error:
          "한글 파일에는 검증된 근거 자료 출처가 필요합니다. 자료를 다시 생성·저장한 뒤 내려받아 주세요.",
      },
      { status: 422 }
    );
  }
  const sources = claimedSources.sources;
  const sections = prepareGeneratedDocForPlainTextExport({
    title,
    sections: rawSections.map((section) => ({
      heading: section.heading ?? "",
      content: section.content ?? "",
    })),
    sources,
  }).sections;

  const auth = { Authorization: `Bearer ${key}` };

  // 미니서버 호출 요청 본문 구성 (템플릿 vs 단순)
  let endpoint: string;
  let payload: Record<string, unknown>;

  if (body.template === "training_plan") {
    const m = body.plan ?? {};
    const planSections = {
      goal: normalizeHwpxCellText(pick(sections, "목표")),
      content: normalizeHwpxCellText(pick(sections, "내용")),
      equipment: normalizeHwpxCellText(pick(sections, "장비")),
      safety: normalizeHwpxCellText(pick(sections, "안전")),
      evaluation: normalizeHwpxCellText(pick(sections, "평가")),
    };
    const requiredLabels: Record<keyof typeof planSections, string> = {
      goal: "훈련 목표",
      content: "훈련 내용",
      equipment: "필요 장비",
      safety: "안전 유의사항",
      evaluation: "평가 기준",
    };
    const missing = (Object.keys(planSections) as (keyof typeof planSections)[])
      .filter((keyName) => !planSections[keyName])
      .map((keyName) => requiredLabels[keyName]);

    if (missing.length > 0) {
      return Response.json(
        {
          error: `훈련계획 필수 항목이 비어 있습니다: ${missing.join(", ")}. 생성 결과를 보완한 뒤 다시 내려받아 주세요.`,
        },
        { status: 422 }
      );
    }

    endpoint = `${base}/generate/template`;
    payload = {
      template_name: "training_plan.hwpx",
      output_name: "training_plan.hwpx",
      values: {
        topic: m.topic ?? title,
        datetime: m.datetime ?? "",
        form_type: m.formType ?? "",
        method: m.method ?? "",
        duration: m.duration ?? "",
        target: m.target ?? "",
        place: m.place ?? "",
        // AI 생성 5개 섹션 → 고정 제목으로 확정 매핑
        ...planSections,
        // 표준 양식에는 별도 출처 셀이 없으므로 마지막 평가 셀의 끝에 한 번만 모은다.
        evaluation: normalizeHwpxCellText(
          appendDocumentSources(planSections.evaluation, sources)
        ),
      },
    };
  } else {
    const text = appendDocumentSources(
      sections
        .map((s) => [s.heading?.trim(), s.content?.trim()].filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n\n"),
      sources
    );
    endpoint = `${base}/generate/plain`;
    payload = { title, body: text, output_name: "generated.hwpx" };
  }

  try {
    // 1) 생성 요청 → {ok, download_path}
    const payloadText = JSON.stringify(payload);
    if (new TextEncoder().encode(payloadText).byteLength > HWP_REQUEST_MAX_BYTES) {
      return Response.json({ error: "한글 변환 요청은 256KiB 이하로 줄여 주세요." }, { status: 413 });
    }
    const gen = await fetchHwpBytes(endpoint, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: payloadText,
    }, HWP_METADATA_MAX_BYTES, req.signal);
    const meta = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(gen)) as { ok?: boolean; download_path?: unknown };
    if (meta.ok !== true || typeof meta.download_path !== "string" ||
      !meta.download_path.startsWith("/") || meta.download_path.startsWith("//") ||
      /[\\\r\n]/.test(meta.download_path)) throw new Error("generate 응답 형식 오류");

    // 2) 파일 다운로드 → 실제 수신 크기 검사 후 반환 (파일명은 클라이언트가 지정)
    const original = await fetchHwpBytes(`${base}${meta.download_path}`, {
      headers: auth,
    }, HWP_FILE_MAX_BYTES, req.signal);

    const output =
      body.template === "training_plan"
        ? await normalizeTrainingPlanHwpx(original, { signal: req.signal })
        : original;
    if (output.byteLength > HWP_FILE_MAX_BYTES) throw new Error("HWP normalized output limit exceeded");
    const responseBody = new ArrayBuffer(output.byteLength);
    new Uint8Array(responseBody).set(output);

    return new Response(responseBody, {
      headers: { "Content-Type": "application/vnd.hancom.hwpx" },
    });
  } catch (e) {
    console.error("[hwp] 미니서버 호출 실패:", safeServerError(e));
    return Response.json(
      { error: "한글 작성 서버에 연결할 수 없습니다." },
      { status: 502 }
    );
  }
}
