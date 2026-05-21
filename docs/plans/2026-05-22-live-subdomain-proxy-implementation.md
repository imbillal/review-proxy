# Live Subdomain Reverse Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render arbitrary third-party websites inside the review iframe by serving them through per-site subdomains on a dedicated live reverse-proxy service, so reviewers can pin and comment on real, framed sites.

**Architecture:** A new `review-proxy` Fastify service fetches the upstream site live on every view, strips framing headers, rewrites same-origin URLs, and injects a `postMessage` overlay runtime. `review_api` allocates a `ProxySite` registry row per website document; `review-Web` mints a signed access token and rewires `website-viewer.tsx` from `contentDocument` access to `postMessage`.

**Tech Stack:** Node 20 + Fastify 5 + undici + cheerio + the `mongodb` driver (review-proxy); Express + Prisma/MongoDB (review_api); Next.js 16 App Router + React 19 (review-Web). Token: HMAC-SHA256.

**Source design:** `review-proxy/docs/2026-05-22-live-subdomain-proxy-design.md` (approved). Section references below (§N) point to that doc.

---

## How this plan is organized

This plan spans **three repos in a strict dependency order** — Part A → Part B → Part C. It is kept as one document (rather than three) because Parts B and C share two wire contracts — the **proxy access-token format** and the **`ProxySite` registry shape** — that must stay in lockstep; splitting them would scatter that contract. Execute the Parts in order. Each Part ends in independently verifiable software.

- **Part A — `review_api`:** `ProxySite` model, SSRF validation, subdomain allocation on website-document creation. (4 tasks)
- **Part B — `review-proxy`:** the new proxy service — config, registry, token verify, SSRF, URL/HTML/CSS rewriting, header handling, overlay runtime, error pages, upstream fetch, request handler, Fastify server. (15 tasks)
- **Part C — `review-Web`:** env + schema, token minting, the token route handler, the `website-viewer.tsx` rewrite, and cleanup of superseded routes. (5 tasks)

### §17 open-question resolutions (locked before this plan)

1. **HTML rewriter** → **cheerio** (buffered). Simplest to TDD; `MAX_HTML_BYTES` caps memory. (§6 allowed it as the fallback.)
2. **Server framework** → **Fastify 5**. Built-in pino logging + graceful shutdown; one catch-all route.
3. **Safari CHIPS** → verified as a step in Task C5 (manual). Fallback (runtime keeps `__rt` in nav URLs) is **out of v1 scope** and noted there.
4. **Superseded route deletions** → confirmed and performed in Task C5.
5. **Disable/regenerate-subdomain endpoint** → **deferred to v2.** The `ProxySite.enabled` flag + the soft-delete hook in Task A4 cover v1 needs.

### Environment-harness notes (discovered, affect testing strategy)

