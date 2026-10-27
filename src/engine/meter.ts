// The meter: feed it responses (host + decoded bytes + optional wire-byte observation),
// get per-host and total repetition numbers out. Scope is strictly per host.

import { StreamChunker, CDC_V1, type ChunkingConfig } from "./chunker.js";
import { fingerprint } from "./fingerprint.js";
import { FingerprintStore } from "./store.js";

export type WireStatus = "observed" | "estimated" | "unavailable";
export interface WireBytes { value: number; status: WireStatus }

export interface ResponseInput {
  host: string;
  decoded: Uint8Array;          // the response body as the application sees it (decompressed)
  wire?: WireBytes;             // bytes on the wire, when known
  url?: string;
  contentType?: string;
}

export interface SourceTotals {
  host: string;
  responses: number;
  chunks: number;
  decodedBytes: number;
  repeatBytes: number;          // decoded bytes whose chunk fingerprint was already present
  inRunRepeatBytes: number;     // ... already present from this run
  historyRepeatBytes: number;   // ... already present from saved history
  repeatPct: number;            // repeatBytes / decodedBytes * 100 (0 when no bytes)
  wireBytes: number;            // sum of observed + estimated wire bytes
  wireStatus: WireStatus;       // "observed" if all observed, "estimated" if any estimated, else "unavailable"
  wireUnavailableResponses: number;
}

export class Meter {
  readonly store: FingerprintStore;
  private readonly sources = new Map<string, SourceTotals>();
  constructor(readonly config: ChunkingConfig = CDC_V1, store?: FingerprintStore) {
    this.store = store ?? new FingerprintStore();
  }

  private source(host: string): SourceTotals {
    let s = this.sources.get(host);
    if (!s) {
      s = { host, responses: 0, chunks: 0, decodedBytes: 0, repeatBytes: 0, inRunRepeatBytes: 0,
            historyRepeatBytes: 0, repeatPct: 0, wireBytes: 0, wireStatus: "unavailable", wireUnavailableResponses: 0 };
      this.sources.set(host, s);
    }
    return s;
  }

  /** Meter one complete response body. */
  async meter(input: ResponseInput): Promise<SourceTotals> {
    const s = this.source(input.host);
    const hs = this.store.host(input.host);
    s.responses++;
    const sc = new StreamChunker(this.config);
    const chunks = sc.push(input.decoded);
    const last = sc.finish();
    if (last) chunks.push(last);
    for (const c of chunks) {
      const fp = await fingerprint(c.bytes);
      s.chunks++;
      s.decodedBytes += c.length;
      const prev = hs.seen(fp, "run");
      if (prev !== null) {
        s.repeatBytes += c.length;
        if (prev === "history") s.historyRepeatBytes += c.length; else s.inRunRepeatBytes += c.length;
      }
    }
    if (input.wire && input.wire.status !== "unavailable") {
      s.wireBytes += input.wire.value;
      if (input.wire.status === "estimated" || s.wireStatus === "estimated") s.wireStatus = "estimated";
      else s.wireStatus = "observed";
    } else {
      s.wireUnavailableResponses++;
    }
    s.repeatPct = s.decodedBytes ? (s.repeatBytes / s.decodedBytes) * 100 : 0;
    return { ...s };
  }

  /** Streaming variant for the forwarder: returns a sink that meters as bytes arrive. */
  openStream(host: string, wire?: () => WireBytes | undefined): { write(b: Uint8Array): Promise<void>; end(): Promise<SourceTotals> } {
    const s = this.source(host);
    const hs = this.store.host(host);
    const sc = new StreamChunker(this.config);
    s.responses++;
    const account = async (chunks: ReturnType<StreamChunker["push"]>) => {
      for (const c of chunks) {
        const fp = await fingerprint(c.bytes);
        s.chunks++;
        s.decodedBytes += c.length;
        const prev = hs.seen(fp, "run");
        if (prev !== null) {
          s.repeatBytes += c.length;
          if (prev === "history") s.historyRepeatBytes += c.length; else s.inRunRepeatBytes += c.length;
        }
      }
    };
    return {
      write: async (b) => { await account(sc.push(b)); },
      end: async () => {
        const last = sc.finish();
        if (last) await account([last]);
        const w = wire?.();
        if (w && w.status !== "unavailable") {
          s.wireBytes += w.value;
          s.wireStatus = (w.status === "estimated" || s.wireStatus === "estimated") ? "estimated" : "observed";
        } else s.wireUnavailableResponses++;
        s.repeatPct = s.decodedBytes ? (s.repeatBytes / s.decodedBytes) * 100 : 0;
        return { ...s };
      },
    };
  }

  /** Snapshots, largest source first. */
  totals(): SourceTotals[] {
    return [...this.sources.values()].sort((a, b) => b.decodedBytes - a.decodedBytes).map((s) => ({ ...s }));
  }
}
