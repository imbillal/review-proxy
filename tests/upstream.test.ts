// review-proxy/tests/upstream.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { fetchUpstream } from "../src/upstream";

let server: http.Server;
let base: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/html") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>hi</body></html>");
    } else if (req.url === "/gz") {
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      res.end(gzipSync(Buffer.from("<html><body>gz</body></html>")));
    } else if (req.url === "/redir") {
      res.writeHead(302, { location: "/html" });
      res.end();
    } else {
      res.writeHead(404);
      res.end("no");
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("fetchUpstream", () => {
  it("buffers and returns HTML as decoded text", async () => {
    const r = await fetchUpstream(`${base}/html`, { method: "GET", timeoutMs: 5000, maxBytes: 1_000_000 });
    expect(r.statusCode).toBe(200);
    expect(r.bodyText).toContain("hi");
  });

  it("decompresses a gzipped HTML body", async () => {
    const r = await fetchUpstream(`${base}/gz`, { method: "GET", timeoutMs: 5000, maxBytes: 1_000_000 });
    expect(r.bodyText).toContain("gz");
  });

  it("returns a 3xx without following it", async () => {
    const r = await fetchUpstream(`${base}/redir`, { method: "GET", timeoutMs: 5000, maxBytes: 1_000_000 });
    expect(r.statusCode).toBe(302);
    expect(r.headers["location"]).toBe("/html");
  });
});
