// 실제 6턴의 답변을 다음 질문 맥락으로 이어 검증한다. 기본 CI에서는 외부 호출도 env 로드도 하지 않는다.
// 실행: RUN_CHAT_CONVERSATION_INTEGRATION=1 npx vitest run tests/chat-conversation-live.integration.test.ts
import { closeSync, constants, existsSync, fchmodSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Database, DocSource } from "@/lib/database.types";
import type { ChatTurnKind } from "@/lib/chat-turn";
import type { ChatQueryExpansion } from "@/lib/chat-query-expansion";
import type { RetrievalCoverage } from "@/lib/rag";

vi.mock("server-only", () => ({}));
// 서버 쿠키 세션을 암묵적으로 만들지 못하게 한다. 실제 검색은 아래 읽기 전용 주입만 사용한다.
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => { throw new Error("통합 검증에는 읽기 전용 클라이언트 주입이 필요합니다."); } }));

const REPORT_PATH = "/tmp/rescue-tutor-conversation-live.json";
const CASES = [
  { question: "인명구조사 2급을 준비하려고 하는데 무엇부터 시작해야하지?", expectedKind: "learning", subject: /인명\s*구조사|구조\s*기술\s*평가|기본\s*역량\s*평가/ },
  { question: "너라면 구조기술평가 중에 어느것 부터 준비할래?", expectedKind: "learning", subject: /인명\s*구조사|구조\s*기술\s*평가|기본\s*역량\s*평가/ },
  { question: "너는 생각이 없니?", expectedKind: "feedback" },
  { question: "너는 딱 RAG된 자료에서만 답변을 하는구나?", expectedKind: "service" },
  { question: "파생되는 질문에 대한 답변을 못하는군", expectedKind: "feedback" },
  { question: "로프기술중에 가장 알아야할 부분이 어떤게 있어?", expectedKind: "learning", subject: /로프|매듭/ },
] as const;

type TurnRecord = {
  index: number;
  question: string;
  expectedKind: ChatTurnKind;
  kind?: ChatTurnKind;
  phase: "classifying" | "expanding" | "retrieving" | "generating" | "reviewing" | "checking" | "passed" | "failed";
  queryPlan?: ChatQueryExpansion;
  retrievalQuestion: string | null;
  contextText: string;
  sources: DocSource[];
  matched: number | null;
  degraded: boolean | null;
  independentEvidenceTopics?: string[];
  retrievalCoverage?: RetrievalCoverage;
  draft: string;
  answer: string;
  reviewStatus?: "verified" | "corrected" | "unverified";
  reviewChecks?: number;
  modelId?: string;
  usage?: { inputTokens: number | undefined; outputTokens: number | undefined; totalTokens: number | undefined };
  durationMs?: number;
  error?: string;
};

type ConversationReport = {
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed";
  scope: string;
  limitation: string;
  readRequests: number;
  blockedWriteRequests: number;
  error?: string;
  turns: TurnRecord[];
};

