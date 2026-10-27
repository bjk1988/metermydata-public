// MeterMyData web app: the HAR drop page and the shared report renderer + share card.
// Bundled to dist/web/app.js (global MMD). The CLI's HTML report embeds the same bundle.

import { Meter, readHar, buildReport, fmtBytes, CDC_V1, buildSharePayload, SHARE_URL, type Report, type ProviderProfile, type BillingInput, type SourceTotals } from "../src/engine/index.js";
import type { StoreStats } from "../src/engine/store.js";

export interface Embedded { sources: SourceTotals[]; stats: Record<string, StoreStats>; profiles: ProviderProfile[]; input: Report["input"]; history: Report["history"]; toolVersion: string }

declare global { interface Window { __MMD__?: Embedded; MMD?: any } }

const SITE = "https://www.metermydata.com";
const VERSION = "0.1.3";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  for (const k of kids) e.append(k);
  return e;
}

export function renderReport(root: HTMLElement, emb: Embedded, billing: BillingInput[] = []): Report {
  const report = buildReport({ toolVersion: emb.toolVersion, chunking: CDC_V1, sources: emb.sources, stats: emb.stats, profiles: emb.profiles, billing, input: emb.input, history: emb.history });
  root.replaceChildren();
  const t = report.totals;
  const hero = el("div", { class: "hero" },
    el("div", { class: "big" }, `${t.repeatPct.toFixed(1)}%`),
    el("div", { class: "sub" }, `of the ${fmtBytes(t.decodedBytes)} you received was a repeat (${fmtBytes(t.repeatBytes)}), across ${t.responses} responses`),
    el("div", { class: "meta" }, `chunking ${report.chunking.id} · scope per host · wire bytes ${t.wireStatus} · history ${report.history.enabled ? `on (${report.history.retained.toLocaleString()} fingerprints kept, ${report.history.evicted.toLocaleString()} evicted)` : "off"} · ${report.generatedAt}`));
  if (t.estimatedRepeatUsd !== undefined) hero.append(el("div", { class: "usd" }, `≈ $${t.estimatedRepeatUsd.toFixed(2)} of repeated bytes at the rates you confirmed (an estimate, not an invoice)`));
  root.append(hero);

  const table = el("table", { class: "rows" });
  table.append(el("thead", {}, el("tr", {}, ...["Source", "Responses", "Received", "Repeated", "Repeat %", "In-run / history", "Wire bytes", "Billing basis", "Rate $/GB", "Repeated $"].map((h) => el("th", {}, h)))));
  const tb = el("tbody");
  for (const r of report.sources) {
    const tr = el("tr");
    tr.append(el("td", {}, el("b", {}, r.host), r.provider ? el("div", { class: "prov" }, r.provider) : ""));
    tr.append(el("td", {}, String(r.responses)));
    tr.append(el("td", {}, fmtBytes(r.decodedBytes)));
    tr.append(el("td", {}, fmtBytes(r.repeatBytes)));
    tr.append(el("td", { class: "pct" }, `${r.repeatPct.toFixed(1)}%`));
    tr.append(el("td", {}, `${fmtBytes(r.inRunRepeatBytes)} / ${fmtBytes(r.historyRepeatBytes)}`));
    tr.append(el("td", {}, r.wireStatus === "unavailable" ? "unavailable" : `${fmtBytes(r.wireBytes)} (${r.wireStatus})`));
    const basisCell = el("td", {}, r.basis);
    if (r.basisSource) basisCell.append(" ", el("a", { href: r.basisSource, target: "_blank", rel: "noopener" }, "source"));
    if (r.note) basisCell.append(el("div", { class: "note" }, r.note));
    tr.append(basisCell);
    const byteBasis = r.basis === "decoded-bytes" || r.basis === "encoded-bytes";
    const rateCell = el("td");
    if (byteBasis) {
      const existing = billing.find((b) => b.host === r.host);
      const inp = el("input", { type: "number", step: "0.001", min: "0", placeholder: "enter rate", value: existing?.rateUsdPerGb !== undefined ? String(existing.rateUsdPerGb) : "" }) as HTMLInputElement;
      const chk = el("input", { type: "checkbox" }) as HTMLInputElement; chk.checked = existing?.confirmed === true;
      const lab = el("label", { class: "confirm" }, chk, " I confirm this is my contract rate");
      const apply = () => {
        const next = billing.filter((b) => b.host !== r.host);
        const v = parseFloat(inp.value);
        if (Number.isFinite(v)) next.push({ host: r.host, basis: r.basis, rateUsdPerGb: v, confirmed: chk.checked });
        renderReport(root, emb, next);
      };
      inp.addEventListener("change", apply); chk.addEventListener("change", apply);
      rateCell.append(inp, lab);
    } else rateCell.append(el("span", { class: "muted" }, "percentage only"));
    tr.append(rateCell);
    tr.append(el("td", {}, r.estimatedRepeatUsd !== undefined ? `$${r.estimatedRepeatUsd.toFixed(2)}` : (byteBasis && r.billableRepeatBytes !== undefined ? `${fmtBytes(r.billableRepeatBytes)} billable (${r.billableRepeatStatus})` : "—")));
    tb.append(tr);
  }
  table.append(tb);
  root.append(table);

  if (report.input.unmeasured?.length) {
    root.append(el("div", { class: "warn" }, el("b", {}, "Unmeasured: "), report.input.unmeasured.map((u) => u.reason).join("; ")));
  }

  // share card
  const canvas = el("canvas", { width: "1200", height: "630", class: "card" }) as HTMLCanvasElement;
  drawCard(canvas, report);
  const dl = el("a", { class: "btn", download: `metermydata-${report.generatedAt.slice(0, 10)}.png`, href: "#" }, "Download share card");
  dl.addEventListener("click", (ev) => { ev.preventDefault(); dl.href = canvas.toDataURL("image/png"); const a = el("a", { href: dl.href, download: dl.getAttribute("download")! }); a.click(); });
  const copy = el("a", { class: "btn", href: "#" }, "Copy card to clipboard");
  copy.addEventListener("click", async (ev) => { ev.preventDefault(); canvas.toBlob(async (b) => { if (b && (navigator as any).clipboard?.write) { await (navigator as any).clipboard.write([new (window as any).ClipboardItem({ "image/png": b })]); copy.textContent = "Copied"; } }); });
  const wl = el("a", { class: "btn primary", href: `${SITE}/#waitlist`, target: "_blank", rel: "noopener" }, "Tell me when I can stop paying for repeats");
  const json = el("a", { class: "btn", href: "#" }, "Download report JSON");
  json.addEventListener("click", (ev) => { ev.preventDefault(); const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }); const a = el("a", { href: URL.createObjectURL(blob), download: `metermydata-${report.generatedAt.slice(0, 10)}.json` }); a.click(); });
  // Opt-in share: show exactly what would be sent, send only on a second click, report the outcome.
  const shareBox = el("div", { class: "share" });
  const shareBtn = el("a", { class: "btn", href: "#" }, "Share my reading with the Repeat Index");
  const client: "browser" | "cli" = window.__MMD__ ? "cli" : "browser";
  shareBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    const payload = buildSharePayload(report, client);
    shareBox.replaceChildren();
    if (!payload) { shareBox.append(el("p", { class: "muted" }, "Nothing to share: every host in this report is private, local or an example domain, and those never leave your machine.")); return; }
    const pre = el("pre", { class: "preview" }, JSON.stringify(payload, null, 2));
    const send = el("a", { class: "btn primary", href: "#" }, "Send exactly this");
    const cancel = el("a", { class: "btn", href: "#" }, "Cancel");
    const status = el("p", { class: "muted" });
    send.addEventListener("click", async (ev2) => {
      ev2.preventDefault(); send.textContent = "Sending…";
      try {
        const r = await fetch(SHARE_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
        const j = await r.json().catch(() => ({}));
        if (r.ok && j.ok) { shareBox.replaceChildren(el("p", {}, "Thank you. Your reading is now part of the ", el("a", { href: `${SITE}/repeat-index`, target: "_blank", rel: "noopener" }, "Repeat Index"), ".")); }
        else { status.textContent = `Not sent: ${j.error || r.status}`; send.textContent = "Send exactly this"; }
      } catch (e) { status.textContent = `Not sent: ${(e as Error).message}`; send.textContent = "Send exactly this"; }
    });
    cancel.addEventListener("click", (ev2) => { ev2.preventDefault(); shareBox.replaceChildren(); });
    shareBox.append(el("p", { class: "muted" }, "This is everything that would be sent: host names, counts, bytes and percentages. No URLs, no content, no email."), pre, el("div", { class: "actions" }, send, cancel), status);
  });
  root.append(el("div", { class: "cardwrap" }, canvas), el("div", { class: "actions" }, dl, copy, json, shareBtn, wl), shareBox);
  return report;
}

