/**
 * Shareable links: the source code is compressed and stored in the URL's
 * hash (`#code=...`). The hash never reaches a server, so sharing needs no
 * backend and works on static hosting like GitHub Pages.
 *
 * deflate-raw via the browser's CompressionStream typically shrinks Verilog
 * 3-5x; base64url makes the bytes URL-safe.
 */

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function encodeSource(source: string): Promise<string> {
  return toBase64Url(await pipe(new TextEncoder().encode(source), new CompressionStream('deflate-raw')));
}

export async function decodeSource(encoded: string): Promise<string> {
  return new TextDecoder().decode(await pipe(fromBase64Url(encoded), new DecompressionStream('deflate-raw')));
}

export async function shareUrl(source: string): Promise<string> {
  const url = new URL(window.location.href);
  url.hash = `code=${await encodeSource(source)}`;
  return url.toString();
}

/** The source stored in the current URL, or null if there isn't one (or it's corrupt). */
export async function sourceFromHash(): Promise<string | null> {
  const m = /(?:^#|&)code=([^&]+)/.exec(window.location.hash);
  if (!m) return null;
  try {
    return await decodeSource(m[1]!);
  } catch {
    return null;
  }
}
