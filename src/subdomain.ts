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
