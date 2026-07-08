import { createClient } from "@/lib/supabase/server";
import { DEMO } from "@/lib/demo";

// 한글(hwpx) 파일 생성 — 미니서버(hwp-writer-api)에 서버 대 서버로 중계한다.
// API 키는 서버 env 에만 두고, 생성→다운로드 2단계를 여기서 처리해 파일을 그대로 스트리밍.
// 미설정(501)/장애(502) 시 클라이언트(lib/hwpx-download.ts)가 로컬 생성(lib/hwpx.ts)으로 폴백한다.
export const maxDuration = 60;

const TIMEOUT_MS = 20_000;

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

  let body: { title?: string; sections?: { heading?: string; content?: string }[] };
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

  // 섹션 배열 → 본문 텍스트 (실제 전북소방 서식 템플릿이 준비되면 /generate/template + values 로 교체)
  const text = sections
    .map((s) => [s.heading?.trim(), s.content?.trim()].filter(Boolean).join("\n"))
    .filter(Boolean)
    .join("\n\n");

  const auth = { Authorization: `Bearer ${key}` };
  try {
    // 1) 생성 요청 → {ok, download_path} JSON
    const gen = await fetch(`${base}/generate/plain`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ title, body: text, output_name: "generated.hwpx" }),
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
    if (!file.ok || !file.body) throw new Error(`download 응답 ${file.status}`);

    return new Response(file.body, {
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
