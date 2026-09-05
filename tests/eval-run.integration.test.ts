// 앱의 검색문 복원·답변 계획·RAG·모델을 사용하는 결정론적 기준 점검.
// HTTP 인증/저장은 별도 검사이며, 점검률은 사실 정확도를 뜻하지 않는다.
//   RUN_INTEGRATION=1 npx vitest run tests/eval-run.integration.test.ts --reporter=verbose
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, dirname, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, beforeAll, expect, vi } from "vitest";
import { convertToCoreMessages, generateText, type Message } from "ai";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database, DocSource } from "@/lib/database.types";
import type { RetrievalCoverage } from "@/lib/rag";
import { scoreTutorEvalAnswer, tutorEvalCaseSchema, type TutorEvalCheck } from "@/eval/scoring";
import { trimChatHistory } from "@/lib/chat-history";
import { prepareChatAnswerText } from "@/lib/chat-answer";
import { buildRetrievalQuestion } from "@/lib/chat-retrieval-query";
import { answerPlanGuidance, buildChatAnswerPlan } from "@/lib/chat-answer-plan";

// CLI 통합 평가는 서버 로직을 직접 호출하므로 Next 빌드의 경계 마커만 대체한다.
vi.mock("server-only", () => ({}));

type EvaluationReportEntry = {
  question: string;
  category: string | null;
  expectation: string;
  retrievalQuestion: string | null;
  answer: string | null;
  contextText: string | null;
  sources: DocSource[];
  matched: number | null;
  degraded: boolean | null;
  independentEvidenceTopics: string[];
  retrievalCoverage: RetrievalCoverage | null;
  checks: TutorEvalCheck[];
  passed: boolean;
  status: "pending" | "scored" | "error";
  errorStage?: "retrieval" | "answer" | "scoring";
};

type EvaluationReport = {
  version: 1;
  startedAt: string;
  total: number;
  results: EvaluationReportEntry[];
};

function evaluationReportPath(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const file = resolve(value);
  const fromRepository = relative(process.cwd(), file);
  if (!isAbsolute(value) || (fromRepository !== ".." && !fromRepository.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(fromRepository))) {
    throw new Error("EVAL_REPORT_FILE은 저장소 밖의 절대 파일 경로여야 합니다.");
  }
  return file;
}

