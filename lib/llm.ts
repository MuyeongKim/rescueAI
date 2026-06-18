// LLM 제공자 단일 출처 — 챗봇(/api/chat)과 AI 자료제작(/api/generate)이 공유한다.
//
// 두 가지 사용법:
//  1) 환경변수 기본값 — LLM_PROVIDER(claude|gemini|openai-compat) 로 서버 전역 기본 모델 지정
//  2) 폼에서 모델 선택 — getChatModel("gemini-2.5-pro") 처럼 모델 키를 넘기면 그 모델 사용
//     (선택지는 MODEL_OPTIONS 중 자격증명이 갖춰진 것만 availableModels() 가 노출)
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";

type Provider = "claude" | "gemini" | "openai-compat";

export type ModelOption = {
  key: string; // 폼·API에서 쓰는 식별자
  label: string; // 화면 표시명
  provider: Provider;
  model: string; // 실제 모델 ID (openai-compat는 LLM_MODEL 로 대체)
  note?: string; // 선택 화면 보조 설명
};

// 선택 가능 후보 — 실제 노출은 availableModels() 가 자격증명 유무로 필터링한다.
// Gemini는 -latest 별칭 사용: 구글이 최신으로 갱신하면 코드 수정 없이 자동 추적
// (현재 flash-latest→gemini-3.5-flash, pro-latest→gemini-3.1-pro-preview).
export const MODEL_OPTIONS: ModelOption[] = [
  { key: "gemini-flash", label: "Gemini Flash", provider: "gemini", model: "gemini-flash-latest", note: "빠름 · 기본" },
  { key: "gemini-pro", label: "Gemini Pro", provider: "gemini", model: "gemini-pro-latest", note: "고품질 · 느림" },
  // GLM (z.ai) — openai-compat. LLM_API_URL=z.ai 엔드포인트 + LLM_API_KEY 설정 시 노출.
  // 모델명은 GLM_MODEL 로 바꿀 수 있다(z.ai 대시보드 기준, 예: glm-4.6/glm-4.7/glm-4.7-flash).
  { key: "glm", label: "GLM (z.ai)", provider: "openai-compat", model: process.env.GLM_MODEL || "glm-4.6", note: "z.ai" },
  { key: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", provider: "claude", model: "claude-sonnet-4-5", note: "고품질" },
  // ※ 내부망 이전 시: openai-compat 슬롯(LLM_API_URL)을 내부 Qwen으로 가리키고 위 GLM 옵션을 Qwen으로 교체.
];

function providerReady(p: Provider): boolean {
  if (p === "gemini") return !!process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (p === "claude") return !!process.env.ANTHROPIC_API_KEY;
  if (p === "openai-compat") return !!process.env.LLM_API_URL;
  return false;
}

// 폼에 보여줄 모델 목록 — 키/주소가 설정된 제공자만. (서버에서만 호출: 자격증명 확인)
export function availableModels(): { key: string; label: string; note?: string }[] {
  return MODEL_OPTIONS.filter((m) => providerReady(m.provider)).map((m) => ({
    key: m.key,
    label: m.label,
    note: m.note,
  }));
}

function build(option: ModelOption): LanguageModelV1 {
  if (option.provider === "gemini") return google(option.model);
  if (option.provider === "claude") return anthropic(option.model);
  // openai-compat (내부망 Qwen·Ollama /v1·vLLM 등)
  const baseURL = process.env.LLM_API_URL;
  if (!baseURL) throw new Error("LLM_API_URL 가 설정되지 않았습니다 (openai-compat).");
  const compat = createOpenAI({ baseURL, apiKey: process.env.LLM_API_KEY || "not-needed" });
  return compat(option.model || process.env.LLM_MODEL || "qwen3.5");
}

// 환경변수 기본 제공자에 해당하는 모델 옵션 (모델 키 미지정 시 사용)
function defaultOption(): ModelOption {
  const provider = (process.env.LLM_PROVIDER as Provider) || "claude";
  if (provider === "gemini")
    return { key: "default", label: "Gemini", provider, model: process.env.GEMINI_MODEL || "gemini-flash-latest" };
  if (provider === "openai-compat")
    return { key: "default", label: "내부망", provider, model: process.env.LLM_MODEL || "qwen3.5" };
  return { key: "default", label: "Claude", provider, model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5" };
}

// 모델 키가 오면 그 모델을, 없거나 사용 불가하면 환경변수 기본값을 반환한다.
export function getChatModel(modelKey?: string): LanguageModelV1 {
  if (modelKey) {
    const opt = MODEL_OPTIONS.find((m) => m.key === modelKey);
    if (opt && providerReady(opt.provider)) return build(opt);
  }
  return build(defaultOption());
}
