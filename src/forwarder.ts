// Local URL forwarder: http://127.0.0.1:PORT/https://host/path  ->  https://host/path
// Streams the upstream response through byte for byte (no decompression on the client path),
// meters a decompressed copy, enforces an upstream allowlist after DNS resolution, follows no
// redirects itself, and rewrites allowlisted Location headers back through the forwarder.

import http from "node:http";
import net from "node:net";
import dns from "node:dns/promises";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { request as undiciRequest, Agent, EnvHttpProxyAgent, type Dispatcher } from "undici";
import { Meter, type WireBytes } from "./engine/meter.js";

const HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length"]);
const RESP_DROP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);

export interface ForwarderOptions {
  allow: string[];               // allowlisted upstream hosts (exact or *.suffix)
  port?: number;                 // 0 = pick a free port
  meter: Meter;
  allowPrivate?: boolean;        // tests only: permit upstreams that resolve to loopback/private addresses
  onUnmeasured?: (host: string, reason: string) => void;
  /** GET /__stop (loopback only) asks the owner to finish; if it returns HTML, that is sent as the response (the report). */
  onStop?: () => Promise<string | void> | string | void;
  /** With exactly one allowed host, requests without the https://host prefix go to this host, so a plain base URL works. */
  defaultUpstream?: string;
  log?: (line: string) => void;
}

export interface Forwarder { port: number; close(): Promise<void>; unmeasured: { host: string; reason: string }[] }

function hostAllowed(host: string, allow: string[]): boolean {
  return allow.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) || host === p.slice(2) : host === p));
}

function isPrivate(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe80") || l.startsWith("::ffff:");
}

async function resolveAllowed(host: string, allow: string[], allowPrivate: boolean): Promise<string | null> {
  if (!hostAllowed(host, allow)) return `host ${host} is not on the allowlist (--allow ${host})`;
  let addrs: string[];
  try { addrs = (await dns.lookup(host, { all: true })).map((a) => a.address); }
  catch (e) { return `DNS lookup failed for ${host}: ${(e as Error).message}`; }
  if (addrs.length === 0) return `DNS lookup returned no address for ${host}`;
  if (!allowPrivate && addrs.some(isPrivate)) return `${host} resolves to a private or loopback address; refused`;
  return null;
}

function decoder(encoding: string | undefined): NodeJS.ReadWriteStream | null {
  switch ((encoding ?? "").toLowerCase().trim()) {
    case "": case "identity": return null;
    case "gzip": case "x-gzip": return zlib.createGunzip();
    case "br": return zlib.createBrotliDecompress();
    case "deflate": return zlib.createInflate();
    default: return undefined as unknown as null; // unknown encoding: handled by caller
  }
}

/** One upstream response shape for both runtimes. */
interface Upstream { statusCode: number; headers: Record<string, string | string[]>; body: AsyncIterable<Uint8Array>; destroy(): void }

const isBun = typeof (globalThis as unknown as { Bun?: unknown }).Bun !== "undefined";

async function readAll(r: Readable): Promise<Buffer> { const parts: Buffer[] = []; for await (const c of r) parts.push(Buffer.isBuffer(c) ? c : Buffer.from(c)); return Buffer.concat(parts); }

/**
 * Open the upstream request. Node: undici.request (raw encoded stream, no redirects, proxy via env).
 * Bun: its "undici" import is a fetch shim that silently decompresses, so use Bun's own fetch with
 * decompress:false and redirect:"manual", which returns the encoded bytes untouched.
 */
