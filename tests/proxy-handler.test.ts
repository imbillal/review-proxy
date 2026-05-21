// review-proxy/tests/proxy-handler.test.ts
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { handleProxyRequest, type ProxyDeps } from "../src/proxy-handler";
import { signProxyToken } from "../src/token";

const config = {
  port: 8080,
  proxyDomain: "reviewproxy.app",
  appOrigin: "http://localhost:3000",
  databaseUrl: "x",
  proxyTokenSecret: "secret",
  upstreamTimeoutMs: 5000,
  maxHtmlBytes: 1_000_000,
};

function deps(over: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    config,
    lookupSite: async () => ({ targetOrigin: "https://dorik.com", documentId: "doc1", enabled: true }),
    assertUpstreamAllowed: async () => {},
    fetchUpstream: async () => ({
      statusCode: 200,
      headers: { "content-type": "text/html" },
      bodyText: "<html><head></head><body><a href='https://dorik.com/x'>x</a></body></html>",
      contentType: "text/html",
    }),
    ...over,
  };
}

const goodToken = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "u" }, "secret");

describe("handleProxyRequest", () => {
  it("404s an unknown subdomain", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "nope.reviewproxy.app", path: "/", query: "", cookies: {} },
      deps({ lookupSite: async () => null }),
    );
    expect(r.status).toBe(404);
  });

  it("401s when the token is missing", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: {} },
      deps(),
    );
    expect(r.status).toBe(401);
  });

  it("302s to a clean URL and sets the cookie when token arrives via query", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/about", query: `__rt=${goodToken}`, cookies: {} },
      deps(),
    );
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBe("/about");
    expect(String(r.headers["set-cookie"])).toContain("__rt=");
  });

  it("proxies HTML, strips framing headers, rewrites same-origin links, injects the runtime", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps(),
    );
    expect(r.status).toBe(200);
    const body = String(r.body);
    expect(body).toContain("d-aaaa1111.reviewproxy.app/x");
    expect(body).toContain("pinion:ready");
  });

  it("rewrites a same-origin redirect Location", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps({
        fetchUpstream: async () => ({
          statusCode: 302,
          headers: { location: "https://dorik.com/next" },
          bodyStream: Readable.from([]),
          contentType: "",
        }),
      }),
    );
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBe("https://d-aaaa1111.reviewproxy.app/next");
  });

  it("504s on an upstream timeout", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps({ fetchUpstream: async () => { throw new Error("UND_ERR_HEADERS_TIMEOUT"); } }),
    );
    expect(r.status).toBe(504);
  });

  it("keeps content-encoding on a streamed passthrough response", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/app.js", query: "", cookies: { __rt: goodToken } },
      deps({
        fetchUpstream: async () => ({
          statusCode: 200,
          headers: { "content-type": "application/javascript", "content-encoding": "gzip" },
          bodyStream: Readable.from([Buffer.from([0x1f, 0x8b, 0x08])]),
          contentType: "application/javascript",
        }),
      }),
    );
    expect(r.status).toBe(200);
    // The body is streamed un-decompressed, so the header MUST survive or the
    // browser parses gzip bytes as source and fails.
    expect(r.headers["content-encoding"]).toBe("gzip");
  });

  it("drops content-encoding on a rewritten HTML response", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps({
        fetchUpstream: async () => ({
          statusCode: 200,
          headers: { "content-type": "text/html", "content-encoding": "gzip" },
          bodyText: "<html><head></head><body></body></html>",
          contentType: "text/html",
        }),
      }),
    );
    expect(r.status).toBe(200);
    // HTML body was decompressed and rewritten — claiming gzip would corrupt it.
    expect(r.headers["content-encoding"]).toBeUndefined();
  });

  it("forwards the method and body for a POST request", async () => {
    let seen: { method?: string; body?: string } = {};
    const r = await handleProxyRequest(
      {
        method: "POST",
        host: "d-aaaa1111.reviewproxy.app",
        path: "/api/x",
        query: "",
        cookies: { __rt: goodToken },
        body: Buffer.from('{"a":1}'),
        requestHeaders: { "content-type": "application/json" },
      },
      deps({
        fetchUpstream: async (_url, opts) => {
          seen = { method: opts.method, body: opts.body?.toString() };
          return {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            bodyStream: Readable.from([Buffer.from("{}")]),
            contentType: "application/json",
          };
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(seen.method).toBe("POST");
    expect(seen.body).toBe('{"a":1}');
  });
});
