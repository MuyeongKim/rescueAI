import { createRequire } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { readResponseWithSizeLimit } from "@ai-sdk/provider-utils";

describe("provider-utils 전용 undici 보안 버전 호환", () => {
  it("Agent DNS 연결과 fetch 응답을 실제 loopback HTTP로 처리하고 과대 응답을 중단한다", async () => {
    const projectRequire = createRequire(import.meta.url);
    const providerRequire = createRequire(projectRequire.resolve("@ai-sdk/provider-utils"));
    expect(providerRequire("undici/package.json").version).toBe("6.28.1");
    const { Agent, fetch } = providerRequire("undici");
    const received: string[] = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      received.push(body);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(request.url === "/large" ? JSON.stringify({ text: "x".repeat(64) }) : JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback fixture missing");
    // provider-utils와 같은 Agent({connect:{lookup}})·fetch API를 사용한다.
    const agent = new Agent({ connect: { lookup: (_name: string, options: { all?: boolean }, done: (error: null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => {
      if (options.all) done(null, [{ address: "127.0.0.1", family: 4 }]);
      else done(null, "127.0.0.1", 4);
    } } });
    const base = `http://synthetic.invalid:${address.port}`;
    try {
      const response = await fetch(`${base}/ok`, { method: "POST", body: "synthetic request", dispatcher: agent });
      const bytes = await readResponseWithSizeLimit({ response, url: `${base}/ok`, maxBytes: 32 });
      expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ ok: true });
      expect(received[0]).toBe("synthetic request");
      await expect(readResponseWithSizeLimit({ response: await fetch(`${base}/large`, { dispatcher: agent }), url: `${base}/large`, maxBytes: 32 })).rejects.toThrow("exceeded maximum size");
    } finally { await agent.close(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
