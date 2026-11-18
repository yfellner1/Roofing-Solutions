import { get, put, del, head, BlobPreconditionFailedError, BlobNotFoundError } from '@vercel/blob';
import crypto from 'node:crypto';

export const PEOPLE = ['Loriale', 'Mayer', 'Mrs. Salcer', 'Ben', 'Mr. Klein', 'Yehuda'];
export const TYPES = ['schedule', 'estimate', 'invoice', 'check', 'followup', 'deposit', 'other'];
export const STATUSES = { todo: 'To do', progress: 'In progress', waiting: 'Waiting on customer', done: 'Done' };
const DB_PATH = 'db/board.json';

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

function users() {
  try { return JSON.parse(process.env.USER_PINS || '{}'); } catch { return {}; }
}
function sign(name, pin) {
  return crypto.createHmac('sha256', process.env.AUTH_SECRET || 'rs').update(name + ':' + pin).digest('hex');
}
function same(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
// Returns the person a code belongs to, or '' if it matches nobody.
export function userForPin(pin) {
  let found = '';
  for (const [name, p] of Object.entries(users())) {
    if (PEOPLE.includes(name) && p && same(pin, p)) found = name;
  }
  return found;
}
export function cookieFor(name) {
  const pin = users()[name];
  return Buffer.from(name).toString('base64url') + '.' + sign(name, pin);
}
// Returns the signed-in person's name, or '' if not signed in.
export function getUser(request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)rs_user=([A-Za-z0-9_-]+)\.([a-f0-9]{64})/);
  if (!m) return '';
  let name = '';
  try { name = Buffer.from(m[1], 'base64url').toString('utf8'); } catch { return ''; }
  const pin = users()[name];
  if (!PEOPLE.includes(name) || !pin) return '';
  return same(m[2], sign(name, pin)) ? name : '';
}

const empty = () => ({ seq: 0, tasks: {}, notes: {}, photos: {} });

const norm = (e) => String(e || '').replace(/^W\//, '').replace(/"/g, '');

// Reads the board. With { forWrite: true } it also asks the storage API for the
// authoritative version tag, because the tag on a downloaded copy can differ.
export async function readDb({ forWrite = false } = {}) {
  let etag = null;
  if (forWrite) {
    try {
      etag = (await head(DB_PATH)).etag || null;
    } catch (e) {
      if (e instanceof BlobNotFoundError || e?.name === 'BlobNotFoundError') return { db: empty(), etag: null, fresh: true };
      throw e;
    }
  }
  try {
    const r = await get(DB_PATH, { access: 'private', useCache: false, headers: { 'accept-encoding': 'identity' } });
    if (!r || r.statusCode !== 200 || !r.stream) return { db: empty(), etag: null, fresh: true };
    const text = await new Response(r.stream).text();
    const fresh = !forWrite || norm(r.blob.etag) === norm(etag);
    return { db: { ...empty(), ...JSON.parse(text) }, etag, fresh };
  } catch (e) {
    if (e instanceof BlobNotFoundError || e?.name === 'BlobNotFoundError') return { db: empty(), etag: null, fresh: true };
    throw e;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isConflict = (e) => e instanceof BlobPreconditionFailedError || e?.name === 'BlobPreconditionFailedError';

// Read-modify-write. Normally guarded so simultaneous edits never overwrite each
// other; if the guard keeps failing, the last attempts save anyway so nobody is
// ever locked out of the board.
export async function mutate(fn) {
  const TRIES = 7;
  for (let i = 0; i < TRIES; i++) {
    const { db, etag, fresh } = await readDb({ forWrite: true });
    if (!fresh && i < 3) { await sleep(120 + Math.random() * 200); continue; }
    const result = await fn(db);
    const opts = { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false, cacheControlMaxAge: 60 };
    const guarded = etag && i < TRIES - 2;
    if (guarded) opts.ifMatch = etag;
    try {
      await put(DB_PATH, JSON.stringify(db), opts);
      return { db, result };
    } catch (e) {
      if (isConflict(e)) {
        console.warn('board save conflict, attempt', i + 1, 'fresh:', fresh);
        await sleep(60 + Math.random() * 240);
        continue;
      }
      throw e;
    }
  }
  throw new Error('The board is busy. Try again.');
}

export const uid = () => Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
export const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function addActivity(db, taskId, by, text) {
  const id = uid();
  db.notes[id] = { taskId, by, at: Date.now(), text, kind: 'activity' };
}

export async function removeBlob(path) {
  try { await del(path); } catch (e) { /* already gone */ }
}

export { put, get };
