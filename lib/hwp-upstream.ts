// 5~7개 섹션의 텍스트 문서와 표준 HWPX 양식에 여유를 두되 전체 응답 적재는 제한한다.
export const HWP_REQUEST_MAX_BYTES = 256 * 1024;
export const HWP_METADATA_MAX_BYTES = 16 * 1024;
export const HWP_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const HWP_UPSTREAM_TIMEOUT_MS = 20_000;

/** 헤더 유무/정확성과 관계없이 실제 수신 바이트를 제한하고 본문 수신까지 시간 제한한다. */
export async function fetchHwpBytes(
  url: string,
  init: RequestInit,
  maxBytes: number,
  requestSignal: AbortSignal
): Promise<Uint8Array> {
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new DOMException("HWP timeout", "TimeoutError")), HWP_UPSTREAM_TIMEOUT_MS);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => {
      reject(new DOMException("HWP request aborted", signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError"));
      void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener("abort", abortListener, { once: true });
    if (signal.aborted) abortListener();
  });
  try {
    response = await Promise.race([fetch(url, { ...init, redirect: "error", signal }), aborted]);
    if (!response.ok) throw new Error("HWP upstream status rejected");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)) || Number(declared) > maxBytes)) {
      throw new Error("HWP upstream body limit exceeded");
    }
    if (!response.body) throw new Error("HWP upstream body missing");
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      // cancel()도 pending read를 done으로 끝내므로 취소를 정상 EOF로 처리하지 않는다.
      if (signal.aborted) throw new DOMException("HWP request aborted", signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error("HWP upstream body limit exceeded");
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } catch (error) {
    // 전송을 중단하고 변환 계층에서도 남은 응답을 읽지 않는다.
    if (reader) void reader.cancel().catch(() => undefined);
    else if (response?.body) void response.body.cancel().catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timer);
    if (abortListener) signal.removeEventListener("abort", abortListener);
    controller.abort();
    reader?.releaseLock();
  }
}
