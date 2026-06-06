// review-proxy/src/proxy-handler.ts
import { Readable } from "node:stream";
import type { Config } from "./config";
import type { SiteRecord } from "./registry";
import type { UpstreamResponse } from "./upstream";
import { parseSubdomain } from "./subdomain";
import { rewriteHtml } from "./html-rewrite";
import { rewriteCss } from "./css-rewrite";
import { sanitizeResponseHeaders, rewriteSetCookie, rewriteLocation } from "./headers";
import { buildOverlayRuntime, FRAME_BUST_SCRIPT } from "./overlay-runtime";
import { errorPage, type ErrorKind } from "./error-pages";

export type ProxyRequest = {
  method: string;
  host: string;
  path: string;          // pathname only
  query: string;         // raw query string, no leading "?"
  cookies: Record<string, string>;
  body?: Buffer;         // request body for POST/PUT/PATCH/DELETE
  requestHeaders?: Record<string, string | string[] | undefined>;
};

export type ProxyResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer | Readable;
};

export type ProxyDeps = {
  config: Config;
  lookupSite: (subdomain: string) => Promise<SiteRecord | null>;
  assertUpstreamAllowed: (url: string) => Promise<void>;
  fetchUpstream: (
    url: string,
    opts: {
      method: string;
      timeoutMs: number;
      maxBytes: number;
      body?: Buffer;
      requestHeaders?: Record<string, string | string[] | undefined>;
    },
  ) => Promise<UpstreamResponse>;
};

function htmlError(kind: ErrorKind, appOrigin: string): ProxyResponse {
  const { status, body } = errorPage(kind, appOrigin);
  return { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body };
}

// Request bodies we may host-rewrite. Binary uploads (images, octet-stream,
// multipart) are left untouched.
const REWRITABLE_REQUEST_BODY =
  /application\/json|application\/graphql|application\/x-www-form-urlencoded|text\//i;

