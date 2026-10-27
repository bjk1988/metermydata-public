#!/usr/bin/env node
// MeterMyData CLI.
//   metermydata --allow api.example.com [--port N] [--history] [--rate host=USD/GB] [--no-open]
//   metermydata har <file.har> [--history] [--rate host=USD/GB] [--no-open]
//   metermydata dir <folder> [--host name] [--history] [--no-open]
//   metermydata report <report.json>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Meter, readHar, buildReport, fmtBytes, CDC_V1, type ProviderProfile, type BillingInput, type Report } from "./engine/index.js";
import { startForwarder } from "./forwarder.js";
import { APP_JS, APP_CSS, PROVIDERS } from "./generated/embedded.js";

const VERSION = "0.1.6";
const major = Number(process.versions.node.split(".")[0]);
if (major < 20) { console.error(`metermydata needs Node 20 or newer; this is ${process.versions.node}. Install Node 20 LTS and run again.`); process.exit(1); }

const home = path.join(os.homedir(), ".metermydata");
const historyFile = path.join(home, "history.json");
const reportsDir = path.join(home, "reports");

function profiles(): ProviderProfile[] { return PROVIDERS as unknown as ProviderProfile[]; }

interface Args { cmd: string; positional: string[]; allow: string[]; port: number; history: boolean; rates: BillingInput[]; open: boolean; host?: string; allowPrivate: boolean; json?: string }
function parse(argv: string[]): Args {
  const a: Args = { cmd: "forward", positional: [], allow: [], port: 7777, history: false, rates: [], open: true, allowPrivate: process.env.MMD_ALLOW_PRIVATE === "1" };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--allow") a.allow.push(argv[++i]);
    else if (x === "--port") a.port = Number(argv[++i]);
    else if (x === "--history") a.history = true;
    else if (x === "--no-open") a.open = false;
    else if (x === "--host") a.host = argv[++i];
    else if (x === "--json") a.json = argv[++i];
    else if (x === "--rate") { const [h, v] = argv[++i].split("="); a.rates.push({ host: h, rateUsdPerGb: Number(v), confirmed: true }); }
    else if (x === "--version" || x === "-v") { console.log(VERSION); process.exit(0); }
    else if (x === "--help" || x === "-h") { usage(); process.exit(0); }
    else if (["har", "dir", "report", "forward"].includes(x) && a.positional.length === 0 && a.cmd === "forward") a.cmd = x;
    else a.positional.push(x);
  }
  return a;
}
function usage(): void {
  console.log(`metermydata ${VERSION} — see how much of the data you received was a repeat. Nothing leaves your machine.

  npx metermydata                                   guided start: answers three questions, then meters
  npx metermydata --allow api.openai.com            meter live traffic to one service; point your app at http://127.0.0.1:7777
  npx metermydata har traffic.har                   meter a HAR file saved from your browser (with bodies)
  npx metermydata dir ./responses --host feed.example.com
  npx metermydata report ~/.metermydata/reports/<file>.json

  While the live meter runs, http://127.0.0.1:7777/__meter shows running totals and a Finish button.
  With one --allow host, set your app's base URL to http://127.0.0.1:7777 (OpenAI: OPENAI_BASE_URL=http://127.0.0.1:7777/v1).
  With several hosts, use http://127.0.0.1:7777/https://<host>/… per app.

  --port N        meter port (default 7777, 0 = any free port)
  --history       keep and use ~/.metermydata/history.json across runs (per host, capped, oldest-first eviction)
  --rate host=X   your confirmed contract rate in USD per GB for a byte-billed host (enables a dollar estimate)
  --no-open       do not open the browser
  --json FILE     also write the report JSON to FILE`);
}

function loadHistory(meter: Meter): { from?: string } {
  try {
    const h = JSON.parse(fs.readFileSync(historyFile, "utf8"));
    meter.store.loadHistory(h.hosts ?? {});
    return { from: h.from };
  } catch { return {}; }
}
function saveHistory(meter: Meter, from?: string): void {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(historyFile, JSON.stringify({ version: 1, chunking: CDC_V1.id, from: from ?? new Date().toISOString(), to: new Date().toISOString(), hosts: meter.store.dump() }));
}

