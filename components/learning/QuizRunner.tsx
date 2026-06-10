"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Award,
  RotateCcw,
  AlertTriangle,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type PublicQuestion = { question: string; choices: string[] };
type ReviewQuestion = PublicQuestion & {
  answerIndex: number;
  explanation: string;
  source?: string | null;
  selected?: number | null;
};

type Phase = "loading" | "quiz" | "result" | "error";

const PASS = 60;

export function QuizRunner({ category }: { category: string }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [questions, setQuestions] = useState<PublicQuestion[]>([]);
  const [token, setToken] = useState("");
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [review, setReview] = useState<ReviewQuestion[] | null>(null);
  const [result, setResult] = useState<{
    score: number;
    total: number;
    passed: boolean;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const generate = useCallback(async () => {
    setPhase("loading");
    setResult(null);
    setReview(null);
    try {
      const res = await fetch("/api/quiz/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrorMsg(data.error || "퀴즈를 생성할 수 없습니다.");
        setPhase("error");
        return;
      }
      const data = (await res.json()) as {
        questions: PublicQuestion[];
        token: string;
      };
      setQuestions(data.questions);
      setToken(data.token);
      setAnswers(new Array(data.questions.length).fill(null));
      setPhase("quiz");
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [category]);

  useEffect(() => {
    generate();
  }, [generate]);

  function select(qi: number, ci: number) {
    setAnswers((prev) => {
      const next = [...prev];
      next[qi] = ci;
      return next;
    });
  }

  async function submit() {
    if (answers.some((a) => a === null)) {
      toast.error("모든 문항에 답해주세요.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/quiz/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category, questions, token, answers }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = (await res.json()) as {
        score: number;
        total: number;
        passed: boolean;
        questions: ReviewQuestion[];
      };
      setResult({ score: data.score, total: data.total, passed: data.passed });
      setReview(data.questions);
      setPhase("result");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      toast.error("제출 실패", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubmitting(false);
    }
  }

  if (phase === "loading") {
    return (
      <div className="flex flex-col items-center gap-3 py-20 text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
        AI가 자료를 바탕으로 문제를 만들고 있습니다…
      </div>
    );
  }

  if (phase === "error") {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
          <AlertTriangle className="h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">{errorMsg}</p>
          <div className="flex gap-2">
            <Button onClick={generate} className="h-11 gap-2">
              <RotateCcw className="h-4 w-4" /> 다시 시도
            </Button>
            <Link href={`/courses/${encodeURIComponent(category)}`}>
              <Button variant="outline" className="h-11">
                과정으로
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }

  const showResult = phase === "result" && result !== null && review !== null;
  const rows: (PublicQuestion | ReviewQuestion)[] = showResult ? review! : questions;

  return (
    <div className="space-y-4">
      {showResult && (
        <Card
          className={cn(
            "border-2",
            result!.passed ? "border-primary" : "border-destructive/50"
          )}
        >
          <CardContent className="flex flex-col items-center gap-2 py-6 text-center">
            {result!.passed ? (
              <Award className="h-10 w-10 text-primary" />
            ) : (
              <XCircle className="h-10 w-10 text-destructive" />
            )}
            <p className="text-2xl font-bold">
              {result!.score} / {result!.total}
            </p>
            <p
              className={cn(
                "text-base font-medium",
                result!.passed ? "text-primary" : "text-destructive"
              )}
            >
              {result!.passed
                ? "합격 — 이 과정을 이수했습니다! 🎉"
                : `불합격 (합격 기준 ${PASS}%)`}
            </p>
          </CardContent>
        </Card>
      )}

      {rows.map((q, qi) => {
        const sel = answers[qi];
        const answerIndex = showResult
          ? (q as ReviewQuestion).answerIndex
          : -1;
        return (
          <Card key={qi}>
            <CardContent className="space-y-3 p-4">
              <p className="font-medium">
                {qi + 1}. {q.question}
              </p>
              <div className="space-y-2">
                {q.choices.map((choice, ci) => {
                  const isSel = sel === ci;
                  const isCorrect = showResult && ci === answerIndex;
                  let state = "idle";
                  if (showResult) {
                    if (isCorrect) state = "correct";
                    else if (isSel) state = "wrong";
                  } else if (isSel) {
                    state = "selected";
                  }
                  return (
                    <button
                      key={ci}
                      type="button"
                      disabled={showResult}
                      onClick={() => select(qi, ci)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-base transition-colors",
                        state === "idle" && "hover:bg-accent",
                        state === "selected" && "border-primary bg-primary/10",
                        state === "correct" && "border-primary bg-primary/10",
                        state === "wrong" && "border-destructive bg-destructive/10"
                      )}
                    >
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs">
                        {String.fromCharCode(9312 + ci)}
                      </span>
                      <span className="min-w-0 flex-1">{choice}</span>
                      {showResult && isCorrect && (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                      )}
                      {showResult && state === "wrong" && (
                        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
                      )}
                    </button>
                  );
                })}
              </div>
              {showResult && (
                <div className="rounded-md bg-muted/50 p-3 text-sm">
                  <span className="font-medium">해설 </span>
                  {(q as ReviewQuestion).explanation}
                  {(q as ReviewQuestion).source && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      근거: {(q as ReviewQuestion).source}
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      {!showResult ? (
        <Button onClick={submit} disabled={submitting} className="h-12 w-full text-base">
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          제출하고 채점하기
        </Button>
      ) : (
        <div className="flex gap-2">
          <Button onClick={generate} variant="outline" className="h-12 flex-1 gap-2">
            <RotateCcw className="h-4 w-4" /> 새 문제로 다시 풀기
          </Button>
          <Link href={`/courses/${encodeURIComponent(category)}`} className="flex-1">
            <Button className="h-12 w-full">과정으로 돌아가기</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
