# Live Subdomain Reverse Proxy for Website Review — Design

**Date:** 2026-05-22
**Status:** Draft — awaiting review
**Repo:** `review-proxy` (new), with changes in `review_api` and `review-Web`
**Supersedes:** the live-proxy / capture portions of `2026-05-04-path-based-proxy-design.md` and
`2026-05-14-iframe-snapshot-pipeline-design.md`. The pin / comment data model is unchanged.

---

## 1. Purpose

The website-review feature renders an arbitrary third-party site inside an iframe so reviewers can
drop pins and comments on it. Every prior approach failed in a different way:

- **HTML sanitization / `/dom` render** — dynamic sites arrive as empty shells; CSS breaks because
  asset URLs are not resolved.
- **Snapshot capture** — requires a headless browser server-side (heavy, expensive), and snapshots
  go stale.
- **Parent-side `contentDocument` access** — breaks the instant upstream JS does any cross-origin
  work.

This design adopts the **Pastel-style live subdomain reverse proxy**: every reviewed site is served
through a per-site subdomain on a dedicated proxy service that fetches the upstream site live on
each view, strips the headers that block framing, rewrites same-origin URLs, and injects an overlay
runtime that talks to the parent app over `postMessage`.

It is a **live** proxy (re-fetches upstream every view) — no capture step, no headless browser, no
stored HTML.

---

## 2. Decisions

Locked in during brainstorming (`2026-05-22`):

| Decision | Choice | Reason |
|---|---|---|
| Rendering model | **Live reverse proxy** | Always fresh; no headless browser; cheapest infra. |
| URL structure | **Subdomain per site** | `/about`, `/_next/static/...`, runtime `fetch('/api')` resolve back into the proxy automatically — no rewriting needed for relative/absolute-path URLs. |
| Runtime | **Dedicated Node service**, hosted on Render | Streaming proxy, full control; own git repo. |
| Proxy domain | **Separate registrable domain** (not a subdomain of the app domain) | Security boundary for untrusted third-party content (cf. `githubusercontent.com`); also satisfies Render's wildcard-domain requirement. |

**Accepted trade-off:** a live proxy re-fetches each view, so a dynamic page can render slightly
differently between visits and DOM-anchored pins can drift. Mitigated by multi-strategy pin
anchoring (§9). This was chosen with eyes open over the snapshot model.

---

## 3. Architecture

```
                  ┌──────────────────────────────────────────────┐
  reviewer's      │  review-Web        (app.<appdomain>)          │
  browser         │   website-viewer.tsx                         │
                  │   <iframe src="https://d-ab12cd34             │
                  │            .<proxydomain>/?__rt=<token>">     │
                  └───────────────┬──────────────────────────────┘
                                  │ iframe loads a DIFFERENT origin
                                  ▼
   *.<proxydomain>  ─────►  ┌───────────────────────────────────┐
   wildcard DNS + TLS       │  review-proxy  (NEW Node service)  │
   (Render)                 │  1. Host → subdomain → registry   │
                            │  2. verify access token           │
                            │  3. upstream URL = origin + path  │
                            │  4. fetch upstream (undici)       │
                            │  5. strip XFO / CSP / COOP / ...  │
                            │  6. rewrite HTML + inject runtime │
                            │  7. stream response back          │
                            └───────────────┬───────────────────┘
                                            ▼
                                   https://dorik.com/...  (upstream)

  registry read ◄── review-proxy reads ProxySite from shared MongoDB (cached)
  token mint    ◄── review-Web signs a token after checking document access
  registry write ◄─ review_api creates a ProxySite row on website-document creation
```

Three codebases:

| Codebase | Role |
|---|---|
| `review-proxy` (new) | The proxy service. Fetch, rewrite, stream. |
| `review_api` | `ProxySite` registry model + subdomain allocation on document creation. |
| `review-Web` | `website-viewer.tsx` rewired to `postMessage`; mints the proxy access token. |

