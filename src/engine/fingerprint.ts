// SHA-256 fingerprints via WebCrypto, which exists in every modern browser and in Node 20+.
// A fingerprint is the lowercase hex digest followed by ":" and the chunk length in decimal.

const subtle = (globalThis as any).crypto?.subtle as SubtleCrypto | undefined;
if (!subtle) throw new Error("WebCrypto (crypto.subtle) is not available in this runtime");

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = await subtle!.digest("SHA-256", bytes as BufferSource);
  const v = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < v.length; i++) s += HEX[v[i]];
  return s;
}

export async function fingerprint(bytes: Uint8Array): Promise<string> {
  return `${await sha256Hex(bytes)}:${bytes.length}`;
}
