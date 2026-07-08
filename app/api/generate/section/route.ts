import { generateObject } from "ai";
import { getChatModel } from "@/lib/llm";
import { createClient } from "@/lib/supabase/server";
import {
  AUDIENCES,
  DURATIONS,
  buildGenerateSystemPrompt,
  buildSectionRegenPrompt,
  buildSlideRegenPrompt,
  regeneratedSectionSchema,
  regeneratedSlideSchema,
  type Audience,
  type Duration,
  type GeneratedSection,
  type GeneratedSlide,
} from "@/lib/generate";
import { DEMO } from "@/lib/demo";
import { fetchCategoryContext } from "@/lib/generate-context";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const maxDuration = 60;

type RegenBody = {
  kind?: "section" | "slide";
  category?: string;
  audience?: Audience;
  duration?: Duration;
  topic?: string;
  model?: string;
  docTitle?: string;
  outline?: string[];
  index?: number;
  current?: Partial<GeneratedSection> & Partial<GeneratedSlide>;
  instruction?: string;
};

// 섹션/슬라이드 1개만 AI로 다시 생성한다. (전체 생성은 /api/generate)
export async function POST(req: Request) {
  let body: RegenBody = {};
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const kind = body.kind;
  const category = (body.category ?? "").trim();
  const audience = body.audience;
  const duration = body.duration;
  const index = body.index;
  const outline = Array.isArray(body.outline) ? body.outline.slice(0, 30) : [];
  const instruction = body.instruction?.slice(0, 200);

  if (
    (kind !== "section" && kind !== "slide") ||
    !category ||
    !audience ||
    !AUDIENCES.includes(audience) ||
    !duration ||
    !DURATIONS.includes(duration) ||
    typeof index !== "number" ||
    index < 0 ||
    !body.current
  ) {
    return new Response("잘못된 요청입니다.", { status: 400 });
  }

  // 데모 모드: AI 없이 현재 내용에 지시 라벨만 덧붙여 반환
  if (DEMO) {
    if (kind === "slide") {
      const cur = body.current as GeneratedSlide;
      return Response.json({
        title: cur.title ?? "슬라이드",
        bullets: cur.bullets?.length ? cur.bullets : ["내용"],
        notes: `${cur.notes ?? ""} (데모 재생성)`,
      } satisfies GeneratedSlide);
    }
    const cur = body.current as GeneratedSection;
    return Response.json({
      heading: cur.heading ?? "섹션",
      content: `${cur.content ?? ""}\n(데모 재생성)`,
    } satisfies GeneratedSection);
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  // 부분 재생성 남용 방지 (분당 20회/사용자)
  const rl = rateLimit(`generate-section:${user.id}`, 20, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const { contextText } = await fetchCategoryContext(category, 40, body.topic);
  if (!contextText) {
    return Response.json(
      { error: "해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다." },
      { status: 422 }
    );
  }

  try {
    const system = buildGenerateSystemPrompt(category, contextText);
    const model = getChatModel(body.model);

    if (kind === "slide") {
      const cur = body.current as GeneratedSlide;
      const { object } = await generateObject({
        model,
        schema: regeneratedSlideSchema,
        system,
        prompt: buildSlideRegenPrompt({
          category,
          audience,
          duration,
          deckTitle: body.docTitle ?? `${category} 발표`,
          outline,
          index,
          current: {
            title: cur.title ?? "",
            bullets: cur.bullets ?? [],
            notes: cur.notes ?? "",
          },
          instruction,
        }),
        temperature: 0.5,
      });
      return Response.json(object satisfies GeneratedSlide);
    }

    const cur = body.current as GeneratedSection;
    const { object } = await generateObject({
      model,
      schema: regeneratedSectionSchema,
      system,
      prompt: buildSectionRegenPrompt({
        category,
        audience,
        duration,
        docTitle: body.docTitle ?? `${category} 교육 문서`,
        outline,
        index,
        currentHeading: cur.heading ?? "",
        currentContent: cur.content ?? "",
        instruction,
      }),
      temperature: 0.5,
    });
    return Response.json(object satisfies GeneratedSection);
  } catch (e) {
    console.error("[generate/section] 실패:", e);
    return Response.json({ error: "재생성 중 오류가 발생했습니다." }, { status: 500 });
  }
}