`<proxydomain>` is a domain to be registered. This document uses **`reviewproxy.app`** as a
stand-in; the real name is chosen at implementation time and stored in env.

---

## 4. Components

### 4.1 DNS + TLS

- Register a dedicated domain (stand-in: `reviewproxy.app`).
- Point apex + wildcard at the Render service per Render's wildcard-domain docs:
  - `*` → `<service>.onrender.com`
  - `_acme-challenge` → `<service-id>.verify.renderdns.com`
  - `_cf-custom-hostname` → `<service-id>.hostname.renderdns.com`
- Render auto-provisions and renews a wildcard Let's Encrypt certificate. No Caddy needed because
  Render terminates TLS.

### 4.2 review-proxy service

Node service. Per-request lifecycle in §5. Stack chosen in the implementation plan (Fastify or raw
`node:http`) + `undici` for upstream fetches + a streaming HTML rewriter (§6).

Environment:

| Var | Purpose |
|---|---|
| `PROXY_DOMAIN` | e.g. `reviewproxy.app` — used to parse the subdomain and to rewrite URLs. |
| `DATABASE_URL` | Read-only access to the shared MongoDB (registry lookups). |
| `PROXY_TOKEN_SECRET` | Shared HMAC secret; verifies access tokens minted by `review-Web`. |
| `UPSTREAM_TIMEOUT_MS` | Default `20000`. |
| `MAX_HTML_BYTES` | Default `15_000_000`. |

### 4.3 Site registry — `ProxySite` (review_api)

One row per reviewed website. Lives in the shared MongoDB.

```prisma
model ProxySite {
  id            String   @id @default(auto()) @map("_id") @db.ObjectId
  documentId    String   @unique @db.ObjectId
  subdomain     String   @unique   // e.g. "d-ab12cd34"
  targetOrigin  String             // e.g. "https://dorik.com" — scheme + host (+ port)
  enabled       Boolean  @default(true)
  createdAt     DateTime @default(now())

  document      Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@index([subdomain])
}
```

`targetOrigin` is the **origin only** — the proxy reconstructs the full URL from origin + the
request path. A `ProxySite` covers exactly one origin (see §16 Out of scope for multi-origin sites).

### 4.4 Subdomain allocation

When a website `Document` is created in `review_api`:

1. SSRF-validate the target URL (§10). Reject before creating the row.
2. Derive `targetOrigin` from the target URL.
3. Mint `subdomain = "d-" + nanoid(8)` — lowercase alphanumeric, ~8 chars. **Not** the
   dots-to-dashes scheme Pastel uses (`dorik-com`): an opaque id has no collisions, handles
   `a.b.co.uk`, and isolates the same site added by two different orgs into two origins.
4. Create the `ProxySite` row.

### 4.5 How the proxy reads the registry

The proxy needs `subdomain → { targetOrigin, enabled }`. **It reads MongoDB directly** with the
official `mongodb` driver (not Prisma — keeps the proxy lightweight) and caches results in-memory
with a ~60 s TTL. The registry changes rarely; a stale-for-60s read is acceptable. Lookups are a
single indexed query on `subdomain`.

*Alternative considered:* an internal HTTP endpoint on `review_api`. Rejected for v1 — adds a
network hop and a second service dependency on the hot path for no real decoupling benefit, since
both services already share the database.

### 4.6 Access token

The proxied content is usually public, but the proxy must not be loadable by anyone with the URL.

- When a reviewer opens a website document, `review-Web` checks document access (it already does
  this for auth + guest links) and **mints a short-lived signed token**: HMAC-SHA256 over
  `{ documentId, subdomain, sub: userId|guestId, exp }` using `PROXY_TOKEN_SECRET`. Expiry ~2 h.
