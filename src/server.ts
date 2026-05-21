// review-proxy/src/server.ts
import Fastify, { type FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { handleProxyRequest, type ProxyDeps } from "./proxy-handler";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function buildServer(deps: ProxyDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  app.get("/healthz", async () => ({ ok: true }));

  // Single catch-all: every other GET/HEAD is a proxied request.
  app.route({
    method: ["GET", "HEAD"],
    url: "/*",
    handler: async (req, reply) => {
      const url = new URL(req.url, "http://placeholder");
      const result = await handleProxyRequest(
        {
          method: req.method,
          host: req.headers.host ?? "",
          path: url.pathname,
          query: url.search.replace(/^\?/, ""),
          cookies: parseCookies(req.headers.cookie),
        },
        deps,
      );
      reply.status(result.status);
      for (const [key, value] of Object.entries(result.headers)) {
        reply.header(key, value);
      }
      if (result.body instanceof Readable) return reply.send(result.body);
      return reply.send(result.body);
    },
  });

  return app;
}
