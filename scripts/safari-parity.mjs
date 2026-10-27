// Safari (and any other real browser) parity: serve the repo locally, open the self-test page in the
// named browser, wait for the page to POST its report back, compare with the expected fixture.
// Usage: node scripts/safari-parity.mjs [--browser Safari|Firefox|"Google Chrome"] [--live https://www.metermydata.com/app]
// With --live the page is loaded from the deployment and POSTs to this local server; some browsers
// block an https page posting to http://127.0.0.1, in which case the local build is tested instead.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const browser = opt("--browser", "Safari");
const live = opt("--live", "");
const root = process.cwd();
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".har": "application/json" };

let resolveResult;
const got = new Promise((r) => { resolveResult = r; });
const server = http.createServer((req, res) => {
  res.setHeader("access-control-allow-origin", "*"); res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method === "POST" && req.url === "/__result") { let b = ""; req.on("data", (c) => { b += c; }); req.on("end", () => { res.writeHead(204); res.end(); resolveResult(b); }); return; }
  const p = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": types[path.extname(p)] || "application/octet-stream" }); res.end(fs.readFileSync(p));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const postTo = `http://127.0.0.1:${port}/__result`;
const shareUrl = opt("--share", "");
const shareQ = shareUrl ? `&share=dry&shareUrl=${encodeURIComponent(shareUrl)}` : "";
const url = live ? `${live.replace(/\/$/, "")}/selftest?post=${encodeURIComponent(postTo)}${shareQ}` : `http://127.0.0.1:${port}/dist/web/selftest.html?post=1${shareQ}`;

const expected = JSON.parse(fs.readFileSync("test/fixtures/sample.expected.json", "utf8"));
delete expected.history.to;

console.log(`opening ${browser}: ${url}`);
// --browser may also be an executable path (any OS): it is launched directly with the URL (plus --headless when MMD_HEADLESS=1)
const isPath = /[\\/]/.test(browser) && fs.existsSync(browser);
const extra = process.env.MMD_HEADLESS === "1" ? ["-headless"] : [];
const opener = isPath ? spawn(browser, [...extra, url], { stdio: "ignore" })
  : process.platform === "darwin" ? spawn("open", ["-a", browser, url]) : process.platform === "win32" ? spawn("cmd", ["/c", "start", "", url]) : spawn("xdg-open", [url]);
const closeBrowser = () => { if (isPath) { try { opener.kill(); } catch {} } };
opener.on("error", (e) => console.error(`could not open browser: ${e.message}`));

const txt = await Promise.race([got, new Promise((r) => setTimeout(() => r(""), 90000))]);
server.close(); closeBrowser();
let res; try { res = JSON.parse(txt); } catch { res = { ok: false, error: "no result posted within 90 s (browser blocked the POST, or the page did not load)" }; }
if (!res.ok) { console.error(`FAIL ${browser}: ${res.error}`); process.exit(1); }
if (shareUrl) { const ok = res.share && res.share.status === 200 && res.share.body && res.share.body.ok === true; console.log(`${ok ? "PASS" : "FAIL"} ${browser}: dry-run share to ${shareUrl} -> ${JSON.stringify(res.share).slice(0, 200)}`); if (!ok) process.exit(1); }
delete res.report.history.to;
const a = JSON.stringify(res.report), e = JSON.stringify(expected);
if (a === e) { console.log(`PASS ${browser} @ ${live || "local build"}: browser report identical to expected (${res.report.totals.repeatPct.toFixed(2)}%)  [${res.ua}]`); process.exit(0); }
console.error(`FAIL ${browser}: report differs\n--- browser\n${a.slice(0, 1500)}\n--- expected\n${e.slice(0, 1500)}`); process.exit(1);
