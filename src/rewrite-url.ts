// review-proxy/src/rewrite-url.ts
const SKIP_SCHEME = /^(data:|blob:|mailto:|tel:|javascript:|about:|#)/i;

/** Rewrite one URL: same-origin absolute → proxy origin; everything else unchanged. */
export function rewriteUrl(raw: string, targetOrigin: string, proxyBase: string): string {
  const trimmed = raw.trim();
  if (!trimmed || SKIP_SCHEME.test(trimmed)) return raw;
  const isAbsolute = /^https?:\/\//i.test(trimmed) || trimmed.startsWith("//");
  if (!isAbsolute) return raw; // relative / absolute-path: resolves to proxy already
  let abs: URL;
  try {
    abs = new URL(trimmed, targetOrigin);
  } catch {
    return raw;
  }
  if (abs.origin !== targetOrigin) return raw; // cross-origin → leave direct (§7)
  // Re-point at the proxy's public origin. Set scheme/hostname/port from the
  // proxy base (not the "host" setter, which retains an existing port when the
  // new value has none and would leak the upstream's port). In production the
  // base is https with no port; in local dev it is http://<host>:8080, so the
  // rewritten link keeps the scheme and port the browser actually reaches.
  const base = new URL(proxyBase);
  abs.protocol = base.protocol;
  abs.hostname = base.hostname;
  abs.port = base.port; // "" for default-port origins (prod https)
  return abs.toString();
}

/** Rewrite every candidate in a srcset attribute, preserving width/density descriptors. */
export function rewriteSrcset(value: string, targetOrigin: string, proxyBase: string): string {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const sp = trimmed.indexOf(" ");
      if (sp === -1) return rewriteUrl(trimmed, targetOrigin, proxyBase);
      const url = trimmed.slice(0, sp);
      const descriptor = trimmed.slice(sp);
      return rewriteUrl(url, targetOrigin, proxyBase) + descriptor;
    })
    .join(", ");
}
