import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkBytes, fingerprint, Meter, readHar, buildReport, CDC_V1, FingerprintStore, HostStore, hostMatches, fmtBytes } from "../dist/engine.js";

function xorshift(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
function bytes(seed, n) { const r = xorshift(seed); const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = r() & 0xff; return b; }

test("empty body: zero chunks, zero bytes, no crash", async () => {
  assert.deepEqual(chunkBytes(new Uint8Array(0)), []);
  const m = new Meter();
  const s = await m.meter({ host: "e.example", decoded: new Uint8Array(0) });
  assert.equal(s.responses, 1); assert.equal(s.decodedBytes, 0); assert.equal(s.repeatPct, 0);
});

test("sizes around the limits: 1, min-1, min, max, max+1, 2*max+1", () => {
  for (const n of [1, CDC_V1.minChunk - 1, CDC_V1.minChunk, CDC_V1.maxChunk, CDC_V1.maxChunk + 1, 2 * CDC_V1.maxChunk + 1]) {
    const chunks = chunkBytes(bytes(n, n));
    assert.equal(chunks.reduce((a, c) => a + c.length, 0), n, `total length ${n}`);
    assert.ok(chunks.every((c) => c.length <= CDC_V1.maxChunk), `max respected at ${n}`);
    assert.ok(chunks.slice(0, -1).every((c) => c.length >= CDC_V1.minChunk), `min respected at ${n}`);
    let off = 0; for (const c of chunks) { assert.equal(c.offset, off); off += c.length; }
  }
});

test("identical bytes give identical fingerprints; one bit flipped does not", async () => {
  const a = bytes(77, 5000), b = bytes(77, 5000); b[2500] ^= 1;
  assert.equal(await fingerprint(a), await fingerprint(bytes(77, 5000)));
  assert.notEqual(await fingerprint(a), await fingerprint(b));
  assert.match(await fingerprint(a), /^[0-9a-f]{64}:5000$/);
});

test("a 24 MiB body meters in bounded time and memory", async () => {
  const big = bytes(3, 24 * 1024 * 1024);
  const t0 = Date.now();
  const m = new Meter();
  const s = await m.meter({ host: "big.example", decoded: big });
  const s2 = await m.meter({ host: "big.example", decoded: big });
  const dt = Date.now() - t0;
  assert.equal(s.decodedBytes, big.length);
  assert.equal(s2.repeatBytes, big.length, "second delivery fully repeated");
  assert.ok(dt < 60000, `took ${dt} ms`);
  assert.ok(s.chunks > 2000 && s.chunks < 12000, `chunk count ${s.chunks} near 24 MiB / 8 KiB`);
});

test("one thousand hosts stay independent", async () => {
  const m = new Meter();
  const body = bytes(8, 3000);
  for (let i = 0; i < 1000; i++) await m.meter({ host: `h${i}.example`, decoded: body });
  assert.equal(m.totals().length, 1000);
  assert.ok(m.totals().every((s) => s.repeatBytes === 0));
});

test("cap and eviction are exact and oldest-first", () => {
  const h = new HostStore(5);
  for (let i = 0; i < 8; i++) assert.equal(h.seen(`fp${i}`), null);
  assert.deepEqual(h.stats(), { retained: 5, evicted: 3, cap: 5 });
  assert.deepEqual(h.entries(), ["fp3", "fp4", "fp5", "fp6", "fp7"]);
  assert.equal(h.seen("fp0"), null, "evicted entry is new again");
  assert.equal(h.seen("fp7"), "run");
});

test("history dump and load round-trip exactly", async () => {
  const m = new Meter();
  await m.meter({ host: "a.example", decoded: bytes(1, 30000) });
  await m.meter({ host: "b.example", decoded: bytes(2, 30000) });
  const dump = m.store.dump();
  const s2 = new FingerprintStore();
  s2.loadHistory(dump);
  assert.deepEqual(s2.dump(), dump);
  const m2 = new Meter(CDC_V1, s2);
  const r = await m2.meter({ host: "a.example", decoded: bytes(1, 30000) });
  assert.equal(r.historyRepeatBytes, 30000); assert.equal(r.inRunRepeatBytes, 0);
});

test("host patterns", () => {
  assert.ok(hostMatches("api.stripe.com", "api.stripe.com"));
  assert.ok(hostMatches("x.s3.amazonaws.com", "*.amazonaws.com"));
  assert.ok(hostMatches("amazonaws.com", "*.amazonaws.com"));
  assert.ok(!hostMatches("evilamazonaws.com", "*.amazonaws.com"));
  assert.ok(!hostMatches("api.stripe.com.evil", "api.stripe.com"));
});

test("fmtBytes", () => {
  assert.equal(fmtBytes(0), "0 B"); assert.equal(fmtBytes(1023), "1023 B"); assert.equal(fmtBytes(1024), "1.00 KB");
  assert.equal(fmtBytes(10 * 1024 * 1024), "10.0 MB"); assert.equal(fmtBytes(1.5e12), "1.36 TB");
});

const mkHar = (entries) => ({ log: { version: "1.2", creator: { name: "t", version: "1" }, entries } });
const E = (over) => ({ request: { method: "GET", url: "https://h.example/x" }, response: { status: 200, bodySize: -1, headers: [], content: { size: 5, mimeType: "text/plain", text: "hello" } }, ...over });

test("HAR variants: Firefox-style bodySize, Chrome compression, negative compression, base64, 304, status 0, bad URL, no log", () => {
  const r = readHar(mkHar([
    E({ response: { status: 200, bodySize: 3, headers: [], content: { size: 5, text: "hello" } } }),                        // observed 3
    E({ response: { status: 200, bodySize: -1, headers: [], content: { size: 5, compression: 2, text: "hello" } } }),       // estimated 3
    E({ response: { status: 200, bodySize: -1, headers: [], content: { size: 5, compression: -1, text: "hello" } } }),      // unavailable
    E({ response: { status: 200, bodySize: 0, headers: [], content: { size: 5, text: "aGVsbG8=", encoding: "base64" } } }), // base64 -> hello, unavailable
    E({ response: { status: 304, bodySize: 0, headers: [], content: { size: 0 } } }),
    E({ response: { status: 0, bodySize: -1, headers: [], content: {} } }),
    E({ request: { method: "GET", url: "not a url" } }),
    E({ response: { status: 200, bodySize: -1, headers: [], content: { size: 0, mimeType: "text/plain" } } }),             // no text
  ]));
  assert.equal(r.entries.length, 4);
  assert.deepEqual(r.entries.map((e) => e.wire), [{ value: 3, status: "observed" }, { value: 3, status: "estimated" }, { value: 0, status: "unavailable" }, { value: 0, status: "unavailable" }]);
  assert.equal(new TextDecoder().decode(r.entries[3].decoded), "hello");
  assert.deepEqual(r.skipped.map((s) => s.reason), ["status 304", "status 0", "unparseable URL", "no body in HAR (export with content)"]);
  assert.throws(() => readHar({}), /Not a HAR/);
  assert.throws(() => readHar(null), /Not a HAR/);
});

test("report totals: wire status rolls up to the weakest and dollars sum only confirmed rows", async () => {
  const m = new Meter();
  const body = bytes(4, 20000);
  await m.meter({ host: "hist.databento.com", decoded: body, wire: { value: 9000, status: "observed" } });
  await m.meter({ host: "hist.databento.com", decoded: body, wire: { value: 9000, status: "observed" } });
  await m.meter({ host: "x.s3.amazonaws.com", decoded: body, wire: { value: 0, status: "unavailable" } });
  await m.meter({ host: "x.s3.amazonaws.com", decoded: body, wire: { value: 0, status: "unavailable" } });
  const profiles = JSON.parse((await import("node:fs")).readFileSync(new URL("../providers.json", import.meta.url), "utf8"));
  const r = buildReport({ toolVersion: "t", chunking: CDC_V1, sources: m.totals(), stats: m.store.stats(), profiles, input: { kind: "har", label: "x", responses: 4, skipped: 0 }, history: { enabled: false },
    billing: [{ host: "hist.databento.com", rateUsdPerGb: 1000, confirmed: true }, { host: "x.s3.amazonaws.com", rateUsdPerGb: 0.09, confirmed: true }] });
  assert.equal(r.totals.wireStatus, "unavailable");
  const d = r.sources.find((s) => s.host === "hist.databento.com"), s3 = r.sources.find((s) => s.host === "x.s3.amazonaws.com");
  assert.ok(Math.abs(d.estimatedRepeatUsd - (20000 / 1e9) * 1000) < 1e-9);
  assert.equal(s3.basis, "encoded-bytes");
  assert.equal(s3.billableRepeatStatus, "unavailable", "encoded basis with no wire bytes gives no billable figure");
  assert.equal(s3.estimatedRepeatUsd, undefined);
  assert.ok(Math.abs(r.totals.estimatedRepeatUsd - d.estimatedRepeatUsd) < 1e-12);
});
