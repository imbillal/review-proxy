// review-proxy/src/error-pages.ts
export type ErrorKind =
  | "UNKNOWN_SUBDOMAIN"
  | "UPSTREAM_UNREACHABLE"
  | "UPSTREAM_TIMEOUT"
  | "TOO_LARGE"
  | "REDIRECT_LOOP";

const SPEC: Record<ErrorKind, { status: number; title: string; message: string }> = {
  UNKNOWN_SUBDOMAIN: { status: 404, title: "Link unavailable", message: "This review link is not available." },
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
