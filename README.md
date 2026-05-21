# review-proxy

Live subdomain reverse proxy for the website-review feature. Serves arbitrary third-party sites
through per-site subdomains so reviewers can pin and comment on them inside an iframe — fetching
upstream live, stripping framing headers, rewriting same-origin URLs, and injecting an overlay
runtime.

Part of the `review-platform` project alongside `review_api` and `review-Web`. Kept as its own git
repo, consistent with the project's separate-repos layout.

## Docs

- [Design](docs/2026-05-22-live-subdomain-proxy-design.md)
- [Implementation plan](docs/plans/)

## Status

Pre-implementation. The design is approved; implementation follows the plan in `docs/plans/`.
