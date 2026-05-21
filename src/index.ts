// review-proxy/src/index.ts
import "dotenv/config";
import { MongoClient } from "mongodb";
import { loadConfig } from "./config";
import { createRegistry, createMongoFetcher } from "./registry";
import { assertUpstreamAllowed } from "./ssrf";
import { fetchUpstream } from "./upstream";
import { buildServer } from "./server";

async function main(): Promise<void> {
  const config = loadConfig();
  const mongo = new MongoClient(config.databaseUrl);
  await mongo.connect();

  const registry = createRegistry(createMongoFetcher(mongo), 60_000);
  const app = buildServer({
    config,
    lookupSite: registry.lookup,
    assertUpstreamAllowed,
    fetchUpstream,
  });

  const shutdown = async () => {
    await app.close();
    await mongo.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  console.error("[review-proxy] fatal:", err);
  process.exit(1);
});
