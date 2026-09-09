import type JSZip from "jszip";

const ZIP_STREAM_TIMEOUT_MS = 10_000;

/** ZIP 메타데이터 대신 실제 해제·생성 바이트를 세고, 상한 전에 전체 결과를 만들지 않는다. */
export function collectLimitedZipStream(
  stream: JSZip.JSZipStreamHelper<Uint8Array>,
  maxBytes: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let chunks: Uint8Array[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      chunks = [];
    };
    const stop = (message: string) => {
      if (settled) return;
      settled = true;
      stream.pause();
      finish();
      reject(new Error(message));
    };
    const abort = () => stop("HWPX ZIP stream aborted");
    const timer = setTimeout(() => stop("HWPX ZIP stream timeout"), ZIP_STREAM_TIMEOUT_MS);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    stream
      .on("data", (chunk) => {
        // JSZip의 현재 압축 입력 블록에서 pause 뒤 늦게 오는 출력도 보관하지 않는다.
        if (settled) return;
        total += chunk.byteLength;
        if (total > maxBytes) { stop("HWPX ZIP stream byte limit exceeded"); return; }
        chunks.push(chunk);
      })
      .on("error", () => stop("HWPX ZIP stream failed"))
      .on("end", () => {
        if (settled) return;
        settled = true;
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
        finish();
        resolve(output);
      })
      .resume();
  });
}

/** internalStream은 JSZip의 공개 API이며, 설치된 타입 선언에만 누락되어 있다. */
export function readLimitedZipEntry(file: JSZip.JSZipObject, maxBytes: number, signal?: AbortSignal) {
  const readable = file as JSZip.JSZipObject & {
    internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
  };
  return collectLimitedZipStream(readable.internalStream("uint8array"), maxBytes, signal);
}
