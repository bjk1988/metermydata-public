// Fingerprint store: one set per source host, insertion-ordered, with a hard cap and
// deterministic oldest-first eviction. Entries remember whether they came from saved
// history or from the current run, so the report can separate the two.

export type Origin = "history" | "run";

export interface StoreStats { retained: number; evicted: number; cap: number }

export class HostStore {
  private readonly map = new Map<string, Origin>();
  private evictedCount = 0;
  constructor(readonly cap: number) {}

  /** Returns the origin of the existing entry if it was already present, else null (and inserts). */
  seen(fp: string, origin: Origin = "run"): Origin | null {
    const prev = this.map.get(fp);
    if (prev !== undefined) return prev;
    this.map.set(fp, origin);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
      this.evictedCount++;
    }
    return null;
  }

  has(fp: string): boolean { return this.map.has(fp); }
  get size(): number { return this.map.size; }
  stats(): StoreStats { return { retained: this.map.size, evicted: this.evictedCount, cap: this.cap }; }
  /** All fingerprints in insertion order (for persisting history). */
  entries(): string[] { return [...this.map.keys()]; }
}

export const DEFAULT_CAP = 1_000_000;

export class FingerprintStore {
  private readonly hosts = new Map<string, HostStore>();
  constructor(readonly cap: number = DEFAULT_CAP) {}

  host(host: string): HostStore {
    let h = this.hosts.get(host);
    if (!h) { h = new HostStore(this.cap); this.hosts.set(host, h); }
    return h;
  }

  /** Load saved history: fingerprints are inserted with origin "history". */
  loadHistory(data: Record<string, string[]>): void {
    for (const [host, fps] of Object.entries(data)) {
      const h = this.host(host);
      for (const fp of fps) h.seen(fp, "history");
    }
  }

  /** Serialise every host's fingerprints for persisting as history. */
  dump(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [host, h] of this.hosts) out[host] = h.entries();
    return out;
  }

  stats(): Record<string, StoreStats> {
    const out: Record<string, StoreStats> = {};
    for (const [host, h] of this.hosts) out[host] = h.stats();
    return out;
  }
}
