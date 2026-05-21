// review-proxy/tests/css-rewrite.test.ts
import { describe, expect, it } from "vitest";
import { rewriteCss } from "../src/css-rewrite";

const ORIGIN = "https://dorik.com";
const PROXY = "d-ab12cd34.reviewproxy.app";

describe("rewriteCss", () => {
  it("rewrites a same-origin absolute url()", () => {
    expect(rewriteCss("a{background:url(https://dorik.com/bg.png)}", ORIGIN, PROXY))
      .toBe("a{background:url(https://d-ab12cd34.reviewproxy.app/bg.png)}");
  });

  it("preserves quotes in url()", () => {
    expect(rewriteCss('a{background:url("https://dorik.com/b.png")}', ORIGIN, PROXY))
      .toBe('a{background:url("https://d-ab12cd34.reviewproxy.app/b.png")}');
  });

  it("leaves relative and cross-origin url() unchanged", () => {
    const css = "a{background:url(/x.png)} b{background:url(https://cdn.example.com/y.png)}";
    expect(rewriteCss(css, ORIGIN, PROXY)).toBe(css);
  });

  it("rewrites @import", () => {
    expect(rewriteCss('@import "https://dorik.com/t.css";', ORIGIN, PROXY))
      .toBe('@import "https://d-ab12cd34.reviewproxy.app/t.css";');
  });
});
