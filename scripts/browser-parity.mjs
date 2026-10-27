// Browser parity: open dist/web/selftest.html (or a deployed copy via MMD_URL) in a real headless
// browser (Edge / Chrome / Chromium), read the report the browser computed through the DevTools
// protocol, and compare it with test/fixtures/sample.expected.json. Exit 1 on any difference.
// No stdout capture and no loopback fetches from the page, so it works locally, on CI runners
// and against a live HTTPS deployment alike.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { WebSocket } from "undici";

const root = process.cwd();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".har": "application/json" };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); res.end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const candidates = process.platform === "win32"
  ? ["C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"]
  : process.platform === "darwin"
    ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
    : ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium", "microsoft-edge"];
const which = (c) => (c.includes("/") || c.includes("\\")) ? (fs.existsSync(c) ? c : null) : (spawnSync(process.platform === "win32" ? "where" : "which", [c]).status === 0 ? c : null);
const browsers = (process.env.MMD_BROWSERS ? process.env.MMD_BROWSERS.split(";") : candidates).map(which).filter(Boolean);
if (browsers.length === 0) { console.error("no headless browser found; set MMD_BROWSERS"); server.close(); process.exit(2); }

// MMD_URL: base URL of a deployed app (e.g. https://preview.metermydata.pages.dev/app); otherwise the local build
const base = process.env.MMD_URL ? process.env.MMD_URL.replace(/\/$/, "") : `http://127.0.0.1:${port}/dist/web`;
const shareUrl = process.env.MMD_SHARE_URL || "";   // when set, the page also posts a dryRun share to it and the check requires {ok:true}
const url = (process.env.MMD_URL ? `${base}/selftest` : `${base}/selftest.html`) + (shareUrl ? `?share=dry&shareUrl=${encodeURIComponent(shareUrl)}` : "");

const expected = JSON.parse(fs.readFileSync("test/fixtures/sample.expected.json", "utf8"));
delete expected.history.to;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class LaunchError extends Error {}
async function cdpReadResult(udd, child, timeoutMs) {
  const portFile = path.join(udd, "DevToolsActivePort");
  const t0 = Date.now();
  // the browser writes DevToolsActivePort while starting; on Windows a read can race the write (EBUSY), so retry
  let dbgPort = 0;
  while (!dbgPort) {
    if (Date.now() - t0 > 45000 || child.exitCode !== null) throw new LaunchError("browser did not open a DevTools port");
    try { dbgPort = Number(fs.readFileSync(portFile, "utf8").split(/\r?\n/)[0]) || 0; } catch { /* not there yet or locked */ }
    if (!dbgPort) await sleep(100);
  }
  let targets = [];
  while (!(targets = await fetch(`http://127.0.0.1:${dbgPort}/json`).then((r) => r.json()).catch(() => [])).some((t) => t.type === "page")) { if (Date.now() - t0 > 45000) throw new LaunchError("no page target"); await sleep(100); }
  const page = targets.find((t) => t.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  let id = 0; const waiting = new Map();
  ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); } });
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.navigate", { url });
  for (;;) {
    const r = await send("Runtime.evaluate", { expression: "(document.getElementById('out')||{}).textContent||''", returnByValue: true });
    const txt = r.result?.result?.value ?? "";
    if (txt && txt !== "running") { ws.close(); return txt; }
    if (Date.now() - t0 > timeoutMs) { ws.close(); throw new Error(`no result within ${timeoutMs} ms (last: ${JSON.stringify(txt).slice(0, 80)})`); }
    await sleep(250);
  }
}

let failed = 0, passed = 0;
for (const b of browsers) {
  const name = path.basename(b);
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "mmd-browser-"));
  const child = spawn(b, [`--user-data-dir=${udd}`, "--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run", "--disable-extensions", "--remote-debugging-port=0", "--remote-allow-origins=*", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = ""; child.stderr.on("data", (d) => { stderr += d; });
  let res;
  try { res = JSON.parse(await cdpReadResult(udd, child, 60000)); }
  catch (e) { res = { ok: false, launch: e instanceof LaunchError, error: `${e.message} (stderr: ${stderr.slice(0, 400)})` }; }
  try { child.kill(); } catch {}
  await sleep(300);
  try { fs.rmSync(udd, { recursive: true, force: true }); } catch {}
  // a browser that never launched on this machine is a SKIP (reported); a browser that ran and disagreed is a FAIL
  if (!res.ok && res.launch) { console.error(`SKIP ${name}: could not launch here: ${res.error}`); continue; }
  if (!res.ok) { console.error(`FAIL ${name} @ ${base}: ${res.error}`); failed++; continue; }
  passed++;
  if (shareUrl) {
    const ok = res.share && res.share.status === 200 && res.share.body && res.share.body.ok === true && res.share.body.dryRun === true;
    if (!ok) { console.error(`FAIL ${name}: dry-run share to ${shareUrl} did not succeed: ${String(JSON.stringify(res.share)).slice(0, 300)}`); failed++; continue; }
    console.log(`PASS ${name}: dry-run share accepted by ${shareUrl} (hosts ${res.share.body.wouldStore.hosts.join(", ")})`);
  }
  delete res.report.history.to;
  const a = JSON.stringify(res.report), e = JSON.stringify(expected);
  if (a === e) console.log(`PASS ${name} @ ${base}: browser report identical to expected (${res.report.totals.repeatPct.toFixed(2)}%)  [${res.ua.slice(0, 70)}]`);
  else { console.error(`FAIL ${name} @ ${base}: browser report differs\n--- browser\n${a.slice(0, 1500)}\n--- expected\n${e.slice(0, 1500)}`); failed++; }
}
server.close();
if (passed === 0) { console.error("FAIL: no browser produced a report on this machine"); process.exit(1); }
process.exit(failed ? 1 : 0);