function persistEvaluationReport(file: string | undefined, report: EvaluationReport): void {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  // 아래 허용된 평가 필드만 전달한다. env·클라이언트·모델 응답 객체·오류 원문은 저장하지 않는다.
  writeFileSync(file, `${JSON.stringify({ ...report, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

describe("튜터 점검 산출물", () => {
  it("명시한 저장소 밖 경로에 전체 답변·근거·실패 항목을 보존한다", () => {
    const directory = mkdtempSync(join(tmpdir(), "rescue-eval-report-"));
    try {
      const file = evaluationReportPath(join(directory, "nested", "report.json"));
      const answer = "긴 답변의 원문과 미확인 범위. ".repeat(100);
      const report: EvaluationReport = {
        version: 1, startedAt: "2026-09-05T00:00:00.000Z", total: 1,
        results: [{
          question: "질문", category: null, expectation: "partial", retrievalQuestion: "질문",
          answer, contextText: "검색 원문", sources: [{ document_id: 54, doc: "구급 자료", page: 270, content: "인용문" }],
          matched: 1, degraded: false, independentEvidenceTopics: ["관통상"],
          retrievalCoverage: { requested: ["관통상", "매달림"], missing: ["매달림"], supplementalQueries: 1 },
          checks: [{ label: "미확인 범위 명시", passed: false }], passed: false, status: "scored",
        }],
      };
      persistEvaluationReport(file, report);
      const saved = JSON.parse(readFileSync(file!, "utf-8"));
      expect(saved.results).toEqual(report.results);
      expect(saved.results[0].answer.length).toBeGreaterThan(800);
      expect(Object.keys(saved).sort()).toEqual(["results", "startedAt", "total", "updatedAt", "version"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("미설정 시 기록하지 않고 저장소 안 경로는 거부한다", () => {
    expect(evaluationReportPath(undefined)).toBeUndefined();
    expect(() => evaluationReportPath("eval/report.json")).toThrow("저장소 밖");
    expect(() => evaluationReportPath(join(process.cwd(), "eval/report.json"))).toThrow("저장소 밖");
  });
});

function loadEnv() {
  for (const line of readFileSync(join(process.cwd(), ".env.local"), "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

function createEvaluationSupabaseClient() {
  if (process.env.NODE_ENV !== "test" || process.env.RUN_INTEGRATION !== "1") {
    throw new Error("service-role 평가 클라이언트는 명시적인 통합 테스트에서만 사용할 수 있습니다.");
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("평가에 NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY가 필요합니다.");
  }
  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const integrationTimeoutMs = Math.max(
  60_000,
  Number(process.env.EVAL_TIMEOUT_MS) || 600_000
);

describe.skipIf(process.env.RUN_INTEGRATION !== "1")("튜터 자동 기준 점검", () => {
  beforeAll(loadEnv);

  it("eval 문항별 답변·검색 근거 기준 충족률", async () => {
    const file = process.env.EVAL_FILE || "eval/questions.example.jsonl";
    const { searchContext, buildSystemPrompt, DEFAULT_TOP_K, NOT_FOUND_MESSAGE } = await import("@/lib/rag");
    const { getChatModel } = await import("@/lib/llm");
    // Vitest/CLI에는 Next.js 요청 쿠키가 없다. 평가 파일에서만 service role을 명시적으로
    // 주입하고, 앱의 기본 호출은 계속 쿠키 세션 + RLS 경로를 사용한다.
    const evaluationSupabase = createEvaluationSupabaseClient();

    const items = readFileSync(file, "utf-8")
      .split("\n").map((l) => l.trim()).filter(Boolean).map((l) => tutorEvalCaseSchema.parse(JSON.parse(l)));
    expect(items.length, "평가 파일에 문항이 없습니다.").toBeGreaterThan(0);

    const reportFile = evaluationReportPath(process.env.EVAL_REPORT_FILE);
    const report: EvaluationReport = {
      version: 1, startedAt: new Date().toISOString(), total: items.length, results: [],
    };
    // 경로·쓰기 오류는 유료 검색/생성을 시작하기 전에 드러낸다.
    persistEvaluationReport(reportFile, report);
    let pass = 0;
    console.log(`\n자동 기준 점검 시작: ${items.length}문항 (${file}) — 사실 정확도는 별도 사람 검토가 필요합니다.\n`);
    for (let i = 0; i < items.length; i++) {
      const q = items[i];
      const entry: EvaluationReportEntry = {
        question: q.question, category: q.category ?? null, expectation: q.expect,
        retrievalQuestion: null, answer: null, contextText: null, sources: [], matched: null,
        degraded: null, independentEvidenceTopics: [], retrievalCoverage: null,
        checks: [], passed: false, status: "pending",
      };
      report.results.push(entry);
      let stage: "retrieval" | "answer" | "scoring" = "retrieval";
      try {
        const messages = trimChatHistory<Message>([
          ...q.history, { role: "user", content: q.question },
        ]).map((message) => message.role === "assistant"
          ? { ...message, content: prepareChatAnswerText(message.content) } : message);
        const retrievalQuestion = buildRetrievalQuestion(messages);
        entry.retrievalQuestion = retrievalQuestion;
        const r = await searchContext(retrievalQuestion, q.category || null, DEFAULT_TOP_K, {
          supabase: evaluationSupabase,
        });
        Object.assign(entry, {
          contextText: r.contextText, matched: r.matched, degraded: r.degraded ?? false,
          sources: r.sources.map(({ document_id, doc, page, content }) => ({ document_id, doc, page, content })),
          independentEvidenceTopics: r.independentEvidenceTopics ?? [],
          retrievalCoverage: r.retrievalCoverage ? {
            requested: r.retrievalCoverage.requested, missing: r.retrievalCoverage.missing,
            supplementalQueries: r.retrievalCoverage.supplementalQueries,
          } : null,
        });
        persistEvaluationReport(reportFile, report);
        stage = "answer";
        // 운영 채팅과 동일하게 근거가 비어 있으면 답변 모델을 호출하지 않는다.
        const text = r.contextText.trim()
          ? (await generateText({
              model: getChatModel(),
              system: buildSystemPrompt(r.contextText, answerPlanGuidance(buildChatAnswerPlan(retrievalQuestion)), r.independentEvidenceTopics, r.retrievalCoverage),
              messages: convertToCoreMessages(messages),
              temperature: 0.2,
            })).text
          : NOT_FOUND_MESSAGE;
        entry.answer = text;
        stage = "scoring";
        const result = scoreTutorEvalAnswer(q, prepareChatAnswerText(text), { ...r, retrievalQuestion });
        entry.checks = result.checks.map(({ label, passed }) => ({ label, passed }));
        entry.passed = result.passed;
        entry.status = "scored";
        if (result.passed) pass++;
        console.log(`[${i + 1}/${items.length}] ${result.passed ? "✓" : "✗"} ${q.question}`);
        if (!result.passed) console.log({
          failedChecks: result.checks.filter((check) => !check.passed).map((check) => check.label),
          retrievalQuestion, matched: r.matched, degraded: r.degraded ?? false,
          answer: text.slice(0, 500),
        });
      } catch (e) {
        entry.status = "error";
        entry.errorStage = stage;
        console.log(`[${i + 1}/${items.length}] ✗ (오류) ${q.question}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        persistEvaluationReport(reportFile, report);
      }
    }
    const rate = Math.round((pass / items.length) * 100);
    const minimum = Number(process.env.EVAL_MIN_CHECK_RATE ?? process.env.EVAL_MIN_ACCURACY ?? 60);
    console.log(`\n자동 기준 충족률(점검률): ${pass}/${items.length} = ${rate}%  (기준 ${minimum}% 이상)`);
    expect(Number.isFinite(minimum) && minimum >= 0 && minimum <= 100).toBe(true);
    expect(rate).toBeGreaterThanOrEqual(minimum);
  }, integrationTimeoutMs);
});
