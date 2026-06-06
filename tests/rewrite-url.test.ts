// review-proxy/tests/rewrite-url.test.ts
import { describe, expect, it } from "vitest";
import { rewriteUrl, rewriteSrcset } from "../src/rewrite-url";

const ORIGIN = "https://dorik.com";
const PROXY = "https://d-ab12cd34.reviewproxy.app";

describe("rewriteUrl", () => {
  it("rewrites an absolute same-origin URL to the proxy host", () => {
    expect(rewriteUrl("https://dorik.com/about?x=1", ORIGIN, PROXY))
      .toBe("https://d-ab12cd34.reviewproxy.app/about?x=1");
  });

  it("rewrites a protocol-relative same-origin URL", () => {
    expect(rewriteUrl("//dorik.com/logo.png", ORIGIN, PROXY))
      .toBe("https://d-ab12cd34.reviewproxy.app/logo.png");
  });

  it("adopts the proxy origin's scheme and port (prod: https, no port)", () => {
    expect(rewriteUrl("http://127.0.0.1:8080/about", "http://127.0.0.1:8080", PROXY))
      .toBe("https://d-ab12cd34.reviewproxy.app/about");
  });

  it("keeps the dev scheme and port when the proxy base is http://host:8080", () => {
    const devProxy = "http://d-ab12cd34.localhost:8080";
    expect(rewriteUrl("https://dorik.com/pricing", ORIGIN, devProxy))
      .toBe("http://d-ab12cd34.localhost:8080/pricing");
  });

  it.each(["/about", "./x", "../y", "page.html", ""])(
    "leaves relative URL %s unchanged",
    (u) => {
      expect(rewriteUrl(u, ORIGIN, PROXY)).toBe(u);
    },
  );

  it("leaves a cross-origin URL unchanged", () => {
    expect(rewriteUrl("https://cdn.example.com/a.js", ORIGIN, PROXY))
      .toBe("https://cdn.example.com/a.js");
  });

  it.each(["data:image/png;base64,AAAA", "mailto:a@b.com", "javascript:void 0", "#frag", "tel:+1"])(
    "leaves non-navigational URL %s unchanged",
    (u) => {
      expect(rewriteUrl(u, ORIGIN, PROXY)).toBe(u);
    },
  );
});

describe("rewriteSrcset", () => {
  it("rewrites each candidate, preserving descriptors", () => {
    const input = "https://dorik.com/a.jpg 1x, https://dorik.com/b.jpg 2x, /c.jpg 3x";
    expect(rewriteSrcset(input, ORIGIN, PROXY)).toBe(
      "https://d-ab12cd34.reviewproxy.app/a.jpg 1x, https://d-ab12cd34.reviewproxy.app/b.jpg 2x, /c.jpg 3x",
    );
  });
});
