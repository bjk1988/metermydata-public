// Generates deterministic test fixtures: test/vectors.json (chunk boundaries + fingerprints for
// seeded inputs) and test/fixtures/sample.har (two hosts, repeated and novel bodies), plus the
// expected report test/fixtures/sample.expected.json. Run after `npm run build`.
import fs from "node:fs";
import { chunkBytes, fingerprint, Meter, readHar, buildReport, CDC_V1 } from "../dist/engine.js";

function xorshift(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
function bytes(seed, n) { const r = xorshift(seed); const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = r() & 0xff; return b; }
// JSON-like text: repeated field names with random ids and numbers, like a real API response.
function text(seed, n) { const r = xorshift(seed); const keys = ["id", "object", "amount", "currency", "created", "status", "customer", "description", "metadata", "livemode"]; let s = "["; while (s.length < n) { s += `{"${keys[r() % keys.length]}":"${(r() >>> 0).toString(36)}","${keys[r() % keys.length]}":${r() % 100000},"${keys[r() % keys.length]}":${r() % 2 ? "true" : "false"}},`; } return s.slice(0, n); }

fs.mkdirSync("test/fixtures", { recursive: true });

// 1) vectors
const vectors = [];
for (const [seed, n] of [[1, 0], [2, 1], [3, 2047], [4, 2048], [5, 10000], [6, 65536], [7, 70000], [8, 250000]]) {
  const data = bytes(seed, n);
  const chunks = chunkBytes(data);
  vectors.push({ seed, length: n, chunks: await Promise.all(chunks.map(async (c) => ({ offset: c.offset, length: c.length, fp: await fingerprint(c.bytes) }))) });
}
// a text input too (low entropy)
{ const data = new TextEncoder().encode(text(99, 50000)); const chunks = chunkBytes(data); vectors.push({ seed: 99, text: true, length: data.length, chunks: await Promise.all(chunks.map(async (c) => ({ offset: c.offset, length: c.length, fp: await fingerprint(c.bytes) }))) }); }
fs.writeFileSync("test/vectors.json", JSON.stringify({ chunking: CDC_V1, generator: "xorshift32, bytes = x & 0xff; text = word list cycle", vectors }, null, 1));

// 2) HAR: host A polls the same body 10 times with a small changing field; host B gets fresh bodies.
const b64 = (u8) => Buffer.from(u8).toString("base64");
const entries = [];
const base = text(7, 60000);
for (let i = 0; i < 10; i++) {
  const body = base.slice(0, 1000) + `{"poll":${i},"ts":"2026-10-26T00:00:${String(i).padStart(2, "0")}Z"},` + base.slice(1000);
  entries.push({ startedDateTime: `2026-10-26T00:00:${String(i).padStart(2, "0")}.000Z`, request: { method: "GET", url: "https://api.poller.example/v1/dashboard" }, response: { status: 200, bodySize: Math.floor(body.length / 4), headers: [{ name: "content-type", value: "application/json" }, { name: "content-encoding", value: "gzip" }], content: { size: body.length, compression: body.length - Math.floor(body.length / 4), mimeType: "application/json", text: body } } });
}
for (let i = 0; i < 5; i++) {
  const body = bytes(100 + i, 40000);
  entries.push({ startedDateTime: `2026-10-26T00:01:${String(i).padStart(2, "0")}.000Z`, request: { method: "GET", url: `https://feed.fresh.example/blob/${i}` }, response: { status: 200, bodySize: body.length, headers: [{ name: "content-type", value: "application/octet-stream" }], content: { size: body.length, mimeType: "application/octet-stream", text: b64(body), encoding: "base64" } } });
}
// one entry with no body (should be skipped) and one redirect (skipped)
entries.push({ request: { method: "GET", url: "https://api.poller.example/v1/nobody" }, response: { status: 200, bodySize: -1, headers: [], content: { size: 0, mimeType: "text/plain" } } });
entries.push({ request: { method: "GET", url: "https://api.poller.example/old" }, response: { status: 301, bodySize: 0, headers: [{ name: "location", value: "/v1/dashboard" }], content: { size: 0, mimeType: "" } } });
const har = { log: { version: "1.2", creator: { name: "metermydata-fixture", version: "1" }, pages: [], entries } };
fs.writeFileSync("test/fixtures/sample.har", JSON.stringify(har));

// 3) expected report (generatedAt and history.to stripped by the test)
const read = readHar(har); const meter = new Meter();
for (const e of read.entries) await meter.meter(e);
const profiles = JSON.parse(fs.readFileSync("providers.json", "utf8"));
const report = buildReport({ toolVersion: "0.1.3", chunking: CDC_V1, sources: meter.totals(), stats: meter.store.stats(), profiles, input: { kind: "har", label: "sample.har", responses: read.entries.length, skipped: read.skipped.length }, history: { enabled: false } });
delete report.generatedAt;
fs.writeFileSync("test/fixtures/sample.expected.json", JSON.stringify(report, null, 1));
console.log("fixtures written: vectors", vectors.length, "| har entries", entries.length, "| report sources", report.sources.map((s) => `${s.host} ${s.repeatPct.toFixed(1)}%`).join(", "));
