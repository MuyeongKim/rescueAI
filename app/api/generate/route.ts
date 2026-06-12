import { generateObject } from "ai";
import { getChatModel } from "@/lib/llm";
import { createClient } from "@/lib/supabase/server";
import {
  AUDIENCES,
  DURATIONS,
  buildGeneratePrompt,
  generatedDocSchema,
  generatedSlidesSchema,
  type GenerateRequest,
  type GeneratedDoc,
  type GeneratedDocSource,
  type GeneratedSlideDeck,
} from "@/lib/generate";
import { DEMO, demoGeneratedDoc, demoGeneratedSlides } from "@/lib/demo";
import { ragTableEnabled, fetchRag2026Context } from "@/lib/rag2026";

export const maxDuration = 60;

// 분야 자료의 청크를 모아 생성 컨텍스트 + 출처 목록을 만든다.
async function fetchCategoryContext(
  category: string,
  limit = 40
): Promise<{ contextText: string; sources: GeneratedDocSource[] }> {
  // RAG_TABLE=rag_2026: 외부에서 임베딩해 둔 기존 테이블 사용
  if (ragTableEnabled()) return fetchRag2026Context(category, limit);

  const supabase = await createClient();
  const { data: docs } = await supabase
    .from("documents")
    .select("id, title")
    .eq("category", category)
    .limit(50);
  if (!docs || docs.length === 0) return { contextText: "", sources: [] };

  const titleById = new Map<number, string>(docs.map((d) => [d.id, d.title]));
  const { data: chunks } = await supabase
    .from("chunks")
    .select("content, page_num, document_id")
    .in("document_id", docs.map((d) => d.id))
    .limit(limit);
  if (!chunks || chunks.length === 0) return { contextText: "", sources: [] };

  const contextText = chunks
    .map(
      (c) =>
        `[${titleById.get(c.document_id ?? -1) ?? "자료"} p.${c.page_num ?? "-"}]\n${c.content}`
    )
    .join("\n\n---\n\n");

  const seen = new Set<string>();
  const sources: GeneratedDocSource[] = [];
  for (const c of chunks) {
    if (c.document_id == null) continue;
    const key = `${c.document_id}::${c.page_num ?? "-"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({
      document_id: c.document_id,
      doc: titleById.get(c.document_id) ?? "자료",
      page: c.page_num,
    });
    if (sources.length >= 5) break;
  }
  return { contextText, sources };
}

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

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

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
  };

  const { contextText, sources } = await fetchCategoryContext(category);
  if (!contextText) {
    return Response.json(
      { error: "해당 분야에 인덱싱된 자료가 없어 생성할 수 없습니다." },
      { status: 422 }
    );
  }

  try {
    const system = `다음은 전북소방 ${category} 분야 교육자료입니다. 이 자료만 근거로 작성하세요.\n\n[참고 자료]\n${contextText}`;
    const model = getChatModel();

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
