// LLM 제공자 단일 출처 — 챗봇(/api/chat)과 AI 자료제작(/api/generate)이 공유한다.
// LLM_PROVIDER=gemini | claude (기본 claude). 내부망 이관 시 OpenAI 호환(Qwen 등) 추가 예정.
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import type { LanguageModelV1 } from "ai";

export function getChatModel(): LanguageModelV1 {
  const provider = process.env.LLM_PROVIDER || "claude";

  if (provider === "gemini") {
    // GOOGLE_GENERATIVE_AI_API_KEY 환경변수를 사용한다 (@ai-sdk/google 기본)
    return google(process.env.GEMINI_MODEL || "gemini-2.5-flash");
  }
  return anthropic(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5");
}
