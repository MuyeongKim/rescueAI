import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";
import { normalizeTrainingPlanHwpx } from "@/lib/hwpx-template";

// 한글(hwpx) 파일 생성 — 미니서버(hwp-writer-api)에 서버 대 서버로 중계한다.
// API 키는 서버 env 에만 두고, 생성→다운로드 2단계를 여기서 처리해 파일을 그대로 스트리밍.
// 미설정(501)/장애(502) 시 클라이언트(lib/hwpx-download.ts)가 로컬 생성(lib/hwpx.ts)으로 폴백한다.
//
// 두 경로:
//  - template === "training_plan": 전북소방 표준 훈련계획 양식(training_plan.hwpx) 자리표시자 채움.
//  - 그 외: 제목 + 섹션 본문을 /generate/plain 으로 단순 생성.
export const maxDuration = 60;

const TIMEOUT_MS = 20_000;

type Section = { heading?: string; content?: string };
type PlanMeta = {
  topic?: string;
  datetime?: string;
  formType?: string; // 훈련형태
  method?: string; // 훈련방법
  duration?: string;
  target?: string; // 훈련대상
  place?: string;
};

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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: {
    title?: string;
    sections?: Section[];
    template?: string;
    plan?: PlanMeta;
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const title = body.title?.trim().slice(0, 200);
  const sections = Array.isArray(body.sections) ? body.sections.slice(0, 50) : [];
  if (!title || sections.length === 0) {
    return new Response("title과 sections가 필요합니다.", { status: 400 });
  }

  const auth = { Authorization: `Bearer ${key}` };

  // 미니서버 호출 요청 본문 구성 (템플릿 vs 단순)
  let endpoint: string;
  let payload: Record<string, unknown>;

  if (body.template === "training_plan") {
    const m = body.plan ?? {};
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
        goal: pick(sections, "목표"),
        content: pick(sections, "내용"),
        equipment: pick(sections, "장비"),
        safety: pick(sections, "안전"),
        evaluation: pick(sections, "평가"),
      },
    };
  } else {
    const text = sections
      .map((s) => [s.heading?.trim(), s.content?.trim()].filter(Boolean).join("\n"))
      .filter(Boolean)
      .join("\n\n");
    endpoint = `${base}/generate/plain`;
    payload = { title, body: text, output_name: "generated.hwpx" };
  }

  try {
    // 1) 생성 요청 → {ok, download_path}
    const gen = await fetch(endpoint, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!gen.ok) throw new Error(`generate 응답 ${gen.status}`);
    const meta = (await gen.json()) as { ok?: boolean; download_path?: string };
    if (!meta.ok || !meta.download_path) throw new Error("generate 응답 형식 오류");

    // 2) 파일 다운로드 → 브라우저로 스트리밍 (파일명은 클라이언트가 지정)
    const file = await fetch(`${base}${meta.download_path}`, {
      headers: auth,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!file.ok) throw new Error(`download 응답 ${file.status}`);

    const original = new Uint8Array(await file.arrayBuffer());
    const output =
      body.template === "training_plan"
        ? await normalizeTrainingPlanHwpx(original)
        : original;
    const responseBody = new ArrayBuffer(output.byteLength);
    new Uint8Array(responseBody).set(output);

    return new Response(responseBody, {
      headers: { "Content-Type": "application/vnd.hancom.hwpx" },
    });
  } catch (e) {
    console.error("[hwp] 미니서버 호출 실패:", e instanceof Error ? e.message : e);
    return Response.json(
      { error: "한글 작성 서버에 연결할 수 없습니다." },
      { status: 502 }
    );
  }
}
