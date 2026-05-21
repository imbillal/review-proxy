// review-proxy/src/upstream.ts
import { request } from "undici";
import { Readable } from "node:stream";
import { gunzipSync, inflateSync, brotliDecompressSync } from "node:zlib";
import { buildUpstreamHeaders } from "./headers";

export type UpstreamOptions = {
  method: string;
  timeoutMs: number;
  maxBytes: number;
  upstreamCookie?: string;
};

export type UpstreamResponse = {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  /** Decoded body when the content type was buffered (HTML/CSS); else undefined. */
  bodyText?: string;
  /** Raw passthrough stream when the body was not buffered. */
  bodyStream?: Readable;
  contentType: string;
};

const BUFFERED = /text\/html|application\/xhtml\+xml|text\/css/i;

function decode(buf: Buffer, encoding: string | undefined): Buffer {
  switch ((encoding ?? "").toLowerCase()) {
    case "gzip": return gunzipSync(buf);
    case "deflate": return inflateSync(buf);
    case "br": return brotliDecompressSync(buf);
    default: return buf;
  }
}

export async function fetchUpstream(url: string, opts: UpstreamOptions): Promise<UpstreamResponse> {
  const res = await request(url, {
    method: opts.method as "GET" | "HEAD",
    headers: buildUpstreamHeaders(opts.upstreamCookie),
    // No redirect following — undici's request() does not follow redirects by
    // default, so 3xx responses pass through for the handler to rewrite Location.
    headersTimeout: opts.timeoutMs,
    bodyTimeout: opts.timeoutMs,
  });

  const contentType = String(res.headers["content-type"] ?? "");

  if (!BUFFERED.test(contentType) || opts.method === "HEAD") {
    return {
      statusCode: res.statusCode,
      headers: res.headers,
      bodyStream: Readable.from(res.body),
      contentType,
    };
  }

  // Buffer HTML/CSS with a hard size cap, then decompress.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > opts.maxBytes) {
      throw new Error("UPSTREAM_TOO_LARGE");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks);
  const decoded = decode(raw, res.headers["content-encoding"] as string | undefined);
  return {
    statusCode: res.statusCode,
    headers: res.headers,
    bodyText: decoded.toString("utf8"),
    contentType,
  };
}
