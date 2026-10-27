// Opt-in sharing: what a user sends to the Repeat Index when they press "Share my reading".
// Aggregates only: host names, counts, bytes and percentages. Never URLs, bodies, emails or keys.
// Private, local and example hosts are dropped before anything is sent.

import type { Report, SourceRow } from "./report.js";

export const SHARE_SCHEMA = "metermydata-share/1";
export const SHARE_URL = "https://www.metermydata.com/share";
export const MAX_SHARE_SOURCES = 50;

export interface ShareSource {
  host: string; provider?: string; basis: string;
  responses: number; decodedBytes: number; repeatBytes: number; repeatPct: number;
  wireBytes: number; wireStatus: string;
}
export interface SharePayload {
  schema: typeof SHARE_SCHEMA;
  tool: { name: string; version: string };
  chunking: { id: string };
  scope: "per-host";
  history: { enabled: boolean };
  generatedAt: string;
  client: "browser" | "cli";
  sources: ShareSource[];
  totals: { responses: number; decodedBytes: number; repeatBytes: number; repeatPct: number };
  dryRun?: boolean;
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[|::1|.*\.(local|localhost|internal|lan|home|example|invalid|test)$|local-files$)/i;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}(?::\d{1,5})?$/i;

/** True for hosts that must never leave the machine (private ranges, local names, test domains). */
export function isPrivateHost(host: string): boolean { return PRIVATE_HOST.test(host) || !HOSTNAME.test(host.replace(/:\d+$/, "")); }

const num = (n: number) => (Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) / 1000 : 0);

/** Build the shareable aggregate from a report. Returns null when nothing shareable remains. */
export function buildSharePayload(report: Report, client: "browser" | "cli", opts: { dryRun?: boolean } = {}): SharePayload | null {
  const sources: ShareSource[] = report.sources
    .filter((s) => !isPrivateHost(s.host) && s.decodedBytes > 0)
    .slice(0, MAX_SHARE_SOURCES)
    .map((s: SourceRow) => ({
      host: s.host.toLowerCase(), provider: s.provider, basis: s.basis,
      responses: num(s.responses), decodedBytes: num(s.decodedBytes), repeatBytes: num(Math.min(s.repeatBytes, s.decodedBytes)), repeatPct: num(s.repeatPct),
      wireBytes: num(s.wireBytes), wireStatus: s.wireStatus,
    }));
  if (sources.length === 0) return null;
  const t = sources.reduce((a, s) => ({ responses: a.responses + s.responses, decodedBytes: a.decodedBytes + s.decodedBytes, repeatBytes: a.repeatBytes + s.repeatBytes }), { responses: 0, decodedBytes: 0, repeatBytes: 0 });
  return {
    schema: SHARE_SCHEMA, tool: { name: report.tool.name, version: report.tool.version }, chunking: { id: report.chunking.id },
    scope: "per-host", history: { enabled: report.history.enabled }, generatedAt: report.generatedAt, client,
    sources, totals: { ...t, repeatPct: t.decodedBytes ? num((t.repeatBytes / t.decodedBytes) * 100) : 0 },
    ...(opts.dryRun ? { dryRun: true } : {}),
  };
}

/** Server-side rules, mirrored in the site's /share function. Returns a reason string on rejection, null if valid. */
export function validateSharePayload(p: unknown): string | null {
  if (!p || typeof p !== "object") return "not an object";
  const x = p as Record<string, unknown>;
  if (x.schema !== SHARE_SCHEMA) return "unknown schema";
  const tool = x.tool as Record<string, unknown> | undefined;
  if (!tool || tool.name !== "metermydata" || typeof tool.version !== "string" || !/^\d+\.\d+\.\d+/.test(tool.version)) return "bad tool";
  const ch = x.chunking as Record<string, unknown> | undefined;
  if (!ch || typeof ch.id !== "string" || !/^mmd-cdc-v\d+$/.test(ch.id)) return "bad chunking id";
  if (x.scope !== "per-host") return "bad scope";
  if (x.client !== "browser" && x.client !== "cli") return "bad client";
  if (typeof x.generatedAt !== "string" || Number.isNaN(Date.parse(x.generatedAt))) return "bad generatedAt";
  const src = x.sources;
  if (!Array.isArray(src) || src.length === 0 || src.length > MAX_SHARE_SOURCES) return "bad sources";
  for (const s of src as Record<string, unknown>[]) {
    if (!s || typeof s.host !== "string" || isPrivateHost(s.host)) return "bad host";
    for (const k of ["responses", "decodedBytes", "repeatBytes", "repeatPct", "wireBytes"]) { const v = s[k]; if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `bad ${k}`; }
    if ((s.repeatBytes as number) > (s.decodedBytes as number)) return "repeat exceeds received";
    if ((s.repeatPct as number) > 100) return "bad repeatPct";
    if (typeof s.basis !== "string" || s.basis.length > 32) return "bad basis";
    if (s.provider !== undefined && (typeof s.provider !== "string" || s.provider.length > 80)) return "bad provider";
    if (typeof s.wireStatus !== "string" || !["observed", "estimated", "unavailable"].includes(s.wireStatus)) return "bad wireStatus";
    const extra = Object.keys(s).filter((k) => !["host", "provider", "basis", "responses", "decodedBytes", "repeatBytes", "repeatPct", "wireBytes", "wireStatus"].includes(k));
    if (extra.length) return `unexpected field ${extra[0]}`;
  }
  const t = x.totals as Record<string, unknown> | undefined;
  if (!t) return "bad totals";
  for (const k of ["responses", "decodedBytes", "repeatBytes", "repeatPct"]) { const v = t[k]; if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `bad totals.${k}`; }
  const extra = Object.keys(x).filter((k) => !["schema", "tool", "chunking", "scope", "history", "generatedAt", "client", "sources", "totals", "dryRun"].includes(k));
  if (extra.length) return `unexpected field ${extra[0]}`;
  if (JSON.stringify(p).length > 64 * 1024) return "too large";
  return null;
}
