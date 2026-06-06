// review-proxy/tests/headers.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeResponseHeaders, rewriteSetCookie, rewriteLocation, buildUpstreamHeaders } from "../src/headers";

describe("sanitizeResponseHeaders", () => {
  it("drops framing/security headers and content-length", () => {
    const out = sanitizeResponseHeaders({
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'",
      "strict-transport-security": "max-age=1",
      "content-length": "123",
      "cache-control": "no-store",
    });
    expect(out["content-type"]).toBe("text/html");
    expect(out["cache-control"]).toBe("no-store");
    expect(out["x-frame-options"]).toBeUndefined();
    expect(out["content-security-policy"]).toBeUndefined();
    expect(out["strict-transport-security"]).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
  });
});

describe("rewriteSetCookie", () => {
  it("rewrites Domain to the proxy host and forces Secure", () => {
    const out = rewriteSetCookie("sid=abc; Domain=dorik.com; Path=/; HttpOnly", "d-ab12cd34.reviewproxy.app");
    expect(out).toContain("Domain=d-ab12cd34.reviewproxy.app");
    expect(out).toMatch(/Secure/);
  });
});

describe("rewriteLocation", () => {
  it("rewrites a same-origin redirect to the proxy origin", () => {
    expect(rewriteLocation("https://dorik.com/next", "https://dorik.com", "https://d-ab12cd34.reviewproxy.app"))
      .toBe("https://d-ab12cd34.reviewproxy.app/next");
  });
  it("leaves a cross-origin redirect unchanged", () => {
    expect(rewriteLocation("https://other.com/x", "https://dorik.com", "https://d-ab12cd34.reviewproxy.app"))
      .toBe("https://other.com/x");
  });
});

describe("buildUpstreamHeaders", () => {
  it("sends a browser UA and never forwards proxy/app headers", () => {
    const h = buildUpstreamHeaders(undefined);
    expect(h["user-agent"]).toMatch(/Mozilla/);
    expect(h.accept).toMatch(/text\/html/);
    expect(h.cookie).toBeUndefined();
  });
  it("forwards stored upstream cookies when provided", () => {
    const h = buildUpstreamHeaders("sid=abc");
    expect(h.cookie).toBe("sid=abc");
  });

  it("strips edge forwarding/infra headers so they never reach the upstream", () => {
    const h = buildUpstreamHeaders(undefined, {
      "x-forwarded-host": "d-qo9vi8p7.proxy.billal.lol",
      "x-forwarded-for": "1.2.3.4",
      "x-forwarded-proto": "https",
      "cf-connecting-ip": "1.2.3.4",
      "cf-ray": "abc",
      "forwarded": "for=1.2.3.4;host=d-qo9vi8p7.proxy.billal.lol",
      "via": "1.1 cloudflare",
      "x-real-ip": "1.2.3.4",
      "accept-language": "en-US", // a normal header still passes through
    });
    expect(h["x-forwarded-host"]).toBeUndefined();
    expect(h["x-forwarded-for"]).toBeUndefined();
    expect(h["x-forwarded-proto"]).toBeUndefined();
    expect(h["cf-connecting-ip"]).toBeUndefined();
    expect(h["cf-ray"]).toBeUndefined();
    expect(h["forwarded"]).toBeUndefined();
    expect(h["via"]).toBeUndefined();
    expect(h["x-real-ip"]).toBeUndefined();
    expect(h["accept-language"]).toBe("en-US");
  });
});
