import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Meter } from "../dist/engine.js";
import { startForwarder } from "../dist/forwarder.js";

function xorshift(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
function bytes(seed, n) { const r = xorshift(seed); const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = r() & 0xff; return b; }
const BIG = bytes(1, 32 * 1024 * 1024);

const upstream = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/big-chunked") { res.writeHead(200, { "content-type": "application/octet-stream" }); let i = 0; const step = 256 * 1024; const w = () => { while (i < BIG.length) { const ok = res.write(BIG.subarray(i, i + step)); i += step; if (!ok) { res.once("drain", w); return; } } res.end(); }; w(); }
  else if (u.pathname === "/big-gzip-chunked") { res.writeHead(200, { "content-type": "application/octet-stream", "content-encoding": "gzip" }); const z = zlib.createGzip(); z.pipe(res); z.end(BIG.subarray(0, 8 * 1024 * 1024)); }
  else if (u.pathname === "/head") { res.writeHead(200, { "content-length": "12345", "x-head": "yes" }); res.end(); }
  else if (u.pathname === "/204") { res.writeHead(204); res.end(); }
  else if (u.pathname === "/500") { res.writeHead(500, { "content-type": "text/plain" }); res.end("server broke"); }
  else if (u.pathname === "/404") { res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"nope"}'); }
  else if (u.pathname === "/echo-headers") { res.writeHead(200, { "content-type": "application/json", etag: '"abc"', "x-custom": "kept", "set-cookie": ["a=1", "b=2"] }); res.end(JSON.stringify({ headers: req.headers, url: req.url, method: req.method })); }
  else if (u.pathname === "/slow") { res.writeHead(200, { "content-type": "text/plain" }); let n = 0; const t = setInterval(() => { res.write("tick\n"); if (++n === 10) { clearInterval(t); res.end(); } }, 25); }
  else if (u.pathname === "/forever") { res.writeHead(200, { "content-type": "text/plain" }); const t = setInterval(() => res.write("x".repeat(1024)), 10); req.on("close", () => clearInterval(t)); }
  else if (u.pathname.startsWith("/uni/")) { res.writeHead(200, { "content-type": "text/plain; charset=utf-8" }); res.end(`path=${decodeURIComponent(u.pathname)} q=${u.search}`); }
  else { res.writeHead(404); res.end(); }
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const UP = `http://localhost:${upstream.address().port}`;
const meter = new Meter();
const fw = await startForwarder({ allow: ["localhost"], port: 0, meter, allowPrivate: true });
const F = `http://127.0.0.1:${fw.port}`;
after(async () => { await fw.close(); upstream.close(); });

function raw(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: opts.method || "GET", headers: opts.headers || {} }, (res) => { const chunks = []; let first; res.on("data", (c) => { if (!first) first = Date.now(); chunks.push(c); }); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), first })); });
    req.on("error", reject); if (opts.body) req.write(opts.body); req.end();
  });
}

test("32 MiB chunked (no content-length) streams through byte-identical and is metered", async () => {
  const t0 = Date.now();
  const r = await raw(`${F}/${UP}/big-chunked`);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, BIG.length);
  assert.ok(r.body.equals(BIG));
  assert.ok(r.first - t0 < 2000, "first byte arrived before the whole body was read");
  await new Promise((r) => setTimeout(r, 200));
  const s = meter.totals().find((s) => s.host.startsWith("localhost"));
  assert.ok(s.decodedBytes >= BIG.length);
});

test("8 MiB gzip chunked passes compressed and meters decompressed as a repeat of the first 8 MiB", async () => {
  const r = await raw(`${F}/${UP}/big-gzip-chunked`);
  assert.equal(r.headers["content-encoding"], "gzip");
  assert.ok(zlib.gunzipSync(r.body).equals(BIG.subarray(0, 8 * 1024 * 1024)));
  await new Promise((r) => setTimeout(r, 300));
  const s = meter.totals().find((s) => s.host.startsWith("localhost"));
  assert.ok(s.repeatBytes >= 8 * 1024 * 1024 - 2 * 65536, `repeat ${s.repeatBytes}`);
});

test("HEAD, 204, 404 and 500 pass through with status, headers and bodies intact", async () => {
  const h = await raw(`${F}/${UP}/head`, { method: "HEAD" });
  assert.equal(h.status, 200); assert.equal(h.headers["x-head"], "yes"); assert.equal(h.body.length, 0);
  const n = await raw(`${F}/${UP}/204`); assert.equal(n.status, 204); assert.equal(n.body.length, 0);
  const e = await raw(`${F}/${UP}/500`); assert.equal(e.status, 500); assert.equal(e.body.toString(), "server broke");
  const f = await raw(`${F}/${UP}/404`); assert.equal(f.status, 404); assert.equal(JSON.parse(f.body.toString()).error, "nope");
});