export function drawCard(canvas: HTMLCanvasElement, report: Report): void {
  const c = canvas.getContext("2d")!;
  const W = canvas.width, H = canvas.height;
  const serif = "Marcellus, Georgia, serif", sans = "Inter, 'Segoe UI', Arial, sans-serif";
  c.fillStyle = "#05060a"; c.fillRect(0, 0, W, H);
  c.strokeStyle = "rgba(255,255,255,0.12)"; c.lineWidth = 2; c.strokeRect(1, 1, W - 2, H - 2);
  c.fillStyle = "#c9a96e"; c.font = `150px ${serif}`; c.textBaseline = "top";
  c.fillText(`${report.totals.repeatPct.toFixed(0)}%`, 70, 70);
  c.fillStyle = "#f2f2f0"; c.font = `44px ${serif}`;
  c.fillText("of the data I received was a repeat", 70, 245);
  c.fillStyle = "#c9ccd1"; c.font = `30px ${sans}`;
  const top = report.sources[0];
  const line2 = top ? `${fmtBytes(report.totals.decodedBytes)} received, ${fmtBytes(report.totals.repeatBytes)} repeated · top source ${top.host} (${top.repeatPct.toFixed(0)}%)` : `${fmtBytes(report.totals.decodedBytes)} received`;
  c.fillText(line2.slice(0, 90), 70, 318);
  c.fillStyle = "#8b9099"; c.font = `24px ${sans}`;
  c.fillText(`${report.chunking.id} · per host · ${report.history.enabled ? "with history" : "single run"} · ${report.generatedAt.slice(0, 10)}`, 70, 376);
  c.fillStyle = "#c9a96e"; c.font = `40px ${serif}`;
  c.fillText("metermydata.com", 70, 536);
  c.fillStyle = "#8b9099"; c.font = `24px ${sans}`;
  c.fillText("npx metermydata · free · nothing leaves your machine", 70, 590);
}

