import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  embed: vi.fn(),
  textEmbeddingModel: vi.fn(() => "google-embedding-model"),
}));

vi.mock("ai", () => ({ embed: mocks.embed }));
vi.mock("@ai-sdk/google", () => ({
  google: { textEmbeddingModel: mocks.textEmbeddingModel },
}));

import { EMBEDDING_DIM, getQueryEmbedding } from "@/lib/embeddings";

describe("query embedding timeout", () => {
  const originalProvider = process.env.EMBEDDING_PROVIDER;
  const originalKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.EMBEDDING_PROVIDER = "google";
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "test-key";
    mocks.embed.mockResolvedValue({ embedding: Array(EMBEDDING_DIM).fill(0.01) });
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.EMBEDDING_PROVIDER;
    else process.env.EMBEDDING_PROVIDER = originalProvider;
    if (originalKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalKey;
  });

  it("원격 임베딩 호출에 Function 상한보다 짧은 중단 신호를 전달한다", async () => {
    const vector = await getQueryEmbedding("고층건물 화재 대응");

    expect(vector).toHaveLength(EMBEDDING_DIM);
    expect(mocks.embed).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: expect.any(AbortSignal) })
    );
  });
});
