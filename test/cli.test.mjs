import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, "..", "dist", "cli.js");
const har = path.join(here, "fixtures", "sample.har");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mmd cli test ")); // a space in the path on purpose
const homeEnv = { ...process.env, HOME: tmp, USERPROFILE: tmp, MMD_ALLOW_PRIVATE: "1" };
const run = (args, env = homeEnv) => { const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env }); return { code: r.status, out: r.stdout + r.stderr }; };

test("--version and --help", () => {
  assert.equal(run(["--version"]).out.trim(), "0.1.3");
  const h = run(["--help"]); assert.equal(h.code, 0); assert.match(h.out, /npx metermydata --allow/);
});

test("forwarder without --allow refuses with the example", () => {
  const r = run([]); assert.equal(r.code, 2); assert.match(r.out, /talks only to hosts you name/);
});

test("har: report files land under the home directory, --json writes a copy, numbers match the fixture", () => {
  const outJson = path.join(tmp, "out one.json");
  const r = run(["har", har, "--no-open", "--json", outJson]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /56\.1% of 782 KB received was a repeat/);
  const j = JSON.parse(fs.readFileSync(outJson, "utf8"));
  assert.equal(j.schema, "metermydata-report/1");
  assert.equal(j.sources.length, 2);
  const reports = fs.readdirSync(path.join(tmp, ".metermydata", "reports"));
  assert.ok(reports.some((f) => f.endsWith(".html")) && reports.some((f) => f.endsWith(".json")));
  const html = fs.readFileSync(path.join(tmp, ".metermydata", "reports", reports.find((f) => f.endsWith(".html"))), "utf8");
  assert.match(html, /window\.__MMD__=/); assert.match(html, /metermydata\.com\/#waitlist/);
});

test("har: --history finds repeats on the second run and the history file is capped and versioned", () => {
  const r1 = run(["har", har, "--no-open", "--history", "--json", path.join(tmp, "h1.json")]);
  assert.equal(r1.code, 0, r1.out);
  const hist = JSON.parse(fs.readFileSync(path.join(tmp, ".metermydata", "history.json"), "utf8"));
  assert.equal(hist.version, 1); assert.equal(hist.chunking, "mmd-cdc-v1"); assert.ok(hist.hosts["api.poller.example"].length > 0);
  const r2 = run(["har", har, "--no-open", "--history", "--json", path.join(tmp, "h2.json")]);
  const j1 = JSON.parse(fs.readFileSync(path.join(tmp, "h1.json"), "utf8")), j2 = JSON.parse(fs.readFileSync(path.join(tmp, "h2.json"), "utf8"));
  assert.equal(j1.totals.historyRepeatBytes, 0);
  assert.equal(j2.totals.historyRepeatBytes + j2.totals.inRunRepeatBytes, j2.totals.decodedBytes, "second run: everything is a repeat");
  assert.ok(j2.totals.historyRepeatBytes > j1.totals.repeatBytes);
  assert.equal(j2.history.enabled, true); assert.ok(j2.history.from);
});

test("har: --rate on a byte-billed host yields a dollar estimate; on a token host it does not", () => {
  const h = JSON.parse(fs.readFileSync(har, "utf8"));
  h.log.entries.forEach((e, i) => { e.request.url = e.request.url.replace("api.poller.example", i % 2 ? "hist.databento.com" : "api.openai.com"); });
  const f = path.join(tmp, "rated.har"); fs.writeFileSync(f, JSON.stringify(h));
  const r = run(["har", f, "--no-open", "--rate", "hist.databento.com=250", "--rate", "api.openai.com=250", "--json", path.join(tmp, "rated.json")]);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(fs.readFileSync(path.join(tmp, "rated.json"), "utf8"));
  const d = j.sources.find((s) => s.host === "hist.databento.com"), o = j.sources.find((s) => s.host === "api.openai.com");
  assert.ok(d.estimatedRepeatUsd >= 0 && d.rateUsdPerGb === 250);
  assert.equal(o.estimatedRepeatUsd, undefined); assert.equal(o.basis, "tokens");
});

test("dir: files with spaces and unicode names, nested folders, --host", () => {
  const d = path.join(tmp, "resp dir"); fs.mkdirSync(path.join(d, "sub dir"), { recursive: true });
  const body = Buffer.alloc(50000, 7);
  fs.writeFileSync(path.join(d, "first file.bin"), body); fs.writeFileSync(path.join(d, "sub dir", "zweite-datei-ß-日本.bin"), body); fs.writeFileSync(path.join(d, "empty.bin"), Buffer.alloc(0));
  const r = run(["dir", d, "--host", "feed.example", "--no-open", "--json", path.join(tmp, "dir.json")]);
  assert.equal(r.code, 0, r.out);
  const j = JSON.parse(fs.readFileSync(path.join(tmp, "dir.json"), "utf8"));
  assert.equal(j.input.responses, 3); assert.equal(j.sources[0].host, "feed.example");
  assert.equal(j.totals.repeatBytes, 50000, "the second identical file is a repeat");
});

test("report: regenerates HTML from a JSON report", () => {
  const src = path.join(tmp, "out one.json");
  const r = run(["report", src, "--no-open"]); assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(path.join(tmp, "out one.html")));
});

test("errors are messages, not stack traces: missing file, not-a-HAR, bad command", () => {
  const a = run(["har", path.join(tmp, "nope.har"), "--no-open"]); assert.notEqual(a.code, 0); assert.doesNotMatch(a.out, /at .*\.js:\d+/);
  fs.writeFileSync(path.join(tmp, "bad.har"), "{}");
  const b = run(["har", path.join(tmp, "bad.har"), "--no-open"]); assert.notEqual(b.code, 0); assert.match(b.out, /Not a HAR/);
  const c = run(["har"]); assert.equal(c.code, 2);
});

test("guided start (wizard) meters a HAR from typed answers", () => {
  const r = spawnSync(process.execPath, [cli, "--no-open", "--json", path.join(tmp, "wiz.json")], { encoding: "utf8", env: { ...homeEnv, MMD_WIZARD: "1" }, input: `2\n"${har}"\n` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /What do you want to meter\?/);
  assert.match(r.stdout, /56\.1% of 782 KB received was a repeat/);
  assert.ok(fs.existsSync(path.join(tmp, "wiz.json")));
});

test("guided start (wizard) meters a folder from typed answers, with a host label", () => {
  const d = path.join(tmp, "wiz dir"); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "a.bin"), Buffer.alloc(30000, 3)); fs.writeFileSync(path.join(d, "b.bin"), Buffer.alloc(30000, 3));
  const r = spawnSync(process.execPath, [cli, "--no-open", "--json", path.join(tmp, "wizdir.json")], { encoding: "utf8", env: { ...homeEnv, MMD_WIZARD: "1" }, input: `3\n${d}\nfeed.example\n` });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(fs.readFileSync(path.join(tmp, "wizdir.json"), "utf8"));
  assert.equal(j.sources[0].host, "feed.example"); assert.equal(j.totals.repeatBytes, 30000);
});

test("guided start (wizard) with a bad choice three times prints usage and exits 2", () => {
  const r = spawnSync(process.execPath, [cli, "--no-open"], { encoding: "utf8", env: { ...homeEnv, MMD_WIZARD: "1" }, input: `x\ny\nz\n` });
  assert.equal(r.status, 2); assert.match(r.stdout, /guided start/);
});

test("Node version gate text exists for Node < 20", () => {
  const src = fs.readFileSync(cli, "utf8");
  assert.match(src, /needs Node 20 or newer/);
});
