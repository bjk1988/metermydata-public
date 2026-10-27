// MeterMyData chunker — content-defined chunking with a gear rolling hash (the public FastCDC
// family). Integer math on byte arrays only, so every platform cuts identical chunks.
//
// Configuration "mmd-cdc-v1" is immutable. A new configuration gets a new id; this one never changes.

export interface ChunkingConfig {
  id: string;
  minChunk: number;
  maxChunk: number;
  mask: number;        // boundary when (hash & mask) === 0
  gearSeed: number;    // seed of the xorshift32 generator that fills the gear table
}

export const CDC_V1: ChunkingConfig = Object.freeze({
  id: "mmd-cdc-v1",
  minChunk: 2048,
  maxChunk: 65536,
  mask: 0x1fff,        // 13 bits: about one boundary per 8 KiB on random data
  gearSeed: 0x9e3779b9,
});

/** 256-entry gear table, deterministic from the seed (xorshift32). */
export function gearTable(seed: number): Uint32Array {
  const t = new Uint32Array(256);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < 256; i++) {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    t[i] = x;
  }
  return t;
}

export interface Chunk { offset: number; length: number; bytes: Uint8Array }

/**
 * Streaming chunker: push bytes in any pieces, get chunks out as boundaries are found.
 * Chunk boundaries do not depend on how the input was pieced, only on the bytes.
 */
export class StreamChunker {
  private readonly gear: Uint32Array;
  private hash = 0;
  private pending: Uint8Array[] = [];
  private pendingLen = 0;
  private offset = 0;
  constructor(readonly config: ChunkingConfig = CDC_V1) {
    this.gear = gearTable(config.gearSeed);
  }

  push(input: Uint8Array): Chunk[] {
    const out: Chunk[] = [];
    const { minChunk, maxChunk, mask } = this.config;
    let start = 0;
    for (let i = 0; i < input.length; i++) {
      this.hash = ((this.hash << 1) + this.gear[input[i]]) >>> 0;
      const len = this.pendingLen + (i - start + 1);
      if ((len >= minChunk && (this.hash & mask) === 0) || len >= maxChunk) {
        out.push(this.emit(input.subarray(start, i + 1)));
        start = i + 1;
        this.hash = 0;
      }
    }
    if (start < input.length) {
      const rest = input.subarray(start);
      this.pending.push(rest);
      this.pendingLen += rest.length;
    }
    return out;
  }

  /** Flush the trailing bytes as the final chunk (if any). */
  finish(): Chunk | null {
    if (this.pendingLen === 0) { this.hash = 0; return null; }
    const c = this.emit(new Uint8Array(0));
    this.hash = 0;
    return c;
  }

  private emit(tail: Uint8Array): Chunk {
    const total = this.pendingLen + tail.length;
    const bytes = new Uint8Array(total);
    let p = 0;
    for (const part of this.pending) { bytes.set(part, p); p += part.length; }
    bytes.set(tail, p);
    const chunk: Chunk = { offset: this.offset, length: total, bytes };
    this.offset += total;
    this.pending = [];
    this.pendingLen = 0;
    return chunk;
  }
}

/** One-shot convenience: chunk a whole buffer. */
export function chunkBytes(data: Uint8Array, config: ChunkingConfig = CDC_V1): Chunk[] {
  const sc = new StreamChunker(config);
  const out = sc.push(data);
  const last = sc.finish();
  if (last) out.push(last);
  return out;
}