// ---------- HAR page ----------
async function runHarPage(): Promise<void> {
  const drop = document.getElementById("drop"); const out = document.getElementById("report"); const status = document.getElementById("status");
  if (!drop || !out) return;
  const profiles: ProviderProfile[] = await fetch("./providers.json").then((r) => r.json()).catch(() => []);
  const handle = async (file: File) => {
    status!.textContent = `Reading ${file.name} (${fmtBytes(file.size)})…`;
    let har: any;
    try { har = JSON.parse(await file.text()); } catch { status!.textContent = "That is not a JSON HAR file."; return; }
    let read;
    try { read = readHar(har); } catch (e) { status!.textContent = (e as Error).message; return; }
    if (read.entries.length === 0) { status!.textContent = `No response bodies found in ${read.skipped.length} entries. In Chrome, right-click the network list and choose "Save all as HAR with content".`; return; }
    const meter = new Meter();
    let n = 0;
    for (const e of read.entries) { await meter.meter(e); n++; if (n % 25 === 0) { status!.textContent = `Metered ${n}/${read.entries.length} responses…`; await new Promise((r) => setTimeout(r, 0)); } }
    status!.textContent = `${read.entries.length} responses metered, ${read.skipped.length} skipped (${[...new Set(read.skipped.map((s) => s.reason))].join("; ") || "none"}). Nothing was uploaded.`;
    const emb: Embedded = { sources: meter.totals(), stats: meter.store.stats(), profiles, input: { kind: "har", label: file.name, responses: read.entries.length, skipped: read.skipped.length }, history: { enabled: false, retained: 0, evicted: 0 }, toolVersion: VERSION };
    renderReport(out, emb);
    out.scrollIntoView({ behavior: "smooth" });
  };
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); const f = e.dataTransfer?.files?.[0]; if (f) void handle(f); });
  const input = document.getElementById("file") as HTMLInputElement | null;
  input?.addEventListener("change", () => { const f = input.files?.[0]; if (f) void handle(f); });
}

// ---------- embedded report (CLI HTML) ----------
function runEmbedded(): void {
  const out = document.getElementById("report");
  if (out && window.__MMD__) renderReport(out, window.__MMD__);
}

if (typeof document !== "undefined") {
  window.MMD = { renderReport, drawCard, Meter, readHar, buildReport, buildSharePayload, SHARE_URL, CDC_V1, VERSION };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => { runEmbedded(); void runHarPage(); });
  else { runEmbedded(); void runHarPage(); }
}