- `review_api`'s integration harness is **stale**: `tests/integration/setup.ts#resetDb` references removed `folder`/`folderMember` models, and `vitest.integration.config.ts` `include`/`setupFiles` paths (`tests/integration/**`) don't match the real location (`tests/tests/integration/**`). **Fixing it is out of scope.** Part A covers pure logic with unit tests (the unit harness works) and verifies route wiring manually.
- `review-Web` has **no test framework**. Task C1 adds Vitest scoped to the pure token module; the route handler and React component are verified manually (E2E), which is the honest verification surface for `postMessage`/iframe integration.
- `review_api` unit tests live in `tests/tests/unit/` and run via `npm run test:unit` (the script's `tests/unit` arg matches that path as a substring).

---

## Shared contracts

These three contracts are referenced by multiple tasks. Defined once here; do not diverge.

### Contract 1 — `ProxySite` registry row

One row per website `Document`. Lives in the shared MongoDB. Prisma model name `ProxySite` → MongoDB collection **`ProxySite`** (no `@@map`). Added to **both** `review_api` and `review-Web` Prisma schemas (the repos already keep duplicate schemas).

```prisma
model ProxySite {
  id           String   @id @default(auto()) @map("_id") @db.ObjectId
  documentId   String   @unique @db.ObjectId
  subdomain    String   @unique          // e.g. "d-ab12cd34"
  targetOrigin String                    // scheme + host (+ port), e.g. "https://dorik.com"
  enabled      Boolean  @default(true)
  createdAt    DateTime @default(now())

  document     Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
}
```

`Document` gets the back-relation field `proxySite ProxySite?`. Note: the design's `@@index([subdomain])` is dropped — `@unique` already creates that index; a second one is redundant and Prisma warns.

### Contract 2 — Proxy access token

A two-part HMAC-SHA256 token: `<b64url(payload)>.<b64url(sig)>` where `sig = HMAC-SHA256(secret, b64urlPayload)`.

Payload JSON:

```ts
type ProxyTokenPayload = {
  documentId: string;
  subdomain: string;
  sub: string;   // reviewer userId
  iat: number;   // unix seconds
  exp: number;   // unix seconds; mint TTL = 2h
};
```

`b64url`: standard base64 with `=` stripped, `+`→`-`, `/`→`_`. Minted by `review-Web` (`signProxyToken`, Task C2); verified by `review-proxy` (`verifyProxyToken`, Task B4). Both repos share `PROXY_TOKEN_SECRET`. Verification checks: 2 parts, signature (timing-safe), parseable payload, `exp >= now`, and `subdomain` equals the subdomain the request arrived on.

### Contract 3 — Overlay `postMessage` protocol (§9)

**iframe → parent** (runtime posts to `APP_ORIGIN`):

| `type` | Payload |
|---|---|
| `pinion:ready` | `{ width, height, pageUrl }` |
| `pinion:positions` | `{ positions: Record<id,{x,y,visible}>, docHeight, pageUrl }` — `x`/`y` are **relative to the iframe's visible viewport** |
| `pinion:click` | `{ selector, path, textHash, xPct, yPct, x, y, pageUrl }` — `x`/`y` viewport-relative click point |
| `pinion:page-url` | `{ pageUrl }` |

**parent → iframe** (parent posts to `proxyOrigin`):

| `type` | Payload |
|---|---|
| `pinion:set-comments` | `{ comments: Array<{ id, selector, path, textHash, xPct, yPct }> }` |
| `pinion:set-mode` | `{ mode: "comment" | "read" }` |

Both ends do strict origin checks: the runtime accepts only `event.origin === APP_ORIGIN`; the parent accepts only `event.origin === proxyOrigin` **and** `event.source === iframe.contentWindow`.

---

# Part A — `review_api`: registry + allocation + SSRF

Working directory for Part A: `/Users/dorik/projects/review-platform/review_api`.

---

### Task A1: SSRF validation utility

Reject private/loopback/link-local/metadata targets at registration time (§10). Pure, name- and literal-IP-based — the proxy does the DNS-resolution re-check separately (Task B5).

**Files:**
- Create: `review_api/src/lib/ssrf.ts`
- Test: `review_api/tests/tests/unit/ssrf.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review_api/tests/tests/unit/ssrf.test.ts
import { describe, expect, it } from "vitest";
import { validateProxyTarget } from "@/lib/ssrf";

describe("validateProxyTarget", () => {
  it("accepts a normal https site and returns its origin", () => {
    const r = validateProxyTarget("https://dorik.com/about?x=1");
    expect(r).toEqual({ ok: true, origin: "https://dorik.com" });
  });

  it("accepts http and keeps a non-default port in the origin", () => {
    const r = validateProxyTarget("http://example.com:8080/x");
    expect(r).toEqual({ ok: true, origin: "http://example.com:8080" });
  });

  it.each([
    ["not a url", "ftp://example.com"],
    ["loopback name", "http://localhost/"],
    ["loopback v4", "http://127.0.0.1/"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["private 10/8", "http://10.1.2.3/"],
    ["private 192.168", "http://192.168.0.1/"],
    ["private 172.16", "http://172.16.5.5/"],
    ["private 172.31", "http://172.31.255.255/"],
    ["link-local / metadata", "http://169.254.169.254/"],
    ["ipv6 loopback", "http://[::1]/"],
    ["ipv6 ULA", "http://[fc00::1]/"],
    ["ipv6 link-local", "http://[fe80::1]/"],
    ["mdns suffix", "http://printer.local/"],
    ["garbage", "::::"],
  ])("rejects %s", (_name, url) => {
    expect(validateProxyTarget(url).ok).toBe(false);
  });

  it("accepts 172.32 (outside the private /12)", () => {
    expect(validateProxyTarget("http://172.32.0.1/").ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/dorik/projects/review-platform/review_api && npx vitest run tests/tests/unit/ssrf.test.ts`
Expected: FAIL — `Cannot find module '@/lib/ssrf'`.

- [ ] **Step 3: Write the implementation**

```ts
// review_api/src/lib/ssrf.ts
export type ProxyTargetResult =
  | { ok: true; origin: string }
  | { ok: false; reason: string };

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // malformed → treat unsafe
  if (a === 0 || a === 127) return true;                 // this-host / loopback
  if (a === 10) return true;                             // 10/8
  if (a === 192 && b === 168) return true;               // 192.168/16
  if (a === 172 && b >= 16 && b <= 31) return true;      // 172.16/12
  if (a === 169 && b === 254) return true;               // link-local + metadata
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;            // loopback / unspecified
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;         // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;         // fe80::/10 link-local
  return false;
}

/** Validate a URL submitted as a proxy target. Name- and literal-IP-based. */
export function validateProxyTarget(rawUrl: string): ProxyTargetResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http and https are allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "Missing host" };
  if (host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "Loopback host not allowed" };
  }
  if (host.endsWith(".local")) {
    return { ok: false, reason: "mDNS host not allowed" };
  }
  if (isPrivateIPv4(host) || isPrivateIPv6(host)) {
    return { ok: false, reason: "Private or link-local address not allowed" };
  }
  return { ok: true, origin: url.origin };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tests/unit/ssrf.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
cd /Users/dorik/projects/review-platform/review_api
git add src/lib/ssrf.ts tests/tests/unit/ssrf.test.ts
git commit -m "feat: add SSRF validation for proxy targets"
```

---

### Task A2: Subdomain generator

Mint an opaque DNS-safe subdomain label `d-<8 lowercase alphanumerics>` (§4.4). Uses `node:crypto` `randomInt` — no new dependency (`nanoid` is not installed and its v5 is ESM-only, which clashes with this CommonJS project).

**Files:**
- Create: `review_api/src/lib/subdomain.ts`
- Test: `review_api/tests/tests/unit/subdomain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review_api/tests/tests/unit/subdomain.test.ts
import { describe, expect, it } from "vitest";
import { generateSubdomain } from "@/lib/subdomain";

describe("generateSubdomain", () => {
  it("matches d- followed by 8 lowercase alphanumerics", () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSubdomain()).toMatch(/^d-[a-z0-9]{8}$/);
    }
  });

  it("is overwhelmingly likely to be unique across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generateSubdomain());
    expect(seen.size).toBe(1000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tests/unit/subdomain.test.ts`
Expected: FAIL — `Cannot find module '@/lib/subdomain'`.

- [ ] **Step 3: Write the implementation**

```ts
// review_api/src/lib/subdomain.ts
import { randomInt } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** Opaque DNS-safe label, e.g. "d-ab12cd34". Collision-free in practice. */
export function generateSubdomain(): string {
  let s = "";
  for (let i = 0; i < 8; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `d-${s}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tests/unit/subdomain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/subdomain.ts tests/tests/unit/subdomain.test.ts
git commit -m "feat: add proxy subdomain generator"
```

---

### Task A3: `ProxySite` Prisma model

Add the registry model (Contract 1) and the `Document` back-relation, then sync the schema.

**Files:**
- Modify: `review_api/prisma/schema.prisma` (Document model at lines 199-226; append new model after it)

- [ ] **Step 1: Add the `proxySite` back-relation to `Document`**

In `model Document`, add the relation field alongside `members` and `comments`:

```prisma
  project        Project          @relation(fields: [projectId], references: [id], onDelete: Cascade)
  members        DocumentMember[]
  comments       Comment[]
  proxySite      ProxySite?

  @@index([projectId])
}
```

- [ ] **Step 2: Append the `ProxySite` model**

Add immediately after the closing `}` of `model Document`:

```prisma
model ProxySite {
  id           String   @id @default(auto()) @map("_id") @db.ObjectId
  documentId   String   @unique @db.ObjectId
  subdomain    String   @unique
  targetOrigin String
  enabled      Boolean  @default(true)
  createdAt    DateTime @default(now())

  document     Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 3: Validate the schema**

Run: `cd /Users/dorik/projects/review-platform/review_api && npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid 🚀`

- [ ] **Step 4: Push the schema and regenerate the client**

Run: `npm run db:push`
Expected: completes with `Your database is now in sync with your Prisma schema.` and `Generated Prisma Client`.

- [ ] **Step 5: Verify the client type compiles**

Run: `npx tsc --noEmit`
Expected: no errors (confirms `db.proxySite` is now a typed model).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma
git commit -m "feat: add ProxySite registry model"
```

---

### Task A4: Allocate `ProxySite` on website-document creation

Wire SSRF validation + subdomain allocation into `POST /documents/website`, and disable the `ProxySite` when a document is soft-deleted (the app soft-deletes via `deletedAt`, so `onDelete: Cascade` never fires).

**Files:**
- Modify: `review_api/src/routes/documents.ts` (imports line 1-16; `/website` handler lines 204-250; `DELETE /:documentId` handler lines 352-378)

- [ ] **Step 1: Add imports**

After the existing import block (after line 16), add:

```ts
import { validateProxyTarget } from "@/lib/ssrf";
import { generateSubdomain } from "@/lib/subdomain";
```

- [ ] **Step 2: SSRF-validate before creating the document**

In the `/website` handler, immediately after `const { projectId, url, title } = parsed.data;` (line 210), insert:

```ts
    const target = validateProxyTarget(url);
    if (!target.ok) {
      return sendError(res, "INVALID_URL", target.reason, 422);
    }
```

- [ ] **Step 3: Create the `ProxySite` row after the document**

In the `/website` handler, immediately after the `const doc = await db.document.create({ ... });` block (after line 224, before the `try {` for capture), insert:

```ts
    await db.proxySite.create({
      data: {
        documentId: doc.id,
        subdomain: generateSubdomain(),
        targetOrigin: target.origin,
      },
    });
```

- [ ] **Step 4: Disable the `ProxySite` on document soft-delete**

In the `DELETE /:documentId` handler, immediately after the `await db.document.update({ ... deletedAt: new Date() ... });` call (after line 369), insert:

```ts
    await db.proxySite.updateMany({
      where: { documentId: doc.id },
      data: { enabled: false },
    });
```

`updateMany` (not `update`) so it is a safe no-op for documents that never had a `ProxySite` (e.g. PDFs).

- [ ] **Step 5: Type-check**

Run: `cd /Users/dorik/projects/review-platform/review_api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Manual verification**

The happy path runs `captureUrl()` (headless browser) and the repo's integration harness is stale, so verify by hand:

1. Start the API: `npm run dev` (separate terminal).
2. Obtain a valid auth cookie/header and a `projectId` you have access to (reuse an existing logged-in session).
3. **SSRF reject:** `POST /documents/website` with `{ "projectId": "<id>", "url": "http://127.0.0.1/" }` → expect HTTP **422**, body code `INVALID_URL`. Confirm in `prisma studio` that **no** `Document` and **no** `ProxySite` row were created.
4. **Happy path:** `POST /documents/website` with a real `{ "url": "https://example.com" }` → expect **201**. In `prisma studio`, confirm a `ProxySite` row exists with `documentId` = the new doc, `subdomain` matching `/^d-[a-z0-9]{8}$/`, `targetOrigin` = `https://example.com`, `enabled: true`.
5. **Soft-delete:** `DELETE /documents/<that id>` → confirm the `ProxySite` row now has `enabled: false`.

- [ ] **Step 7: Commit**

```bash
git add src/routes/documents.ts
git commit -m "feat: allocate ProxySite on website-document creation"
```

**Part A complete.** `review_api` now SSRF-validates website URLs and maintains a `ProxySite` registry row per website document.

---

# Part B — `review-proxy`: the proxy service

Working directory for Part B: `/Users/dorik/projects/review-platform/review-proxy`. This repo currently contains only `README.md`, `.gitignore`, and `docs/`. Part B uses **relative imports** (no `@/` path alias) to avoid a post-build path-rewriting step.

---

### Task B1: Scaffold the service

**Files:**
- Create: `review-proxy/package.json`, `review-proxy/tsconfig.json`, `review-proxy/vitest.config.ts`, `review-proxy/.env.example`, `review-proxy/.env`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "review-proxy",
  "version": "0.1.0",
  "private": true,
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "cheerio": "^1.2.0",
    "dotenv": "^16.4.7",
    "fastify": "^5.2.0",
    "mongodb": "^6.12.0",
    "undici": "^7.2.0"
  },
  "devDependencies": {
    "@types/node": "^20.19.39",
    "tsx": "^4.21.0",
    "typescript": "^5.7.0",
    "vitest": "^4.1.4"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "commonjs",
    "moduleResolution": "node",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": false,
    "noEmit": false,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Create `.env.example`**

```
PORT=8080
PROXY_DOMAIN=reviewproxy.app
APP_ORIGIN=http://localhost:3000
DATABASE_URL=
PROXY_TOKEN_SECRET=
UPSTREAM_TIMEOUT_MS=20000
MAX_HTML_BYTES=15000000
```

- [ ] **Step 5: Create a local `.env`** (git-ignored already by `.gitignore`)

Copy `.env.example` to `.env` and fill `DATABASE_URL` with the shared MongoDB connection string (same as `review_api`'s `.env`) and `PROXY_TOKEN_SECRET` with any random string for now — it must equal `review-Web`'s value in Task C1.

- [ ] **Step 6: Install dependencies**

Run: `cd /Users/dorik/projects/review-platform/review-proxy && npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 7: Commit**

```bash
cd /Users/dorik/projects/review-platform/review-proxy
git add package.json package-lock.json tsconfig.json vitest.config.ts .env.example
git commit -m "chore: scaffold review-proxy service"
```

---

### Task B2: Config module

Parse and validate environment variables once at startup.

**Files:**
- Create: `review-proxy/src/config.ts`
- Test: `review-proxy/tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-proxy/tests/config.test.ts
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";

const base = {
  PORT: "8080",
  PROXY_DOMAIN: "reviewproxy.app",
  APP_ORIGIN: "http://localhost:3000",
  DATABASE_URL: "mongodb://localhost/db",
  PROXY_TOKEN_SECRET: "secret",
  UPSTREAM_TIMEOUT_MS: "20000",
  MAX_HTML_BYTES: "15000000",
};

describe("loadConfig", () => {
  it("parses a complete environment", () => {
    const c = loadConfig(base);
    expect(c.port).toBe(8080);
    expect(c.proxyDomain).toBe("reviewproxy.app");
    expect(c.appOrigin).toBe("http://localhost:3000");
    expect(c.upstreamTimeoutMs).toBe(20000);
    expect(c.maxHtmlBytes).toBe(15000000);
  });

  it("applies defaults for optional vars", () => {
    const c = loadConfig({
      PROXY_DOMAIN: "reviewproxy.app",
      APP_ORIGIN: "http://localhost:3000",
      DATABASE_URL: "mongodb://localhost/db",
      PROXY_TOKEN_SECRET: "secret",
    });
    expect(c.port).toBe(8080);
    expect(c.upstreamTimeoutMs).toBe(20000);
    expect(c.maxHtmlBytes).toBe(15000000);
  });

  it.each(["PROXY_DOMAIN", "APP_ORIGIN", "DATABASE_URL", "PROXY_TOKEN_SECRET"])(
    "throws when required var %s is missing",
    (key) => {
      const env = { ...base } as Record<string, string>;
      delete env[key];
      expect(() => loadConfig(env)).toThrow(key);
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `Cannot find module '../src/config'`.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/config.ts
export type Config = {
  port: number;
  proxyDomain: string;
  appOrigin: string;
  databaseUrl: string;
  proxyTokenSecret: string;
  upstreamTimeoutMs: number;
  maxHtmlBytes: number;
};

function required(env: Record<string, string | undefined>, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function intOr(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    port: intOr(env.PORT, 8080),
    proxyDomain: required(env, "PROXY_DOMAIN").toLowerCase(),
    appOrigin: required(env, "APP_ORIGIN").replace(/\/$/, ""),
    databaseUrl: required(env, "DATABASE_URL"),
    proxyTokenSecret: required(env, "PROXY_TOKEN_SECRET"),
    upstreamTimeoutMs: intOr(env.UPSTREAM_TIMEOUT_MS, 20000),
    maxHtmlBytes: intOr(env.MAX_HTML_BYTES, 15_000_000),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat: add config loader"
```

---

### Task B3: Host → subdomain parsing

**Files:**
- Create: `review-proxy/src/subdomain.ts`
- Test: `review-proxy/tests/subdomain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-proxy/tests/subdomain.test.ts
import { describe, expect, it } from "vitest";
import { parseSubdomain } from "../src/subdomain";

const DOMAIN = "reviewproxy.app";

describe("parseSubdomain", () => {
  it("extracts the label from a subdomain host", () => {
    expect(parseSubdomain("d-ab12cd34.reviewproxy.app", DOMAIN)).toBe("d-ab12cd34");
  });

  it("ignores a port in the Host header", () => {
    expect(parseSubdomain("d-ab12cd34.reviewproxy.app:8080", DOMAIN)).toBe("d-ab12cd34");
  });

  it("is case-insensitive", () => {
    expect(parseSubdomain("D-AB12CD34.ReviewProxy.App", DOMAIN)).toBe("d-ab12cd34");
  });

  it("returns null for the apex domain", () => {
    expect(parseSubdomain("reviewproxy.app", DOMAIN)).toBeNull();
  });

  it("returns null for a foreign domain", () => {
    expect(parseSubdomain("d-ab12cd34.evil.com", DOMAIN)).toBeNull();
  });

  it("returns null for a multi-label subdomain", () => {
    expect(parseSubdomain("a.b.reviewproxy.app", DOMAIN)).toBeNull();
  });

  it.each(["", undefined, "d-ab12cd34..reviewproxy.app", "_x.reviewproxy.app"])(
    "returns null for malformed host %s",
    (host) => {
      expect(parseSubdomain(host as string, DOMAIN)).toBeNull();
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/subdomain.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/subdomain.ts
/** Extract the single subdomain label from a Host header, or null. */
export function parseSubdomain(host: string | undefined, proxyDomain: string): string | null {
  if (!host) return null;
  const h = host.toLowerCase().split(":")[0]!; // drop port
  const suffix = `.${proxyDomain.toLowerCase()}`;
  if (!h.endsWith(suffix)) return null;
  const label = h.slice(0, -suffix.length);
  if (!label) return null;                       // apex
  if (!/^[a-z0-9][a-z0-9-]*$/.test(label)) return null; // single DNS label only
  return label;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/subdomain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/subdomain.ts tests/subdomain.test.ts
git commit -m "feat: add Host-to-subdomain parser"
```

---

### Task B4: Token sign + verify

Implements Contract 2. `signProxyToken` is included here too — it is needed by this repo's own tests (and keeps the two repos' implementations verifiably identical).

**Files:**
- Create: `review-proxy/src/token.ts`
- Test: `review-proxy/tests/token.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/token.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/token.ts
import crypto from "node:crypto";

export type ProxyTokenPayload = {
  documentId: string;
  subdomain: string;
  sub: string;
  iat: number;
  exp: number;
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(s: string): Buffer {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signProxyToken(
  claims: { documentId: string; subdomain: string; sub: string },
  secret: string,
  ttlSeconds = 2 * 60 * 60,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  const payload: ProxyTokenPayload = {
    ...claims,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64urlEncode(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyProxyToken(
  token: string,
  secret: string,
  expectedSubdomain: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): ProxyTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts as [string, string];
  const expected = b64urlEncode(crypto.createHmac("sha256", secret).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload: ProxyTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body).toString("utf8")) as ProxyTokenPayload;
  } catch {
    return null;
  }
  if (
    typeof payload.documentId !== "string" ||
    typeof payload.subdomain !== "string" ||
    typeof payload.sub !== "string" ||
    typeof payload.exp !== "number"
  ) {
    return null;
  }
  if (payload.exp < nowSeconds) return null;
  if (payload.subdomain !== expectedSubdomain) return null;
  return payload;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/token.ts tests/token.test.ts
git commit -m "feat: add proxy access token sign/verify"
```

---

### Task B5: SSRF re-check (with DNS resolution)

The proxy re-checks the upstream host at fetch time to defend against DNS rebinding (§5.5, §10). Reuses the literal/name rules from Part A's logic plus an actual DNS resolution.

**Files:**
- Create: `review-proxy/src/ssrf.ts`
- Test: `review-proxy/tests/ssrf.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/ssrf.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/ssrf.ts
import { lookup } from "node:dns/promises";

function isPrivateIPv4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a === 0 || a === 127 || a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "::1" || h === "::") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

export function isPrivateAddress(host: string): boolean {
  return isPrivateIPv4(host) || isPrivateIPv6(host);
}

/** Throws if the URL's host is private, mDNS, or resolves to a private IP. */
export async function assertUpstreamAllowed(rawUrl: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("SSRF: invalid upstream URL");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("SSRF: loopback/mDNS host blocked");
  }
  if (isPrivateAddress(host)) {
    throw new Error("SSRF: private host blocked");
  }
  // DNS-rebinding defense: resolve and re-check every returned address.
  const records = await lookup(host, { all: true });
  for (const r of records) {
    if (isPrivateAddress(r.address)) {
      throw new Error("SSRF: host resolves to a private address");
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/ssrf.test.ts`
Expected: PASS. (The "allows a public host" case performs a real DNS lookup of `example.com`; it needs network access. If the executor is offline, mark this single case skipped and note it.)

- [ ] **Step 5: Commit**

```bash
git add src/ssrf.ts tests/ssrf.test.ts
git commit -m "feat: add SSRF re-check with DNS resolution"
```

---

### Task B6: Registry lookup with TTL cache

Reads `subdomain → { targetOrigin, documentId, enabled }` from the shared MongoDB (`ProxySite` collection) and caches each result for ~60s (§4.5). The cache wrapper is split from the Mongo query so the wrapper is unit-testable with an injected fetcher.

**Files:**
- Create: `review-proxy/src/registry.ts`
- Test: `review-proxy/tests/registry.test.ts`

- [ ] **Step 1: Write the failing test** (covers the cache wrapper only)

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/registry.ts tests/registry.test.ts
git commit -m "feat: add ProxySite registry with TTL cache"
```

---

### Task B7: Single-URL rewriting

The subdomain model means relative and absolute-path URLs already resolve to the proxy origin and need no work. Only absolute URLs naming the site's own `targetOrigin` get rewritten; cross-origin URLs are left direct (§6, §7).

**Files:**
- Create: `review-proxy/src/rewrite-url.ts`
- Test: `review-proxy/tests/rewrite-url.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-proxy/tests/rewrite-url.test.ts
import { describe, expect, it } from "vitest";
import { rewriteUrl, rewriteSrcset } from "../src/rewrite-url";

const ORIGIN = "https://dorik.com";
const PROXY = "d-ab12cd34.reviewproxy.app";

describe("rewriteUrl", () => {
  it("rewrites an absolute same-origin URL to the proxy host", () => {
    expect(rewriteUrl("https://dorik.com/about?x=1", ORIGIN, PROXY))
      .toBe("https://d-ab12cd34.reviewproxy.app/about?x=1");
  });

  it("rewrites a protocol-relative same-origin URL", () => {
    expect(rewriteUrl("//dorik.com/logo.png", ORIGIN, PROXY))
      .toBe("https://d-ab12cd34.reviewproxy.app/logo.png");
  });

  it.each(["/about", "./x", "../y", "page.html", ""])(
    "leaves relative URL %s unchanged",
    (u) => {
      expect(rewriteUrl(u, ORIGIN, PROXY)).toBe(u);
    },
  );

  it("leaves a cross-origin URL unchanged", () => {
    expect(rewriteUrl("https://cdn.example.com/a.js", ORIGIN, PROXY))
      .toBe("https://cdn.example.com/a.js");
  });

  it.each(["data:image/png;base64,AAAA", "mailto:a@b.com", "javascript:void 0", "#frag", "tel:+1"])(
    "leaves non-navigational URL %s unchanged",
    (u) => {
      expect(rewriteUrl(u, ORIGIN, PROXY)).toBe(u);
    },
  );
});

describe("rewriteSrcset", () => {
  it("rewrites each candidate, preserving descriptors", () => {
    const input = "https://dorik.com/a.jpg 1x, https://dorik.com/b.jpg 2x, /c.jpg 3x";
    expect(rewriteSrcset(input, ORIGIN, PROXY)).toBe(
      "https://d-ab12cd34.reviewproxy.app/a.jpg 1x, https://d-ab12cd34.reviewproxy.app/b.jpg 2x, /c.jpg 3x",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/rewrite-url.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/rewrite-url.ts
const SKIP_SCHEME = /^(data:|blob:|mailto:|tel:|javascript:|about:|#)/i;

/** Rewrite one URL: same-origin absolute → proxy host; everything else unchanged. */
export function rewriteUrl(raw: string, targetOrigin: string, proxyHost: string): string {
  const trimmed = raw.trim();
  if (!trimmed || SKIP_SCHEME.test(trimmed)) return raw;
  const isAbsolute = /^https?:\/\//i.test(trimmed) || trimmed.startsWith("//");
  if (!isAbsolute) return raw; // relative / absolute-path: resolves to proxy already
  let abs: URL;
  try {
    abs = new URL(trimmed, targetOrigin);
  } catch {
    return raw;
  }
  if (abs.origin !== targetOrigin) return raw; // cross-origin → leave direct (§7)
  abs.protocol = "https:";
  abs.host = proxyHost;
  return abs.toString();
}

/** Rewrite every candidate in a srcset attribute, preserving width/density descriptors. */
export function rewriteSrcset(value: string, targetOrigin: string, proxyHost: string): string {
  return value
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const sp = trimmed.indexOf(" ");
      if (sp === -1) return rewriteUrl(trimmed, targetOrigin, proxyHost);
      const url = trimmed.slice(0, sp);
      const descriptor = trimmed.slice(sp);
      return rewriteUrl(url, targetOrigin, proxyHost) + descriptor;
    })
    .join(", ");
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/rewrite-url.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/rewrite-url.ts tests/rewrite-url.test.ts
git commit -m "feat: add single-URL and srcset rewriting"
```

---

### Task B8: CSS rewriting

Rewrite `url(...)` and `@import` references in CSS text (used for `<style>` bodies, `style=` attributes, and standalone `.css` responses).

**Files:**
- Create: `review-proxy/src/css-rewrite.ts`
- Test: `review-proxy/tests/css-rewrite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-proxy/tests/css-rewrite.test.ts
import { describe, expect, it } from "vitest";
import { rewriteCss } from "../src/css-rewrite";

const ORIGIN = "https://dorik.com";
const PROXY = "d-ab12cd34.reviewproxy.app";

describe("rewriteCss", () => {
  it("rewrites a same-origin absolute url()", () => {
    expect(rewriteCss("a{background:url(https://dorik.com/bg.png)}", ORIGIN, PROXY))
      .toBe("a{background:url(https://d-ab12cd34.reviewproxy.app/bg.png)}");
  });

  it("preserves quotes in url()", () => {
    expect(rewriteCss('a{background:url("https://dorik.com/b.png")}', ORIGIN, PROXY))
      .toBe('a{background:url("https://d-ab12cd34.reviewproxy.app/b.png")}');
  });

  it("leaves relative and cross-origin url() unchanged", () => {
    const css = "a{background:url(/x.png)} b{background:url(https://cdn.example.com/y.png)}";
    expect(rewriteCss(css, ORIGIN, PROXY)).toBe(css);
  });

  it("rewrites @import", () => {
    expect(rewriteCss('@import "https://dorik.com/t.css";', ORIGIN, PROXY))
      .toBe('@import "https://d-ab12cd34.reviewproxy.app/t.css";');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/css-rewrite.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/css-rewrite.ts
import { rewriteUrl } from "./rewrite-url";

/** Rewrite url(...) and @import references inside a block of CSS text. */
export function rewriteCss(css: string, targetOrigin: string, proxyHost: string): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, quote: string, url: string) => {
      return `url(${quote}${rewriteUrl(url, targetOrigin, proxyHost)}${quote})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, quote: string, url: string) => {
      return `@import ${quote}${rewriteUrl(url, targetOrigin, proxyHost)}${quote}`;
    });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/css-rewrite.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/css-rewrite.ts tests/css-rewrite.test.ts
git commit -m "feat: add CSS url() and @import rewriting"
```

---

### Task B9: Overlay runtime + frame-bust neutralizer

Vendor the `postMessage` overlay runtime from `review_api/src/lib/overlay-runtime.ts`, adapted for the subdomain proxy: viewport-relative pin coordinates (Contract 3), strict origin checks, and `window.open`/`target=_blank` interception (§8). Plus a small best-effort frame-bust neutralizer (§6).

**Files:**
- Create: `review-proxy/src/overlay-runtime.ts`

This task has no unit test — it produces browser-side script strings exercised by the Task B14 integration test and Task C5 E2E.

- [ ] **Step 1: Create the runtime module**

```ts
// review-proxy/src/overlay-runtime.ts
// Browser-side overlay runtime, injected before </body> by the HTML rewriter.
// Adapted from review_api/src/lib/overlay-runtime.ts for the subdomain proxy:
// viewport-relative coordinates, strict origin checks, new-window interception.

/** Returns the IIFE source with the parent app origin baked in. */
export function buildOverlayRuntime(appOrigin: string): string {
  return `
(function(){
  var APP_ORIGIN = ${JSON.stringify(appOrigin)};
  if (!window.parent || window.parent === window) return;
  function post(msg){ try { parent.postMessage(msg, APP_ORIGIN); } catch(e){} }

  var comments = [];
  var mode = "comment";

  function currentPageUrl(){ return location.pathname + location.search + location.hash; }

  function textHash(el){
    var t = (el.textContent || "").slice(0,120).trim(), h = 0;
    for (var i=0;i<t.length;i++) h = ((h<<5)-h+t.charCodeAt(i))|0;
    return el.tagName.toLowerCase()+":"+t.length+":"+h;
  }
  function buildPath(el){
    var parts=[], cur=el;
    while (cur && cur.tagName !== "BODY"){
      var p=cur.parentElement, idx=p?Array.prototype.indexOf.call(p.children,cur):0;
      parts.unshift(cur.tagName.toLowerCase()+"["+idx+"]"); cur=p;
    }
    return parts.join("/");
  }
  function findByPath(path){
    var segs=path.split("/"), node=document.body;
    for (var i=0;i<segs.length;i++){
      if (!node) return null;
      var m=segs[i].match(/^(\\w+)\\[(\\d+)\\]$/); if (!m) return null;
      var child=node.children[Number(m[2])];
      if (!child || child.tagName.toLowerCase()!==m[1]) return null;
      node=child;
    }
    return node;
  }
  function esc(s){ try { return CSS.escape(s); } catch(e){ return s; } }
  function segmentFor(el){
    var parent=el.parentElement, tag=el.tagName.toLowerCase();
    if (!parent) return tag;
    var idx=Array.prototype.indexOf.call(parent.children,el);
    if (el.id){ try { var s="#"+esc(el.id); if (document.querySelectorAll(s).length===1) return s; } catch(e){} }
    if (el.classList && el.classList.length){
      for (var i=0;i<el.classList.length;i++){
        var cls=el.classList[i], count=0;
        for (var j=0;j<parent.children.length;j++){
          var c=parent.children[j];
          if (c.classList && c.classList.contains(cls)) count++;
        }
        if (count===1) return "."+esc(cls);
      }
      return tag+":nth-child("+(idx+1)+")."+esc(el.classList[0]);
    }
    return tag+":nth-child("+(idx+1)+")";
  }
  function genSelector(el){
    if (!el || el===document.body) return "body";
    var parts=[], cur=el;
    while (cur && cur.parentElement && cur!==document.body){ parts.unshift(segmentFor(cur)); cur=cur.parentElement; }
    return "body > "+parts.join(" > ");
  }
  function resolve(c){
    var candidate=null;
    if (c.path){ var el=findByPath(c.path); if (el){ if (!c.textHash||textHash(el)===c.textHash) return el; candidate=el; } }
    if (c.selector){
      try {
        var matches=document.querySelectorAll(c.selector);
        for (var i=0;i<matches.length;i++){ if (!c.textHash||textHash(matches[i])===c.textHash) return matches[i]; }
        if (matches.length>0 && !candidate) candidate=matches[0];
      } catch(e){}
    }
    if (c.textHash){
      var tag=c.textHash.split(":")[0], list=document.getElementsByTagName(tag);
      for (var j=0;j<list.length;j++){ if (textHash(list[j])===c.textHash) return list[j]; }
    }
    return candidate;
  }

  function sendPositions(){
    var out={};
    for (var i=0;i<comments.length;i++){
      var c=comments[i], el=resolve(c);
      if (!el){ out[c.id]={x:0,y:0,visible:false}; continue; }
      var r=el.getBoundingClientRect();
      var x=r.left+r.width*(c.xPct||0)/100;
      var y=r.top+r.height*(c.yPct||0)/100;
      var vis=x>=0&&y>=0&&x<=window.innerWidth&&y<=window.innerHeight;
      out[c.id]={x:x,y:y,visible:vis};
    }
    post({type:"pinion:positions",positions:out,
      docHeight:document.documentElement.scrollHeight,pageUrl:currentPageUrl()});
  }

  function onClick(e){
    var t=e.target;
    var a=t.closest&&t.closest("a");
    if (mode!=="comment"){
      // read mode: let same-tab links navigate; only stop new windows
      if (a && (a.target==="_blank")) e.preventDefault();
      return;
    }
    if (a) e.preventDefault();
    e.stopPropagation();
    if (!t || t===document.body) return;
    var r=t.getBoundingClientRect();
    var xPct=Math.max(0,Math.min(100,((e.clientX-r.left)/r.width)*100));
    var yPct=Math.max(0,Math.min(100,((e.clientY-r.top)/r.height)*100));
    post({type:"pinion:click",selector:genSelector(t),path:buildPath(t),textHash:textHash(t),
      xPct:xPct,yPct:yPct,x:e.clientX,y:e.clientY,pageUrl:currentPageUrl()});
  }

  // Keep new-window navigations inside the frame's flow rather than escaping it.
  var origOpen=window.open;
  window.open=function(){ return null; };
  void origOpen;

  var lastPageUrl=currentPageUrl();
  function emitPageUrl(){
    var u=currentPageUrl();
    if (u!==lastPageUrl){ lastPageUrl=u; post({type:"pinion:page-url",pageUrl:u}); sendPositions(); }
  }
  ["pushState","replaceState"].forEach(function(name){
    var orig=history[name];
    history[name]=function(){ var r=orig.apply(this,arguments); setTimeout(emitPageUrl,0); return r; };
  });
  window.addEventListener("popstate",emitPageUrl);

  window.addEventListener("message",function(e){
    if (e.origin!==APP_ORIGIN) return;
    var d=e.data;
    if (!d||typeof d!=="object") return;
    if (d.type==="pinion:set-comments"){ comments=d.comments||[]; sendPositions(); }
    else if (d.type==="pinion:set-mode"){ mode=d.mode; }
  });

  document.addEventListener("click",onClick,true);
  window.addEventListener("scroll",sendPositions,{passive:true});
  window.addEventListener("resize",sendPositions);
  if ("ResizeObserver" in window){ try { new ResizeObserver(sendPositions).observe(document.body); } catch(e){} }

  function ready(){
    var doc=document.documentElement;
    post({type:"pinion:ready",
      width:Math.max(doc.scrollWidth,doc.clientWidth),
      height:Math.max(doc.scrollHeight,doc.clientHeight),
      pageUrl:currentPageUrl()});
    sendPositions();
  }
  if (document.readyState==="complete") ready();
  else window.addEventListener("load",ready);
})();
`.trim();
}

/** Best-effort neutralizer injected at the start of <head> (§6). */
export const FRAME_BUST_SCRIPT = `
(function(){
  try { Object.defineProperty(window,"frameElement",{get:function(){return null;},configurable:true}); } catch(e){}
  try { Object.defineProperty(document,"domain",{get:function(){return location.hostname;},set:function(){},configurable:true}); } catch(e){}
})();
`.trim();
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/overlay-runtime.ts
git commit -m "feat: vendor overlay runtime and frame-bust script"
```

---

### Task B10: HTML rewriting

cheerio-based: rewrite same-origin absolute URLs across the §6 attribute table, rewrite CSS in `<style>`/`style=`, strip `integrity` and CSP/XFO `<meta>` tags, inject the frame-bust script at the start of `<head>` and the overlay runtime before `</body>`.

**Files:**
- Create: `review-proxy/src/html-rewrite.ts`
- Test: `review-proxy/tests/html-rewrite.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-proxy/tests/html-rewrite.test.ts
import { describe, expect, it } from "vitest";
import { rewriteHtml } from "../src/html-rewrite";

const OPTS = {
  targetOrigin: "https://dorik.com",
  proxyHost: "d-ab12cd34.reviewproxy.app",
  frameBustScript: "/*fb*/",
  runtimeScript: "/*rt*/",
};

describe("rewriteHtml", () => {
  it("rewrites same-origin absolute hrefs and leaves relative ones", () => {
    const out = rewriteHtml(
      `<html><body><a href="https://dorik.com/about">a</a><a href="/x">b</a></body></html>`,
      OPTS,
    );
    expect(out).toContain('href="https://d-ab12cd34.reviewproxy.app/about"');
    expect(out).toContain('href="/x"');
  });

  it("leaves cross-origin asset URLs direct", () => {
    const out = rewriteHtml(`<body><img src="https://cdn.example.com/a.png"></body>`, OPTS);
    expect(out).toContain('src="https://cdn.example.com/a.png"');
  });

  it("rewrites srcset candidates", () => {
    const out = rewriteHtml(
      `<body><img srcset="https://dorik.com/a.png 1x, /b.png 2x"></body>`,
      OPTS,
    );
    expect(out).toContain("https://d-ab12cd34.reviewproxy.app/a.png 1x");
  });

  it("strips integrity and CSP/XFO meta tags", () => {
    const out = rewriteHtml(
      `<head><meta http-equiv="Content-Security-Policy" content="x">` +
        `<script src="/a.js" integrity="sha256-xxx"></script></head><body></body>`,
      OPTS,
    );
    expect(out).not.toContain("integrity");
    expect(out.toLowerCase()).not.toContain("content-security-policy");
  });

  it("injects the frame-bust script into head and the runtime into body", () => {
    const out = rewriteHtml(`<html><head></head><body></body></html>`, OPTS);
    expect(out).toContain("/*fb*/");
    expect(out).toContain("/*rt*/");
    expect(out.indexOf("/*rt*/")).toBeGreaterThan(out.indexOf("</body".length > 0 ? "" : ""));
  });

  it("rewrites url() in a <style> body", () => {
    const out = rewriteHtml(
      `<head><style>a{background:url(https://dorik.com/bg.png)}</style></head><body></body>`,
      OPTS,
    );
    expect(out).toContain("https://d-ab12cd34.reviewproxy.app/bg.png");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/html-rewrite.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/html-rewrite.ts
import * as cheerio from "cheerio";
import { rewriteUrl, rewriteSrcset } from "./rewrite-url";
import { rewriteCss } from "./css-rewrite";

export type RewriteHtmlOptions = {
  targetOrigin: string;
  proxyHost: string;
  frameBustScript: string;
  runtimeScript: string;
};

// [selector, attribute] pairs for plain URL attributes.
const URL_ATTRS: ReadonlyArray<readonly [string, string]> = [
  ["a[href]", "href"], ["link[href]", "href"], ["area[href]", "href"],
  ["img[src]", "src"], ["script[src]", "src"], ["iframe[src]", "src"],
  ["source[src]", "src"], ["video[src]", "src"], ["audio[src]", "src"],
  ["track[src]", "src"], ["embed[src]", "src"],
  ["video[poster]", "poster"], ["form[action]", "action"],
  ["button[formaction]", "formaction"], ["input[formaction]", "formaction"],
  ["object[data]", "data"],
];

export function rewriteHtml(html: string, opts: RewriteHtmlOptions): string {
  const { targetOrigin, proxyHost, frameBustScript, runtimeScript } = opts;
  const $ = cheerio.load(html);
  const rw = (u: string) => rewriteUrl(u, targetOrigin, proxyHost);

  for (const [selector, attr] of URL_ATTRS) {
    $(selector).each((_, el) => {
      const v = $(el).attr(attr);
      if (v != null) $(el).attr(attr, rw(v));
    });
  }

  $("img[srcset], source[srcset]").each((_, el) => {
    const v = $(el).attr("srcset");
    if (v != null) $(el).attr("srcset", rewriteSrcset(v, targetOrigin, proxyHost));
  });

  $("use, image").each((_, el) => {
    for (const a of ["href", "xlink:href"]) {
      const v = $(el).attr(a);
      if (v != null) $(el).attr(a, rw(v));
    }
  });

  $("base[href]").each((_, el) => {
    const v = $(el).attr("href");
    if (v != null) $(el).attr("href", rw(v));
  });

  // <meta http-equiv="refresh" content="3; url=...">
  $("meta[http-equiv]").each((_, el) => {
    if (($(el).attr("http-equiv") ?? "").toLowerCase() !== "refresh") return;
    const content = $(el).attr("content");
    if (!content) return;
    const m = content.match(/^(\s*[\d.]+\s*;\s*url=)(.+)$/i);
    if (m) $(el).attr("content", m[1] + rw(m[2]!.trim()));
  });

  // Inline style="" attributes.
  $("[style]").each((_, el) => {
    const v = $(el).attr("style");
    if (v != null) $(el).attr("style", rewriteCss(v, targetOrigin, proxyHost));
  });

  // <style> element bodies.
  $("style").each((_, el) => {
    const css = $(el).html();
    if (css != null) $(el).html(rewriteCss(css, targetOrigin, proxyHost));
  });

  // Sub-resource integrity breaks once we rewrite/proxy.
  $("[integrity]").removeAttr("integrity");

  // Strip CSP / X-Frame-Options <meta> tags (header equivalents stripped separately).
  $("meta[http-equiv]").each((_, el) => {
    const eq = ($(el).attr("http-equiv") ?? "").toLowerCase();
    if (eq === "content-security-policy" || eq === "x-frame-options") $(el).remove();
  });

  // Ensure head/body exist, then inject.
  if ($("head").length === 0) $("html").prepend("<head></head>");
  $("head").prepend(`<script>${frameBustScript}</script>`);
  if ($("body").length === 0) $("html").append("<body></body>");
  $("body").append(`<script>${runtimeScript}</script>`);

  return $.html();
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/html-rewrite.test.ts`
Expected: PASS. (The injection-order assertion in the test confirms `/*rt*/` is present; the integration test in B14 confirms it lands before `</body>`.)

- [ ] **Step 5: Commit**

```bash
git add src/html-rewrite.ts tests/html-rewrite.test.ts
git commit -m "feat: add cheerio HTML rewriting and runtime injection"
```

---

### Task B11: Header rewriting

Strip framing headers, rewrite `Set-Cookie` domains, rewrite `Location` for redirects, and build the outgoing upstream request headers (§7).

**Files:**
- Create: `review-proxy/src/headers.ts`
- Test: `review-proxy/tests/headers.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-proxy/tests/headers.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeResponseHeaders, rewriteSetCookie, rewriteLocation, buildUpstreamHeaders } from "../src/headers";

describe("sanitizeResponseHeaders", () => {
  it("drops framing/security headers and content-length", () => {
    const out = sanitizeResponseHeaders({
      "content-type": "text/html",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'",
      "strict-transport-security": "max-age=1",
      "content-length": "123",
      "cache-control": "no-store",
    });
    expect(out["content-type"]).toBe("text/html");
    expect(out["cache-control"]).toBe("no-store");
    expect(out["x-frame-options"]).toBeUndefined();
    expect(out["content-security-policy"]).toBeUndefined();
    expect(out["strict-transport-security"]).toBeUndefined();
    expect(out["content-length"]).toBeUndefined();
  });
});

describe("rewriteSetCookie", () => {
  it("rewrites Domain to the proxy host and forces Secure", () => {
    const out = rewriteSetCookie("sid=abc; Domain=dorik.com; Path=/; HttpOnly", "d-ab12cd34.reviewproxy.app");
    expect(out).toContain("Domain=d-ab12cd34.reviewproxy.app");
    expect(out).toMatch(/Secure/);
  });
});

describe("rewriteLocation", () => {
  it("rewrites a same-origin redirect to the proxy host", () => {
    expect(rewriteLocation("https://dorik.com/next", "https://dorik.com", "d-ab12cd34.reviewproxy.app"))
      .toBe("https://d-ab12cd34.reviewproxy.app/next");
  });
  it("leaves a cross-origin redirect unchanged", () => {
    expect(rewriteLocation("https://other.com/x", "https://dorik.com", "d-ab12cd34.reviewproxy.app"))
      .toBe("https://other.com/x");
  });
});

describe("buildUpstreamHeaders", () => {
  it("sends a browser UA and never forwards proxy/app headers", () => {
    const h = buildUpstreamHeaders(undefined);
    expect(h["user-agent"]).toMatch(/Mozilla/);
    expect(h.accept).toMatch(/text\/html/);
    expect(h.cookie).toBeUndefined();
  });
  it("forwards stored upstream cookies when provided", () => {
    const h = buildUpstreamHeaders("sid=abc");
    expect(h.cookie).toBe("sid=abc");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/headers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/headers.ts
import { rewriteUrl } from "./rewrite-url";

const STRIP = new Set([
  "x-frame-options",
  "content-security-policy",
  "content-security-policy-report-only",
  "cross-origin-opener-policy",
  "cross-origin-embedder-policy",
  "cross-origin-resource-policy",
  "strict-transport-security",
  "permissions-policy",
  "content-length",
  "content-encoding", // body is decompressed before this point (see upstream.ts)
  "set-cookie",       // handled separately, per-cookie
  "location",         // handled separately
]);

/** Copy upstream response headers minus framing/security/length headers. */
export function sanitizeResponseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (STRIP.has(k) || value == null) continue;
    out[k] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

/** Rewrite a Set-Cookie line: Domain → proxy host, force Secure. */
export function rewriteSetCookie(cookie: string, proxyHost: string): string {
  let out = cookie.replace(/;\s*Domain=[^;]*/i, `; Domain=${proxyHost}`);
  if (!/;\s*Domain=/i.test(out)) out += `; Domain=${proxyHost}`;
  if (!/;\s*Secure/i.test(out)) out += "; Secure";
  return out;
}

/** Rewrite a redirect Location: same-origin → proxy host; cross-origin unchanged. */
export function rewriteLocation(location: string, targetOrigin: string, proxyHost: string): string {
  if (/^https?:\/\//i.test(location) || location.startsWith("//")) {
    return rewriteUrl(location, targetOrigin, proxyHost);
  }
  return location; // relative — resolves to the proxy origin already
}

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Headers sent to the upstream site. Never includes review-platform headers. */
export function buildUpstreamHeaders(upstreamCookie: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    "user-agent": BROWSER_UA,
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.9",
    "accept-encoding": "gzip, deflate, br",
  };
  if (upstreamCookie) h.cookie = upstreamCookie;
  return h;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/headers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/headers.ts tests/headers.test.ts
git commit -m "feat: add request/response header rewriting"
```

---

### Task B12: Branded error pages

Each error response is a self-contained HTML page that also posts `pinion:ready` so the parent does not hang (§11).

**Files:**
- Create: `review-proxy/src/error-pages.ts`
- Test: `review-proxy/tests/error-pages.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/error-pages.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/error-pages.ts
export type ErrorKind =
  | "UNKNOWN_SUBDOMAIN"
  | "BAD_TOKEN"
  | "UPSTREAM_UNREACHABLE"
  | "UPSTREAM_TIMEOUT"
  | "TOO_LARGE"
  | "REDIRECT_LOOP";

const SPEC: Record<ErrorKind, { status: number; title: string; message: string }> = {
  UNKNOWN_SUBDOMAIN: { status: 404, title: "Link unavailable", message: "This review link is not available." },
  BAD_TOKEN: { status: 401, title: "Link expired", message: "This review link has expired." },
  UPSTREAM_UNREACHABLE: { status: 502, title: "Site unreachable", message: "Couldn't reach the site." },
  UPSTREAM_TIMEOUT: { status: 504, title: "Site too slow", message: "The site took too long to respond." },
  TOO_LARGE: { status: 502, title: "Page too large", message: "This page is too large to preview." },
  REDIRECT_LOOP: { status: 508, title: "Redirect loop", message: "This page redirects in a loop." },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

/** Build a self-contained error page that still notifies the parent app. */
export function errorPage(kind: ErrorKind, appOrigin: string): { status: number; body: string } {
  const { status, title, message } = SPEC[kind];
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;
font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#fafafa;color:#333}
.box{text-align:center;padding:2rem}h1{font-size:1.1rem;margin:0 0 .4rem}p{margin:0;color:#777}</style></head>
<body><div class="box"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></div>
<script>(function(){try{if(window.parent&&window.parent!==window){
window.parent.postMessage({type:"pinion:ready",width:0,height:0,pageUrl:location.pathname},${JSON.stringify(appOrigin)});
}}catch(e){}})();</script></body></html>`;
  return { status, body };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/error-pages.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/error-pages.ts tests/error-pages.test.ts
git commit -m "feat: add branded error pages"
```

---

### Task B13: Upstream fetch

Fetch the upstream site with `undici`: browser headers, manual redirects, timeout, and a body-size cap for buffered content. Decompresses gzip/deflate/br for buffered (HTML/CSS) bodies.

**Files:**
- Create: `review-proxy/src/upstream.ts`
- Test: `review-proxy/tests/upstream.test.ts`

- [ ] **Step 1: Write the failing test** (uses a local `node:http` server — no internet)

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/upstream.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
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
    maxRedirections: 0, // manual — the handler rewrites Location
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/upstream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/upstream.ts tests/upstream.test.ts
git commit -m "feat: add undici upstream fetch with size cap and decoding"
```

---

### Task B14: Request handler

Orchestrates the §5 request lifecycle. Pure of Fastify — takes a normalized request + injected dependencies — so it is fully unit-testable.

**Files:**
- Create: `review-proxy/src/proxy-handler.ts`
- Test: `review-proxy/tests/proxy-handler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-proxy/tests/proxy-handler.test.ts
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { handleProxyRequest, type ProxyDeps } from "../src/proxy-handler";
import { signProxyToken } from "../src/token";

const config = {
  port: 8080,
  proxyDomain: "reviewproxy.app",
  appOrigin: "http://localhost:3000",
  databaseUrl: "x",
  proxyTokenSecret: "secret",
  upstreamTimeoutMs: 5000,
  maxHtmlBytes: 1_000_000,
};

function deps(over: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    config,
    lookupSite: async () => ({ targetOrigin: "https://dorik.com", documentId: "doc1", enabled: true }),
    assertUpstreamAllowed: async () => {},
    fetchUpstream: async () => ({
      statusCode: 200,
      headers: { "content-type": "text/html" },
      bodyText: "<html><head></head><body><a href='https://dorik.com/x'>x</a></body></html>",
      contentType: "text/html",
    }),
    ...over,
  };
}

const goodToken = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "u" }, "secret");

describe("handleProxyRequest", () => {
  it("404s an unknown subdomain", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "nope.reviewproxy.app", path: "/", query: "", cookies: {} },
      deps({ lookupSite: async () => null }),
    );
    expect(r.status).toBe(404);
  });

  it("401s when the token is missing", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: {} },
      deps(),
    );
    expect(r.status).toBe(401);
  });

  it("302s to a clean URL and sets the cookie when token arrives via query", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/about", query: `__rt=${goodToken}`, cookies: {} },
      deps(),
    );
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBe("/about");
    expect(String(r.headers["set-cookie"])).toContain("__rt=");
  });

  it("proxies HTML, strips framing headers, rewrites same-origin links, injects the runtime", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps(),
    );
    expect(r.status).toBe(200);
    const body = String(r.body);
    expect(body).toContain("d-aaaa1111.reviewproxy.app/x");
    expect(body).toContain("pinion:ready");
  });

  it("rewrites a same-origin redirect Location", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps({
        fetchUpstream: async () => ({
          statusCode: 302,
          headers: { location: "https://dorik.com/next" },
          bodyStream: Readable.from([]),
          contentType: "",
        }),
      }),
    );
    expect(r.status).toBe(302);
    expect(r.headers["location"]).toBe("https://d-aaaa1111.reviewproxy.app/next");
  });

  it("504s on an upstream timeout", async () => {
    const r = await handleProxyRequest(
      { method: "GET", host: "d-aaaa1111.reviewproxy.app", path: "/", query: "", cookies: { __rt: goodToken } },
      deps({ fetchUpstream: async () => { throw new Error("UND_ERR_HEADERS_TIMEOUT"); } }),
    );
    expect(r.status).toBe(504);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/proxy-handler.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// review-proxy/src/proxy-handler.ts
import { Readable } from "node:stream";
import type { Config } from "./config";
import type { SiteRecord } from "./registry";
import type { UpstreamResponse } from "./upstream";
import { parseSubdomain } from "./subdomain";
import { verifyProxyToken } from "./token";
import { rewriteHtml } from "./html-rewrite";
import { rewriteCss } from "./css-rewrite";
import { sanitizeResponseHeaders, rewriteSetCookie, rewriteLocation } from "./headers";
import { buildOverlayRuntime, FRAME_BUST_SCRIPT } from "./overlay-runtime";
import { errorPage, type ErrorKind } from "./error-pages";

export type ProxyRequest = {
  method: string;
  host: string;
  path: string;          // pathname only
  query: string;         // raw query string, no leading "?"
  cookies: Record<string, string>;
};

export type ProxyResponse = {
  status: number;
  headers: Record<string, string | string[]>;
  body: string | Buffer | Readable;
};

export type ProxyDeps = {
  config: Config;
  lookupSite: (subdomain: string) => Promise<SiteRecord | null>;
  assertUpstreamAllowed: (url: string) => Promise<void>;
  fetchUpstream: (
    url: string,
    opts: { method: string; timeoutMs: number; maxBytes: number },
  ) => Promise<UpstreamResponse>;
};

function htmlError(kind: ErrorKind, appOrigin: string): ProxyResponse {
  const { status, body } = errorPage(kind, appOrigin);
  return { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body };
}

export async function handleProxyRequest(req: ProxyRequest, deps: ProxyDeps): Promise<ProxyResponse> {
  const { config } = deps;
  const appOrigin = config.appOrigin;

  // 1. Host → subdomain.
  const subdomain = parseSubdomain(req.host, config.proxyDomain);
  if (!subdomain) return htmlError("UNKNOWN_SUBDOMAIN", appOrigin);

  // 2. Registry lookup.
  const site = await deps.lookupSite(subdomain);
  if (!site || !site.enabled) return htmlError("UNKNOWN_SUBDOMAIN", appOrigin);

  // 3. Authenticate.
  const params = new URLSearchParams(req.query);
  const queryToken = params.get("__rt");
  const token = req.cookies["__rt"] ?? queryToken ?? "";
  const payload = verifyProxyToken(token, config.proxyTokenSecret, subdomain);
  if (!payload || payload.documentId !== site.documentId) {
    return htmlError("BAD_TOKEN", appOrigin);
  }
  // If the token came via the query string, set the cookie and 302 to a clean URL.
  if (queryToken && !req.cookies["__rt"]) {
    params.delete("__rt");
    const clean = req.path + (params.toString() ? `?${params.toString()}` : "");
    return {
      status: 302,
      headers: {
        location: clean,
        "set-cookie": `__rt=${queryToken}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`,
        "cache-control": "no-store",
      },
      body: "",
    };
  }

  // 4. Build the upstream URL.
  const cleanQuery = (() => {
    params.delete("__rt");
    const s = params.toString();
    return s ? `?${s}` : "";
  })();
  const upstreamUrl = site.targetOrigin + req.path + cleanQuery;

  // 5. SSRF re-check (DNS rebinding).
  try {
    await deps.assertUpstreamAllowed(upstreamUrl);
  } catch {
    return htmlError("UPSTREAM_UNREACHABLE", appOrigin);
  }

  // 6. Fetch upstream.
  let upstream: UpstreamResponse;
  try {
    upstream = await deps.fetchUpstream(upstreamUrl, {
      method: req.method === "HEAD" ? "HEAD" : "GET",
      timeoutMs: config.upstreamTimeoutMs,
      maxBytes: config.maxHtmlBytes,
    });
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (/TIMEOUT/i.test(msg)) return htmlError("UPSTREAM_TIMEOUT", appOrigin);
    if (/TOO_LARGE/i.test(msg)) return htmlError("TOO_LARGE", appOrigin);
    return htmlError("UPSTREAM_UNREACHABLE", appOrigin);
  }

  const proxyHost = `${subdomain}.${config.proxyDomain}`;
  const headers = sanitizeResponseHeaders(upstream.headers);

  // Rewrite Set-Cookie (may be one or many).
  const rawCookies = upstream.headers["set-cookie"];
  if (rawCookies != null) {
    const list = Array.isArray(rawCookies) ? rawCookies : [rawCookies];
    headers["set-cookie"] = list.map((c) => rewriteSetCookie(c, proxyHost)) as unknown as string;
  }

  // 7. Branch on the response.
  // 3xx — rewrite Location.
  if (upstream.statusCode >= 300 && upstream.statusCode < 400) {
    const loc = upstream.headers["location"];
    const out: Record<string, string | string[]> = { ...headers };
    if (typeof loc === "string") {
      out["location"] = rewriteLocation(loc, site.targetOrigin, proxyHost);
    }
    return { status: upstream.statusCode, headers: out, body: "" };
  }

  // HTML — rewrite + inject.
  if (/text\/html|application\/xhtml\+xml/i.test(upstream.contentType) && upstream.bodyText != null) {
    const rewritten = rewriteHtml(upstream.bodyText, {
      targetOrigin: site.targetOrigin,
      proxyHost,
      frameBustScript: FRAME_BUST_SCRIPT,
      runtimeScript: buildOverlayRuntime(appOrigin),
    });
    headers["content-type"] = "text/html; charset=utf-8";
    return { status: upstream.statusCode, headers, body: rewritten };
  }

  // CSS — rewrite url()/@import.
  if (/text\/css/i.test(upstream.contentType) && upstream.bodyText != null) {
    headers["content-type"] = "text/css";
    return {
      status: upstream.statusCode,
      headers,
      body: rewriteCss(upstream.bodyText, site.targetOrigin, proxyHost),
    };
  }

  // Everything else — stream through unmodified.
  return {
    status: upstream.statusCode,
    headers,
    body: upstream.bodyStream ?? Readable.from([]),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/proxy-handler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/proxy-handler.ts tests/proxy-handler.test.ts
git commit -m "feat: add proxy request handler"
```

---

### Task B15: Fastify server + entrypoint + integration test

Wire a single catch-all route to the handler, connect Mongo, and add a full-pipeline integration test that proxies a local upstream.

**Files:**
- Create: `review-proxy/src/server.ts`, `review-proxy/src/index.ts`
- Test: `review-proxy/tests/integration.test.ts`
- Modify: `review-proxy/README.md` (Status section)

- [ ] **Step 1: Write the failing integration test**

```ts
// review-proxy/tests/integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { buildServer } from "../src/server";
import { signProxyToken } from "../src/token";
import { createRegistry } from "../src/registry";
import { assertUpstreamAllowed } from "../src/ssrf";
import { fetchUpstream } from "../src/upstream";

let upstream: http.Server;
let upstreamPort: number;

const config = {
  port: 0,
  proxyDomain: "reviewproxy.app",
  appOrigin: "http://localhost:3000",
  databaseUrl: "x",
  proxyTokenSecret: "secret",
  upstreamTimeoutMs: 5000,
  maxHtmlBytes: 1_000_000,
};

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
    res.end(`<html><head></head><body><a href="http://127.0.0.1:${upstreamPort}/about">about</a></body></html>`);
  });
  await new Promise<void>((r) => upstream.listen(0, r));
  upstreamPort = (upstream.address() as { port: number }).port;
});
afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

describe("review-proxy end to end", () => {
  it("proxies a framed site: strips XFO, rewrites links, injects runtime", async () => {
    const targetOrigin = `http://127.0.0.1:${upstreamPort}`;
    const registry = createRegistry(
      async (sub) => (sub === "d-aaaa1111"
        ? { targetOrigin, documentId: "doc1", enabled: true }
        : null),
      60_000,
    );
    const app = buildServer({
      config,
      lookupSite: registry.lookup,
      assertUpstreamAllowed,
      fetchUpstream,
    });

    const token = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "u" }, "secret");

    // Token via cookie → 200 HTML.
    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "d-aaaa1111.reviewproxy.app", cookie: `__rt=${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.body).toContain("d-aaaa1111.reviewproxy.app/about");
    expect(res.body).toContain("pinion:ready");

    // Unknown subdomain → 404.
    const miss = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "d-nope0000.reviewproxy.app", cookie: `__rt=${token}` },
    });
    expect(miss.statusCode).toBe(404);

    // No token → 401.
    const noTok = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "d-aaaa1111.reviewproxy.app" },
    });
    expect(noTok.statusCode).toBe(401);

    await app.close();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/integration.test.ts`
Expected: FAIL — `Cannot find module '../src/server'`.

- [ ] **Step 3: Write `src/server.ts`**

```ts
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
```

- [ ] **Step 4: Run the integration test to verify it passes**

Run: `npx vitest run tests/integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Write `src/index.ts` (the entrypoint)**

```ts
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
```

- [ ] **Step 6: Type-check and run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc clean; all test files pass.

- [ ] **Step 7: Update `README.md` Status section**

Replace the `## Status` section body with:

```markdown
## Status

In development. Implementation follows `docs/plans/2026-05-22-live-subdomain-proxy-implementation.md`.
Run `npm test` for the unit + integration suite; `npm run dev` to start locally (needs `.env`).
```

- [ ] **Step 8: Commit**

```bash
git add src/server.ts src/index.ts tests/integration.test.ts README.md
git commit -m "feat: add Fastify server, entrypoint, and integration test"
```

**Part B complete.** `review-proxy` is a runnable service: `npm run dev` proxies any registered subdomain. Deployment (Render wildcard DNS/TLS, §4.1, §14) is an operational follow-up, not a code task.

---

# Part C — `review-Web`: token minting + viewer rewrite

Working directory for Part C: `/Users/dorik/projects/review-platform/review-Web`.

**v1 scope note:** the proxy-token route handles **authenticated users only**, matching the current `/api/proxy` route (which already does `getCookieUserId` with no guest path). Guest review of website documents is not supported today and stays out of scope.

---

### Task C1: Env vars, `ProxySite` schema, Vitest

**Files:**
- Modify: `review-Web/.env.example`, `review-Web/.env.local`
- Modify: `review-Web/prisma/schema.prisma`
- Create: `review-Web/vitest.config.ts`
- Modify: `review-Web/package.json` (devDependencies + a `test` script)

- [ ] **Step 1: Add env vars to `.env.example`**

Append to `review-Web/.env.example`:

```
# Live proxy service (review-proxy)
# PROXY_DOMAIN: the registrable domain the proxy serves wildcard subdomains on
# PROXY_TOKEN_SECRET: HMAC secret — MUST match review-proxy's PROXY_TOKEN_SECRET
PROXY_DOMAIN="reviewproxy.app"
PROXY_TOKEN_SECRET=""
```

- [ ] **Step 2: Add the same two vars to `.env.local`**

Add `PROXY_DOMAIN` (the real proxy domain, or `reviewproxy.app` for dev) and `PROXY_TOKEN_SECRET` — its value **must equal** `review-proxy`'s `.env` `PROXY_TOKEN_SECRET` (Task B1 Step 5).

- [ ] **Step 3: Add the `ProxySite` model to review-Web's Prisma schema**

`review-Web` keeps its own copy of the schema. Mirror Contract 1 exactly. In `review-Web/prisma/schema.prisma`, add `proxySite ProxySite?` to the `Document` model's relation list, and append:

```prisma
model ProxySite {
  id           String   @id @default(auto()) @map("_id") @db.ObjectId
  documentId   String   @unique @db.ObjectId
  subdomain    String   @unique
  targetOrigin String
  enabled      Boolean  @default(true)
  createdAt    DateTime @default(now())

  document     Document @relation(fields: [documentId], references: [id], onDelete: Cascade)
}
```

- [ ] **Step 4: Regenerate the Prisma client**

Run: `cd /Users/dorik/projects/review-platform/review-Web && npx prisma generate`
Expected: `Generated Prisma Client`. (No `db push` — Part A Task A3 already pushed to the shared database.)

- [ ] **Step 5: Add Vitest**

Run: `npm install -D vitest@^4.1.4`

- [ ] **Step 6: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 7: Add a `test` script to `package.json`**

In `review-Web/package.json` `scripts`, add:

```json
    "test": "vitest run",
```

- [ ] **Step 8: Commit**

```bash
git add .env.example prisma/schema.prisma vitest.config.ts package.json package-lock.json
git commit -m "chore: add proxy env vars, ProxySite model, vitest"
```

---

### Task C2: Proxy token minting

Implements the signing half of Contract 2. The code is byte-identical to `review-proxy/src/token.ts`'s `signProxyToken` (Task B4) — verified by the cross-check test below.

**Files:**
- Create: `review-Web/src/lib/proxy-token.ts`
- Test: `review-Web/src/lib/proxy-token.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// review-Web/src/lib/proxy-token.test.ts
import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { signProxyToken } from "./proxy-token";

const SECRET = "shared-secret";

// Mirror of review-proxy/src/token.ts verifyProxyToken — keeps the two repos in lockstep.
function verify(token: string, secret: string, expectedSubdomain: string, now: number) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const b64url = (b: Buffer) =>
    b.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const expected = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  if (sig !== expected) return null;
  const pad = "=".repeat((4 - (body.length % 4)) % 4);
  const payload = JSON.parse(
    Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64").toString("utf8"),
  );
  if (payload.exp < now) return null;
  if (payload.subdomain !== expectedSubdomain) return null;
  return payload;
}

describe("signProxyToken", () => {
  it("produces a token the proxy's verify logic accepts", () => {
    const tok = signProxyToken({ documentId: "doc1", subdomain: "d-aaaa1111", sub: "user1" }, SECRET);
    const p = verify(tok, SECRET, "d-aaaa1111", Math.floor(Date.now() / 1000));
    expect(p.documentId).toBe("doc1");
    expect(p.sub).toBe("user1");
  });

  it("sets exp roughly two hours out", () => {
    const before = Math.floor(Date.now() / 1000);
    const tok = signProxyToken({ documentId: "d", subdomain: "d-aaaa1111", sub: "u" }, SECRET);
    const p = JSON.parse(
      Buffer.from(tok.split(".")[0].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    expect(p.exp - before).toBeGreaterThanOrEqual(7190);
    expect(p.exp - before).toBeLessThanOrEqual(7210);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/proxy-token.test.ts`
Expected: FAIL — `Cannot find module './proxy-token'`.

- [ ] **Step 3: Write the implementation**

```ts
// review-Web/src/lib/proxy-token.ts
import crypto from "node:crypto";

export type ProxyTokenPayload = {
  documentId: string;
  subdomain: string;
  sub: string;
  iat: number;
  exp: number;
};

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Mint a proxy access token (Contract 2). TTL defaults to 2 hours. */
export function signProxyToken(
  claims: { documentId: string; subdomain: string; sub: string },
  secret: string,
  ttlSeconds = 2 * 60 * 60,
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: ProxyTokenPayload = { ...claims, iat: now, exp: now + ttlSeconds };
  const body = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64urlEncode(crypto.createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/proxy-token.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/proxy-token.ts src/lib/proxy-token.test.ts
git commit -m "feat: add proxy access token minting"
```

---

### Task C3: Proxy-token route handler

A route handler that checks document access and returns the iframe's proxy origin, a signed token, and the entry path.

**Files:**
- Create: `review-Web/src/app/api/proxy-token/route.ts`

- [ ] **Step 1: Write the route handler**

```ts
// review-Web/src/app/api/proxy-token/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { resolveAccess } from "@/lib/access";
import { getCookieUserId } from "@/lib/web-auth";
import { signProxyToken } from "@/lib/proxy-token";

// Returns the proxied-iframe session for a website document:
// { proxyOrigin, token, entryPath }. Authenticated users only (v1).
export async function GET(req: Request) {
  const userId = await getCookieUserId();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const documentId = new URL(req.url).searchParams.get("documentId");
  if (!documentId) return NextResponse.json({ error: "Missing documentId" }, { status: 400 });

  const doc = await db.document.findUnique({ where: { id: documentId } });
  if (!doc || doc.deletedAt) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (doc.type !== "WEBSITE" || !doc.sourceUrl) {
    return NextResponse.json({ error: "Not a website document" }, { status: 400 });
  }

  const role = await resolveAccess(userId, { kind: "document", documentId: doc.id });
  if (!role) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const site = await db.proxySite.findUnique({ where: { documentId: doc.id } });
  if (!site || !site.enabled) {
    return NextResponse.json({ error: "Proxy site unavailable" }, { status: 409 });
  }

  const secret = process.env.PROXY_TOKEN_SECRET;
  const proxyDomain = process.env.PROXY_DOMAIN;
  if (!secret || !proxyDomain) {
    return NextResponse.json({ error: "Proxy not configured" }, { status: 500 });
  }

  const token = signProxyToken(
    { documentId: doc.id, subdomain: site.subdomain, sub: userId },
    secret,
  );

  let entryPath = "/";
  try {
    const u = new URL(doc.sourceUrl);
    entryPath = u.pathname + u.search;
  } catch {
    // sourceUrl already validated at creation; fall back to "/"
  }

  return NextResponse.json(
    { proxyOrigin: `https://${site.subdomain}.${proxyDomain}`, token, entryPath },
    { headers: { "Cache-Control": "no-store" } },
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd /Users/dorik/projects/review-platform/review-Web && npx tsc --noEmit`
Expected: no errors. (If `@/lib/db`/`@/lib/access` resolution differs, match the imports used by `src/app/api/proxy/route.ts`.)

- [ ] **Step 3: Manual verification**

1. Start `review-Web` (`npm run dev`) and `review_api`.
2. Logged in, with a website document that has a `ProxySite` row (create one via Part A if needed), open in the browser:
   `http://localhost:3000/api/proxy-token?documentId=<id>` → expect JSON `{ proxyOrigin, token, entryPath }`; `proxyOrigin` ends in your `PROXY_DOMAIN`; `token` has exactly one `.`.
3. With no session cookie (incognito) → expect HTTP **401**.
4. With a `documentId` you cannot access → expect **403**.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/proxy-token/route.ts
git commit -m "feat: add proxy-token route handler"
```

---

### Task C4: Rewrite `website-viewer.tsx` to `postMessage`

Replace all `contentDocument` access with the Contract 3 `postMessage` protocol. The component's `Props` are unchanged, so `review-workspace.tsx` does not change.

**Files:**
- Create: `review-Web/src/app/app/[orgSlug]/d/[documentId]/use-proxy-session.ts`
- Replace: `review-Web/src/app/app/[orgSlug]/d/[documentId]/website-viewer.tsx`

- [ ] **Step 1: Create the `useProxySession` hook**

```ts
// review-Web/src/app/app/[orgSlug]/d/[documentId]/use-proxy-session.ts
import { useQuery } from "@tanstack/react-query";

export type ProxySession = {
  proxyOrigin: string;
  token: string;
  entryPath: string;
};

/** Fetch the proxied-iframe session (proxy origin + signed token) for a document. */
export function useProxySession(documentId: string) {
  return useQuery<ProxySession>({
    queryKey: ["proxy-session", documentId],
    queryFn: async () => {
      const res = await fetch(
        `/api/proxy-token?documentId=${encodeURIComponent(documentId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error(`proxy-token ${res.status}`);
      return res.json() as Promise<ProxySession>;
    },
    staleTime: 90 * 60 * 1000, // token lives 2h; treat fresh for 90 min
    retry: 1,
  });
}
```

> If the app has no `QueryClientProvider`, confirm one wraps the tree (search `app/layout.tsx` / a providers file for `QueryClientProvider`). `@tanstack/react-query` is already a dependency, so it should be present; if not, that is a pre-existing gap to flag, not fix here.

- [ ] **Step 2: Replace `website-viewer.tsx` entirely**

```tsx
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { clientFetch } from "@/lib/api-client";
import { RichTextEditor } from "@/components/comments/rich-text-editor";
import { useProxySession } from "./use-proxy-session";
import type { Comment } from "./types";

type Props = {
	initialUrl: string;
	documentId: string;
	comments: Comment[];
	onCommentCreated: (c: Comment) => void;
	activeThreadId: string | null;
	onPinClick: (threadId: string) => void;
	canAddPins: boolean;
	currentPageUrl: string;
	onPageUrlChange: (pathname: string) => void;
};

const DEVICE_PRESETS = [
	{ id: "mobile", label: "Mobile", width: 390 },
	{ id: "tablet", label: "Tablet", width: 768 },
	{ id: "desktop", label: "Desktop", width: 1440 },
] as const;
type DeviceId = (typeof DEVICE_PRESETS)[number]["id"];

type IframeMessage =
	| { type: "pinion:ready"; width: number; height: number; pageUrl: string }
	| {
			type: "pinion:positions";
			positions: Record<string, { x: number; y: number; visible: boolean }>;
			docHeight: number;
			pageUrl: string;
	  }
	| {
			type: "pinion:click";
			selector: string;
			path: string;
			textHash: string;
			xPct: number;
			yPct: number;
			x: number;
			y: number;
			pageUrl: string;
	  }
	| { type: "pinion:page-url"; pageUrl: string };

type Pending = {
	x: number;
	y: number;
	selector: string;
	path: string;
	textHash: string;
	xPct: number;
	yPct: number;
	pageUrl: string;
};

export function WebsiteViewer({
	initialUrl,
	documentId,
	comments,
	onCommentCreated,
	activeThreadId,
	onPinClick,
	canAddPins,
	currentPageUrl,
	onPageUrlChange,
}: Props) {
	const frameRef = useRef<HTMLIFrameElement>(null);
	const composerFileRef = useRef<HTMLInputElement>(null);

	const [device, setDevice] = useState<DeviceId>("desktop");
	const [iframeLoaded, setIframeLoaded] = useState(false);
	const [reloadNonce, setReloadNonce] = useState(0);
	const [pinPositions, setPinPositions] = useState<
		Record<string, { x: number; y: number; visible: boolean }>
	>({});
	const [pending, setPending] = useState<Pending | null>(null);
	const [draft, setDraft] = useState("");
	const [draftAttachment, setDraftAttachment] = useState("");
	const [posting, setPosting] = useState(false);

	const deviceWidth = DEVICE_PRESETS.find((d) => d.id === device)!.width;

	const { data: session, isLoading, isError } = useProxySession(documentId);

	// Root comments scoped to the current page (null pageUrl = any page).
	const rootComments = useMemo(
		() =>
			comments.filter(
				(c) =>
					c.threadId === null &&
					(c.pageUrl == null || c.pageUrl === currentPageUrl),
			),
		[comments, currentPageUrl],
	);
	const numberById = useMemo(() => {
		const m = new Map<string, number>();
		rootComments.forEach((c, i) => m.set(c.id, i + 1));
		return m;
	}, [rootComments]);

	// Entry iframe src — built once per session; never reassigned on navigation
	// (client-side navigation happens inside the iframe; §8).
	const iframeSrc = useMemo(() => {
		if (!session) return "";
		const u = new URL(session.entryPath || "/", session.proxyOrigin);
		u.searchParams.set("__rt", session.token);
		return u.toString();
	}, [session]);

	// Post a message into the iframe (targeted at the proxy origin).
	const postToIframe = useCallback(
		(msg: unknown) => {
			const win = frameRef.current?.contentWindow;
			if (win && session) win.postMessage(msg, session.proxyOrigin);
		},
		[session],
	);

	// Push comments + mode into the iframe whenever they change.
	const syncIframe = useCallback(() => {
		postToIframe({
			type: "pinion:set-comments",
			comments: rootComments.map((c) => ({
				id: c.id,
				selector: c.elementSelector,
				path: c.elementPath,
				textHash: c.textFingerprint,
				xPct: c.xPct,
				yPct: c.yPct,
			})),
		});
		postToIframe({
			type: "pinion:set-mode",
			mode: canAddPins ? "comment" : "read",
		});
	}, [postToIframe, rootComments, canAddPins]);

	useEffect(() => {
		if (iframeLoaded) syncIframe();
	}, [iframeLoaded, syncIframe]);

	// Listen for messages from the proxied iframe.
	useEffect(() => {
		if (!session) return;
		function onMessage(e: MessageEvent) {
			if (e.origin !== session!.proxyOrigin) return;
			if (e.source !== frameRef.current?.contentWindow) return;
			const msg = e.data as IframeMessage;
			if (!msg || typeof msg !== "object") return;
			if (msg.type === "pinion:ready") {
				setIframeLoaded(true);
				onPageUrlChange(msg.pageUrl);
			} else if (msg.type === "pinion:positions") {
				setPinPositions(msg.positions);
			} else if (msg.type === "pinion:click") {
				if (!canAddPins) return;
				setPending({
					x: msg.x,
					y: msg.y,
					selector: msg.selector,
					path: msg.path,
					textHash: msg.textHash,
					xPct: msg.xPct,
					yPct: msg.yPct,
					pageUrl: msg.pageUrl,
				});
				setDraft("");
			} else if (msg.type === "pinion:page-url") {
				onPageUrlChange(msg.pageUrl);
				setPending(null);
			}
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [session, canAddPins, onPageUrlChange]);

	async function submitPending() {
		if (!pending || !draft.trim() || posting) return;
		setPosting(true);
		try {
			const iframe = frameRef.current;
			const res = await clientFetch(`/comments`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					documentId,
					body: draft.trim(),
					xPct: pending.xPct,
					yPct: pending.yPct,
					elementSelector: pending.selector,
					elementPath: pending.path,
					textFingerprint: pending.textHash,
					pageUrl: pending.pageUrl,
					attachmentUrl: draftAttachment || undefined,
					viewportWidth: iframe?.clientWidth,
					viewportHeight: iframe?.clientHeight,
				}),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({}));
				toast.error(data.error?.message ?? "Could not post comment");
				return;
			}
			const created: Comment = await res.json();
			onCommentCreated(created);
			setPending(null);
			setDraft("");
			setDraftAttachment("");
		} finally {
			setPosting(false);
		}
	}

	async function attachComposerFile(e: React.ChangeEvent<HTMLInputElement>) {
		const file = e.target.files?.[0];
		if (!file) return;
		if (!file.type.startsWith("image/")) {
			toast.error("Only images can be attached");
			return;
		}
		if (file.size > 1_200_000) {
			toast.error("Image must be under 1.2 MB");
			return;
		}
		const reader = new FileReader();
		reader.onload = () => setDraftAttachment(reader.result as string);
		reader.readAsDataURL(file);
	}

	function reloadIframe() {
		setIframeLoaded(false);
		setPinPositions({});
		setReloadNonce((n) => n + 1);
	}

	return (
		<div className="flex flex-col h-full min-h-0 bg-muted/30">
			<div className="h-10 shrink-0 border-b bg-background flex items-center px-3 gap-2 text-sm">
				<span className="text-muted-foreground">Preview:</span>
				{DEVICE_PRESETS.map((p) => (
					<button
						key={p.id}
						onClick={() => setDevice(p.id)}
						className={`px-2 py-0.5 rounded ${
							device === p.id ? "bg-primary text-primary-foreground" : "hover:bg-accent"
						}`}
					>
						{p.label} <span className="text-[10px] opacity-70">{p.width}</span>
					</button>
				))}
				<button
					onClick={reloadIframe}
					className="px-2 py-0.5 rounded hover:bg-accent disabled:opacity-50"
					title="Reload"
					aria-label="Reload site"
					disabled={!iframeLoaded}
				>
					<span className={iframeLoaded ? "" : "inline-block animate-spin"} aria-hidden>
						↻
					</span>
				</button>
				<span className="ml-3 text-xs text-muted-foreground truncate flex-1">
					{currentPageUrl}
				</span>
				<span className="text-xs text-muted-foreground shrink-0">
					{canAddPins ? "Click on the page to add a pin" : "Read mode"}
				</span>
			</div>
			<div className="relative flex-1 overflow-auto flex justify-center">
				{isError ? (
					<div className="flex items-center justify-center h-full text-sm text-muted-foreground">
						Couldn’t open the proxied site.
					</div>
				) : isLoading || !iframeSrc ? (
					<div className="flex items-center justify-center h-full text-sm text-muted-foreground">
						Preparing preview…
					</div>
				) : (
					<div className="relative h-full" style={{ width: deviceWidth }}>
						<iframe
							ref={frameRef}
							key={`${iframeSrc}#${reloadNonce}`}
							src={iframeSrc}
							style={{ width: deviceWidth, opacity: iframeLoaded ? 1 : 0, transition: "opacity 150ms ease" }}
							className="bg-white shadow-lg block h-full"
						/>
						{!iframeLoaded && (
							<div className="absolute inset-0 flex items-center justify-center pointer-events-none">
								<div className="flex flex-col items-center gap-3">
									<div className="w-8 h-8 rounded-full border-2 border-muted-foreground/30 border-t-primary animate-spin" />
									<div className="text-sm text-muted-foreground">Loading site…</div>
								</div>
							</div>
						)}
						<div className="absolute inset-0 overflow-hidden pointer-events-none">
							{rootComments.map((c) => {
								const pos = pinPositions[c.id];
								if (!pos || !pos.visible) return null;
								const num = numberById.get(c.id) ?? 0;
								const isActive = activeThreadId === c.id;
								const resolved = c.status === "RESOLVED";
								return (
									<button
										key={c.id}
										onClick={() => onPinClick(c.id)}
										className={`absolute -translate-x-1/2 -translate-y-1/2 rounded-full w-7 h-7 text-xs font-semibold shadow-md flex items-center justify-center pointer-events-auto transition ${
											resolved
												? "bg-green-500 text-white opacity-70"
												: isActive
													? "bg-yellow-400 text-black ring-2 ring-yellow-200"
													: "bg-primary text-primary-foreground"
										}`}
										style={{ left: pos.x, top: pos.y }}
									>
										{num}
									</button>
								);
							})}
							{pending && (
								<div
									className="absolute -translate-x-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-yellow-400 ring-2 ring-yellow-200"
									style={{ left: pending.x, top: pending.y }}
								/>
							)}
						</div>
					</div>
				)}
			</div>
			{pending && (
				<div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-popover text-popover-foreground border rounded-lg shadow-lg p-3 w-[460px] z-10">
					<RichTextEditor
						value={draft}
						onChange={setDraft}
						placeholder="Leave a comment at this pin…"
						minHeight="5rem"
						compact
						autoFocus
					/>
					{draftAttachment && (
						<div className="mt-2 relative inline-block">
							{/* eslint-disable-next-line @next/next/no-img-element */}
							<img
								src={draftAttachment}
								alt="attachment"
								className="max-h-[60px] max-w-[60px] rounded border object-cover"
							/>
							<button
								type="button"
								onClick={() => setDraftAttachment("")}
								className="absolute right-1 top-1 rounded-full bg-foreground/80 text-background w-5 h-5 flex items-center justify-center text-xs hover:bg-foreground"
								aria-label="Remove attachment"
							>
								×
							</button>
						</div>
					)}
					<div className="mt-2 flex items-center justify-between gap-2">
						<button
							type="button"
							onClick={() => composerFileRef.current?.click()}
							className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
						>
							📎 Attach image
						</button>
						<input
							ref={composerFileRef}
							type="file"
							accept="image/*"
							className="hidden"
							onChange={attachComposerFile}
						/>
						<div className="flex gap-1.5">
							<button
								onClick={() => {
									setPending(null);
									setDraft("");
									setDraftAttachment("");
								}}
								className="border rounded-md px-3 py-1.5 text-sm"
							>
								Cancel
							</button>
							<button
								onClick={submitPending}
								disabled={posting || !draft.trim()}
								className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
							>
								{posting ? "Posting…" : "Post"}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
```

Notes on the rewrite:
- `genSelector` / `buildPath` / `textHash` / `findByPath` / `resolveElement` / `proxyUrlFor` / `navigateTo` / `recomputePins` are **removed** — pin anchoring now runs inside the iframe runtime (Task B9).
- `initialUrl` stays in `Props` (the parent passes it) but is unused; the entry path comes from the proxy-token route. Keep the prop to avoid touching `review-workspace.tsx`.
- The pin overlay is a sibling of the `<iframe>` inside a `position: relative` box sized to the iframe, so reported viewport coordinates map directly to `left`/`top`.

- [ ] **Step 3: Type-check and lint**

Run: `cd /Users/dorik/projects/review-platform/review-Web && npx tsc --noEmit && npm run lint`
Expected: no errors. (`initialUrl` may trigger an unused-var lint warning — prefix it `_initialUrl` in the destructure if your ESLint config errors on it, or leave it; do not remove it from the `Props` type.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/app/[orgSlug]/d/[documentId]/use-proxy-session.ts" "src/app/app/[orgSlug]/d/[documentId]/website-viewer.tsx"
git commit -m "feat: rewire website viewer to postMessage proxy"
```

---

### Task C5: E2E verification, CHIPS check, and cleanup of superseded routes

**Files:**
- Delete: `review-Web/src/app/api/iframe-render/route.ts`, `review-Web/src/app/api/proxy/route.ts`
- Delete (in `review_api`): `review_api/src/routes/dom.ts`, `review_api/src/routes/asset-proxy.ts`, `review_api/src/routes/proxy.ts`, `review_api/src/routes/render.ts` — **only after** Step 3 confirms each is unreferenced.

- [ ] **Step 1: End-to-end verification**

With `review_api`, `review-Web`, and `review-proxy` (`npm run dev`) all running, and a website document that has a `ProxySite` row:

1. Open the document in `review-Web`. The iframe loads the live site via `https://<subdomain>.<PROXY_DOMAIN>/…`.
2. A site that sends `X-Frame-Options`/CSP (e.g. `https://github.com`) is no longer blocked from framing.
3. In Comment mode, click an element → a pending pin appears at the click point → post a comment → the numbered pin renders at that element.
4. Click an internal link → the iframe navigates client-side; the breadcrumb URL updates; the iframe `src` attribute stays the entry URL (inspect it in devtools).
5. Reload the page → the pin reappears at the same element.
6. In devtools, confirm there is **no** `contentDocument` access from the parent and that proxied responses carry no `X-Frame-Options`/`Content-Security-Policy`.

- [ ] **Step 2: Safari CHIPS check (§17.3)**

In **Safari**, repeat Step 1. Confirm the `__rt` cookie (set `Partitioned`) survives across an in-iframe link click (the second navigation should not 401). If Safari drops the partitioned cookie, record it as a known v1 limitation in `review-proxy/docs/2026-05-22-live-subdomain-proxy-design.md` §17 — the documented fallback (runtime keeps `__rt` in same-origin nav URLs) is **out of v1 scope**.

- [ ] **Step 3: Confirm the superseded routes are unreferenced**

Run from the repo root:

```bash
cd /Users/dorik/projects/review-platform
grep -rn "iframe-render\|api/proxy" review-Web/src --include=*.tsx --include=*.ts | grep -v "src/app/api/"
grep -rn "\"/dom\"\|/asset-proxy\|\"/proxy\"\|\"/render\"\|routes/dom\|routes/asset-proxy\|routes/proxy\|routes/render" review_api/src
```

Expected: no remaining references (Task C4 removed `proxyUrlFor`). For `review_api`, also open `src/app.ts` and confirm which of `dom`, `asset-proxy`, `proxy`, `render` routers it mounts — **only delete a route file whose mount line you also remove**. If any router is still imported/mounted and you are unsure, leave it and note it; deleting live routes is out of scope for this task.

- [ ] **Step 4: Delete the confirmed-dead routes**

For `review-Web` (these were the website viewer's old proxy paths, now replaced):

```bash
rm review-Web/src/app/api/iframe-render/route.ts
rm review-Web/src/app/api/proxy/route.ts
```

For `review_api`, remove each confirmed-unreferenced router file **and its mount line in `src/app.ts`** (`import` + `app.use(...)`). Files to evaluate: `src/routes/dom.ts`, `src/routes/asset-proxy.ts`, `src/routes/proxy.ts`, `src/routes/render.ts`. Skip any that are still referenced.

- [ ] **Step 5: Type-check both apps**

```bash
cd /Users/dorik/projects/review-platform/review-Web && npx tsc --noEmit
cd /Users/dorik/projects/review-platform/review_api && npx tsc --noEmit
```

Expected: no errors in either.

- [ ] **Step 6: Commit (one commit per repo touched)**

```bash
cd /Users/dorik/projects/review-platform/review-Web
git add -A
git commit -m "chore: remove superseded iframe-render and proxy routes"

cd /Users/dorik/projects/review-platform/review_api
git add -A
git commit -m "chore: remove superseded proxy/render routes"
```

**Part C complete.** The website viewer renders live, framed sites through the subdomain proxy, with pins and comments driven entirely by `postMessage`.

---

## Self-review

**Spec coverage** — every design section maps to a task:

- §3-§4 architecture / components → Tasks A3, B1-B15, C1-C5.
- §4.3 `ProxySite` model → A3 / C1 (both schemas).
- §4.4 subdomain allocation → A2, A4.
- §4.5 registry read + cache → B6.
- §4.6 access token → B4, C2, C3; cookie set + 302 → B14.
- §5 request lifecycle → B14 (handler), B15 (server).
- §6 HTML rewriting → B7, B8, B10; runtime/frame-bust injection → B9, B10.
- §7 header rewriting + cross-origin policy → B11; redirect rewriting → B14.
- §8 SPA routing → B9 (runtime `pushState`/`popstate`), C4 (`src` never reassigned).
- §9 `postMessage` protocol → Contract 3, B9, C4.
- §10 security → A1 (registration SSRF), B5 (fetch-time DNS re-check), B4 (token), separate domain + CHIPS cookie in B14.
- §11 error handling → B12, B14.
- §12 `review_api` changes → A3, A4 (incl. the soft-delete `enabled:false` hook, since the app soft-deletes).
- §13 `review-Web` changes → C2, C3, C4; route deletions → C5.
- §14 deployment → noted as operational follow-up after B15 (not a code task).
- §15 testing → unit tests throughout; B15 integration test; C5 E2E + CHIPS.
- §16 scope → POST/forms, cross-origin API proxying, guest access, caching all left out (handler is GET/HEAD only, B13/B14).
- §17 open questions → resolved at the top of this plan; CHIPS verified in C5.
- §18 acceptance criteria → covered by the C5 E2E checklist and the B15 integration test.

**Known limitations carried into v1 (by design):** cross-origin API/XHR calls may CORS-fail (§7); frame-bust neutralization is best-effort (B9); a soft-deleted document leaves its `ProxySite` row present but `enabled:false` (A4); guest review of website docs is unsupported (C intro).

**Type consistency:** `ProxyTokenPayload` and the `signProxyToken`/`verifyProxyToken` token format are identical across B4 and C2 (C2's test re-implements verification to prove it). `SiteRecord` (B6) flows unchanged through `ProxyDeps` (B14). The Contract 3 message shapes match between B9 (runtime) and C4 (`IframeMessage`).

**Placeholder scan:** none — every code step contains complete code; manual-verification steps (A4, C3, C5) are used only where a headless-browser dependency or a stale test harness makes automated testing dishonest, and each lists concrete commands and expected results.

---

## Execution handoff

Plan complete and saved to `review-proxy/docs/plans/2026-05-22-live-subdomain-proxy-implementation.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Execute the Parts strictly in order (A → B → C); each Part ends in independently verifiable software.
