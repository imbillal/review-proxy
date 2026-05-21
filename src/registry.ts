// review-proxy/src/registry.ts
import { MongoClient } from "mongodb";

export type SiteRecord = {
  targetOrigin: string;
  documentId: string;
  enabled: boolean;
};

export type Registry = {
  lookup: (subdomain: string) => Promise<SiteRecord | null>;
};

type SiteFetcher = (subdomain: string) => Promise<SiteRecord | null>;

/** Wrap a fetcher with a per-subdomain TTL cache (hits and misses both cached). */
export function createRegistry(fetcher: SiteFetcher, ttlMs: number): Registry {
  const cache = new Map<string, { value: SiteRecord | null; expiresAt: number }>();
  return {
    async lookup(subdomain) {
      const hit = cache.get(subdomain);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      const value = await fetcher(subdomain);
      cache.set(subdomain, { value, expiresAt: Date.now() + ttlMs });
      return value;
    },
  };
}

/** Production fetcher: a single indexed query on the shared ProxySite collection. */
export function createMongoFetcher(client: MongoClient): SiteFetcher {
  const collection = client.db().collection("ProxySite");
  return async (subdomain) => {
    const row = await collection.findOne(
      { subdomain },
      { projection: { targetOrigin: 1, documentId: 1, enabled: 1 } },
    );
    if (!row) return null;
    return {
      targetOrigin: String(row.targetOrigin),
      documentId: String(row.documentId),
      enabled: row.enabled !== false,
    };
  };
}
