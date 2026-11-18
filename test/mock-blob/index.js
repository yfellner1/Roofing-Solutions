// In-memory stand-in for @vercel/blob. MODE=weak|diff reproduces the Nov 2026 etag mismatch.
const store = new Map(); let n = 0;
export class BlobPreconditionFailedError extends Error { constructor() { super('pre'); this.name = 'BlobPreconditionFailedError'; } }
export class BlobNotFoundError extends Error { constructor() { super('nf'); this.name = 'BlobNotFoundError'; } }
export async function head(p) { const v = store.get(p); if (!v) throw new BlobNotFoundError(); return { etag: v.etag }; }
export async function get(p) {
  const v = store.get(p); if (!v) return null;
  const big = String(v.data).length > 600, m = process.env.MODE;
  const etag = m === 'weak' && big ? 'W/' + v.etag : m === 'diff' && big ? '"gzip-' + n + '"' : v.etag;
  return { statusCode: 200, stream: new Response(v.data).body, blob: { etag, contentType: v.ct } };
}
export async function put(p, d, o) {
  const cur = store.get(p);
  if (o.ifMatch && (!cur || cur.etag !== o.ifMatch)) throw new BlobPreconditionFailedError();
  store.set(p, { data: d, etag: '"e' + (++n) + '"', ct: o.contentType }); return {};
}
export async function del(p) { store.delete(p); }