- The iframe's initial `src` carries `?__rt=<token>`.
- The proxy verifies the token (signature, expiry, subdomain match). On success it sets the token
  as a cookie so later navigations and asset requests are authorized without the query param:
  `Set-Cookie: __rt=<token>; Secure; HttpOnly; SameSite=None; Partitioned` and then 302-redirects
  to the same URL minus `?__rt` (clean URL).
- `Partitioned` (CHIPS) is required: the proxy origin is a **third-party iframe** relative to the
  app page, so an unpartitioned cookie would be blocked by Safari ITP / Chrome third-party cookie
  rules. See §17 — Safari CHIPS behavior must be verified; the fallback is for the injected runtime
  to keep `__rt` in same-origin navigation URLs.

---

## 5. Request lifecycle

For `GET https://d-ab12cd34.reviewproxy.app/about?x=1`:

1. **Parse Host** → subdomain label `d-ab12cd34`. No subdomain or malformed → 404 (§11).
2. **Registry lookup** (cached) → `{ targetOrigin: "https://dorik.com", documentId, enabled }`.
   Missing or `enabled === false` → 404.
3. **Authenticate** — read `__rt` from cookie, else from `?__rt`. Verify signature + expiry +
   subdomain match. Invalid/missing → 401 (§11). If it arrived via query param, set the cookie and
   302 to the clean URL.
4. **Build upstream URL** — `targetOrigin` + request path + query string (with `__rt` removed):
   `https://dorik.com/about?x=1`.
5. **SSRF re-check** — resolve the upstream host; reject private / link-local / metadata IPs even
   though `targetOrigin` was validated at registration (DNS-rebinding defense, §10).
6. **Fetch upstream** with `undici`:
   - Methods: **GET and HEAD only** in v1 (POST/forms are §16 Out of scope).
   - Request headers sent: a real browser `User-Agent`, `Accept`, `Accept-Language`,
     `Accept-Encoding`; the proxy's stored upstream cookies for this site, if any. **Never** the
     review-platform's own cookies/headers.
   - `redirect: "manual"`, `UPSTREAM_TIMEOUT_MS` timeout, body cap `MAX_HTML_BYTES` for HTML.
7. **Branch on the response:**
   - **3xx** — rewrite `Location` (§7). Same-origin → proxy subdomain + new path. Cross-origin →
     §7 policy. Cap the redirect chain at 10 → 508 on loop.
   - **HTML** (`text/html`) — rewrite (§6), inject the runtime, return.
   - **CSS** (`text/css`) — rewrite absolute same-origin `url(...)` references; CSS files are
     small enough to buffer.
   - **Everything else** (JS, images, fonts, JSON, …) — stream through unmodified.
8. **Rewrite response headers** (all responses) — §7.
9. **Stream** to the client. Use chunked transfer (drop upstream `Content-Length`) whenever the
   body was modified.

---

## 6. HTML rewriting

With a subdomain proxy, relative URLs (`./x`, `../x`) and absolute-path URLs (`/about`,
`/_next/static/...`) already resolve to the proxy origin — **no rewriting needed**. Only two things
need work: **absolute URLs that name the upstream origin**, and **injected scripts**.

**Engine:** a streaming, selector-based HTML rewriter built on `lol-html` (e.g. the `html-rewriter`
npm package). Streaming avoids buffering whole pages on a small Render instance. `cheerio` is an
acceptable fallback if streaming proves fiddly — decided in the implementation plan.

**Injected into `<head>` (at the very start):** a frame-busting neutralizer — redefine
`window.top` / `window.parent` to `window`, set `window.frameElement = null`, neutralize
`document.domain` writes.

**Injected before `</body>`:** the **overlay runtime** (`overlay-runtime.ts`, §9).

**URL attributes rewritten** — if the URL is absolute *and* its origin equals the site's
`targetOrigin`, rewrite the origin to the proxy subdomain. If the origin is a different host, apply
the §7 cross-origin policy.

