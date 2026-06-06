// review-proxy/src/proxy-handler.ts
import { Readable } from "node:stream";
import type { Config } from "./config";
import type { SiteRecord } from "./registry";
import type { UpstreamResponse } from "./upstream";
import { parseSubdomain } from "./subdomain";
import { verifyProxyToken } from "./token";
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

export async function handleProxyRequest(req: ProxyRequest, deps: ProxyDeps): Promise<ProxyResponse> {
  const { config } = deps;
  const appOrigin = config.appOrigin;

  // 1. Host → subdomain.
  const subdomain = parseSubdomain(req.host, config.proxyDomain);
  if (!subdomain) return htmlError("UNKNOWN_SUBDOMAIN", appOrigin);

  // 2. Registry lookup.
  const site = await deps.lookupSite(subdomain);
  if (!site || !site.enabled) return htmlError("UNKNOWN_SUBDOMAIN", appOrigin);

  // 3. Authenticate.
  const params = new URLSearchParams(req.query);
  const queryToken = params.get("__rt");
  // A query token is a deliberate fresh entry minted by the app, so it wins over
  // any cookie. Preferring the cookie would strand a viewer on a stale cookie
  // from an earlier session (expired or for another document) — the fresh token
  // would be ignored and every reload would 401 "Link expired".
  const token = queryToken ?? req.cookies["__rt"] ?? "";
  const payload = verifyProxyToken(token, config.proxyTokenSecret, subdomain);
  if (!payload || payload.documentId !== site.documentId) {
    return htmlError("BAD_TOKEN", appOrigin);
  }
  // If the token arrived via the query string on a navigation, persist it as the
  // cookie and 302 to a clean URL. This also overwrites a stale cookie. Only
  // GET/HEAD — a 302 would drop a POST/PUT body.
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    queryToken &&
    req.cookies["__rt"] !== queryToken
  ) {
    params.delete("__rt");
    const clean = req.path + (params.toString() ? `?${params.toString()}` : "");
    return {
      status: 302,
      headers: {
        location: clean,
        "set-cookie": `__rt=${queryToken}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
        "cache-control": "no-store",
      },
      body: "",
    };
  }

  // 4. Build the upstream URL.
  const cleanQuery = (() => {
    params.delete("__rt");
    const s = params.toString();
    return s ? `?${s}` : "";
  })();
  const upstreamUrl = site.targetOrigin + req.path + cleanQuery;

  // 5. SSRF re-check (DNS rebinding).
  try {
    await deps.assertUpstreamAllowed(upstreamUrl);
  } catch {
    return htmlError("UPSTREAM_UNREACHABLE", appOrigin);
  }

  // 6. Fetch upstream.
  let upstream: UpstreamResponse;
  try {
    upstream = await deps.fetchUpstream(upstreamUrl, {
      method: req.method,
      timeoutMs: config.upstreamTimeoutMs,
      maxBytes: config.maxHtmlBytes,
      body: req.body,
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

  // 7. Branch on the response.
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
