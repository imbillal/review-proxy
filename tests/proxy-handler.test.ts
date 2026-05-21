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
});
