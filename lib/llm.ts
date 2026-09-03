// LLM 제공자 단일 출처 — 챗봇(/api/chat)과 AI 자료제작(/api/generate)이 공유한다.
//
// 두 가지 사용법:
//  1) 환경변수 기본값 — LLM_PROVIDER(claude|gemini|openai-compat) 로 서버 전역 기본 모델 지정
//  2) 호출부에서 모델 지정 — getChatModel("gemini-pro") 처럼 모델 키를 넘기면 그 모델 사용
//     (자료제작은 availableModels() 안에서 정밀 모델을 자동 우선하고, 튜터는 화면 선택을 유지)
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
// Gemini는 -latest 별칭 사용: 구글이 최신으로 갱신하면 코드 수정 없이 자동 추적한다.
// 실제 해석된 버전은 응답 메타데이터로 확인한다(별칭의 대상은 수시로 바뀔 수 있음).
export const MODEL_OPTIONS: ModelOption[] = [
  { key: "gemini-flash", label: "빠른 처리", provider: "gemini", model: "gemini-flash-latest", note: "신속 · 기본" },
  { key: "gemini-pro", label: "정밀 처리", provider: "gemini", model: "gemini-pro-latest", note: "품질 우선 · 다소 느림" },
  // GLM (z.ai) — openai-compat. LLM_API_URL=z.ai 엔드포인트 + LLM_API_KEY 설정 시 노출.
  // 모델명은 GLM_MODEL 로 바꿀 수 있다. 미설정 시 현재 권장 대체 모델인 GLM-5.3을 사용한다.
  { key: "glm", label: "대체 처리", provider: "openai-compat", model: process.env.GLM_MODEL || "glm-5.3", note: "관리자 연결 모델" },
  { key: "claude-sonnet-4-5", label: "심층 처리", provider: "claude", model: "claude-sonnet-4-5", note: "복합 내용 우선" },
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

// z.ai 요청 호환성 보정:
// - GLM-5.3은 thinking 비활성화를 허용하지 않으므로 항상 enabled로 보내고,
//   호출부가 별도 지정하지 않은 경우 reasoning_effort=low로 비용·지연을 제한한다.
// - 이전 GLM은 기존처럼 thinking을 명시하지 않았을 때만 disabled를 적용한다.
// - 다른 openai-compat 모델은 건드리지 않는다.
export function normalizeOpenAICompatRequestBody(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return body;

    const request = parsed as Record<string, unknown>;
    if (typeof request.model !== "string" || !request.model.startsWith("glm")) return body;

    if (request.model.startsWith("glm-5.3")) {
      const thinking = request.thinking;
      request.thinking =
        thinking && typeof thinking === "object" && !Array.isArray(thinking)
          ? { ...(thinking as Record<string, unknown>), type: "enabled" }
          : { type: "enabled" };
      if (request.reasoning_effort === undefined) request.reasoning_effort = "low";
    } else if (request.thinking === undefined) {
      request.thinking = { type: "disabled" };
    }

    return JSON.stringify(request);
  } catch {
    return body;
  }
}

const glmFetch: typeof fetch = async (input, init) => {
  if (init?.body && typeof init.body === "string") {
    init = { ...init, body: normalizeOpenAICompatRequestBody(init.body) };
  }
  return fetch(input, init);
};

function build(option: ModelOption): LanguageModelV1 {
  if (option.provider === "gemini") return google(option.model);
  if (option.provider === "claude") return anthropic(option.model);
  // openai-compat (z.ai GLM·내부망 Qwen·vLLM 등)
  const baseURL = process.env.LLM_API_URL;
  if (!baseURL) throw new Error("LLM_API_URL 가 설정되지 않았습니다 (openai-compat).");
  const compat = createOpenAI({
    baseURL,
    apiKey: process.env.LLM_API_KEY || "not-needed",
    fetch: glmFetch,
  });
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