async function openUpstream(url: URL, method: string, headers: Record<string, string>, body: Readable | undefined, dispatcher: Dispatcher): Promise<Upstream> {
  if (!isBun) {
    const up = await undiciRequest(url, { method: method as any, headers, body, dispatcher, maxRedirections: 0 });
    const h: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) if (v !== undefined) h[k] = v as string | string[];
    return { statusCode: up.statusCode, headers: h, body: up.body as AsyncIterable<Uint8Array>, destroy: () => up.body.destroy() };
  }
  const ac = new AbortController();
  const init: Record<string, unknown> = { method, headers, redirect: "manual", decompress: false, signal: ac.signal };
  if (body) init.body = await readAll(body);
  const resp = await fetch(url, init as RequestInit);
  const h: Record<string, string | string[]> = {};
  resp.headers.forEach((v, k) => { if (k !== "set-cookie") h[k] = v; });
  const cookies = (resp.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.();
  if (cookies && cookies.length) h["set-cookie"] = cookies;
  const stream = resp.body;
  const iter: AsyncIterable<Uint8Array> = stream ? (stream as unknown as AsyncIterable<Uint8Array>) : (async function* () {})();
  return { statusCode: resp.status, headers: h, body: iter, destroy: () => ac.abort() };
}

/** The live page served at /__meter: what to point at the meter, running totals, and a Finish button. */
function livePage(allow: string[], def: string | undefined, port: number): string {
  const base = `http://127.0.0.1:${port}`;
  const host = def ?? allow[0] ?? "api.example.com";
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const how = def
    ? `<p>Your meter is on. Point the app you want to measure at <code>${base}</code> instead of <code>https://${esc(def)}</code>, then use it normally.</p>
<ul>
<li>OpenAI SDK: set <code>OPENAI_BASE_URL=${base}/v1</code></li>
<li>Anthropic SDK: set <code>ANTHROPIC_BASE_URL=${base}</code></li>
<li>Stripe (Node): <code>new Stripe(key, { protocol: "http", host: "127.0.0.1", port: ${port} })</code></li>
<li>Anything else: replace <code>https://${esc(def)}</code> with <code>${base}</code> in its base URL or config</li>
</ul>`
    : `<p>Your meter is on for: ${allow.map(esc).join(", ")}. Point each app at <code>${base}/https://&lt;host&gt;/…</code>, for example <code>OPENAI_BASE_URL=${base}/https://${esc(host)}/v1</code>.</p>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MeterMyData is running</title>
<style>body{margin:0;background:#05060a;color:#f2f2f0;font:16px/1.55 Inter,"Segoe UI",Arial,sans-serif}main{max-width:860px;margin:0 auto;padding:28px 20px}h1{font-family:Marcellus,Georgia,serif;font-weight:400;font-size:30px;margin:0 0 6px}.sub{color:#c9ccd1}code{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:6px;padding:2px 6px;font-size:14px}ul{color:#c9ccd1}.big{font-family:Marcellus,Georgia,serif;font-size:64px;color:#c9a96e;line-height:1;margin:24px 0 4px}.meta{color:#8b9099;font-size:14px}table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid rgba(255,255,255,.12)}th{color:#8b9099;font-weight:normal}.btn{display:inline-block;background:#c9a96e;color:#05060a;font-weight:600;padding:12px 20px;border-radius:8px;text-decoration:none;margin-top:12px}.hint{color:#8b9099;font-size:13px;margin-top:10px}</style></head>
<body><main><h1>MeterMyData is running</h1><p class="sub">Nothing leaves this machine. Use your app for a while, then press Finish.</p>${how}
<div class="big" id="pct">0%</div><div class="meta" id="sum">waiting for the first response…</div>
<table><thead><tr><th>Host</th><th>Responses</th><th>Received</th><th>Repeated</th><th>Repeat %</th></tr></thead><tbody id="rows"></tbody></table>
<a class="btn" href="${base}/__stop">Finish and show my report</a><p class="hint">Keep this tab open; it refreshes itself every two seconds.</p>
<script>
const fmt=n=>n<1024?n+" B":n<1048576?(n/1024).toFixed(1)+" KB":n<1073741824?(n/1048576).toFixed(1)+" MB":(n/1073741824).toFixed(2)+" GB";
async function tick(){try{const s=await fetch("${base}/__status",{cache:"no-store"}).then(r=>r.json());const t=s.sources.reduce((a,x)=>(a.r+=x.responses,a.d+=x.decodedBytes,a.p+=x.repeatBytes,a),{r:0,d:0,p:0});
document.getElementById("pct").textContent=(t.d?100*t.p/t.d:0).toFixed(1)+"%";document.getElementById("sum").textContent=t.r?(t.r+" responses · "+fmt(t.d)+" received · "+fmt(t.p)+" was a repeat"):"waiting for the first response…";
document.getElementById("rows").innerHTML=s.sources.map(x=>"<tr><td>"+x.host+"</td><td>"+x.responses+"</td><td>"+fmt(x.decodedBytes)+"</td><td>"+fmt(x.repeatBytes)+"</td><td>"+x.repeatPct.toFixed(1)+"%</td></tr>").join("");}catch(e){}}
tick();setInterval(tick,2000);
</script></main></body></html>`;
}

