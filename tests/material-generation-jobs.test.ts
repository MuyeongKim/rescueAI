import { describe, expect, it, vi } from "vitest";
import { runDurableMaterialPilot, type DurableMaterialPilotOptions } from "@/eval/material-generation-jobs";

const options: DurableMaterialPilotOptions = {
  enabled: true, baseUrl: "https://evaluation.example", sessionCookie: "test-session=fixture",
  input: { type: "plan", category: "산악", topic: "산악구조 훈련", audience: "일반 대원", duration: "1시간" },
  pollIntervalMs: 100,
};

function transport(statuses = ["queued", "drafting", "completed"], qualityPassed = true) {
  let jobId = "";
  let index = 0;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "POST") jobId = JSON.parse(String(init.body)).jobId;
    const status = statuses[Math.min(index++, statuses.length - 1)];
    return Response.json({ job: { id: jobId, status, qualityPassed: status === "completed" && qualityPassed, result: status === "completed" ? { title: "완성본" } : null } });
  });
  return fetcher;
}

describe("내구성 자료제작 평가 harness", () => {
  it.each([
    { enabled: false }, { sessionCookie: undefined }, { baseUrl: undefined },
  ])("명시 실행·사용자 쿠키·대상 주소가 없으면 외부 호출을 하지 않는다", async (override) => {
    const fetcher = transport();
    const result = await runDurableMaterialPilot({ ...options, ...override, fetcher });
    expect(result.status).toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("실제 사용자 인증 헤더로 작업을 한 번 생성하고 같은 ID를 완료까지 조회한다", async () => {
    const fetcher = transport();
    const sleep = vi.fn(async () => {});
    const result = await runDurableMaterialPilot({ ...options, fetcher, sleep });
    expect(result.status).toBe("completed");
    const first = fetcher.mock.calls[0];
    const body = JSON.parse(String(first[1]?.body));
    expect(body.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.clientRequestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.topic).toBe(options.input.topic);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    for (const [url, init] of fetcher.mock.calls.slice(1)) {
      expect(String(url)).toBe(`https://evaluation.example/api/generate/jobs/${body.jobId}`);
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({ Cookie: options.sessionCookie });
      expect(init?.redirect).toBe("error");
    }
    expect(sleep).toHaveBeenCalledTimes(2);
  });
  it.each(["needs_attention", "failed"])("%s 종료는 완성본으로 통과시키지 않는다", async (status) => {
    await expect(runDurableMaterialPilot({ ...options, fetcher: transport([status]), sleep: async () => {} })).rejects.toThrow("완성본 기준");
  });
  it("completed 상태여도 품질 통과가 확인되지 않으면 실패한다", async () => {
    await expect(runDurableMaterialPilot({ ...options, fetcher: transport(["completed"], false) })).rejects.toThrow("완성본 기준");
  });
  it.each([401, 429, 409, 500])("HTTP %i 응답을 실패로 처리하고 다른 작업을 만들지 않는다", async (status) => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("error", { status }));
    await expect(runDurableMaterialPilot({ ...options, fetcher })).rejects.toThrow(`HTTP ${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("POST 응답 유실 시 새 작업을 만들지 않고 쿠키를 오류에 노출하지 않는다", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("provider error with test-session=fixture"); });
    await expect(runDurableMaterialPilot({ ...options, fetcher })).rejects.toThrow("같은 작업의 상태");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("시간 한도가 지나면 폴링을 멈추고 생성 요청을 반복하지 않는다", async () => {
    let time = 0;
    const fetcher = transport(["queued"]);
    await expect(runDurableMaterialPilot({ ...options, fetcher, timeoutMs: 1000, now: () => time, sleep: async (ms) => { time += ms; } })).rejects.toThrow("대기시간을 초과");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(time).toBe(1000);
  });
  it.each(["http://evaluation.example", "https://user:pass@evaluation.example", "https://evaluation.example/?secret=x"])(
    "세션 쿠키 전달에 부적합한 원점을 거부한다: %s", async (baseUrl) => {
      const fetcher = transport();
      await expect(runDurableMaterialPilot({ ...options, baseUrl, fetcher })).rejects.toThrow("평가 주소");
      expect(fetcher).not.toHaveBeenCalled();
    }
  );
  it("다른 작업 ID 응답을 본인 평가 결과로 받지 않는다", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ job: { id: "00000000-0000-4000-8000-000000000001", status: "completed", qualityPassed: true, result: {} } }));
    await expect(runDurableMaterialPilot({ ...options, fetcher })).rejects.toThrow("응답 계약");
  });
});
