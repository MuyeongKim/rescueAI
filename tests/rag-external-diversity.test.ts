import { describe, expect, it } from "vitest";
import { selectSourceDiverse } from "@/lib/rag-external";

type Chunk = { id: string; source: string };

const sourceOf = (chunk: Chunk) => chunk.source;

describe("selectSourceDiverse", () => {
  it("관련도 목록이 한 문서에 몰려 있어도 문서별로 번갈아 선택한다", () => {
    const chunks: Chunk[] = [
      { id: "a1", source: "A" },
      { id: "a2", source: "A" },
      { id: "a3", source: "A" },
      { id: "b1", source: "B" },
      { id: "c1", source: "C" },
      { id: "b2", source: "B" },
    ];

    expect(selectSourceDiverse(chunks, 6, sourceOf).map((chunk) => chunk.id)).toEqual([
      "a1",
      "b1",
      "c1",
      "a2",
      "b2",
      "a3",
    ]);
  });

  it("제한 개수 안에서도 가능한 모든 문서를 먼저 한 번씩 포함한다", () => {
    const chunks: Chunk[] = [
      { id: "a1", source: "A" },
      { id: "a2", source: "A" },
      { id: "b1", source: "B" },
      { id: "c1", source: "C" },
    ];

    expect(selectSourceDiverse(chunks, 3, sourceOf).map((chunk) => chunk.id)).toEqual([
      "a1",
      "b1",
      "c1",
    ]);
  });

  it("원본 문서가 하나뿐이면 기존 관련도 순서와 요청량을 유지한다", () => {
    const chunks: Chunk[] = [
      { id: "a1", source: "A" },
      { id: "a2", source: "A" },
      { id: "a3", source: "A" },
      { id: "a4", source: "A" },
    ];

    expect(selectSourceDiverse(chunks, 3, sourceOf).map((chunk) => chunk.id)).toEqual([
      "a1",
      "a2",
      "a3",
    ]);
  });

  it("빈 입력과 0 이하 제한을 안전하게 처리하고 원본 배열을 바꾸지 않는다", () => {
    const chunks: Chunk[] = [{ id: "a1", source: "A" }];
    const snapshot = [...chunks];

    expect(selectSourceDiverse([], 5, sourceOf)).toEqual([]);
    expect(selectSourceDiverse(chunks, 0, sourceOf)).toEqual([]);
    expect(selectSourceDiverse(chunks, -2, sourceOf)).toEqual([]);
    expect(chunks).toEqual(snapshot);
  });
});
