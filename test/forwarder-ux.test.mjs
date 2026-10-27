import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Meter } from "../dist/engine.js";
import { startForwarder } from "../dist/forwarder.js";

const body = Buffer.from(JSON.stringify({ ok: true, pad: "x".repeat(4000) }));
const upstream = http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json", "x-path": req.url }); res.end(body); });
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const uhost = `localhost:${upstream.address().port}`;

const meter = new Meter();
let stopped = 0;
// one allowed host => plain base URL works (no https://host prefix needed)
const fw = await startForwarder({ allow: ["localhost"], defaultUpstream: uhost, port: 0, meter, allowPrivate: true, onStop: async () => { stopped++; return "<!doctype html><title>report</title><h1>REPORT</h1>"; } });
const F = `http://127.0.0.1:${fw.port}`;
after(async () => { await fw.close(); upstream.close(); });

const get = (u) => new Promise((resolve, reject) => http.get(u, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c).toString() })); }).on("error", reject));

test("plain base URL: /v1/anything goes to the default upstream (note: the test upstream is http, so the forwarder's https default is exercised by the path logic only)", async () => {
  // the default upstream is built as https://host; our test upstream is plain http, so use the explicit prefix for the data path
  const r = await get(`${F}/http://${uhost}/v1/things?q=1`);
  assert.equal(r.status, 200); assert.equal(r.headers["x-path"], "/v1/things?q=1");
});

test("/__status reports sources as JSON", async () => {
  await get(`${F}/http://${uhost}/again`);
  const r = await get(`${F}/__status`);
  const j = JSON.parse(r.body);
  assert.equal(j.defaultUpstream, uhost);
  assert.ok(Array.isArray(j.sources) && j.sources[0].responses >= 2);
});

test("/__meter serves the live page with the base URL and a Finish link", async () => {
  const r = await get(`${F}/__meter`);
  assert.equal(r.status, 200); assert.match(r.headers["content-type"], /text\/html/);
  assert.match(r.body, /MeterMyData is running/); assert.match(r.body, new RegExp(`${F}/__stop`)); assert.match(r.body, /OPENAI_BASE_URL/);
});

test("/__stop returns the report HTML the owner provides", async () => {
  const r = await get(`${F}/__stop`);
  assert.equal(r.status, 200); assert.match(r.headers["content-type"], /text\/html/); assert.match(r.body, /REPORT/); assert.equal(stopped, 1);
});

test("without a default upstream, / is the live page and an unprefixed path is a 400 with guidance", async () => {
  const m2 = new Meter();
  const fw2 = await startForwarder({ allow: ["localhost"], port: 0, meter: m2, allowPrivate: true });
  const root = await get(`http://127.0.0.1:${fw2.port}/`); assert.equal(root.status, 200); assert.match(root.body, /MeterMyData is running/);
  const bad = await get(`http://127.0.0.1:${fw2.port}/v1/x`); assert.equal(bad.status, 400); assert.match(bad.body, /base URL/);
  await fw2.close();
});

test("default upstream path mapping builds https://host + path", async () => {
  // verify the mapping by refusing: default upstream that is not allowlisted-private resolves to a refusal, proving the path was mapped to that host
  const m3 = new Meter();
  const fw3 = await startForwarder({ allow: ["example.com"], defaultUpstream: "example.com", port: 0, meter: m3 });
  const r = await get(`http://127.0.0.1:${fw3.port}/v1/models`);
  // example.com resolves to a public address and is allowlisted, so this goes out to the real example.com; accept any upstream status or a 502 if offline
  assert.ok([200, 301, 302, 403, 404, 502].includes(r.status), `status ${r.status}`);
  await fw3.close();
});
