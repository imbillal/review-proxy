// review-proxy/tests/token.test.ts
import { describe, expect, it } from "vitest";
import { signProxyToken, verifyProxyToken } from "../src/token";

const SECRET = "test-secret";
const NOW = 1_700_000_000;

describe("proxy token", () => {
  it("verifies a freshly signed token", () => {
    const tok = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "user1" }, SECRET, 7200, NOW);
    const p = verifyProxyToken(tok, SECRET, "d-aaaa1111", NOW + 10);
    expect(p?.documentId).toBe("doc1");
    expect(p?.sub).toBe("user1");
  });

  it("rejects an expired token", () => {
    const tok = signProxyToken({ documentId: "d", subdomain: "d-aaaa1111", sub: "u" }, SECRET, 100, NOW);
    expect(verifyProxyToken(tok, SECRET, "d-aaaa1111", NOW + 200)).toBeNull();
  });

  it("rejects a token signed with a different secret", () => {
    const tok = signProxyToken({ documentId: "d", subdomain: "d-aaaa1111", sub: "u" }, "other", 7200, NOW);
    expect(verifyProxyToken(tok, SECRET, "d-aaaa1111", NOW)).toBeNull();
  });

  it("rejects a subdomain mismatch", () => {
    const tok = signProxyToken({ documentId: "d", subdomain: "d-aaaa1111", sub: "u" }, SECRET, 7200, NOW);
    expect(verifyProxyToken(tok, SECRET, "d-bbbb2222", NOW)).toBeNull();
  });

  it.each(["", "onlyonepart", "a.b.c", "garbage.token"])(
    "rejects malformed token %s",
    (tok) => {
      expect(verifyProxyToken(tok, SECRET, "d-aaaa1111", NOW)).toBeNull();
    },
  );
});
