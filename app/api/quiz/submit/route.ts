import { createClient } from "@/lib/supabase/server";
import { gradeQuiz, decryptAnswerKey, type PublicQuestion } from "@/lib/quiz";
import { DEMO } from "@/lib/demo";
import type { QuizQuestionRecord } from "@/lib/database.types";

// 퀴즈 제출 → 토큰 복호화 후 서버에서 채점 → quiz_attempts 기록(이수 판정).
// 정답은 token 안에만 있으므로 클라이언트가 조작할 수 없다.
export async function POST(req: Request) {
  let body: {
    category?: string;
    questions?: PublicQuestion[];
    token?: string;
    answers?: number[];
  };
  try {
    body = await req.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  // 데모 모드: 채점·해설 반환 (DB 기록 생략)
  if (DEMO) {
    const questions = body.questions ?? [];
    const answers = body.answers ?? [];
    let answerKey;
    try {
      answerKey = decryptAnswerKey(body.token ?? "");
    } catch {
      return new Response("유효하지 않은 퀴즈 토큰입니다.", { status: 400 });
    }
    const { score, total, passed } = gradeQuiz(answerKey, answers);
    const recorded: QuizQuestionRecord[] = questions.map((q, i) => ({
      question: q.question,
      choices: q.choices,
      answerIndex: answerKey[i].answerIndex,
      explanation: answerKey[i].explanation,
      source: answerKey[i].source,
      selected: typeof answers[i] === "number" ? answers[i] : null,
    }));
    return Response.json({ score, total, passed, questions: recorded });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });

  const category = (body.category ?? "").trim();
  const questions = body.questions ?? [];
  const answers = body.answers ?? [];
  const token = body.token ?? "";
  if (!category || questions.length === 0 || !token) {
    return new Response("category, questions, token이 필요합니다.", { status: 400 });
  }

  // 토큰 복호화 (변조/위조 시 실패)
  let answerKey;
  try {
    answerKey = decryptAnswerKey(token);
  } catch {
    return new Response("유효하지 않은 퀴즈 토큰입니다.", { status: 400 });
  }
  if (answerKey.length !== questions.length) {
    return new Response("문항 수가 토큰과 일치하지 않습니다.", { status: 400 });
  }

  // 서버 채점
  const { score, total, passed } = gradeQuiz(answerKey, answers);

  // 저장/리뷰용 전체 문항 재구성 (정답·해설 포함)
  const recorded: QuizQuestionRecord[] = questions.map((q, i) => ({
    question: q.question,
    choices: q.choices,
    answerIndex: answerKey[i].answerIndex,
    explanation: answerKey[i].explanation,
    source: answerKey[i].source,
    selected: typeof answers[i] === "number" ? answers[i] : null,
  }));

  const { error } = await supabase.from("quiz_attempts").insert({
    user_id: user.id,
    category,
    score,
    total,
    passed,
    questions: recorded,
  });
  if (error) {
    console.error("[quiz/submit] 저장 실패:", error.message);
    return new Response("저장 실패", { status: 500 });
  }

  // 채점 후에는 정답/해설을 돌려줘 리뷰 화면에 표시
  return Response.json({ score, total, passed, questions: recorded });
}
