// review-proxy/src/token.ts
import crypto from "node:crypto";

export type ProxyTokenPayload = {
  documentId: string;
  subdomain: string;
  sub: string;
  iat: number;
  exp: number;
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signProxyToken(
  claims: { documentId: string; subdomain: string; sub: string },
  secret: string,
  ttlSeconds = 2 * 60 * 60,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload: ProxyTokenPayload = {
    ...claims,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64urlEncode(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyProxyToken(
  token: string,
  secret: string,
  expectedSubdomain: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ProxyTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = b64urlEncode(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: ProxyTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as ProxyTokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.documentId !== "string" ||
    typeof payload.subdomain !== "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp < nowSeconds) return null;
  if (payload.subdomain !== expectedSubdomain) return null;
  return payload;
}
