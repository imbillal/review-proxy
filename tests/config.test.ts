// review-proxy/tests/config.test.ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  PORT: "8080",
  PROXY_DOMAIN: "reviewproxy.app",
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "mongodb://localhost/db",
  UPSTREAM_TIMEOUT_MS: "20000",
  MAX_HTML_BYTES: "15000000",
};

describe("loadConfig", () => {
  it("parses a complete environment", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.proxyDomain).toBe("reviewproxy.app");
    expect(c.appOrigin).toBe("http://localhost:3000");
    expect(c.upstreamTimeoutMs).toBe(20000);
    expect(c.maxHtmlBytes).toBe(15000000);
  });

  it("applies defaults for optional vars", () => {
    const c = loadConfig({
      PROXY_DOMAIN: "reviewproxy.app",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: "mongodb://localhost/db",
    });
    expect(c.port).toBe(8080);
    expect(c.upstreamTimeoutMs).toBe(20000);
    expect(c.maxHtmlBytes).toBe(15000000);
  });

  it.each(["PROXY_DOMAIN", "APP_ORIGIN", "DATABASE_URL"])(
    "throws when required var %s is missing",
    (key) => {
      const env = { ...base } as Record<string, string>;
      delete env[key];
      expect(() => loadConfig(env)).toThrow(key);
    },
  );
});
