import OpenAI from "openai";
import { embed } from "ai";
import { google } from "@ai-sdk/google";

// 임베딩 차원 — DB 스키마 vector(1024) 와 반드시 일치해야 한다.
export const EMBEDDING_DIM = 1024;

type Provider = "auto" | "google" | "openai" | "bge" | "ollama";

function getProvider(): Provider {
  const provider = process.env.EMBEDDING_PROVIDER || "google";
  if (!["auto", "google", "openai", "bge", "ollama"].includes(provider)) {
    throw new Error(`지원하지 않는 EMBEDDING_PROVIDER입니다: ${provider}`);
  }
  return provider as Provider;
}

export type EmbeddingContract = {
  provider: Exclude<Provider, "auto">;
  model: string;
  dimensions: number;
  version: string;
};

export function getConfiguredEmbeddingContract(): EmbeddingContract {
  const requested = getProvider();
  const provider = requested === "auto" ? "ollama" : requested;
  const defaults: Record<EmbeddingContract["provider"], { model: string; version: string }> = {
    google: {
      model: process.env.GOOGLE_EMBEDDING_MODEL || "gemini-embedding-001",
      version: "google-retrieval-v1",
    },
    openai: {
      model: process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small",
      version: "openai-raw-v1",
    },
    bge: {
      model: process.env.BGE_EMBEDDING_MODEL || "BAAI/bge-m3",
      version: "bge-m3-raw-v1",
    },
    ollama: {
      model: process.env.EMBEDDING_MODEL || "bge-m3:latest",
      version: (process.env.EMBEDDING_MODEL || "bge-m3:latest")
        .toLowerCase()
        .includes("bge-m3")
        ? "bge-m3-raw-v1"
        : "ollama-raw-v1",
    },
  };
  return {
    provider,
    model: defaults[provider].model,
    dimensions: EMBEDDING_DIM,
    version: process.env.EMBEDDING_VERSION || defaults[provider].version,
  };
}

function validateEmbeddingVector(vector: number[]): number[] {
  if (vector.length !== EMBEDDING_DIM) {
    throw new Error(
      `임베딩 차원 불일치: ${vector.length} (기대값 ${EMBEDDING_DIM}). EMBEDDING_PROVIDER/모델 설정을 확인하세요.`
    );
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("임베딩에 유한수가 아닌 값이 포함되어 있습니다.");
  }
  const squaredNorm = vector.reduce((sum, value) => sum + value * value, 0);
  if (squaredNorm <= 1e-24) throw new Error("임베딩 벡터의 노름이 0입니다.");
  return vector;
}

// 쿼리 한 건을 1024차원 벡터로 임베딩한다. 인덱서와 동일한 제공자/모델을 사용해야 한다.
export async function getQueryEmbedding(text: string): Promise<number[]> {
  const provider = getProvider();
  const vec =
    provider === "auto"
      ? await embedOllama(text)
      : provider === "google"
        ? await embedGoogle(text)
        : provider === "bge"
          ? await embedBGE(text)
          : provider === "ollama"
            ? await embedOllama(text)
            : await embedOpenAI(text);
  return validateEmbeddingVector(vec);
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
  const vec = res.data?.[0]?.embedding;
  if (!vec) throw new Error("OpenAI 임베딩 응답이 비어 있습니다.");
  return vec;
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
  const vec = json.embeddings?.[0];
  if (!vec) throw new Error("BGE 임베딩 응답이 비어 있습니다.");
  return vec;
}

// Ollama 임베딩 (홈서버 등 자체 호스팅, 예: bge-m3)
// POST {EMBEDDING_API_URL}/api/embed  body: {"model":"bge-m3","input":[text]} -> {"embeddings":[[...1024...]]}
async function embedOllama(text: string): Promise<number[]> {
  const base = process.env.EMBEDDING_API_URL;
  if (!base)
    throw new Error("EMBEDDING_API_URL 가 설정되지 않았습니다 (EMBEDDING_PROVIDER=ollama).");
  const model = process.env.EMBEDDING_MODEL || "bge-m3:latest";

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
  const vec = json.embeddings?.[0];
  if (!vec) throw new Error("Ollama 임베딩 응답이 비어 있습니다.");
  return vec;
}

// pgvector 입력 형식: '[0.1,0.2,...]' 문자열
export function toPgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
