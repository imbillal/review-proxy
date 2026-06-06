// review-proxy/tests/proxy-handler.test.ts
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { handleProxyRequest, rewriteRequestBody, type ProxyDeps } from "../src/proxy-handler";
import { signProxyToken } from "../src/token";

describe("rewriteRequestBody", () => {
  const proxyHost = "d-ab12cd34.reviewproxy.app";
  const target = "https://billal.dev";
  const json = { "content-type": "application/json" };

  it("rewrites the proxy host → target host in a JSON body (CMS self-lookup)", () => {
    const body = Buffer.from(JSON.stringify({ variables: { domain: proxyHost } }));
    const out = rewriteRequestBody(body, json, proxyHost, "", target);
    expect(out!.toString()).toBe(JSON.stringify({ variables: { domain: "billal.dev" } }));
  });

  it("also rewrites the host:port form (dev) before the bare host", () => {
    const body = Buffer.from(`{"a":"${proxyHost}:8080","b":"${proxyHost}"}`);
    const out = rewriteRequestBody(body, json, proxyHost, "8080", target);
    expect(out!.toString()).toBe(`{"a":"billal.dev","b":"billal.dev"}`);
  });

  it("leaves non-textual bodies (uploads) untouched", () => {
    const body = Buffer.from(proxyHost);
    const out = rewriteRequestBody(body, { "content-type": "image/png" }, proxyHost, "", target);
    expect(out).toBe(body);
  });

  it("is a no-op when the body doesn't mention the proxy host", () => {
    const body = Buffer.from('{"hello":"world"}');
    const out = rewriteRequestBody(body, json, proxyHost, "", target);
    expect(out).toBe(body);
  });
});

const config = {
  port: 8080,
  proxyDomain: "reviewproxy.app",
  appOrigin: "http://localhost:3000",
  databaseUrl: "x",
  proxyTokenSecret: "secret",
  upstreamTimeoutMs: 5000,
  maxHtmlBytes: 1_000_000,
  publicScheme: "https",
  publicPort: "",
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
// A cookie left over from an earlier session — signed with a now-rotated secret,
// so it fails verification (stands in for any expired/foreign stale cookie).
const staleToken = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "u" }, "old-secret");

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

  it("lets a fresh query token override a stale cookie (302 + refreshed cookie)", async () => {
    const r = await handleProxyRequest(
      {
        method: "GET",
        host: "d-aaaa1111.reviewproxy.app",
        path: "/about",
        query: `__rt=${goodToken}`,
        cookies: { __rt: staleToken },
      },
      deps(),
    );
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBe("/about");
    // The cookie is rewritten to the fresh token, not left on the stale one.
    expect(String(r.headers["set-cookie"])).toContain(`__rt=${goodToken}`);
  });

  it("401s when only a stale cookie is present and no fresh query token", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: staleToken } },
      deps(),
    );
    expect(r.status).toBe(401);
  });

  it("rewrites same-origin links with the dev scheme and port when configured", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps({ config: { ...config, publicScheme: "http", publicPort: "8080" } }),
    );
    expect(r.status).toBe(200);
    expect(String(r.body)).toContain("http://d-aaaa1111.reviewproxy.app:8080/x");
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
