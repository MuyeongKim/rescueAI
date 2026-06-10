import crypto from "node:crypto";
import { z } from "zod";

export const QUIZ_SIZE = 5;
export const QUIZ_PASS_PERCENT = 60;

// AI가 생성할 퀴즈 구조 (generateObject 스키마)
export const quizSchema = z.object({
  questions: z
    .array(
      z.object({
        question: z.string().describe("한국어 객관식 문제"),
        choices: z.array(z.string()).length(4).describe("보기 4개"),
        answerIndex: z.number().int().min(0).max(3).describe("정답 보기 인덱스(0~3)"),
        explanation: z.string().describe("정답 해설(한국어)"),
        source: z.string().optional().describe("근거가 된 문서명"),
      })
    )
    .length(QUIZ_SIZE),
});

export type GeneratedQuiz = z.infer<typeof quizSchema>;
export type GeneratedQuestion = GeneratedQuiz["questions"][number];

// 클라이언트로 내려가는 문제(정답 없음)
export type PublicQuestion = { question: string; choices: string[] };
// 서버만 보유하는 정답키 (암호화 토큰으로만 왕복)
export type AnswerKeyItem = {
  answerIndex: number;
  explanation: string;
  source: string | null;
};

export function splitQuestions(questions: GeneratedQuestion[]): {
  publicQuestions: PublicQuestion[];
  answerKey: AnswerKeyItem[];
} {
  return {
    publicQuestions: questions.map((q) => ({
      question: q.question,
      choices: q.choices,
    })),
    answerKey: questions.map((q) => ({
      answerIndex: q.answerIndex,
      explanation: q.explanation,
      source: q.source ?? null,
    })),
  };
}

// ── 정답키 암호화(AES-256-GCM) ─────────────────────────────
// 정답이 클라이언트에 평문으로 노출되지 않도록 암호화된 토큰으로만 오간다.
function cryptoKey(): Buffer {
  const secret =
    process.env.QUIZ_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "dev-insecure-secret-change-me";
  return crypto.createHash("sha256").update(secret).digest();
}

export function encryptAnswerKey(items: AnswerKeyItem[]): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", cryptoKey(), iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(items), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptAnswerKey(token: string): AnswerKeyItem[] {
  const raw = Buffer.from(token, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", cryptoKey(), iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(dec.toString("utf8")) as AnswerKeyItem[];
}

// 카테고리 자료(청크)를 모아 퀴즈 출제 근거 컨텍스트로 만든다.
export async function fetchCategoryContext(
  category: string,
  limit = 30
): Promise<string> {
  // 서버 전용 모듈을 지연 import (테스트에서 이 파일을 안전하게 import 하기 위함)
  const { createClient } = await import("@/lib/supabase/server");
  const supabase = await createClient();
  const { data: docs } = await supabase
    .from("documents")
    .select("id, title")
    .eq("category", category)
    .limit(50);
  if (!docs || docs.length === 0) return "";

  const titleById = new Map<number, string>(docs.map((d) => [d.id, d.title]));
  const ids = docs.map((d) => d.id);

  const { data: chunks } = await supabase
    .from("chunks")
    .select("content, page_num, document_id")
    .in("document_id", ids)
    .limit(limit);
  if (!chunks || chunks.length === 0) return "";

  return chunks
    .map(
      (c) =>
        `[${titleById.get(c.document_id ?? -1) ?? "자료"} p.${
          c.page_num ?? "-"
        }]\n${c.content}`
    )
    .join("\n\n---\n\n");
}

export function buildQuizPrompt(category: string): string {
  return `아래 '참고 자료'만 근거로 전북소방 ${category} 분야 구조 교육 ${QUIZ_SIZE}문항 객관식 퀴즈를 출제하세요.

[규칙]
- 각 문항: 보기 4개(choices), 정답 인덱스(answerIndex 0~3), 한국어 해설(explanation).
- 참고 자료에 실제로 있는 내용만 출제. 자료에 없으면 만들지 마세요(추측 금지).
- source 에는 근거가 된 문서명을 적으세요.
- 현장 안전·절차·장비 운용 등 실무에서 중요한 내용 위주로 출제하세요.`;
}

export function gradeQuiz(
  answerKey: { answerIndex: number }[],
  answers: number[]
): { score: number; total: number; passed: boolean } {
  const total = answerKey.length;
  let score = 0;
  for (let i = 0; i < total; i++) {
    if (answers[i] === answerKey[i].answerIndex) score++;
  }
  const passed = total > 0 && (score / total) * 100 >= QUIZ_PASS_PERCENT;
  return { score, total, passed };
}
