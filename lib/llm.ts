// LLM 제공자 단일 출처 — 챗봇(/api/chat)과 AI 자료제작(/api/generate)이 공유한다.
// LLM_PROVIDER:
//   claude        Anthropic API (기본)
//   gemini        Google Gemini API (외부망 테스트 — 기존 챗봇과 동일)
//   openai-compat OpenAI 호환 서버 (내부망 Qwen, Ollama /v1, vLLM 등 — LLM_API_URL 필요)
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";

export function getChatModel(): LanguageModelV1 {
  const provider = process.env.LLM_PROVIDER || "claude";

  if (provider === "gemini") {
    // GOOGLE_GENERATIVE_AI_API_KEY 환경변수를 사용한다 (@ai-sdk/google 기본)
    return google(process.env.GEMINI_MODEL || "gemini-2.5-flash");
  }

  if (provider === "openai-compat") {
    const baseURL = process.env.LLM_API_URL;
    if (!baseURL) {
      throw new Error("LLM_API_URL 가 설정되지 않았습니다 (LLM_PROVIDER=openai-compat).");
    }
    // 예: 내부망 Qwen — LLM_API_URL=http://10.x.x.x:11434/v1, LLM_MODEL=qwen3.5
    const compat = createOpenAI({
      baseURL,
      apiKey: process.env.LLM_API_KEY || "not-needed",
    });
    return compat(process.env.LLM_MODEL || "qwen3.5");
  }

  return anthropic(process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5");
}