export async function startForwarder(opts: ForwarderOptions): Promise<Forwarder> {
  const log = opts.log ?? (() => {});
  const unmeasured: { host: string; reason: string }[] = [];
  const dispatcher: Dispatcher = (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy)
    ? new EnvHttpProxyAgent() : new Agent();

  const server = http.createServer(async (req, res) => {
    const path = req.url ?? "/";
    // Control surface (loopback only): live page, status JSON, stop (returns the report when the owner provides one)
    if (path === "/__stop" || path.startsWith("/__stop?")) {
      let html: string | void;
      try { html = await opts.onStop?.(); } catch { html = undefined; }
      if (typeof html === "string") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); }
      else { res.writeHead(200, { "content-type": "text/plain" }); res.end("stopping\n"); }
      return;
    }
    if (path === "/__status") { res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ allow: opts.allow, defaultUpstream: opts.defaultUpstream ?? null, sources: opts.meter.totals(), unmeasured })); return; }
    if (path === "/__meter" || path === "/__meter/" || (!opts.defaultUpstream && (path === "/" || path === "/index.html"))) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(livePage(opts.allow, opts.defaultUpstream, (server.address() as net.AddressInfo).port)); return;
    }
    const m = /^\/(https?:\/\/[^/]+)(\/.*)?$/i.exec(path);
    let upstream: URL;
    if (m) upstream = new URL(m[1] + (m[2] ?? "/"));
    else if (opts.defaultUpstream) upstream = new URL(`https://${opts.defaultUpstream}${path.startsWith("/") ? path : "/" + path}`);
    else {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("MeterMyData forwarder. Set your SDK's base URL to http://127.0.0.1:PORT/https://host/path, or start the meter with one --allow host and use http://127.0.0.1:PORT directly.\n");
      return;
    }
    const refusal = await resolveAllowed(upstream.hostname, opts.allow, opts.allowPrivate === true);
    if (refusal) { res.writeHead(403, { "content-type": "text/plain" }); res.end(`refused: ${refusal}\n`); log(`refused ${upstream.host}: ${refusal}`); return; }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP.has(k) || v === undefined) continue;
      headers[k] = Array.isArray(v) ? v.join(", ") : v;
    }
    headers["host"] = upstream.host;
    const hasBody = !(req.method === "GET" || req.method === "HEAD");
    let wireFinal: WireBytes | undefined;
    const sink = opts.meter.openStream(upstream.host, () => wireFinal);
    let up: Upstream;
    try {
      up = await openUpstream(upstream, req.method ?? "GET", headers, hasBody ? (req as unknown as Readable) : undefined, dispatcher);
    } catch (e) {
      res.writeHead(502, { "content-type": "text/plain" }); res.end(`upstream error: ${(e as Error).message}\n`);
      log(`upstream error ${upstream.host}: ${(e as Error).message}`); return;
    }
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(up.headers)) { if (!RESP_DROP.has(k) && v !== undefined) out[k] = v; }
    // Redirect handling: rewrite allowlisted Location back through the forwarder; otherwise pass and record.
    if (up.statusCode >= 300 && up.statusCode < 400 && typeof out["location"] === "string") {
      let target: URL | null = null;
      try { target = new URL(out["location"] as string, upstream); } catch { target = null; }
      if (target && hostAllowed(target.hostname, opts.allow)) {
        out["location"] = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/${target.href}`;
      } else if (target) {
        const reason = `redirect to ${target.host} left the allowlist; bytes after it are unmeasured`;
        unmeasured.push({ host: target.host, reason }); opts.onUnmeasured?.(target.host, reason); log(reason);
      }
    }
    res.writeHead(up.statusCode, out);
    const enc = typeof up.headers["content-encoding"] === "string" ? (up.headers["content-encoding"] as string) : undefined;
    const dec = decoder(enc);
    const clen = Number(up.headers["content-length"]);
    let wireCount = 0;
    // Metering copy: identity bodies go straight to the sink; encoded bodies are written into a zlib decoder
    // whose output feeds the sink. The encoded bytes are also kept (bounded) so that a runtime whose zlib
    // streams emit nothing can still be metered by a synchronous decode at the end.
    let decodeFailed = false, decodedOut = 0;
    const encoded: Buffer[] = []; let encodedLen = 0; const ENCODED_CAP = 256 * 1024 * 1024;
    if (dec === undefined) {
      const reason = `unknown content-encoding "${enc}" from ${upstream.host}; response passed through unmeasured`;
      unmeasured.push({ host: upstream.host, reason }); opts.onUnmeasured?.(upstream.host, reason); log(reason);
    } else if (dec) {
      dec.on("data", (b: Buffer) => { decodedOut += b.length; void sink.write(new Uint8Array(b)); });
      dec.on("error", (e: Error) => { decodeFailed = true; log(`decode error (${enc}) from ${upstream.host}: ${e.message}`); });
    }
    const decoderDone = () => new Promise<void>((resolve) => {
      if (!dec) { resolve(); return; }
      let settled = false; const fin = () => { if (!settled) { settled = true; resolve(); } };
      dec.once("end", fin); dec.once("error", fin); dec.once("close", fin);
      dec.end();
      setTimeout(fin, 10000); // never hang a response on a decoder that will not finish
    });
    const syncDecode = (): Buffer | null => {
      const buf = Buffer.concat(encoded);
      try {
        switch ((enc ?? "").toLowerCase().trim()) {
          case "gzip": case "x-gzip": return zlib.gunzipSync(buf);
          case "br": return zlib.brotliDecompressSync(buf);
          case "deflate": try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
          default: return null;
        }
      } catch { return null; }
    };
    let clientGone = false;
    req.on("close", () => { if (!res.writableEnded) { clientGone = true; up.destroy(); } });
    try {
      for await (const chunk of up.body) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        wireCount += b.length; res.write(b);
        if (dec) { if (!decodeFailed) dec.write(b); if (encodedLen + b.length <= ENCODED_CAP) { encoded.push(b); encodedLen += b.length; } }
        else if (dec === null) void sink.write(new Uint8Array(b));
      }
    } catch (e) {
      if (!clientGone) { log(`upstream body error ${upstream.host}: ${(e as Error).message}`); res.destroy(e as Error); }
      try { (dec as unknown as { destroy?: () => void } | null)?.destroy?.(); } catch { /* ignore */ }
      return;
    }
    res.end();
    await decoderDone();
    if (dec && decodedOut === 0 && encodedLen > 0 && encodedLen <= ENCODED_CAP) {
      const plain = syncDecode();
      if (plain) { await sink.write(new Uint8Array(plain)); log(`decoded ${enc} synchronously (${plain.length} bytes) for ${upstream.host}`); }
      else { const reason = `could not decode ${enc} body from ${upstream.host}; response passed through unmeasured`; unmeasured.push({ host: upstream.host, reason }); opts.onUnmeasured?.(upstream.host, reason); log(reason); }
    }
    wireFinal = { value: wireCount, status: "observed" };
    if (Number.isFinite(clen) && clen !== wireCount) wireFinal.status = "estimated";
    await sink.end();
    log(`${req.method} ${upstream.host}${upstream.pathname} ${up.statusCode} wire=${wireCount}${enc ? ` (${enc})` : ""}`);
  });

  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(opts.port ?? 0, "127.0.0.1", () => resolve()); });
  const port = (server.address() as net.AddressInfo).port;
  return { port, unmeasured, close: () => new Promise((r) => server.close(() => r())) };
}
