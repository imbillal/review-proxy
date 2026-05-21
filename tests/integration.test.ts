// review-proxy/tests/integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { buildServer } from "../src/server";
import { signProxyToken } from "../src/token";
import { createRegistry } from "../src/registry";
import { fetchUpstream } from "../src/upstream";

let upstream: http.Server;
let upstreamPort: number;

const config = {
  port: 0,
  proxyDomain: "reviewproxy.app",
  appOrigin: "http://localhost:3000",
  databaseUrl: "x",
  proxyTokenSecret: "secret",
  upstreamTimeoutMs: 5000,
  maxHtmlBytes: 1_000_000,
};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            method: req.method,
            contentType: req.headers["content-type"] ?? null,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
    res.end(`<html><head></head><body><a href="http://127.0.0.1:${upstreamPort}/about">about</a></body></html>`);
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

describe("review-proxy end to end", () => {
  it("proxies a framed site: strips XFO, rewrites links, injects runtime", async () => {
    const targetOrigin = `http://127.0.0.1:${upstreamPort}`;
    const registry = createRegistry(
      async (sub) => (sub === "d-aaaa1111"
        ? { targetOrigin, documentId: "doc1", enabled: true }
        : null),
      60_000,
    );
    // No-op SSRF guard: the test upstream binds to 127.0.0.1, which the real
    // assertUpstreamAllowed (correctly) blocks. The SSRF guard is covered by
    // tests/ssrf.test.ts; this test exercises the proxy pipeline end to end.
    const app = buildServer({
      config,
      lookupSite: registry.lookup,
      assertUpstreamAllowed: async () => {},
      fetchUpstream,
    });

    const token = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "u" }, "secret");

    // Token via cookie → 200 HTML.
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "d-aaaa1111.reviewproxy.app", cookie: `__rt=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.body).toContain("d-aaaa1111.reviewproxy.app/about");
    expect(res.body).toContain("pinion:ready");

    // Unknown subdomain → 404.
    const miss = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "d-nope0000.reviewproxy.app", cookie: `__rt=${token}` },
    });
    expect(miss.statusCode).toBe(404);

    // No token → 401.
    const noTok = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "d-aaaa1111.reviewproxy.app" },
    });
    expect(noTok.statusCode).toBe(401);

    await app.close();
  });

  it("forwards a POST with its body and content-type to the upstream", async () => {
    const targetOrigin = `http://127.0.0.1:${upstreamPort}`;
    const registry = createRegistry(
      async (sub) =>
        sub === "d-aaaa1111" ? { targetOrigin, documentId: "doc1", enabled: true } : null,
      60_000,
    );
    const app = buildServer({
      config,
      lookupSite: registry.lookup,
      assertUpstreamAllowed: async () => {},
      fetchUpstream,
    });
    const token = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "u" }, "secret");

    const res = await app.inject({
      method: "POST",
      url: "/api/echo",
      headers: {
        host: "d-aaaa1111.reviewproxy.app",
        cookie: `__rt=${token}`,
        "content-type": "application/json",
      },
      payload: '{"hello":"world"}',
    });
    expect(res.statusCode).toBe(200);
    const echoed = JSON.parse(res.body) as { method: string; contentType: string; body: string };
    expect(echoed.method).toBe("POST");
    expect(echoed.contentType).toContain("application/json");
    expect(echoed.body).toBe('{"hello":"world"}');

    await app.close();
  });
});
