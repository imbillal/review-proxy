// review-proxy/src/headers.ts
import { rewriteUrl } from "./rewrite-url";

const STRIP = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "permissions-policy",
  "content-length",
  // NOTE: content-encoding is intentionally NOT stripped here. Passthrough
  // (non-HTML/CSS) bodies are streamed still-compressed, so the browser needs
  // the header to decode them. The HTML/CSS branches of the handler delete it
  // explicitly after decompressing and rewriting the body.
  "set-cookie",       // handled separately, per-cookie
  "location",         // handled separately
]);

/** Copy upstream response headers minus framing/security/length headers. */
export function sanitizeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (STRIP.has(k) || value == null) continue;
    out[k] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Rewrite a Set-Cookie line: Domain → proxy host, force Secure. */
export function rewriteSetCookie(cookie: string, proxyHost: string): string {
  let out = cookie.replace(/;\s*Domain=[^;]*/i, `; Domain=${proxyHost}`);
  if (!/;\s*Domain=/i.test(out)) out += `; Domain=${proxyHost}`;
  if (!/;\s*Secure/i.test(out)) out += "; Secure";
  return out;
}

/** Rewrite a redirect Location: same-origin → proxy host; cross-origin unchanged. */
export function rewriteLocation(location: string, targetOrigin: string, proxyHost: string): string {
  if (/^https?:\/\//i.test(location) || location.startsWith("//")) {
    return rewriteUrl(location, targetOrigin, proxyHost);
  }
  return location; // relative — resolves to the proxy origin already
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Request headers never forwarded upstream: hop-by-hop, length (undici
// recomputes it), encoding (the proxy controls it), and anything that would
// leak the proxy's own auth (the __rt cookie) or a mismatched origin.
const REQUEST_HEADER_DENYLIST = new Set([
  "host",
  "cookie",
  "content-length",
  "accept-encoding",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-connection",
  "origin",
  "referer",
]);

/**
 * Headers sent to the upstream site. Forwards the page's own request headers
 * (content-type, accept, authorization, x-* …) so POST/API calls work, minus
 * the denylist above. Never includes review-platform headers.
 */
export function buildUpstreamHeaders(
  upstreamCookie: string | undefined,
  requestHeaders?: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const h: Record<string, string> = {};
  if (requestHeaders) {
    for (const [key, value] of Object.entries(requestHeaders)) {
      const k = key.toLowerCase();
      if (REQUEST_HEADER_DENYLIST.has(k) || value == null) continue;
      h[k] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  if (!h["user-agent"]) h["user-agent"] = BROWSER_UA;
  if (!h["accept"]) {
    h["accept"] =
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8";
  }
  if (!h["accept-language"]) h["accept-language"] = "en-US,en;q=0.9";
  h["accept-encoding"] = "gzip, deflate, br"; // proxy-controlled — it decodes buffered bodies
  if (upstreamCookie) h.cookie = upstreamCookie;
  return h;
}