function headerValue(
  headers: Record<string, string | string[] | undefined> | undefined,
  name: string,
): string | undefined {
  const v = headers?.[name];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Rewrite the proxy's own host → the upstream host inside a textual request body.
 *
 * SPAs frequently resolve *themselves* by `window.location.hostname` — e.g. a CMS
 * `getSiteByDomain(domain)` lookup. Through the proxy that hostname is the proxy
 * subdomain (`d-x.proxy.example.com`), which the upstream's CMS doesn't recognize,
 * so it 404s and the app renders its own "could not be loaded" error. Swapping the
 * proxy host back to the real target host makes those self-lookups resolve.
 * No-op for non-textual bodies or bodies that don't mention the proxy host.
 */
export function rewriteRequestBody(
  body: Buffer | undefined,
  headers: Record<string, string | string[] | undefined> | undefined,
  proxyHost: string,
  publicPort: string,
  targetOrigin: string,
): Buffer | undefined {
  if (!body || body.length === 0) return body;
  const ct = headerValue(headers, "content-type") ?? "";
  if (!REWRITABLE_REQUEST_BODY.test(ct)) return body;
  let targetHost: string;
  try {
    targetHost = new URL(targetOrigin).host;
  } catch {
    return body;
  }
  const text = body.toString("utf8");
  let out = text;
  // location.host (with dev port) before the bare location.hostname.
  if (publicPort) out = out.split(`${proxyHost}:${publicPort}`).join(targetHost);
  out = out.split(proxyHost).join(targetHost);
  return out === text ? body : Buffer.from(out, "utf8");
}

export async function handleProxyRequest(req: ProxyRequest, deps: ProxyDeps): Promise<ProxyResponse> {
  const { config } = deps;
  const appOrigin = config.appOrigin;

  // 1. Host → subdomain.
  const subdomain = parseSubdomain(req.host, config.proxyDomain);
  if (!subdomain) return htmlError("UNKNOWN_SUBDOMAIN", appOrigin);

  // 2. Registry lookup.
  const site = await deps.lookupSite(subdomain);
  if (!site || !site.enabled) return htmlError("UNKNOWN_SUBDOMAIN", appOrigin);

  // 3. Build the upstream URL. The proxy is open: access is gated only by the
  // subdomain resolving to an enabled registry entry — there is no per-viewer
  // token. The query string passes through to the upstream unchanged.
  const cleanQuery = req.query ? `?${req.query}` : "";
  const upstreamUrl = site.targetOrigin + req.path + cleanQuery;

  // 4. SSRF re-check (DNS rebinding).
  try {
    await deps.assertUpstreamAllowed(upstreamUrl);
  } catch {
    return htmlError("UPSTREAM_UNREACHABLE", appOrigin);
  }

  // 5. Fetch upstream. Rewrite the proxy host → target host in the request body
  // so the upstream's self-lookups (e.g. CMS getSiteByDomain) resolve (§ above).
  const outBody = rewriteRequestBody(
    req.body,
    req.requestHeaders,
    `${subdomain}.${config.proxyDomain}`,
    config.publicPort,
    site.targetOrigin,
  );
  let upstream: UpstreamResponse;
  try {
    upstream = await deps.fetchUpstream(upstreamUrl, {
      method: req.method,
      timeoutMs: config.upstreamTimeoutMs,
      maxBytes: config.maxHtmlBytes,
      body: outBody,
      requestHeaders: req.requestHeaders,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/TIMEOUT/i.test(msg)) return htmlError("UPSTREAM_TIMEOUT", appOrigin);
    if (/TOO_LARGE/i.test(msg)) return htmlError("TOO_LARGE", appOrigin);
    return htmlError("UPSTREAM_UNREACHABLE", appOrigin);
  }

  const proxyHost = `${subdomain}.${config.proxyDomain}`;
  // Full public origin for URL rewriting (scheme + host + port). proxyHost stays
  // bare for the cookie Domain attribute, which must be a hostname only.
  const proxyScheme = config.publicScheme || "https";
  const proxyBase = `${proxyScheme}://${proxyHost}${config.publicPort ? `:${config.publicPort}` : ""}`;
  const headers = sanitizeResponseHeaders(upstream.headers);

  // Rewrite Set-Cookie (may be one or many).
  const rawCookies = upstream.headers["set-cookie"];
  if (rawCookies != null) {
    const list = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
    headers["set-cookie"] = list.map((c) => rewriteSetCookie(c, proxyHost)) as unknown as string;
  }

  // 6. Branch on the response.
  // 3xx — rewrite Location.
  if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
    const loc = upstream.headers["location"];
    const out: Record<string, string | string[]> = { ...headers };
    delete out["content-encoding"]; // redirect body is empty
    if (typeof loc === "string") {
      out["location"] = rewriteLocation(loc, site.targetOrigin, proxyBase);
    }
    return { status: upstream.statusCode, headers: out, body: "" };
  }

  // HTML — rewrite + inject.
  if (/text\/html|application\/xhtml\+xml/i.test(upstream.contentType) && upstream.bodyText != null) {
    const rewritten = rewriteHtml(upstream.bodyText, {
      targetOrigin: site.targetOrigin,
      proxyBase,
      frameBustScript: FRAME_BUST_SCRIPT,
      runtimeScript: buildOverlayRuntime(appOrigin),
    });
    headers["content-type"] = "text/html; charset=utf-8";
    delete headers["content-encoding"]; // body was decompressed and rewritten
    return { status: upstream.statusCode, headers, body: rewritten };
  }

  // CSS — rewrite url()/@import.
  if (/text\/css/i.test(upstream.contentType) && upstream.bodyText != null) {
    headers["content-type"] = "text/css";
    delete headers["content-encoding"]; // body was decompressed and rewritten
    return {
      status: upstream.statusCode,
      headers,
      body: rewriteCss(upstream.bodyText, site.targetOrigin, proxyBase),
    };
  }

  // Everything else — stream through unmodified.
  return {
    status: upstream.statusCode,
    headers,
    body: upstream.bodyStream ?? Readable.from([]),
  };
}