| Element | Attributes |
|---|---|
| `<a>`, `<link>`, `<area>` | `href` |
| `<img>`, `<script>`, `<iframe>`, `<source>`, `<video>`, `<audio>`, `<track>`, `<embed>` | `src` |
| `<img>`, `<source>` | `srcset` (rewrite each candidate) |
| `<video>` | `poster` |
| `<form>` | `action` |
| `<button>`, `<input>` | `formaction` |
| `<object>` | `data` |
| SVG `<use>`, `<image>` | `href`, `xlink:href` |
| any element | `style` attribute (`url(...)`) |
| `<base>` | `href` — rewrite if the upstream page sets one |
| `<meta http-equiv="refresh">` | the URL in `content` |
| `<style>` element body | `url(...)` |

**Stripped:** `integrity` attributes on `<link>` / `<script>` (rewriting or proxying breaks
sub-resource integrity hashes).

**Not rewritten:** inline event handlers and inline `<script>` bodies — they cannot be statically
analyzed. They are covered at runtime because same-origin URLs the page builds dynamically already
point at the proxy origin.

---

## 7. Header rewriting & cross-origin policy

**Headers stripped from every response** (these block framing or sub-resource loading):
`X-Frame-Options`, `Content-Security-Policy`, `Content-Security-Policy-Report-Only`,
`Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, `Cross-Origin-Resource-Policy`,
`Strict-Transport-Security`, `Permissions-Policy`.

**`Set-Cookie`** — rewrite the `Domain` attribute to the proxy subdomain host (or drop `Domain` so
it defaults to that host); keep `Path`; force `Secure`. These are the *upstream site's* cookies,
scoped to that one subdomain — site A cannot read site B's cookies because they are different
origins.

**`Location`** (3xx) — rewritten per the redirect rule in §5.7.

**`Content-Length`** — dropped when the body was modified; respond chunked.

**Cross-origin resources policy (v1):**

| Resource origin | Policy |
|---|---|
| The site's own `targetOrigin` | Rewrite to the proxy subdomain → flows through the proxy. |
| Third-party CDN static assets (images, fonts, CSS, JS) | **Left as direct absolute URLs.** Loaded straight from the CDN. Tag-loaded images/CSS/JS need no CORS; most font CDNs send permissive CORS. Keeps proxy bandwidth down. |
| Third-party API / `fetch` / XHR endpoints | Left direct; may CORS-fail. For a *visual* review tool a failed background API call rarely breaks the visible layout. A documented limitation; a per-origin asset-proxy is §16 v2. |

---

## 8. SPA / client-side routing

Dorik and other modern sites navigate client-side. Because the SPA runs **on the proxy subdomain
origin**, its `history.pushState('/about')` and `fetch('/api/x')` already stay on the proxy origin
and flow through the proxy with zero rewriting — the subdomain payoff again.

The overlay runtime additionally:

- Monkey-patches `history.pushState` / `replaceState` and listens for `popstate`; after each, reads
  `location.href` and posts `pinion:page-url` to the parent.
- Lets hard `<a>` navigations proceed normally — their `href` was rewritten at HTML-rewrite time.
- Intercepts `target="_blank"` / `window.open` and posts to the parent instead of escaping the
  frame.

The parent (`website-viewer.tsx`) updates **its own** route state from `pinion:page-url` but never
reassigns the iframe `src` attribute. Result: the `src` attribute stays at the entry URL while the
document URL changes — exactly the behavior observed in Pastel.

---

## 9. Overlay runtime ↔ parent `postMessage` protocol

The iframe is a different origin from the app → the parent **cannot** read `contentDocument`. All
interaction is `postMessage`. `review_api/src/lib/overlay-runtime.ts` already exists and is reused;
this section confirms the contract.

**iframe → parent:**

| Message | Payload |
|---|---|
| `pinion:ready` | runtime booted; document dimensions |
| `pinion:positions` | pin coordinates + current page height |
| `pinion:click` | new-pin location + element anchor data |
| `pinion:page-url` | client-side navigation occurred; new `pageUrl` |

**parent → iframe:**

| Message | Payload |
|---|---|
| `pinion:set-comments` | comments to render for the current page |
| `pinion:set-mode` | whether pin-adding is enabled |

**Origin checks:** the parent accepts messages only when `event.origin` ends in `<proxydomain>`
**and** `event.source === iframe.contentWindow`. The runtime accepts messages only from the app
origin.

**Pin anchoring:** the existing `genSelector` / `buildPath` / `textHash` strategy is kept, but now
runs **inside the runtime** (in the iframe) rather than in the parent; results travel by
`postMessage`. Multi-strategy anchoring (CSS selector + DOM path + text hash + normalized
coordinates) absorbs the small layout differences a live proxy can produce between views.

---

## 10. Security model

- **Open-proxy / SSRF.** The proxy serves **only registered subdomains**. `targetOrigin` is fixed
  at registration and SSRF-validated then: reject `localhost`, `127.0.0.0/8`, `10/8`,
  `172.16/12`, `192.168/16`, link-local `169.254/16` (incl. cloud metadata `169.254.169.254`),
  IPv6 ULA/link-local, and `*.local`. At fetch time the resolved IP is re-checked (DNS-rebinding
  defense). The request path can never change the origin.
- **Separate registrable domain.** The proxy is not a subdomain of the app domain → a malicious
  proxied site cannot reach app cookies or use `document.domain` against the app.
- **Per-subdomain isolation.** Each site is a distinct origin; cookies, `localStorage`, etc. do
  not cross between reviewed sites.
- **Token gating.** Only a reviewer holding a valid signed token (minted by `review-Web` after a
  document-access check) can load a proxied site.
- **No credential bleed.** Upstream never receives review-platform cookies/headers; the parent app
  never receives upstream cookies.
- **Resource caps.** `UPSTREAM_TIMEOUT_MS` + `MAX_HTML_BYTES` + redirect-chain cap guard against
  slowloris / memory exhaustion / redirect loops.
- **Injected runtime** is the only script the proxy adds; it is first-party to the proxy origin and
  communicates only via `postMessage` with strict origin checks on both ends.

---

## 11. Error handling

Every error response is a small self-contained HTML page that **includes the overlay runtime
stub**, so the parent still receives `pinion:ready` and does not hang.

| Condition | Status | Page |
|---|---|---|
| Unknown / disabled subdomain | 404 | "This review link is not available." |
| Missing / invalid token | 401 | "This review link has expired." |
| Upstream DNS fail / connection refused | 502 | "Couldn't reach the site." + Retry |
| Upstream timeout (> `UPSTREAM_TIMEOUT_MS`) | 504 | "The site took too long to respond." + Retry |
| Body over `MAX_HTML_BYTES` | 502 | "This page is too large to preview." |
| Redirect loop (> 10 hops) | 508 | "This page redirects in a loop." |
| Upstream 4xx / 5xx | passthrough | upstream body shown, framing headers still stripped |

---

## 12. Changes in `review_api`

- Add the `ProxySite` Prisma model + migration; relation on `Document`.
- On website-`Document` creation: SSRF-validate, derive `targetOrigin`, allocate the subdomain,
  create the `ProxySite` row. `onDelete: Cascade` removes it with the document.
- (Optional, can defer) an endpoint to disable / regenerate a subdomain.

## 13. Changes in `review-Web`

- `website-viewer.tsx`:
  - iframe `src` = `https://<subdomain>.<proxydomain>/<entry-path>?__rt=<token>`.
  - Remove **all** `contentDocument` access and parent-side DOM walking.
  - Add the `postMessage` listener/sender per §9; render pin markers in the parent DOM from
    `pinion:positions`; sync route state from `pinion:page-url`.
