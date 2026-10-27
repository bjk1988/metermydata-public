// HAR (HTTP Archive) reader. Works in the browser and in Node: input is the parsed JSON object.
// Decoded bytes = the body as recorded (HAR bodies are already decompressed by the browser).
// Wire bytes: response.bodySize when > 0 (observed); else content.size - content.compression
// when both are present (estimated); else unavailable. Nothing is inferred silently.

import type { ResponseInput, WireBytes } from "./meter.js";

export interface HarEntryResult extends ResponseInput { status: number; skipped?: string }

export interface HarReadResult {
  entries: HarEntryResult[];
  skipped: { url: string; reason: string }[];
  log: { creator?: string; version?: string; pages: number };
}

function b64ToBytes(b64: string): Uint8Array {
  const g = globalThis as any;
  if (typeof g.atob === "function") {
    const bin = g.atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  // Node without atob (not expected on Node 20+, kept for safety)
  return new Uint8Array(g.Buffer.from(b64, "base64"));
}

const enc = new TextEncoder();

export function readHar(har: any): HarReadResult {
  const log = har?.log;
  if (!log || !Array.isArray(log.entries)) throw new Error("Not a HAR file: missing log.entries");
  const entries: HarEntryResult[] = [];
  const skipped: { url: string; reason: string }[] = [];
  for (const e of log.entries) {
    const url: string = e?.request?.url ?? "";
    let host = "";
    try { host = new URL(url).host; } catch { skipped.push({ url, reason: "unparseable URL" }); continue; }
    const res = e?.response ?? {};
    const content = res.content ?? {};
    const status = Number(res.status ?? 0);
    if (status === 0 || (status >= 300 && status < 400)) { skipped.push({ url, reason: `status ${status}` }); continue; }
    if (typeof content.text !== "string") { skipped.push({ url, reason: "no body in HAR (export with content)" }); continue; }
    const decoded = content.encoding === "base64" ? b64ToBytes(content.text) : enc.encode(content.text);
    let wire: WireBytes;
    const bodySize = Number(res.bodySize);
    if (Number.isFinite(bodySize) && bodySize > 0) wire = { value: bodySize, status: "observed" };
    else if (Number.isFinite(Number(content.size)) && Number(content.size) >= 0 && Number.isFinite(Number(content.compression)) && Number(content.compression) >= 0)
      wire = { value: Math.max(0, Number(content.size) - Number(content.compression)), status: "estimated" };
    else wire = { value: 0, status: "unavailable" };
    const ctHeader = (res.headers ?? []).find((h: any) => String(h.name).toLowerCase() === "content-type");
    entries.push({ host, url, status, decoded, wire, contentType: ctHeader?.value ?? content.mimeType });
  }
  return { entries, skipped, log: { creator: log.creator?.name, version: log.creator?.version, pages: Array.isArray(log.pages) ? log.pages.length : 0 } };
}