test("request headers are forwarded (authorization kept, host rewritten); response headers kept incl. multiple set-cookie", async () => {
  const r = await raw(`${F}/${UP}/echo-headers?a=1&b=two%20words`, { method: "POST", headers: { authorization: "Bearer sk-test-123", "x-api-key": "k", "content-type": "application/json", "user-agent": "mmd-test" }, body: "{}" });
  const j = JSON.parse(r.body.toString());
  assert.equal(j.headers.authorization, "Bearer sk-test-123");
  assert.equal(j.headers["x-api-key"], "k");
  assert.equal(j.headers.host, `localhost:${upstream.address().port}`, "host header points at the upstream");
  assert.equal(j.url, "/echo-headers?a=1&b=two%20words");
  assert.equal(j.method, "POST");
  assert.equal(r.headers.etag, '"abc"'); assert.equal(r.headers["x-custom"], "kept");
  assert.deepEqual(r.headers["set-cookie"], ["a=1", "b=2"]);
});

test("unicode and encoded paths survive", async () => {
  const r = await raw(`${F}/${UP}/uni/caf%C3%A9/%E6%97%A5%E6%9C%AC?x=%2Fy&z=1`);
  assert.equal(r.status, 200);
  assert.equal(r.body.toString("utf8"), "path=/uni/café/日本 q=?x=%2Fy&z=1");
});

test("50 concurrent requests all complete correctly", async () => {
  const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => raw(`${F}/${UP}/uni/n${i}`)));
  rs.forEach((r, i) => { assert.equal(r.status, 200); assert.equal(r.body.toString(), `path=/uni/n${i} q=`); });
});

test("slow upstream is streamed as it arrives", async () => {
  const t0 = Date.now();
  const r = await raw(`${F}/${UP}/slow`);
  assert.equal(r.body.toString(), "tick\n".repeat(10));
  assert.ok(r.first - t0 < 150, "first tick arrived early");
});

test("client abort mid-stream does not crash the forwarder and the next request works", async () => {
  await new Promise((resolve) => {
    const req = http.get(`${F}/${UP}/forever`, (res) => { res.once("data", () => { req.destroy(); resolve(); }); });
  });
  await new Promise((r) => setTimeout(r, 100));
  const r = await raw(`${F}/${UP}/uni/after-abort`);
  assert.equal(r.status, 200);
});

test("upstream connection refused gives 502, not a hang", async () => {
  const r = await raw(`${F}/http://localhost:1/x`);
  assert.equal(r.status, 502);
  assert.match(r.body.toString(), /upstream error/);
});

test("an upstream that resolves to a private address is refused unless allowPrivate", async () => {
  const m2 = new Meter();
  const strict = await startForwarder({ allow: ["localhost"], port: 0, meter: m2 });
  const r = await raw(`http://127.0.0.1:${strict.port}/${UP}/uni/x`);
  assert.equal(r.status, 403); assert.match(r.body.toString(), /private or loopback/);
  await strict.close();
});

test("busy port is reported, not swallowed", async () => {
  const blocker = net.createServer(); await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
  const port = blocker.address().port;
  await assert.rejects(startForwarder({ allow: ["localhost"], port, meter: new Meter() }), /EADDRINUSE/);
  blocker.close();
});

test("HTTP_PROXY is honoured for the upstream hop (CLI child process)", async () => {
  // a minimal proxy: undici tunnels every proxied request with CONNECT, so implement the tunnel
  let seen = [];
  const proxy = http.createServer((req, res) => { seen.push(req.url); res.writeHead(400); res.end(); });
  proxy.on("connect", (req, socket, head) => {
    seen.push(`CONNECT ${req.url}`);
    const [host, port] = req.url.split(":");
    const s = net.connect(Number(port), host, () => { socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) s.write(head); s.pipe(socket); socket.pipe(s); });
    s.on("error", () => socket.destroy()); socket.on("error", () => s.destroy());
  });
  await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
  const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
  const child = spawn(process.execPath, [cli, "--allow", "localhost", "--port", "0", "--no-open"], { env: { ...process.env, HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}`, MMD_ALLOW_PRIVATE: "1", NO_PROXY: "" }, stdio: ["ignore", "pipe", "pipe"] });
  let out = ""; child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { out += d; });
  const port = await new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error("forwarder did not start: " + out)), 15000); const h = () => { const m = /127\.0\.0\.1:(\d+)\//.exec(out); if (m) { clearTimeout(t); resolve(Number(m[1])); } else setTimeout(h, 50); }; h(); });
  const r = await raw(`http://127.0.0.1:${port}/${UP}/uni/viaproxy`);
  assert.equal(r.status, 200); assert.equal(r.body.toString(), "path=/uni/viaproxy q=");
  assert.ok(seen.some((u) => u.startsWith("CONNECT localhost:")), `proxy saw the tunnel request (${seen.join(", ")})`);
  await raw(`http://127.0.0.1:${port}/__stop`);
  await new Promise((r) => child.on("exit", r));
  assert.match(out, /received was a repeat|0 responses|received/);
  proxy.close();
});
