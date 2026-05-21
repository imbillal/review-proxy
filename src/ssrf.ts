// review-proxy/src/ssrf.ts
import { lookup } from "node:dns/promises";

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

export function isPrivateAddress(host: string): boolean {
  return isPrivateIPv4(host) || isPrivateIPv6(host);
}

/** Throws if the URL's host is private, mDNS, or resolves to a private IP. */
export async function assertUpstreamAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("SSRF: invalid upstream URL");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("SSRF: loopback/mDNS host blocked");
  }
  if (isPrivateAddress(host)) {
    throw new Error("SSRF: private host blocked");
  }
  // DNS-rebinding defense: resolve and re-check every returned address.
  const records = await lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new Error("SSRF: host resolves to a private address");
    }
  }
}
