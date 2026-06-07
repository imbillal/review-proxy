// review-proxy/src/html-rewrite.ts
import * as cheerio from "cheerio";
import { rewriteUrl, rewriteSrcset } from "./rewrite-url";
import { rewriteCss } from "./css-rewrite";

export type RewriteHtmlOptions = {
  targetOrigin: string;
  proxyBase: string;
  frameBustScript: string;
  runtimeScript: string;
};

// [selector, attribute] pairs for plain URL attributes.
const URL_ATTRS: ReadonlyArray<readonly [string, string]> = [
  ["a[href]", "href"], ["link[href]", "href"], ["area[href]", "href"],
  ["img[src]", "src"], ["script[src]", "src"], ["iframe[src]", "src"],
  ["source[src]", "src"], ["video[src]", "src"], ["audio[src]", "src"],
  ["track[src]", "src"], ["embed[src]", "src"],
  ["video[poster]", "poster"], ["form[action]", "action"],
  ["button[formaction]", "formaction"], ["input[formaction]", "formaction"],
  ["object[data]", "data"],
];

export function rewriteHtml(html: string, opts: RewriteHtmlOptions): string {
  const { targetOrigin, proxyBase, frameBustScript, runtimeScript } = opts;
  const $ = cheerio.load(html);
  const rw = (u: string) => rewriteUrl(u, targetOrigin, proxyBase);

  // Cloudflare's bot-challenge / "JavaScript Detections" injection. Left in place
  // it runs inside the frame, fails its verify callback through the proxy, and
  // flips the real page to a "Just a moment…" interstitial. The proxy already
  // fetched the real page server-side, so we drop it and let the content render.
  // Cloudflare injects it two ways: a direct <script src=".../cdn-cgi/challenge-
  // platform/..."> and an inline loader that sets window.__CF$cv$params and
  // appends jsd/main.js. Remove both.
  $("script").each((_, el) => {
    const src = $(el).attr("src") ?? "";
    const code = $(el).html() ?? "";
    if (
      src.includes("/cdn-cgi/challenge-platform") ||
      code.includes("/cdn-cgi/challenge-platform") ||
      code.includes("__CF$cv$params")
    ) {
      $(el).remove();
    }
  });

  for (const [selector, attr] of URL_ATTRS) {
    $(selector).each((_, el) => {
      const v = $(el).attr(attr);
      if (v != null) $(el).attr(attr, rw(v));
    });
  }

  $("img[srcset], source[srcset]").each((_, el) => {
    const v = $(el).attr("srcset");
    if (v != null) $(el).attr("srcset", rewriteSrcset(v, targetOrigin, proxyBase));
  });

  $("use, image").each((_, el) => {
    for (const a of ["href", "xlink:href"]) {
      const v = $(el).attr(a);
      if (v != null) $(el).attr(a, rw(v));
    }
  });

  $("base[href]").each((_, el) => {
    const v = $(el).attr("href");
    if (v != null) $(el).attr("href", rw(v));
  });

  // <meta http-equiv="refresh" content="3; url=...">
  $("meta[http-equiv]").each((_, el) => {
    if (($(el).attr("http-equiv") ?? "").toLowerCase() !== "refresh") return;
    const content = $(el).attr("content");
    if (!content) return;
    const m = content.match(/^(\s*[\d.]+\s*;\s*url=)(.+)$/i);
    if (m) $(el).attr("content", m[1] + rw(m[2]!.trim()));
  });

  // Inline style="" attributes.
  $("[style]").each((_, el) => {
    const v = $(el).attr("style");
    if (v != null) $(el).attr("style", rewriteCss(v, targetOrigin, proxyBase));
  });

  // <style> element bodies.
  $("style").each((_, el) => {
    const css = $(el).html();
    if (css != null) $(el).html(rewriteCss(css, targetOrigin, proxyBase));
  });

  // Sub-resource integrity breaks once we rewrite/proxy.
  $("[integrity]").removeAttr("integrity");

  // Strip CSP / X-Frame-Options <meta> tags (header equivalents stripped separately).
  $("meta[http-equiv]").each((_, el) => {
    const eq = ($(el).attr("http-equiv") ?? "").toLowerCase();
    if (eq === "content-security-policy" || eq === "x-frame-options") $(el).remove();
  });

  // Ensure head/body exist, then inject.
  if ($("head").length === 0) $("html").prepend("<head></head>");
  $("head").prepend(`<script>${frameBustScript}</script>`);
  if ($("body").length === 0) $("html").append("<body></body>");
  $("body").append(`<script>${runtimeScript}</script>`);

  return $.html();
}
