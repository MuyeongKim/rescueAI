import { describe, it, expect } from "vitest";
import {
  gradeQuiz,
  encryptAnswerKey,
  decryptAnswerKey,
  splitQuestions,
  QUIZ_PASS_PERCENT,
  type AnswerKeyItem,
  type GeneratedQuestion,
} from "@/lib/quiz";

const key: AnswerKeyItem[] = [
  { answerIndex: 0, explanation: "a", source: "문서1" },
  { answerIndex: 2, explanation: "b", source: null },
  { answerIndex: 1, explanation: "c", source: "문서2" },
  { answerIndex: 3, explanation: "d", source: null },
  { answerIndex: 0, explanation: "e", source: null },
];

describe("gradeQuiz", () => {
  it("정답 수를 세고 60% 기준으로 합격을 판정한다", () => {
    // 3/5 = 60% → 합격
    const r1 = gradeQuiz(key, [0, 2, 1, 9, 9]);
    expect(r1.score).toBe(3);
    expect(r1.total).toBe(5);
    expect(r1.passed).toBe(true);

    // 2/5 = 40% → 불합격
    const r2 = gradeQuiz(key, [0, 2, 9, 9, 9]);
    expect(r2.score).toBe(2);
    expect(r2.passed).toBe(false);
  });

  it("합격 기준은 정확히 QUIZ_PASS_PERCENT(60%)", () => {
    expect(QUIZ_PASS_PERCENT).toBe(60);
  });
});

describe("answer key 암호화 토큰", () => {
  it("암호화 후 복호화하면 원본과 같다(round-trip)", () => {
    const token = encryptAnswerKey(key);
    expect(typeof token).toBe("string");
    expect(token).not.toContain("answerIndex"); // 평문 노출 없음
    const back = decryptAnswerKey(token);
    expect(back).toEqual(key);
  });

  it("매번 다른 IV로 매번 다른 토큰을 만든다", () => {
    expect(encryptAnswerKey(key)).not.toBe(encryptAnswerKey(key));
  });

  it("변조된 토큰은 복호화에 실패한다(GCM 인증)", () => {
    const token = encryptAnswerKey(key);
    const raw = Buffer.from(token, "base64");
    raw[raw.length - 1] ^= 0xff; // 마지막 바이트 변조
    const tampered = raw.toString("base64");
    expect(() => decryptAnswerKey(tampered)).toThrow();
  });
});

describe("splitQuestions", () => {
  it("보기(public)에는 정답/해설이 없고, answerKey에만 있다", () => {
    const questions: GeneratedQuestion[] = [
      {
        question: "Q1",
        choices: ["a", "b", "c", "d"],
        answerIndex: 2,
        explanation: "해설",
        source: "문서",
      },
    ];
    const { publicQuestions, answerKey } = splitQuestions(questions);
    expect(publicQuestions[0]).toEqual({ question: "Q1", choices: ["a", "b", "c", "d"] });
    expect(publicQuestions[0]).not.toHaveProperty("answerIndex");
    expect(answerKey[0]).toEqual({ answerIndex: 2, explanation: "해설", source: "문서" });
  });
});
