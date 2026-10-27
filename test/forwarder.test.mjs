import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { Meter } from "../dist/engine.js";
import { startForwarder } from "../dist/forwarder.js";

// A local upstream that serves: /plain (identity), /gzip (gzip), /br (brotli), /sse (streamed events),
// /redir (302 to /plain), /away (302 to another host), /weird (unknown content-encoding), /echo (POST body back).
const body = Buffer.from("x".repeat(5000) + JSON.stringify({ hello: "world", n: 1 }).repeat(400));
const upstream = http.createServer((req, res) => {
  if (req.url === "/plain") { res.writeHead(200, { "content-type": "application/json", "content-length": body.length }); res.end(body); }
  else if (req.url === "/gzip") { const z = zlib.gzipSync(body); res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": z.length }); res.end(z); }
  else if (req.url === "/br") { const z = zlib.brotliCompressSync(body); res.writeHead(200, { "content-type": "application/json", "content-encoding": "br", "content-length": z.length }); res.end(z); }
  else if (req.url === "/sse") { res.writeHead(200, { "content-type": "text/event-stream" }); let i = 0; const t = setInterval(() => { res.write(`data: {"tick":${i++}}\n\n`); if (i === 5) { clearInterval(t); res.end(); } }, 30); }
  else if (req.url === "/redir") { res.writeHead(302, { location: "/plain" }); res.end(); }
  else if (req.url === "/away") { res.writeHead(302, { location: "https://elsewhere.invalid/x" }); res.end(); }
  else if (req.url === "/weird") { res.writeHead(200, { "content-encoding": "zstd" }); res.end(body); }
  else if (req.url === "/echo" && req.method === "POST") { const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => { res.writeHead(200, { "content-type": req.headers["content-type"] || "application/octet-stream" }); res.end(Buffer.concat(chunks)); }); }
  else { res.writeHead(404); res.end("nope"); }
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const uport = upstream.address().port;
const UP = `http://localhost:${uport}`;

const meter = new Meter();
const fw = await startForwarder({ allow: ["localhost"], port: 0, meter, allowPrivate: true });
const F = `http://127.0.0.1:${fw.port}`;
after(async () => { await fw.close(); upstream.close(); });

const get = (path, opts = {}) => fetch(`${F}/${UP}${path}`, { redirect: "manual", ...opts });

test("plain body passes through byte-identical and is metered", async () => {
  const r = await get("/plain");
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), body);
  await new Promise((r) => setTimeout(r, 50));
  const s = meter.totals().find((s) => s.host === `localhost:${uport}`);
  assert.ok(s && s.decodedBytes >= body.length);
});

// raw GET without fetch's automatic decompression, so we can see exactly what came over the wire
function rawGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })); }).on("error", reject);
  });
}

test("gzip and brotli bodies pass through still compressed (byte-identical), metered decompressed", async () => {
  const before = meter.totals().find((s) => s.host === `localhost:${uport}`)?.repeatBytes ?? 0;
  for (const [path, compress] of [["/gzip", zlib.gzipSync], ["/br", zlib.brotliCompressSync]]) {
    const r = await rawGet(`${F}/${UP}${path}`);
    assert.equal(r.status, 200);
    assert.equal(r.headers["content-encoding"], path.slice(1), "content-encoding header preserved");
    assert.deepEqual(r.body, compress(body), `${path}: compressed bytes untouched`);
  }
  await new Promise((r) => setTimeout(r, 100));
  const s = meter.totals().find((s) => s.host === `localhost:${uport}`);
  assert.ok(s.repeatBytes - before >= body.length * 2 - 2 * 65536, "both deliveries were metered decompressed and seen as repeats of /plain");
});

test("SSE streams arrive progressively, not after the end", async () => {
  const r = await get("/sse");
  const reader = r.body.getReader();
  const t0 = Date.now(); const times = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; times.push(Date.now() - t0); void value; }
  assert.ok(times.length >= 2, "received more than one piece");
  assert.ok(times[times.length - 1] - times[0] >= 60, "pieces spread over time, so the stream was not buffered");
});

test("allowlisted redirect is rewritten back through the forwarder", async () => {
  const r = await get("/redir");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), `${F}/${UP}/plain`);
});

test("redirect off the allowlist passes unchanged and is recorded as unmeasured", async () => {
  const r = await get("/away");
  assert.equal(r.status, 302);
  assert.equal(r.headers.get("location"), "https://elsewhere.invalid/x");
  assert.ok(fw.unmeasured.some((u) => u.host === "elsewhere.invalid"));
});

test("unknown content-encoding passes through and is recorded as unmeasured", async () => {
  const r = await get("/weird");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-encoding"), "zstd");
  assert.ok(fw.unmeasured.some((u) => /zstd/.test(u.reason)));
});

test("POST bodies reach the upstream", async () => {
  const payload = JSON.stringify({ q: "hi".repeat(1000) });
  const r = await get("/echo", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
  assert.equal(await r.text(), payload);
});

test("non-allowlisted host is refused with 403", async () => {
  const r = await fetch(`${F}/https://example.com/`, { redirect: "manual" });
  assert.equal(r.status, 403);
  assert.match(await r.text(), /allowlist/);
});

test("bad path gives usage, not a crash", async () => {
  const r = await fetch(`${F}/not-a-url`);
  assert.equal(r.status, 400);
});
