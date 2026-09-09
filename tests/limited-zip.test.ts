import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectLimitedZipStream, readLimitedZipEntry } from "@/lib/limited-zip";

afterEach(() => vi.restoreAllMocks());

describe("HWPX 해제·생성 중 바이트 제한", () => {
  it("압축 후 작은 파일이라도 실제 해제 크기로 중단한다", async () => {
    const zip = new JSZip().file("synthetic.xml", "X".repeat(128 * 1024));
    const input = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    expect(input.byteLength).toBeLessThan(1024);
    const loaded = await JSZip.loadAsync(input);
    await expect(readLimitedZipEntry(loaded.file("synthetic.xml")!, 1024)).rejects.toThrow("byte limit exceeded");
  });

  it("ZIP 헤더가 작은 해제 크기를 주장해도 실제 출력으로 차단한다", async () => {
    const zip = new JSZip().file("synthetic.xml", "X".repeat(128 * 1024));
    const input = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const central = Buffer.from(input).indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(central).toBeGreaterThan(0);
    // ZIP 중앙 디렉터리의 uncompressed size. 선언값 검증만으로는 통과할 입력이다.
    new DataView(input.buffer, input.byteOffset, input.byteLength).setUint32(central + 24, 32, true);
    const loaded = await JSZip.loadAsync(input);
    await expect(readLimitedZipEntry(loaded.file("synthetic.xml")!, 1024)).rejects.toThrow("byte limit exceeded");
  });

  it("상한 도달 시 pause하고 이미 전송 중이던 추가 chunk와 end를 무시한다", async () => {
    const callbacks: Record<string, (...args: unknown[]) => void> = {};
    const stream = {
      on: vi.fn(function (event: string, callback: (...args: unknown[]) => void) { callbacks[event] = callback; return stream; }),
      pause: vi.fn(() => stream),
      resume: vi.fn(() => {
        callbacks.data(new Uint8Array(9));
        callbacks.data(new Uint8Array(2));
        callbacks.end();
        return stream;
      }),
    };
    await expect(collectLimitedZipStream(stream as unknown as JSZip.JSZipStreamHelper<Uint8Array>, 8)).rejects.toThrow("byte limit exceeded");
    expect(stream.pause).toHaveBeenCalledOnce();
  });

  it("정상 UTF-8 자료를 정확하게 반환하고 취소 요청도 존중한다", async () => {
    const text = "합성 훈련계획";
    const zip = await JSZip.loadAsync(await new JSZip().file("safe.xml", text).generateAsync({ type: "uint8array", compression: "DEFLATE" }));
    const result = await readLimitedZipEntry(zip.file("safe.xml")!, new TextEncoder().encode(text).byteLength);
    expect(new TextDecoder().decode(result)).toBe(text);
    const abort = new AbortController(); abort.abort();
    await expect(readLimitedZipEntry(zip.file("safe.xml")!, 100, abort.signal)).rejects.toThrow("aborted");
  });
});