describe.skipIf(process.env.RUN_CHAT_CONVERSATION_INTEGRATION !== "1")("AI 튜터 실제 연속 대화(읽기 전용 통합)", () => {
  const envSnapshot = new Map<string, string | undefined>();
  const report: ConversationReport = {
    startedAt: "", updatedAt: "", status: "running",
    scope: "운영 자료를 읽고 실제 답변을 다음 턴에 전달하는 6개 질문. 채팅·사용자·자료 데이터 저장 없음.",
    limitation: "분류·검색 회수·저하 상태·출처·학습 라벨을 확인하는 회귀 시나리오입니다. 수치·사실·안전성 전체를 자동 검증하거나 검색 정확도를 점수화한 결과가 아닙니다. 보고서의 원문과 실제 답변을 사람이 대조해야 합니다. service-role 읽기이므로 일반 사용자 RLS 접근 검증도 별도로 필요합니다.",
    readRequests: 0, blockedWriteRequests: 0, turns: [],
  };

  function persistReport() {
    report.updatedAt = new Date().toISOString();
    // 기존 심볼릭 링크를 따라가지 않고, 이미 있던 보고서의 권한도 0600으로 제한한다.
    const fd = openSync(REPORT_PATH, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, JSON.stringify(report, null, 2) + "\n", "utf8");
    } finally {
      closeSync(fd);
    }
  }

  function failureMessage(error: unknown): string {
    let message = error instanceof Error ? `${error.name}: ${error.message}` : "통합 검증 중 오류가 발생했습니다.";
    // 제공자 오류 객체·요청 헤더·환경 파일은 출력하지 않는다. 오류 메시지도 알려진 비밀값을 제거한다.
    for (const [key, value] of Object.entries(process.env)) {
      if (/(?:KEY|TOKEN|PASSWORD|SECRET)/.test(key) && value && value.length >= 6) message = message.split(value).join("[redacted]");
    }
    return message.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [redacted]").replace(/([?&](?:key|token|apikey)=)[^&\s]+/gi, "$1[redacted]").slice(0, 3_000);
  }

  beforeAll(() => {
    report.startedAt = new Date().toISOString();
    persistReport();
    try {
      const envPath = join(process.cwd(), ".env.local");
      if (existsSync(envPath)) {
        // 셸 실행·변수 확장 없이 dotenv 문법만 파싱한다. 이미 명시한 실행 환경은 유지한다.
        for (const [key, value] of Object.entries(parseEnv(readFileSync(envPath, "utf8")))) {
          if (key in process.env) continue;
          envSnapshot.set(key, process.env[key]);
          process.env[key] = value;
        }
      }
      for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GOOGLE_GENERATIVE_AI_API_KEY"]) {
        if (!process.env[key]) throw new Error(`실제 대화 검증에 필요한 환경변수가 없습니다: ${key}`);
      }
    } catch (error) {
      report.status = "failed";
      report.error = failureMessage(error);
      persistReport();
      throw new Error(report.error);
    }
  });

  afterAll(() => {
    for (const [key, value] of envSnapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("후속 학습 질문·기능 문의·불만을 구분하고 실제 근거로 6턴을 이어간다", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const { generateText } = await import("ai");
    const { classifyChatTurn, buildDirectChatReply } = await import("@/lib/chat-turn");
    const { expandChatQuery } = await import("@/lib/chat-query-expansion");
    const { searchContext, buildSystemPrompt, NOT_FOUND_MESSAGE } = await import("@/lib/rag");
    const { buildChatAnswerPlan, answerPlanGuidance } = await import("@/lib/chat-answer-plan");
    const { getChatModel } = await import("@/lib/llm");
    const { reviewChatLearningAnswer } = await import("@/lib/chat-learning-review");
    const expectedOrigin = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).origin;

    const readOnlyFetch: typeof fetch = async (input, init) => {
      const requestUrl = new URL(input instanceof Request ? input.url : String(input));
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const isRead = (method === "GET" || method === "HEAD") && requestUrl.pathname.startsWith("/rest/v1/");
      // 기본 RAG·운영 외부 RAG에서 사용하는 읽기 RPC만 POST 허용한다.
      const isReadRpc = method === "POST" && [
        "/rest/v1/rpc/hybrid_search",
        "/rest/v1/rpc/match_rag_rescue",
        "/rest/v1/rpc/search_rag_rescue_keywords",
      ].includes(requestUrl.pathname);
      if (requestUrl.origin !== expectedOrigin || (!isRead && !isReadRpc)) {
        report.blockedWriteRequests += 1;
        persistReport();
        throw new Error("통합 검증에서 읽기 전용 범위를 벗어난 Supabase 요청을 차단했습니다.");
      }
      report.readRequests += 1;
      return fetch(input, init);
    };
    const readClient = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: readOnlyFetch } },
    );
    const history: Array<{ role: "user" | "assistant"; content: string }> = [];

    try {
      for (const [index, testCase] of CASES.entries()) {
        const startedAt = Date.now();
        const turnDeadline = startedAt + 55_000;
        const turn: TurnRecord = {
          index: index + 1, question: testCase.question, expectedKind: testCase.expectedKind,
          phase: "classifying", retrievalQuestion: null, contextText: "", sources: [], matched: null, degraded: null, draft: "", answer: "",
        };
        report.turns.push(turn);
        history.push({ role: "user", content: testCase.question });
        persistReport();
        try {
          const kind = classifyChatTurn(testCase.question);
          turn.kind = kind;
          persistReport();
          expect(kind, `turn ${index + 1}: 질문 목적`).toBe(testCase.expectedKind);
          const directReply = buildDirectChatReply(kind, history);
          if (directReply !== null) {
            turn.answer = directReply;
            turn.phase = "checking";
            persistReport();
            expect(directReply).not.toContain(NOT_FOUND_MESSAGE);
            expect(directReply).toMatch(/학습 순서|쉽게 풀어 설명|등록된 교육자료/);
            expect(turn.retrievalQuestion).toBeNull();
          } else {
            turn.phase = "expanding";
            persistReport();
            const queryPlan = await expandChatQuery(history);
            turn.queryPlan = queryPlan;
            turn.retrievalQuestion = queryPlan.retrievalQuestion;
            turn.phase = "retrieving";
            persistReport();
            if (index === 5) {
              expect(queryPlan.retrievalQuestion, "명시적으로 바뀐 로프 주제에 과거 자격·등급을 강제 재사용하지 않는다").not.toMatch(/인명\s*구조사|2\s*급/);
            }
            const result = await searchContext(queryPlan.retrievalQuestion, null, undefined, { supabase: readClient, expansion: queryPlan.expansion });
            Object.assign(turn, {
              contextText: result.contextText, sources: result.sources, matched: result.matched,
              degraded: result.degraded ?? false, independentEvidenceTopics: result.independentEvidenceTopics,
              retrievalCoverage: result.retrievalCoverage,
            });
            persistReport();
            expect(result.matched, `turn ${index + 1}: 실제 검색 회수`).toBeGreaterThan(0);
            expect(result.degraded ?? false, `turn ${index + 1}: 검색 저하`).toBe(false);
            expect(result.contextText.trim().length).toBeGreaterThan(0);
            expect(result.sources.length).toBeGreaterThan(0);
            expect(result.sources.every((source) => source.doc.trim().length > 0 && source.content.trim().length > 0)).toBe(true);
            if ("subject" in testCase) {
              expect(result.contextText, `turn ${index + 1}: 요청 주제 원문`).toMatch(testCase.subject);
              expect(result.sources.some((source) => testCase.subject.test(`${source.doc}\n${source.content}`)), `turn ${index + 1}: 요청 주제 출처`).toBe(true);
            }
            const answerPlan = buildChatAnswerPlan(queryPlan.retrievalQuestion, { learningAdvice: kind === "learning" });
            expect(answerPlan.mode).toBe("learning");
            const system = buildSystemPrompt(
              result.contextText, answerPlanGuidance(answerPlan), result.independentEvidenceTopics ?? [], result.retrievalCoverage,
              { learningAdvice: kind === "learning", retrievalQuestion: queryPlan.retrievalQuestion },
            );
            turn.phase = "generating";
            persistReport();
            const generated = await generateText({
              model: getChatModel("gemini-flash"), system, messages: history,
              temperature: 0.2, maxRetries: 0,
              abortSignal: AbortSignal.timeout(Math.max(1, Math.min(30_000, turnDeadline - Date.now() - 4_000))),
            });
            turn.draft = generated.text;
            turn.modelId = generated.response.modelId;
            turn.usage = generated.usage;
            turn.phase = "reviewing";
            persistReport();
            expect(generated.text).not.toContain(NOT_FOUND_MESSAGE);
            const reviewed = await reviewChatLearningAnswer(generated.text, result.contextText, { deadline: turnDeadline });
            turn.reviewStatus = reviewed.status;
            turn.reviewChecks = reviewed.checks;
            turn.answer = reviewed.text;
            turn.phase = "checking";
            persistReport();
            expect(["verified", "corrected"], `turn ${index + 1}: 공개 전 원문 검토`).toContain(reviewed.status);
            expect(reviewed.text).not.toContain(NOT_FOUND_MESSAGE);
            expect(reviewed.text).toContain("자료에서 확인한 내용");
            expect(reviewed.text).toContain("AI 학습 순서 제안");
            expect(reviewed.text).not.toMatch(/\[[^\]\r\n]+ p\.\d+\]/);
          }
          history.push({ role: "assistant", content: turn.answer });
          turn.phase = "passed";
          turn.durationMs = Date.now() - startedAt;
          persistReport();
          console.info("[chat-conversation-live]", { turn: turn.index, kind, matched: turn.matched, degraded: turn.degraded, sourceCount: turn.sources.length, review: turn.reviewStatus, reviewChecks: turn.reviewChecks, durationMs: turn.durationMs });
        } catch (error) {
          turn.phase = "failed";
          turn.durationMs = Date.now() - startedAt;
          turn.error = failureMessage(error);
          report.status = "failed";
          persistReport();
          throw new Error(turn.error);
        }
      }
      expect(report.turns).toHaveLength(6);
      expect(history).toHaveLength(12);
      expect(report.blockedWriteRequests).toBe(0);
      expect(report.readRequests).toBeGreaterThan(0);
      report.status = "passed";
    } catch (error) {
      report.status = "failed";
      report.error = failureMessage(error);
      throw new Error(report.error);
    } finally {
      report.finishedAt = new Date().toISOString();
      persistReport();
    }
  }, 360_000);
});
