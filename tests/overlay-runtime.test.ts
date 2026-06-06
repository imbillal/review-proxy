// review-proxy/tests/overlay-runtime.test.ts
import { describe, expect, it } from "vitest";
import { FRAME_BUST_SCRIPT, buildOverlayRuntime } from "../src/overlay-runtime";

describe("FRAME_BUST_SCRIPT", () => {
  it("neutralizes frame detection", () => {
    expect(FRAME_BUST_SCRIPT).toContain("frameElement");
    expect(FRAME_BUST_SCRIPT).toContain("document");
  });

  it("shims localStorage and sessionStorage so storage-denied iframes don't crash", () => {
    // In a cross-site iframe with third-party storage blocked, reading
    // window.localStorage throws SecurityError and storage-using SPAs crash on
    // boot. The head script must install an in-memory fallback for both stores.
    expect(FRAME_BUST_SCRIPT).toContain("shimStorage");
    expect(FRAME_BUST_SCRIPT).toContain('shimStorage("localStorage")');
    expect(FRAME_BUST_SCRIPT).toContain('shimStorage("sessionStorage")');
  });
});

describe("buildOverlayRuntime", () => {
  it("bakes the parent app origin into the postMessage target", () => {
    const src = buildOverlayRuntime("https://www.example.com");
    expect(src).toContain('"https://www.example.com"');
    expect(src).toContain("pinion:ready");
  });
});
