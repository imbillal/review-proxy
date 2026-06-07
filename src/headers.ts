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
  // transfer-encoding: the proxy buffers and re-emits every body (rewritten HTML/
  // CSS, or a fresh stream for passthrough), so the framework sets its own framing.
  // Forwarding the upstream's `transfer-encoding: chunked` leaves it alongside the
  // re-added Content-Length → "Content-Length can't be present with Transfer-
  // Encoding". Browsers tolerate it; strict HTTP edges (Render) reject the response.
  "transfer-encoding",
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

/** Rewrite a redirect Location: same-origin → proxy origin; cross-origin unchanged. */
export function rewriteLocation(location: string, targetOrigin: string, proxyBase: string): string {
  if (/^https?:\/\//i.test(location) || location.startsWith("//")) {
    return rewriteUrl(location, targetOrigin, proxyBase);
  }
  return location; // relative — resolves to the proxy origin already
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

// Request headers never forwarded upstream: hop-by-hop, length (undici
// recomputes it), encoding (the proxy controls it), and anything that would
// leak a mismatched origin.
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
  // Forwarding/infra headers injected by the edge (Cloudflare, Render, …).
  // These leak the proxy's OWN hostname and the visitor's real IP to the
  // upstream. Critically, multi-tenant upstreams commonly resolve the site via
  // `x-forwarded-host || host`, so forwarding x-forwarded-host = the proxy
  // subdomain makes them look up the wrong tenant (404). The proxy must present
  // as a clean direct client; undici sets Host from the upstream URL itself.
  "forwarded",
  "via",
  "x-real-ip",
  "true-client-ip",
  "cdn-loop",
  // Browser fingerprint hint. Forwarded alongside the proxy's undici (non-Chrome)
  // network fingerprint, a perfect "I am Chrome" header set makes anti-bot edges
  // (Cloudflare) flag a spoofed browser and serve a challenge. We present as a
  // plain client instead — see the sec-ch-/sec-fetch- prefixes below.
  "priority",
]);

// Any header in these families is also infra/forwarding noise (or browser
// fingerprint hints) and is dropped. `sec-ch-*` (client hints) and `sec-fetch-*`
// (fetch metadata) are what let Cloudflare's bot check tell a real Chrome from
// the proxy's undici fetch; dropping them makes upstream requests look like the
// simple client that reliably gets the real page.
const DENY_PREFIXES = [
  "x-forwarded-",
  "cf-",
  "x-render-",
  "render-",
  "x-vercel-",
  "sec-ch-",
  "sec-fetch-",
];

function isForwardedHeader(key: string): boolean {
  return REQUEST_HEADER_DENYLIST.has(key) || DENY_PREFIXES.some((p) => key.startsWith(p));
}

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
      if (isForwardedHeader(k) || value == null) continue;
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
