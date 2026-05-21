// review-proxy/src/rewrite-url.ts
const SKIP_SCHEME = /^(data:|blob:|mailto:|tel:|javascript:|about:|#)/i;

/** Rewrite one URL: same-origin absolute → proxy host; everything else unchanged. */
export function rewriteUrl(raw: string, targetOrigin: string, proxyHost: string): string {
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
  abs.protocol = "https:";
  // Set hostname (not host) and clear the port: the URL "host" setter retains
  // an existing port when the new value has none, which would leak the
  // upstream's port (e.g. when targetOrigin is http://127.0.0.1:8080).
  abs.hostname = proxyHost;
  abs.port = "";
  return abs.toString();
}

/** Rewrite every candidate in a srcset attribute, preserving width/density descriptors. */
export function rewriteSrcset(value: string, targetOrigin: string, proxyHost: string): string {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const sp = trimmed.indexOf(" ");
      if (sp === -1) return rewriteUrl(trimmed, targetOrigin, proxyHost);
      const url = trimmed.slice(0, sp);
      const descriptor = trimmed.slice(sp);
      return rewriteUrl(url, targetOrigin, proxyHost) + descriptor;
    })
    .join(", ");
}
