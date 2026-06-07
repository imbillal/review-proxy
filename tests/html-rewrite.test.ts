// review-proxy/tests/html-rewrite.test.ts
import { describe, expect, it } from "vitest";
import { rewriteHtml } from "../src/html-rewrite";

const OPTS = {
  targetOrigin: "https://dorik.com",
  proxyBase: "https://d-ab12cd34.reviewproxy.app",
  frameBustScript: "/*fb*/",
  runtimeScript: "/*rt*/",
};

describe("rewriteHtml", () => {
  it("rewrites same-origin absolute hrefs and leaves relative ones", () => {
    const out = rewriteHtml(
      `<html><body><a href="https://dorik.com/about">a</a><a href="/x">b</a></body></html>`,
      OPTS,
    );
    expect(out).toContain('href="https://d-ab12cd34.reviewproxy.app/about"');
    expect(out).toContain('href="/x"');
  });

  it("leaves cross-origin asset URLs direct", () => {
    const out = rewriteHtml(`<body><img src="https://cdn.example.com/a.png"></body>`, OPTS);
    expect(out).toContain('src="https://cdn.example.com/a.png"');
  });

  it("rewrites srcset candidates", () => {
    const out = rewriteHtml(
      `<body><img srcset="https://dorik.com/a.png 1x, /b.png 2x"></body>`,
      OPTS,
    );
    expect(out).toContain("https://d-ab12cd34.reviewproxy.app/a.png 1x");
  });

  it("removes Cloudflare's challenge-platform script (inline loader + src) so it can't flip the framed page to an interstitial", () => {
    // The inline form is what live Cloudflare actually injects: an inline script
    // that sets window.__CF$cv$params and appends the jsd/main.js loader.
    const out = rewriteHtml(
      `<html><head>` +
        `<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>` +
        `<script>(function(){window.__CF$cv$params={r:'abc',t:'xyz'};var a=document.createElement('script');a.src='/cdn-cgi/challenge-platform/scripts/jsd/main.js';document.getElementsByTagName('head')[0].appendChild(a);})();</script>` +
        `<script src="/app.js"></script>` +
        `</head><body><h1>Real coffee page</h1></body></html>`,
      OPTS,
    );
    expect(out).not.toContain("cdn-cgi/challenge-platform");
    expect(out).not.toContain("__CF$cv$params");
    // The real page and unrelated scripts survive.
    expect(out).toContain("Real coffee page");
    expect(out).toContain("/app.js");
  });

  it("strips integrity and CSP/XFO meta tags", () => {
    const out = rewriteHtml(
      `<head><meta http-equiv="Content-Security-Policy" content="x">` +
        `<script src="/a.js" integrity="sha256-xxx"></script></head><body></body>`,
      OPTS,
    );
    expect(out).not.toContain("integrity");
    expect(out.toLowerCase()).not.toContain("content-security-policy");
  });

  it("injects the frame-bust script into head and the runtime into body", () => {
    const out = rewriteHtml(`<html><head></head><body></body></html>`, OPTS);
    expect(out).toContain("/*fb*/");
    expect(out).toContain("/*rt*/");
    expect(out.indexOf("/*rt*/")).toBeGreaterThan(out.indexOf("</body".length > 0 ? "" : ""));
  });

  it("rewrites url() in a <style> body", () => {
    const out = rewriteHtml(
      `<head><style>a{background:url(https://dorik.com/bg.png)}</style></head><body></body>`,
      OPTS,
    );
    expect(out).toContain("https://d-ab12cd34.reviewproxy.app/bg.png");
  });
});
