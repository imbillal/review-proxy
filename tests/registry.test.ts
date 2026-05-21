// review-proxy/tests/registry.test.ts
import { describe, expect, it, vi } from "vitest";
import { createRegistry, type SiteRecord } from "../src/registry";

const REC: SiteRecord = { targetOrigin: "https://dorik.com", documentId: "doc1", enabled: true };

describe("createRegistry cache", () => {
  it("caches a hit for the TTL window", async () => {
    const fetcher = vi.fn(async () => REC);
    const reg = createRegistry(fetcher, 60_000);
    expect(await reg.lookup("d-aaaa1111")).toEqual(REC);
    expect(await reg.lookup("d-aaaa1111")).toEqual(REC);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after the TTL expires", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => REC);
    const reg = createRegistry(fetcher, 60_000);
    await reg.lookup("d-aaaa1111");
    vi.advanceTimersByTime(61_000);
    await reg.lookup("d-aaaa1111");
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("caches a miss (null) too", async () => {
    const fetcher = vi.fn(async () => null);
    const reg = createRegistry(fetcher, 60_000);
    expect(await reg.lookup("d-missing0")).toBeNull();
    expect(await reg.lookup("d-missing0")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
