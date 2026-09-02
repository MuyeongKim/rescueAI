import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/rag-external", () => ({
  ragTableEnabled: () => false,
  fetchExternalRagContext: vi.fn(),
  fetchExternalSopContext: vi.fn(),
}));

import {
  MAX_GENERATION_CONTEXT_UTF8_BYTES,
  limitGenerationContextText,
} from "@/lib/generate-context";

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("생성 근거 체크포인트 예산", () => {
  it("일반 교범과 SOP를 청크 경계로 제한하면서 SOP 예산을 보존한다", () => {
    const general = Array.from(
      { length: 30 },
      (_, index) => `[일반교범 p.${index + 1}]\n${"일반근거".repeat(4_000)}`
    ).join("\n\n---\n\n");
    const sop = Array.from(
      { length: 6 },
      (_, index) => `[현장SOP p.${index + 1}]\n${"안전절차".repeat(2_000)}`
    ).join("\n\n---\n\n");

    const limited = limitGenerationContextText(general, sop);

    expect(utf8Bytes(limited)).toBeLessThanOrEqual(MAX_GENERATION_CONTEXT_UTF8_BYTES);
    expect(limited).toContain("[일반교범 p.1]");
    expect(limited).toContain("=== 관련 SOP·현장지침 근거 ===");
    expect(limited).toContain("[현장SOP p.1]");
    expect(limited).not.toContain("[일반교범 p.30]");
  });

  it("예산 안의 근거는 내용과 순서를 바꾸지 않는다", () => {
    const general = "[교범 p.1]\n첫 근거\n\n---\n\n[교범 p.2]\n둘째 근거";
    const sop = "[SOP p.3]\n확인 절차";

    expect(limitGenerationContextText(general, sop)).toBe(
      `${general}\n\n=== 관련 SOP·현장지침 근거 ===\n${sop}`
    );
  });
});
