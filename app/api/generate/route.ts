import { generateObject } from "ai";
import { getChatModel } from "@/lib/llm";
import { requireApiUser } from "@/lib/auth";
import {
  AUDIENCES,
  DURATIONS,
  buildGeneratePrompt,
  buildGenerateSystemPrompt,
  generatedDocSchema,
  generatedSlidesSchema,
  type GenerateRequest,
  type GeneratedDoc,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import { DEMO, demoGeneratedDoc, demoGeneratedSlides } from "@/lib/demo";
import { fetchCategoryContext } from "@/lib/generate-context";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";

export const maxDuration = 60;

// 인덱싱 자료를 근거로 훈련계획/교안을 생성한다. (NotebookLM 프롬프트는 클라이언트에서 조립)
export async function POST(req: Request) {
  let body: Partial<GenerateRequest> = {};
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // 데모 모드: AI/DB 없이 목 문서/슬라이드 반환
  if (DEMO) {
    if (body.type === "slides") {
      return Response.json({
        ...demoGeneratedSlides,
        title: body.category
          ? demoGeneratedSlides.title.replace("화재", body.category)
          : demoGeneratedSlides.title,
      } satisfies GeneratedSlideDeck);
    }
    return Response.json({
      ...demoGeneratedDoc,
      title: body.category
        ? demoGeneratedDoc.title.replace("화재", body.category)
        : demoGeneratedDoc.title,
    } satisfies GeneratedDoc);
  }

  const auth = await requireApiUser();
  if (!auth.ok) return auth.response;

  // 문서 생성은 비용이 크므로 더 타이트하게 (분당 10회/사용자)
  const rl = rateLimit(`generate:${auth.user.id}`, 10, 60_000);
  if (!rl.ok) return tooManyRequests(rl.retryAfterSec);

  const type = body.type;
  const category = (body.category ?? "").trim();
  const audience = body.audience;
  const duration = body.duration;
  if (
    (type !== "plan" && type !== "lesson" && type !== "slides") ||
    !category ||
    !audience ||
    !AUDIENCES.includes(audience) ||
    !duration ||
    !DURATIONS.includes(duration)
  ) {
    return new Response("잘못된 요청입니다.", { status: 400 });
  }
  const genReq: GenerateRequest = {
    type,
    category,
    audience,
    duration,
    topic: body.topic?.slice(0, 100),
    date: /^\d{4}-\d{2}-\d{2}$/.test(body.date ?? "") ? body.date : undefined,
    place: body.place?.slice(0, 100),
    model: body.model,
  };

  const { contextText, sources } = await fetchCategoryContext(category, 40, genReq.topic);
  if (!contextText) {
    return Response.json(
      { error: "해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다." },
      { status: 422 }
    );
  }

  try {
    const system = buildGenerateSystemPrompt(category, contextText);
    // 폼에서 선택한 모델 — 미지정/사용불가 시 서버 기본값으로 폴백
    const model = getChatModel(genReq.model);

    if (type === "slides") {
      const { object } = await generateObject({
        model,
        schema: generatedSlidesSchema,
        system,
        prompt: buildGeneratePrompt(genReq),
        temperature: 0.4,
      });
      return Response.json({ ...object, sources } satisfies GeneratedSlideDeck);
    }

    const { object } = await generateObject({
      model,
      schema: generatedDocSchema,
      system,
      prompt: buildGeneratePrompt(genReq),
      temperature: 0.4,
    });
    return Response.json({ ...object, sources } satisfies GeneratedDoc);
  } catch (e) {
    console.error("[generate] 실패:", e);
    return Response.json(
      { error: "문서 생성 중 오류가 발생했습니다." },
      { status: 500 }
    );
  }
}
