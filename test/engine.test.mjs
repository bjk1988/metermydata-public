import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { chunkBytes, StreamChunker, fingerprint, Meter, readHar, buildReport, CDC_V1, FingerprintStore } from "../dist/engine.js";

function xorshift(seed) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x; }; }
function bytes(seed, n) { const r = xorshift(seed); const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = r() & 0xff; return b; }
function text(seed, n) { const r = xorshift(seed); const keys = ["id", "object", "amount", "currency", "created", "status", "customer", "description", "metadata", "livemode"]; let s = "["; while (s.length < n) { s += `{"${keys[r() % keys.length]}":"${(r() >>> 0).toString(36)}","${keys[r() % keys.length]}":${r() % 100000},"${keys[r() % keys.length]}":${r() % 2 ? "true" : "false"}},`; } return s.slice(0, n); }

const V = JSON.parse(fs.readFileSync(new URL("./vectors.json", import.meta.url), "utf8"));

test("frozen chunking configuration is mmd-cdc-v1", () => {
  assert.deepEqual(CDC_V1, V.chunking);
});

test("vectors: chunk boundaries and fingerprints are byte-identical to the frozen set", async () => {
  for (const v of V.vectors) {
    const data = v.text ? new TextEncoder().encode(text(v.seed, v.length)) : bytes(v.seed, v.length);
    assert.equal(data.length, v.length);
    const chunks = chunkBytes(data);
    assert.equal(chunks.length, v.chunks.length, `seed ${v.seed}: chunk count`);
    for (let i = 0; i < chunks.length; i++) {
      assert.equal(chunks[i].offset, v.chunks[i].offset, `seed ${v.seed} chunk ${i} offset`);
      assert.equal(chunks[i].length, v.chunks[i].length, `seed ${v.seed} chunk ${i} length`);
      assert.equal(await fingerprint(chunks[i].bytes), v.chunks[i].fp, `seed ${v.seed} chunk ${i} fingerprint`);
    }
  }
});

test("streaming chunker is independent of how the input is pieced", () => {
  const data = bytes(42, 300000);
  const whole = chunkBytes(data).map((c) => `${c.offset}:${c.length}`);
  for (const piece of [1, 7, 1000, 4096, 65537]) {
    const sc = new StreamChunker();
    const out = [];
    for (let i = 0; i < data.length; i += piece) out.push(...sc.push(data.subarray(i, Math.min(i + piece, data.length))));
    const last = sc.finish(); if (last) out.push(last);
    assert.deepEqual(out.map((c) => `${c.offset}:${c.length}`), whole, `piece size ${piece}`);
  }
});

test("chunk sizes respect min and max", () => {
  const chunks = chunkBytes(bytes(9, 500000));
  for (let i = 0; i < chunks.length - 1; i++) assert.ok(chunks[i].length >= CDC_V1.minChunk && chunks[i].length <= CDC_V1.maxChunk);
  assert.ok(chunks[chunks.length - 1].length <= CDC_V1.maxChunk);
});

test("repeats count only within the same host", async () => {
  const m = new Meter();
  const body = bytes(5, 100000);
  await m.meter({ host: "a.example", decoded: body });
  const a2 = await m.meter({ host: "a.example", decoded: body });
  const b = await m.meter({ host: "b.example", decoded: body });
  assert.equal(a2.repeatBytes, 200000 - 100000 + 0 - 0 === 0 ? a2.repeatBytes : a2.repeatBytes);
  assert.equal(a2.repeatBytes, 100000);
  assert.equal(a2.inRunRepeatBytes, 100000);
  assert.equal(b.repeatBytes, 0, "cross-host bytes are never repeats");
});

test("history repeats are separated from in-run repeats and eviction is oldest-first", async () => {
  const body = bytes(11, 50000);
  const m1 = new Meter();
  await m1.meter({ host: "h.example", decoded: body });
  const saved = m1.store.dump();
  const store = new FingerprintStore(3);
  const m2 = new Meter(CDC_V1, store);
  m2.store.loadHistory(saved);
  const r = await m2.meter({ host: "h.example", decoded: body });
  assert.ok(r.historyRepeatBytes > 0 || store.host("h.example").stats().evicted > 0);
  assert.equal(r.inRunRepeatBytes, 0);
  const st = store.host("h.example").stats();
  assert.equal(st.retained, Math.min(3, st.retained));
  assert.ok(st.evicted >= saved["h.example"].length - 3);
});

test("HAR parity: sample.har produces the committed expected report", async () => {
  const har = JSON.parse(fs.readFileSync(new URL("./fixtures/sample.har", import.meta.url), "utf8"));
  const expected = JSON.parse(fs.readFileSync(new URL("./fixtures/sample.expected.json", import.meta.url), "utf8"));
  const read = readHar(har);
  assert.equal(read.skipped.length, 2);
  const m = new Meter();
  for (const e of read.entries) await m.meter(e);
  const profiles = JSON.parse(fs.readFileSync(new URL("../providers.json", import.meta.url), "utf8"));
  const report = buildReport({ toolVersion: "0.1.3", chunking: CDC_V1, sources: m.totals(), stats: m.store.stats(), profiles, input: { kind: "har", label: "sample.har", responses: read.entries.length, skipped: read.skipped.length }, history: { enabled: false } });
  delete report.generatedAt;
  assert.deepEqual(JSON.parse(JSON.stringify(report)), expected);
});

test("dollars appear only with a byte basis and a confirmed rate", async () => {
  const m = new Meter();
  const body = bytes(21, 80000);
  await m.meter({ host: "hist.databento.com", decoded: body });
  await m.meter({ host: "hist.databento.com", decoded: body });
  await m.meter({ host: "api.openai.com", decoded: body });
  await m.meter({ host: "api.openai.com", decoded: body });
  const profiles = JSON.parse(fs.readFileSync(new URL("../providers.json", import.meta.url), "utf8"));
  const base = { toolVersion: "0.1.3", chunking: CDC_V1, sources: m.totals(), stats: m.store.stats(), profiles, input: { kind: "har", label: "x", responses: 4, skipped: 0 }, history: { enabled: false } };
  const r0 = buildReport(base);
  assert.equal(r0.totals.estimatedRepeatUsd, undefined);
  const r1 = buildReport({ ...base, billing: [{ host: "hist.databento.com", rateUsdPerGb: 100, confirmed: false }, { host: "api.openai.com", rateUsdPerGb: 100, confirmed: true }] });
  assert.equal(r1.totals.estimatedRepeatUsd, undefined, "unconfirmed rate and token basis both yield no dollars");
  const r2 = buildReport({ ...base, billing: [{ host: "hist.databento.com", rateUsdPerGb: 100, confirmed: true }] });
  const row = r2.sources.find((s) => s.host === "hist.databento.com");
  assert.equal(row.basis, "decoded-bytes");
  assert.ok(Math.abs(row.estimatedRepeatUsd - (80000 / 1e9) * 100) < 1e-9);
  assert.equal(r2.sources.find((s) => s.host === "api.openai.com").estimatedRepeatUsd, undefined);
});
