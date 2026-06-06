// review-proxy/src/css-rewrite.ts
import { rewriteUrl } from "./rewrite-url";

/** Rewrite url(...) and @import references inside a block of CSS text. */
export function rewriteCss(css: string, targetOrigin: string, proxyBase: string): string {
  return css
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (_m, quote: string, url: string) => {
      return `url(${quote}${rewriteUrl(url, targetOrigin, proxyBase)}${quote})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (_m, quote: string, url: string) => {
      return `@import ${quote}${rewriteUrl(url, targetOrigin, proxyBase)}${quote}`;
    });
}
