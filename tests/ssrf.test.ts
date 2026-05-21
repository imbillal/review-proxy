// review-proxy/tests/ssrf.test.ts
import { describe, expect, it } from "vitest";
import { isPrivateAddress, assertUpstreamAllowed } from "../src/ssrf";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.9.9",
    "169.254.169.254", "0.0.0.0", "::1", "fc00::1", "fe80::1",
  ])("flags %s as private", (ip) => {
    expect(isPrivateAddress(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])(
    "treats %s as public",
    (ip) => {
      expect(isPrivateAddress(ip)).toBe(false);
    },
  );
});

describe("assertUpstreamAllowed", () => {
  it("rejects a literal private host without resolving", async () => {
    await expect(assertUpstreamAllowed("http://10.0.0.1/x")).rejects.toThrow();
  });

  it("allows a public host (resolves DNS)", async () => {
    await expect(assertUpstreamAllowed("https://example.com/")).resolves.toBeUndefined();
  });
});