function htmlReport(report: Report, emb: object): string {
  const appJs = APP_JS, css = APP_CSS;
  const data = JSON.stringify(emb).replace(/<\//g, "<\\/");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MeterMyData report ${report.generatedAt.slice(0, 10)}</title><style>${css}</style></head>
<body><header><a class="brand" href="https://www.metermydata.com">MeterMyData</a><nav><a href="https://www.metermydata.com">metermydata.com</a></nav></header>
<main><h1>Your report</h1><p class="lead">${report.input.kind === "forwarder" ? "Live traffic through the local forwarder" : report.input.label}: ${report.input.responses} responses metered, ${report.input.skipped} skipped. Generated locally; nothing was uploaded.</p><div id="report"></div></main>
<footer>Free. Local. Nothing leaves your machine. <a href="https://www.metermydata.com/#waitlist">Tell me when I can stop paying for repeats</a>.</footer>
<script>window.__MMD__=${data};</script><script>${appJs}</script></body></html>`;
}

function openInBrowser(file: string): void {
  const p = process.platform;
  const cmd = p === "win32" ? ["cmd", ["/c", "start", "", file]] : p === "darwin" ? ["open", [file]] : ["xdg-open", [file]];
  try { spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore" }).unref(); } catch { /* ignore */ }
}

function finish(meter: Meter, input: Report["input"], args: Args, hist: { from?: string }): { report: Report; html: string; htmlPath: string } {
  const report = buildReport({ toolVersion: VERSION, chunking: CDC_V1, sources: meter.totals(), stats: meter.store.stats(), profiles: profiles(), billing: args.rates, input, history: { enabled: args.history, from: hist.from, to: new Date().toISOString() } });
  const emb = { sources: meter.totals(), stats: meter.store.stats(), profiles: profiles(), input, history: report.history, toolVersion: VERSION };
  fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(reportsDir, `${stamp}.json`), htmlPath = path.join(reportsDir, `${stamp}.html`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const html = htmlReport(report, emb);
  fs.writeFileSync(htmlPath, html);
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(report, null, 2));
  if (args.history) saveHistory(meter, hist.from);
  const t = report.totals;
  console.log(`\n${t.repeatPct.toFixed(1)}% of ${fmtBytes(t.decodedBytes)} received was a repeat (${fmtBytes(t.repeatBytes)}) across ${t.responses} responses.`);
  for (const s of report.sources) console.log(`  ${s.host.padEnd(32)} ${s.repeatPct.toFixed(1).padStart(6)}%  ${fmtBytes(s.decodedBytes).padStart(10)} received  basis: ${s.basis}${s.estimatedRepeatUsd !== undefined ? `  ≈ $${s.estimatedRepeatUsd.toFixed(2)} repeated` : ""}`);
  console.log(`\nreport: ${htmlPath}\njson:   ${jsonPath}`);
  if (args.open) openInBrowser(htmlPath);
  return { report, html, htmlPath };
}

async function cmdHar(args: Args): Promise<void> {
  const file = args.positional[0];
  if (!file) { console.error("usage: metermydata har <file.har>"); process.exit(2); }
  const read = readHar(JSON.parse(fs.readFileSync(file, "utf8")));
  const meter = new Meter();
  const hist = args.history ? loadHistory(meter) : {};
  for (const e of read.entries) await meter.meter(e);
  if (read.entries.length === 0) console.error(`No response bodies in ${file} (${read.skipped.length} entries skipped). In Chrome use "Save all as HAR with content".`);
  finish(meter, { kind: "har", label: path.basename(file), responses: read.entries.length, skipped: read.skipped.length }, args, hist);
}

async function cmdDir(args: Args): Promise<void> {
  const dir = args.positional[0];
  if (!dir) { console.error("usage: metermydata dir <folder> [--host name]"); process.exit(2); }
  const host = args.host ?? "local-files";
  const meter = new Meter();
  const hist = args.history ? loadHistory(meter) : {};
  let n = 0;
  const walk = (d: string) => { for (const ent of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, ent.name); if (ent.isDirectory()) walk(p); else if (ent.isFile()) { files.push(p); } } };
  const files: string[] = []; walk(dir); files.sort();
  for (const f of files) { await meter.meter({ host, decoded: new Uint8Array(fs.readFileSync(f)), wire: { value: fs.statSync(f).size, status: "observed" }, url: f }); n++; }
  finish(meter, { kind: "directory", label: dir, responses: n, skipped: 0 }, args, hist);
}

function cmdReport(args: Args): void {
  const file = args.positional[0];
  if (!file) { console.error("usage: metermydata report <report.json>"); process.exit(2); }
  const report: Report = JSON.parse(fs.readFileSync(file, "utf8"));
  const emb = { sources: report.sources, stats: Object.fromEntries(report.sources.map((s) => [s.host, s.store])), profiles: profiles(), input: report.input, history: report.history, toolVersion: report.tool.version };
  const out = file.replace(/\.json$/i, "") + ".html";
  fs.writeFileSync(out, htmlReport(report, emb));
  console.log(`report: ${out}`);
  if (args.open) openInBrowser(out);
}

function instructions(port: number, allow: string[]): string {
  const base = `http://127.0.0.1:${port}`;
  if (allow.length === 1) {
    const h = allow[0];
    return `Your meter is on. Point the app you want to measure at ${base} instead of https://${h}, then use it normally.
  OpenAI SDK:      OPENAI_BASE_URL=${base}/v1
  Anthropic SDK:   ANTHROPIC_BASE_URL=${base}
  Stripe (Node):   new Stripe(key, { protocol: "http", host: "127.0.0.1", port: ${port} })
  anything else:   replace https://${h} with ${base} in its base URL or config
Watch it live:     ${base}/__meter   (press Finish there, or Ctrl-C here, for your report)`;
  }
  return `Your meter is on for ${allow.join(", ")}. Point each app at ${base}/https://<host>/… (for example OPENAI_BASE_URL=${base}/https://${allow[0]}/v1).
Watch it live:     ${base}/__meter   (press Finish there, or Ctrl-C here, for your report)`;
}

async function cmdForward(args: Args): Promise<void> {
  if (args.allow.length === 0) {
    if ((process.stdin.isTTY && process.stdout.isTTY) || process.env.MMD_WIZARD === "1") return wizard(args);
    console.error(`The meter talks only to hosts you name. Example:\n  npx metermydata --allow api.openai.com\n  then OPENAI_BASE_URL=http://127.0.0.1:7777/v1\nRun npx metermydata in a terminal with no arguments for a guided start.`);
    process.exit(2);
  }
  const meter = new Meter();
  const hist = args.history ? loadHistory(meter) : {};
  const defaultUpstream = args.allow.length === 1 ? args.allow[0] : undefined;
  let stopping = false;
  let fwRef: Awaited<ReturnType<typeof startForwarder>> | undefined;
  const stop = async (openReport: boolean): Promise<string> => {
    if (stopping) return "";
    stopping = true;
    clearInterval(tick);
    const total = meter.totals().reduce((a, s) => a + s.responses, 0);
    const r = finish(meter, { kind: "forwarder", label: `127.0.0.1:${fwRef?.port ?? args.port}`, responses: total, skipped: 0, unmeasured: fwRef?.unmeasured ?? [] }, { ...args, open: openReport }, hist);
    setTimeout(async () => { await fwRef?.close(); process.exit(0); }, 800);
    return r.html;
  };
  const fw = await startForwarder({ allow: args.allow, port: args.port, meter, allowPrivate: args.allowPrivate, defaultUpstream, log: (l) => console.log(`  ${l}`), onStop: () => stop(false) });
  fwRef = fw;
  console.log(`\n${instructions(fw.port, args.allow)}\n`);
  if (args.open) openInBrowser(`http://127.0.0.1:${fw.port}/__meter`);
  let responses = 0;
  const tick = setInterval(() => { const t = meter.totals(); const r = t.reduce((a, s) => a + s.responses, 0); if (r !== responses) { responses = r; const d = t.reduce((a, s) => a + s.decodedBytes, 0), rep = t.reduce((a, s) => a + s.repeatBytes, 0); console.log(`  so far: ${r} responses, ${fmtBytes(d)} received, ${d ? ((rep / d) * 100).toFixed(1) : "0.0"}% repeat`); } }, 5000);
  process.on("SIGINT", () => void stop(args.open)); process.on("SIGTERM", () => void stop(args.open));
  if (process.platform === "win32" && process.stdin.isTTY) { const rl = await import("node:readline"); rl.createInterface({ input: process.stdin }).on("SIGINT", () => void stop(args.open)); }
}

/** No arguments in a terminal: three questions, then run. */
async function wizard(args: Args): Promise<void> {
  // A line queue rather than readline's question(): piped answers that arrive before the next prompt
  // would otherwise be lost, and the same code serves a real terminal (with echo) and a pipe.
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdin.isTTY ? process.stdout : undefined, terminal: process.stdin.isTTY === true });
  const queue: string[] = []; const waiters: ((s: string) => void)[] = []; let closed = false;
  rl.on("line", (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
  rl.on("close", () => { closed = true; for (const w of waiters.splice(0)) w(""); });
  const ask = (q: string): Promise<string> => {
    process.stdout.write(q);
    if (queue.length) return Promise.resolve(queue.shift()!.trim());
    if (closed) return Promise.resolve("");
    return new Promise((res) => waiters.push((l) => res(l.trim())));
  };
  console.log(`\nMeterMyData ${VERSION} — see how much of the data you receive is a repeat. Nothing leaves your machine.\n`);
  let choice = "";
  for (let i = 0; i < 3 && !["1", "2", "3"].includes(choice); i++) {
    choice = await ask(`What do you want to meter?\n  1) Live traffic from an app on this computer (recommended)\n  2) A HAR file saved from your browser\n  3) A folder of saved responses\nType 1, 2 or 3: `);
  }
  const unquote = (p: string) => p.replace(/^["']|["']$/g, "").trim();
  if (choice === "1") {
    let hosts: string[] = [];
    for (let i = 0; i < 3 && hosts.length === 0; i++) {
      const a = await ask(`Which service does that app talk to? Type its API host, like api.openai.com (several separated by spaces): `);
      hosts = a.split(/[\s,]+/).map((h) => h.replace(/^https?:\/\//, "").replace(/\/.*$/, "")).filter(Boolean);
    }
    rl.close();
    if (hosts.length === 0) { console.log("No host given; nothing to meter."); process.exit(2); }
    args.allow = hosts;
    return cmdForward(args);
  }
  if (choice === "2") {
    const f = unquote(await ask(`Drag the .har file into this window (or type its path), then press Enter: `));
    rl.close();
    if (!f) { console.log("No file given."); process.exit(2); }
    args.cmd = "har"; args.positional = [f];
    return cmdHar(args);
  }
  if (choice === "3") {
    const d = unquote(await ask(`Drag the folder into this window (or type its path), then press Enter: `));
    const h = await ask(`What service did these come from? (a label, e.g. feed.example.com): `);
    rl.close();
    if (!d) { console.log("No folder given."); process.exit(2); }
    args.cmd = "dir"; args.positional = [d]; args.host = h || "local-files";
    return cmdDir(args);
  }
  rl.close();
  usage(); process.exit(2);
}

const args = parse(process.argv.slice(2));
(args.cmd === "har" ? cmdHar(args) : args.cmd === "dir" ? cmdDir(args) : args.cmd === "report" ? Promise.resolve(cmdReport(args)) : cmdForward(args))
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
