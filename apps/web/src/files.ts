/**
 * A file's bytes as base64, without blowing the stack on a large one.
 *
 * `String.fromCharCode(...bytes)` is the usual one-liner and throws on a
 * spreadsheet of any size — the spread becomes one argument per byte. Chunked
 * instead, which is the same result and survives a real file.
 */
export async function readAsBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
