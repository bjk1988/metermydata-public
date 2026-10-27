// Report schema v1 and the billing rules. Dollars appear only when a provider's billing basis is
// a byte basis AND a rate was supplied; otherwise the row carries a percentage and nothing else.

import type { SourceTotals, WireStatus } from "./meter.js";
import type { ChunkingConfig } from "./chunker.js";
import type { StoreStats } from "./store.js";

export type BillingBasis = "decoded-bytes" | "encoded-bytes" | "records" | "tokens" | "transactions" | "subscription" | "unknown";

export interface ProviderProfile {
  name: string;
  hosts: string[];               // exact hosts or "*.suffix" patterns
  basis: BillingBasis;
  source: string;                // URL of the provider's own pricing / docs page
  note?: string;
  defaultRateUsdPerGb?: number;  // only a reference figure; the user must confirm
}

export interface BillingInput { host: string; basis?: BillingBasis; rateUsdPerGb?: number; confirmed?: boolean }

export interface SourceRow extends SourceTotals {
  provider?: string;
  basis: BillingBasis;
  basisSource?: string;
  note?: string;
  billableRepeatBytes?: number;         // only for byte bases
  billableRepeatStatus?: WireStatus;    // which byte column the billable figure came from
  rateUsdPerGb?: number;
  estimatedRepeatUsd?: number;          // only when basis is bytes AND rate confirmed
  store: StoreStats;
}

export interface Report {
  schema: "metermydata-report/1";
  generatedAt: string;
  tool: { name: string; version: string };
  chunking: ChunkingConfig;
  scope: "per-host";
  history: { enabled: boolean; from?: string; to?: string; retained: number; evicted: number };
  input: { kind: "har" | "forwarder" | "directory"; label: string; responses: number; skipped: number; unmeasured?: { host: string; reason: string }[] };
  sources: SourceRow[];
  totals: {
    responses: number; decodedBytes: number; repeatBytes: number; repeatPct: number;
    inRunRepeatBytes: number; historyRepeatBytes: number;
    wireBytes: number; wireStatus: WireStatus;
    estimatedRepeatUsd?: number;        // sum of rows that have one
  };
}

export function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) { const suf = pattern.slice(1); return host.endsWith(suf) || host === pattern.slice(2); }
  return host === pattern;
}

export function findProfile(host: string, profiles: ProviderProfile[]): ProviderProfile | undefined {
  return profiles.find((p) => p.hosts.some((h) => hostMatches(host, h)));
}

export function buildReport(args: {
  toolVersion: string; chunking: ChunkingConfig; sources: SourceTotals[]; stats: Record<string, StoreStats>;
  profiles: ProviderProfile[]; billing?: BillingInput[]; input: Report["input"];
  history: { enabled: boolean; from?: string; to?: string };
}): Report {
  const rows: SourceRow[] = [];
  let retained = 0, evicted = 0;
  for (const s of args.sources) {
    const prof = findProfile(s.host, args.profiles);
    const user = args.billing?.find((b) => hostMatches(s.host, b.host));
    const basis: BillingBasis = user?.basis ?? prof?.basis ?? "unknown";
    const st = args.stats[s.host] ?? { retained: 0, evicted: 0, cap: 0 };
    retained += st.retained; evicted += st.evicted;
    const row: SourceRow = { ...s, provider: prof?.name, basis, basisSource: prof?.source, note: prof?.note, store: st };
    if (basis === "decoded-bytes" || basis === "encoded-bytes") {
      if (basis === "decoded-bytes") { row.billableRepeatBytes = s.repeatBytes; row.billableRepeatStatus = "observed"; }
      else if (s.wireStatus !== "unavailable" && s.decodedBytes > 0) {
        // Encoded (compressed) bytes: scale the decoded repeat share onto the wire bytes and label it
        // estimated. Compression is nonlinear, so this is never shown as observed.
        row.billableRepeatBytes = Math.round(s.wireBytes * (s.repeatBytes / s.decodedBytes));
        row.billableRepeatStatus = "estimated";
      } else { row.billableRepeatStatus = "unavailable"; }
      const rate = user?.rateUsdPerGb;
      if (user?.confirmed && rate !== undefined && row.billableRepeatBytes !== undefined) {
        row.rateUsdPerGb = rate;
        row.estimatedRepeatUsd = (row.billableRepeatBytes / 1e9) * rate;
      }
    }
    rows.push(row);
  }
  const t = rows.reduce((a, r) => {
    a.responses += r.responses; a.decodedBytes += r.decodedBytes; a.repeatBytes += r.repeatBytes;
    a.inRunRepeatBytes += r.inRunRepeatBytes; a.historyRepeatBytes += r.historyRepeatBytes; a.wireBytes += r.wireBytes;
    if (r.wireStatus === "estimated" && a.wireStatus !== "unavailable") a.wireStatus = "estimated";
    if (r.wireStatus === "unavailable") a.wireStatus = "unavailable";
    if (r.estimatedRepeatUsd !== undefined) a.estimatedRepeatUsd = (a.estimatedRepeatUsd ?? 0) + r.estimatedRepeatUsd;
    return a;
  }, { responses: 0, decodedBytes: 0, repeatBytes: 0, repeatPct: 0, inRunRepeatBytes: 0, historyRepeatBytes: 0, wireBytes: 0, wireStatus: "observed" as WireStatus, estimatedRepeatUsd: undefined as number | undefined });
  t.repeatPct = t.decodedBytes ? (t.repeatBytes / t.decodedBytes) * 100 : 0;
  if (rows.length === 0) t.wireStatus = "unavailable";
  return {
    schema: "metermydata-report/1", generatedAt: new Date().toISOString(),
    tool: { name: "metermydata", version: args.toolVersion }, chunking: args.chunking, scope: "per-host",
    history: { ...args.history, retained, evicted }, input: args.input, sources: rows, totals: t,
  };
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"]; let v = n / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${u[i]}`;
}
