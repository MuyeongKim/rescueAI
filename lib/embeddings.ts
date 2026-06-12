import OpenAI from "openai";

// 임베딩 차원 — DB 스키마 vector(1024) 와 반드시 일치해야 한다.
export const EMBEDDING_DIM = 1024;

type Provider = "openai" | "bge" | "ollama";

function getProvider(): Provider {
  return (process.env.EMBEDDING_PROVIDER as Provider) || "openai";
}

// 쿼리 한 건을 1024차원 벡터로 임베딩한다. 인덱서와 동일한 제공자/모델을 사용해야 한다.
export async function getQueryEmbedding(text: string): Promise<number[]> {
  const provider = getProvider();
  const vec =
    provider === "bge"
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