- Add a route/server action that checks document access and returns a signed proxy token
  (`PROXY_TOKEN_SECRET` in `review-Web`'s env).
- **Candidate deletions** (confirm during implementation): the old `api/iframe-render`,
  `api/proxy`, `api/dom-render`, `api/iframe-proxy`, `api/asset-proxy` Next routes that belonged to
  superseded approaches.

---

## 14. Deployment

- `review-proxy` → Render. Free tier during development (accept the 30–60 s cold start, or add a
  ~10-minute uptime pinger); **Render Starter ($7/mo)** before real reviewers use it — it removes
  spin-down and raises CPU to 0.5.
- Dedicated proxy domain with wildcard DNS + Render-managed wildcard TLS (§4.1).
- Proxy env vars per §4.2; `review-Web` and `review-proxy` share `PROXY_TOKEN_SECRET`.

---

## 15. Testing

**Unit:** `Host` → subdomain parse; upstream-URL build; header strip/rewrite; `Location` rewrite;
`Set-Cookie` `Domain` rewrite; HTML URL rewrite (same-origin absolute → proxy; cross-origin left
alone; `srcset` multi-candidate); token sign/verify (expiry, subdomain mismatch, bad signature);
SSRF blocklist.

**Integration:** proxy a static marketing site and an SPA (Next.js); assert XFO/CSP gone, runtime
injected, internal links rewritten, cross-origin CDN assets untouched; redirect `Location`
rewriting; unknown subdomain → 404; bad token → 401; private-IP target rejected at registration.

**E2E:** open a website document → iframe loads via the proxy subdomain → click an internal link →
the document URL changes while the iframe `src` attribute stays the entry URL → place a pin →
comment scoped to the new `pageUrl` → reload → the pin reappears at the same position.

**Light load:** N concurrent page loads on Render free (0.1 CPU) vs Starter (0.5 CPU) — confirms
the free-vs-Starter cutover point.

---

## 16. Scope

**In (v1):**

- `review-proxy` live proxy: one proxy domain, per-site subdomains.
- `ProxySite` registry + subdomain allocation in `review_api`.
- Access-token mint (`review-Web`) + verify (`review-proxy`).
- `website-viewer.tsx` rewritten to `postMessage`.
- HTML rewriting: same-origin absolute URL rewrite, runtime injection, header stripping.
- Branded error pages.
- Cross-origin CDN assets left direct.

**Out (v2+):**

- POST / form-submission passthrough.
- Cross-origin API/XHR proxying (a per-origin asset-proxy).
- Authenticated upstream sites (login-walled targets).
- Response caching at the proxy.
- A single `ProxySite` spanning multiple origins (e.g. `dorik.com` + `app.dorik.com`); v1 covers
  one origin per site, cross-origin links render a "you've left the site" notice.

---

## 17. Open questions for the implementation plan

1. HTML rewriter library — `lol-html` streaming binding vs `cheerio` buffered.
2. Proxy framework — Fastify vs raw `node:http`.
3. **Safari CHIPS** — verify the `Partitioned` `__rt` cookie survives in a third-party iframe in
   Safari. If not, the injected runtime must keep `__rt` in same-origin navigation URLs.
4. Final confirmation of which superseded `review-Web` API routes are safe to delete.
5. Whether to ship the optional disable/regenerate-subdomain endpoint in v1 or defer.

---

## 18. Acceptance criteria

- [ ] Adding a website document allocates a `ProxySite` row with a unique subdomain.
- [ ] Opening the document loads the live site in the iframe through `https://<sub>.<proxydomain>/`.
- [ ] `X-Frame-Options` / `CSP` from the upstream site no longer block framing.
- [ ] Clicking an internal link changes the document URL while the iframe `src` attribute stays the
      entry URL; pins/comments re-scope to the new `pageUrl`.
- [ ] A dynamic/SPA site (Dorik) renders with working CSS and images.
- [ ] No parent-side `contentDocument` access remains in `website-viewer.tsx`.
- [ ] An SSRF payload (private IP, `localhost`) is rejected at document-creation time.
- [ ] Loading a proxy URL without a valid token returns 401.
