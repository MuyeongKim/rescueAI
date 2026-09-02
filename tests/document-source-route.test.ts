import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireApiUser: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ requireApiUser: mocks.requireApiUser }));
vi.mock("@/lib/demo", () => ({ DEMO: false }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));

import { GET } from "@/app/api/documents/[id]/source/route";

function makeClient({
  document,
  documentError = null,
  signedUrl = "https://example.supabase.co/signed.pdf",
  signedError = null,
}: {
  document: {
    id: number;
    title: string;
    source_type: string;
    file_url: string | null;
    status: string;
  } | null;
  documentError?: { message: string } | null;
  signedUrl?: string;
  signedError?: { message: string } | null;
}) {
  const maybeSingle = vi.fn().mockResolvedValue({ data: document, error: documentError });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const createSignedUrl = vi.fn().mockResolvedValue({
    data: signedError ? null : { signedUrl },
    error: signedError,
  });
  return {
    from: vi.fn(() => ({ select })),
    storage: { from: vi.fn(() => ({ createSignedUrl })) },
    spies: { createSignedUrl },
  };
}

describe("GET /api/documents/[id]/source", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireApiUser.mockResolvedValue({ ok: true, user: { id: "user-1" } });
  });

  it("rejects an invalid document id before authentication", async () => {
    const response = await GET(new Request("http://localhost"), {
      params: { id: "invalid" },
    });

    expect(response.status).toBe(400);
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("returns a short-lived signed URL from the authenticated client", async () => {
    const client = makeClient({
      document: {
        id: 7,
        title: "화학보호복 교범",
        source_type: "pdf",
        file_url: "rag/ab/document.pdf",
        status: "processed",
      },
    });
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new Request("http://localhost"), {
      params: { id: "7" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(body).toEqual({
      url: "https://example.supabase.co/signed.pdf",
      title: "화학보호복 교범",
      expiresIn: 300,
    });
    expect(client.spies.createSignedUrl).toHaveBeenCalledWith(
      "rag/ab/document.pdf",
      300
    );
  });

  it("does not issue a URL when the original file is missing", async () => {
    const client = makeClient({
      document: {
        id: 7,
        title: "화학보호복 교범",
        source_type: "pdf",
        file_url: null,
        status: "processed",
      },
    });
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new Request("http://localhost"), {
      params: { id: "7" },
    });

    expect(response.status).toBe(404);
    expect(client.spies.createSignedUrl).not.toHaveBeenCalled();
  });

  it("does not issue a URL for a processed non-PDF document", async () => {
    const client = makeClient({
      document: {
        id: 8,
        title: "동영상 교육자료",
        source_type: "video",
        file_url: "rag/video/training.mp4",
        status: "processed",
      },
    });
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new Request("http://localhost"), {
      params: { id: "8" },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: "이 자료에는 열람 가능한 원본 PDF가 없습니다.",
    });
    expect(client.spies.createSignedUrl).not.toHaveBeenCalled();
  });

  it("does not make the browser fetch an arbitrary legacy external URL", async () => {
    const client = makeClient({
      document: {
        id: 8,
        title: "외부 링크 자료",
        source_type: "pdf",
        file_url: "https://external.example/manual.pdf",
        status: "processed",
      },
    });
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new Request("http://localhost"), {
      params: { id: "8" },
    });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "외부 링크 원본은 PPTX 시각자료로 사용할 수 없습니다.",
    });
    expect(client.spies.createSignedUrl).not.toHaveBeenCalled();
  });

  it("does not issue a URL for an inactive document", async () => {
    const client = makeClient({
      document: {
        id: 9,
        title: "비활성 자료",
        source_type: "pdf",
        file_url: "rag/archive/document.pdf",
        status: "inactive",
      },
    });
    mocks.createClient.mockResolvedValue(client);

    const response = await GET(new Request("http://localhost"), {
      params: { id: "9" },
    });

    expect(response.status).toBe(404);
    expect(client.spies.createSignedUrl).not.toHaveBeenCalled();
  });
});
