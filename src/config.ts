// review-proxy/src/config.ts
export type Config = {
  port: number;
  proxyDomain: string;
  appOrigin: string;
  databaseUrl: string;
  upstreamTimeoutMs: number;
  maxHtmlBytes: number;
  // Public-facing origin the proxy is reached at, used to rewrite same-origin
  // absolute URLs in proxied bodies. Production terminates TLS upstream, so the
  // default is https with no explicit port. Local dev sets PUBLIC_SCHEME=http +
  // PUBLIC_PORT=8080 so rewritten links keep the dev scheme and port.
  publicScheme: string;
  publicPort: string;
};

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function intOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: intOr(env.PORT, 8080),
    proxyDomain: required(env, "PROXY_DOMAIN").toLowerCase(),
    appOrigin: required(env, "APP_ORIGIN").replace(/\/$/, ""),
    databaseUrl: required(env, "DATABASE_URL"),
    upstreamTimeoutMs: intOr(env.UPSTREAM_TIMEOUT_MS, 20000),
    maxHtmlBytes: intOr(env.MAX_HTML_BYTES, 15_000_000),
    publicScheme: (env.PUBLIC_SCHEME ?? "https").toLowerCase(),
    publicPort: env.PUBLIC_PORT ?? "",
  };
}
