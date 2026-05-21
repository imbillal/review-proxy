// review-proxy/tests/subdomain.test.ts
import { describe, expect, it } from "vitest";
import { parseSubdomain } from "../src/subdomain";

const DOMAIN = "reviewproxy.app";

describe("parseSubdomain", () => {
  it("extracts the label from a subdomain host", () => {
    expect(parseSubdomain("d-ab12cd34.reviewproxy.app", DOMAIN)).toBe("d-ab12cd34");
  });

  it("ignores a port in the Host header", () => {
    expect(parseSubdomain("d-ab12cd34.reviewproxy.app:8080", DOMAIN)).toBe("d-ab12cd34");
  });

  it("is case-insensitive", () => {
    expect(parseSubdomain("D-AB12CD34.ReviewProxy.App", DOMAIN)).toBe("d-ab12cd34");
  });

  it("returns null for the apex domain", () => {
    expect(parseSubdomain("reviewproxy.app", DOMAIN)).toBeNull();
  });

  it("returns null for a foreign domain", () => {
    expect(parseSubdomain("d-ab12cd34.evil.com", DOMAIN)).toBeNull();
  });

  it("returns null for a multi-label subdomain", () => {
    expect(parseSubdomain("a.b.reviewproxy.app", DOMAIN)).toBeNull();
  });

  it.each(["", undefined, "d-ab12cd34..reviewproxy.app", "_x.reviewproxy.app"])(
    "returns null for malformed host %s",
    (host) => {
      expect(parseSubdomain(host as string, DOMAIN)).toBeNull();
    },
  );
});
