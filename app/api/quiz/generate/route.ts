import { generateObject } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { createClient } from "@/lib/supabase/server";
import {
  quizSchema,
  buildQuizPrompt,
  fetchCategoryContext,
  splitQuestions,
  encryptAnswerKey,
} from "@/lib/quiz";
import { DEMO, demoQuizQuestions } from "@/lib/demo";

export const maxDuration = 60;

// 과정 자료를 근거로 AI가 객관식 퀴즈를 생성한다.
// 정답/해설은 암호화 토큰(token)으로만 반환하고, 보기(questions)에는 정답을 포함하지 않는다.
export async function POST(req: Request) {
  // 데모 모드: 정해진 문제 + 암호화 토큰 반환 (AI/DB 미사용)
  if (DEMO) {
    let body: { category?: string } = {};
    try {
      body = await req.json();
    } catch {
      /* noop */
    }
    const { publicQuestions, answerKey } = splitQuestions(demoQuizQuestions);
    return Response.json({
      category: body.category ?? "데모",
      questions: publicQuestions,
      token: encryptAnswerKey(answerKey),
    });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  let body: { category?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  const category = (body.category ?? "").trim();
  if (!category) return new Response("category가 필요합니다.", { status: 400 });

  const context = await fetchCategoryContext(category);
  if (!context) {
    return new Response(
      JSON.stringify({ error: "해당 분야에 인덱싱된 자료가 없어 퀴즈를 만들 수 없습니다." }),
      { status: 422, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const { object } = await generateObject({
      model: anthropic(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5"),
      schema: quizSchema,
      system: `다음은 전북소방 ${category} 분야 교육자료입니다.\n\n[참고 자료]\n${context}`,
      prompt: buildQuizPrompt(category),
      temperature: 0.4,
    });

    const { publicQuestions, answerKey } = splitQuestions(object.questions);
    const token = encryptAnswerKey(answerKey);

    // 정답은 token(암호화) 안에만 존재 — 클라이언트는 정답을 알 수 없다.
    return Response.json({ category, questions: publicQuestions, token });
  } catch (e) {
    console.error("[quiz/generate] 실패:", e);
    return new Response(
      JSON.stringify({ error: "퀴즈 생성 중 오류가 발생했습니다." }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}
