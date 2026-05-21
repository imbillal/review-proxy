// review-proxy/tests/error-pages.test.ts
import { describe, expect, it } from "vitest";
import { errorPage } from "../src/error-pages";

describe("errorPage", () => {
  it("returns status, html body, and posts pinion:ready", () => {
    const r = errorPage("UNKNOWN_SUBDOMAIN", "http://localhost:3000");
    expect(r.status).toBe(404);
    expect(r.body).toContain("not available");
    expect(r.body).toContain("pinion:ready");
    expect(r.body).toContain("http://localhost:3000");
  });

  it("maps each known kind to the documented status", () => {
    expect(errorPage("BAD_TOKEN", "o").status).toBe(401);
    expect(errorPage("UPSTREAM_UNREACHABLE", "o").status).toBe(502);
    expect(errorPage("UPSTREAM_TIMEOUT", "o").status).toBe(504);
    expect(errorPage("TOO_LARGE", "o").status).toBe(502);
    expect(errorPage("REDIRECT_LOOP", "o").status).toBe(508);
  });
});
