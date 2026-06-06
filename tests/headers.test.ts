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
});
