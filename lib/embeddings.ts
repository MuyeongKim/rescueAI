import OpenAI from "openai";
import { embed } from "ai";
import { google } from "@ai-sdk/google";

// 임베딩 차원 — DB 스키마 vector(1024) 와 반드시 일치해야 한다.
export const EMBEDDING_DIM = 1024;

type Provider = "auto" | "google" | "openai" | "bge" | "ollama";

function getProvider(): Provider {
  return (process.env.EMBEDDING_PROVIDER as Provider) || "google";
}

// auto 모드: Ollama 실패 시 이 시각까지는 재시도 없이 바로 Google 폴백(요청마다 타임아웃 대기 방지)
let ollamaDownUntil = 0;
const OLLAMA_RETRY_MS = 60_000;

// auto — Ollama(홈서버) 우선, 실패하면 Google 폴백.
// 주의: DB 벡터가 bge-m3(Ollama)로 적재돼 있으면 Google 쿼리와는 호환되지 않아
// 폴백 중에는 검색 품질이 무의미해진다. 폴백은 "앱이 죽지 않게 하는" 용도이며 경고를 남긴다.
async function embedAuto(text: string): Promise<number[]> {
  if (Date.now() >= ollamaDownUntil) {
    try {
      return await embedOllama(text);
    } catch (e) {
      ollamaDownUntil = Date.now() + OLLAMA_RETRY_MS;
      console.warn(
        `[embeddings] Ollama 실패 — ${OLLAMA_RETRY_MS / 1000}초간 Google 폴백:`,
        e instanceof Error ? e.message : e
      );
      console.warn(
        "[embeddings] 주의: DB가 bge-m3 벡터라면 Google 쿼리로는 검색이 맞지 않습니다."
      );
    }
  }
  return embedGoogle(text);
}

// 쿼리 한 건을 1024차원 벡터로 임베딩한다. 인덱서와 동일한 제공자/모델을 사용해야 한다.
export async function getQueryEmbedding(text: string): Promise<number[]> {
  const provider = getProvider();
  const vec =
    provider === "auto"
      ? await embedAuto(text)
      : provider === "google"
        ? await embedGoogle(text)
        : provider === "bge"
          ? await embedBGE(text)
          : provider === "ollama"
            ? await embedOllama(text)
            : await embedOpenAI(text);

  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `임베딩 차원 불일치: ${vec.length} (기대값 ${EMBEDDING_DIM}). EMBEDDING_PROVIDER/모델 설정을 확인하세요.`
    );
  }
  return vec;
}

// Google Generative AI 임베딩 (기본, gemini-embedding-001).
// gemini-embedding-001 은 기본 3072차원이나 MRL(Matryoshka)로 1024차원으로 절단해 스키마와 맞춘다.
// 쿼리 임베딩이므로 taskType=RETRIEVAL_QUERY — 적재기(rag7.py)는 RETRIEVAL_DOCUMENT 로 넣어야 대칭이 맞다.
// (절단 벡터는 정규화가 풀리지만 pgvector 코사인거리 <=> 는 스케일 불변이라 검색 순위에 영향 없음.)
async function embedGoogle(text: string): Promise<number[]> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error(
      "GOOGLE_GENERATIVE_AI_API_KEY 가 설정되지 않았습니다 (EMBEDDING_PROVIDER=google)."
    );
  }
  const model = process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001";
  const { embedding } = await embed({
    model: google.textEmbeddingModel(model, {
      outputDimensionality: EMBEDDING_DIM,
      taskType: "RETRIEVAL_QUERY",
    }),
    value: text,
  });
  return embedding;
}

let _openai: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY 가 설정되지 않았습니다.");
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

async function embedOpenAI(text: string): Promise<number[]> {
  const model = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const res = await openaiClient().embeddings.create({
    model,
    input: text,
    dimensions: EMBEDDING_DIM, // text-embedding-3-* 는 차원 축소 지원
  });
  return res.data[0].embedding;
}

// 자체 호스팅 BGE-M3 임베딩 서비스 호출 (indexing/serve.py 와 호환)
// POST {EMBEDDING_API_URL}/embed  body: {"texts": [text]} -> {"embeddings": [[...1024...]]}
async function embedBGE(text: string): Promise<number[]> {
  const base = process.env.EMBEDDING_API_URL;
  if (!base) throw new Error("EMBEDDING_API_URL 가 설정되지 않았습니다 (EMBEDDING_PROVIDER=bge).");

  const res = await fetch(`${base.replace(/\/$/, "")}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts: [text] }),
  });
  if (!res.ok) {
    throw new Error(`BGE 임베딩 서비스 오류: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { embeddings: number[][] };
  return json.embeddings[0];
}

// Ollama 임베딩 (홈서버 등 자체 호스팅, 예: bge-m3)
// POST {EMBEDDING_API_URL}/api/embed  body: {"model":"bge-m3","input":[text]} -> {"embeddings":[[...1024...]]}
async function embedOllama(text: string): Promise<number[]> {
  const base = process.env.EMBEDDING_API_URL;
  if (!base)
    throw new Error("EMBEDDING_API_URL 가 설정되지 않았습니다 (EMBEDDING_PROVIDER=ollama).");
  const model = process.env.EMBEDDING_MODEL || "bge-m3";

  const res = await fetch(`${base.replace(/\/$/, "")}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: [text] }),
    // 서버 다운 시 auto 폴백 판단이 늦어지지 않도록 제한 (기본 5초)
    signal: AbortSignal.timeout(Number(process.env.EMBEDDING_TIMEOUT_MS) || 5000),
  });
  if (!res.ok) {
    throw new Error(`Ollama 임베딩 오류: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { embeddings: number[][] };
  return json.embeddings[0];
}

// pgvector 입력 형식: '[0.1,0.2,...]' 문자열
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
