// Local preview with NO real storage: everything lives in memory and is lost on exit.
// Usage: node test/dev.mjs   → http://localhost:3000   (sign in: loriale / 11111111 (admin), ben / 22222222, mayer / 33333333)
// FAKE_GEO=1 places addresses at made-up map points so routes work offline.
import { mkdirSync, cpSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dest = path.join(root, 'node_modules/@vercel/blob');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(path.join(root, 'test/mock-blob'), dest, { recursive: true });
process.on('exit', () => rmSync(dest, { recursive: true, force: true }));
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
Object.assign(process.env, { AUTH_SECRET: 'dev', USER_PINS: JSON.stringify({ Loriale: '11111111', Ben: '22222222', Mayer: '33333333' }) });
if (process.env.FAKE_GEO) {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    if (!String(url).includes('geocoding.geo.census.gov')) return real(url, o);
    const a = new URL(url).searchParams.get('address');
    let h = 0; for (const ch of a) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return new Response(JSON.stringify({ result: { addressMatches: [{ coordinates: { y: 41.1 + (h % 1000) / 5000, x: -74.1 + ((h >> 10) % 1000) / 4000 } }] } }));
  };
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const handlers = {};
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const name = url.pathname.slice(5).replace(/[^a-z]/g, '');
      if (!existsSync(path.join(root, 'api', name + '.js'))) { res.writeHead(404).end(); return; }
      handlers[name] ||= (await import('../api/' + name + '.js')).default;
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
      const r = await handlers[name].fetch(new Request(url, { method: req.method, headers: req.headers, body }));
      res.writeHead(r.status, Object.fromEntries(r.headers));
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  } catch (e) { console.error(e); res.writeHead(500).end('error'); }
}).listen(process.env.PORT || 3000, () => console.log('Preview running at http://localhost:' + (process.env.PORT || 3000)));
