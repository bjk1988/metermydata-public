import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Meter, readHar, buildReport, CDC_V1, buildSharePayload, validateSharePayload, isPrivateHost, SHARE_SCHEMA } from "../dist/engine.js";

const har = JSON.parse(fs.readFileSync(new URL("./fixtures/sample.har", import.meta.url), "utf8"));
const profiles = JSON.parse(fs.readFileSync(new URL("../providers.json", import.meta.url), "utf8"));

async function report(extraHosts = []) {
  const read = readHar(har);
  const m = new Meter();
  for (const e of read.entries) await m.meter(e);
  for (const h of extraHosts) await m.meter({ host: h, decoded: new Uint8Array(5000).fill(1) });
  return buildReport({ toolVersion: "0.1.3", chunking: CDC_V1, sources: m.totals(), stats: m.store.stats(), profiles, input: { kind: "har", label: "x", responses: read.entries.length, skipped: 0 }, history: { enabled: false } });
}

test("private, local and example hosts are never shareable", () => {
  for (const h of ["localhost", "localhost:7777", "127.0.0.1", "10.1.2.3", "192.168.1.5:8080", "172.16.0.1", "api.poller.example", "feed.fresh.example", "box.local", "local-files", "::1", "[::1]:80", "not a host", "x"]) assert.ok(isPrivateHost(h), h);
  for (const h of ["api.stripe.com", "hist.databento.com", "mybucket.s3.amazonaws.com", "api.github.com:443"]) assert.ok(!isPrivateHost(h), h);
});

test("the fixture report (example hosts only) yields no payload; real hosts yield only aggregates", async () => {
  assert.equal(buildSharePayload(await report(), "cli"), null, "example hosts are dropped, nothing to share");
  const r = await report(["api.stripe.com", "api.stripe.com", "hist.databento.com"]);
  const p = buildSharePayload(r, "browser");
  assert.ok(p); assert.equal(p.schema, SHARE_SCHEMA); assert.equal(p.client, "browser");
  assert.deepEqual(p.sources.map((s) => s.host).sort(), ["api.stripe.com", "hist.databento.com"]);
  const stripe = p.sources.find((s) => s.host === "api.stripe.com");
  assert.equal(stripe.responses, 2); assert.equal(stripe.repeatBytes, 5000); assert.equal(stripe.provider, "Stripe API"); assert.equal(stripe.basis, "transactions");
  const text = JSON.stringify(p);
  assert.ok(!/url|http|@|sk_|Bearer|body/i.test(text), "payload carries no URLs, emails, keys or bodies");
  assert.equal(validateSharePayload(p), null);
});

test("validation rejects every malformed shape the endpoint must refuse", async () => {
  const good = buildSharePayload(await report(["api.stripe.com"]), "cli");
  const bad = (mut) => { const c = JSON.parse(JSON.stringify(good)); mut(c); return validateSharePayload(c); };
  assert.equal(validateSharePayload(null), "not an object");
  assert.equal(bad((c) => { c.schema = "x"; }), "unknown schema");
  assert.equal(bad((c) => { c.tool.name = "other"; }), "bad tool");
  assert.equal(bad((c) => { c.chunking.id = "evil"; }), "bad chunking id");
  assert.equal(bad((c) => { c.client = "bot"; }), "bad client");
  assert.equal(bad((c) => { c.sources = []; }), "bad sources");
  assert.equal(bad((c) => { c.sources[0].host = "127.0.0.1"; }), "bad host");
  assert.equal(bad((c) => { c.sources[0].repeatBytes = c.sources[0].decodedBytes + 1; }), "repeat exceeds received");
  assert.equal(bad((c) => { c.sources[0].repeatPct = 101; }), "bad repeatPct");
  assert.equal(bad((c) => { c.sources[0].decodedBytes = -1; }), "bad decodedBytes");
  assert.equal(bad((c) => { c.sources[0].wireStatus = "guess"; }), "bad wireStatus");
  assert.equal(bad((c) => { c.sources[0].url = "https://x"; }), "unexpected field url");
  assert.equal(bad((c) => { c.email = "a@b.co"; }), "unexpected field email");
  assert.equal(bad((c) => { c.sources = Array.from({ length: 51 }, () => c.sources[0]); }), "bad sources");
  assert.equal(bad((c) => { c.sources[0].provider = "x".repeat(81); }), "bad provider");
  assert.equal(bad((c) => { c.dryRun = true; }), null, "dryRun is allowed");
});
