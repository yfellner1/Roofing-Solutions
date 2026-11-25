// People who can sign in: username + password, a role (admin or editor) and an on/off switch.
// Kept in db/users.json, apart from the board, so password hashes never reach a browser.
import { get, put } from '@vercel/blob';
import crypto from 'node:crypto';

const PATH = 'db/users.json';
export const ROLES = { admin: 'Admin', editor: 'Editor' };
export const TITLES = ['Owner', 'Office staff', 'Bookkeeper', 'Foreman', 'Crew', 'Other'];
const COLORS = ['#A8252B', '#1F2326', '#6B4E9B', '#2D6A8E', '#5C6B2E', '#B4540A', '#1F7A7A', '#8E2D6A', '#4A5056', '#2C7A4B'];
// The original six. On first run they become accounts whose password is the 8-digit code they already use.
const FIRST = [
  ['loriale', 'Loriale', 'Office staff', 'admin'], ['mayer', 'Mayer', 'Owner', 'admin'], ['salcer', 'Mrs. Salcer', 'Bookkeeper', 'editor'],
  ['ben', 'Ben', 'Foreman', 'editor'], ['klein', 'Mr. Klein', 'Foreman', 'editor'], ['yehuda', 'Yehuda', 'Foreman', 'editor'],
];

// Names of everyone who can currently be given work. Refreshed on every request (see syncPeople).
export const PEOPLE = FIRST.map((f) => f[1]);

export const USERNAME_RULES = '3 to 20 characters: lowercase letters, numbers, dots or dashes.';
export const normalizeUsername = (s) => String(s || '').trim().toLowerCase();
export const isValidUsername = (s) => /^[a-z0-9][a-z0-9.-]{2,19}$/.test(s);
export const passwordProblem = (p) => (String(p).length < 8 ? 'Use at least 8 characters.' : String(p).length > 100 ? 'That is too long.' : '');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(String(password), salt, 32).toString('hex') };
}
export function checkPassword(user, password) {
  if (!user?.hash || !user.salt) return false;
  const got = crypto.scryptSync(String(password), user.salt, 32);
  const want = Buffer.from(user.hash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
const newStamp = () => crypto.randomBytes(8).toString('hex');
const newId = () => 'u' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');

function seed() {
  let pins = {};
  try { pins = JSON.parse(process.env.USER_PINS || '{}'); } catch { /* no codes */ }
  const users = {};
  FIRST.forEach(([username, name, title, role], i) => {
    // No code on file → a random password nobody knows; an admin sets a real one.
    const pw = pins[name] ? String(pins[name]) : crypto.randomBytes(24).toString('hex');
    users[newId() + i] = { username, name, title, role, active: true, color: COLORS[i % COLORS.length], ...hashPassword(pw), stamp: newStamp(), createdAt: Date.now() };
  });
  return { users };
}

let cache = null, cacheAt = 0;
function syncPeople(data) {
  const names = Object.values(data.users).filter((u) => u.active).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).map((u) => u.name);
  PEOPLE.splice(0, PEOPLE.length, ...names);
}
// A short cache keeps every request from re-reading the file; a change made here is seen at once,
// and by other server instances within a few seconds.
export async function loadUsers(force = false) {
  if (!force && cache && Date.now() - cacheAt < 5000) return cache;
  let data = null;
  try {
    const r = await get(PATH, { access: 'private', useCache: false, headers: { 'accept-encoding': 'identity' } });
    if (r && r.statusCode === 200 && r.stream) data = JSON.parse(await new Response(r.stream).text());
  } catch (e) {
    if (!(e?.name === 'BlobNotFoundError')) throw e;
  }
  if (!data || !data.users || !Object.keys(data.users).length) { data = seed(); await saveUsers(data); }
  cache = data; cacheAt = Date.now();
  syncPeople(data);
  return data;
}
export async function saveUsers(data) {
  await put(PATH, JSON.stringify(data), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });
  cache = data; cacheAt = Date.now();
  syncPeople(data);
}

// What the browser may know about a person (never the password hash).
export const publicUser = (id, u) => ({ id, username: u.username, name: u.name, title: u.title || '', role: u.role, active: !!u.active, color: u.color || '#959CA3' });
export const peopleList = (data) => Object.entries(data.users).sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0)).map(([id, u]) => publicUser(id, u));
export const pickColor = (data) => COLORS.find((c) => !Object.values(data.users).some((u) => u.color === c)) || COLORS[Object.keys(data.users).length % COLORS.length];
export { newStamp, newId };

// ---------- sign-in cookie ----------
const sign = (id, stamp) => crypto.createHmac('sha256', process.env.AUTH_SECRET || 'rs').update('u2:' + id + ':' + stamp).digest('hex');
export const cookieFor = (id, u) => Buffer.from(id).toString('base64url') + '.' + sign(id, u.stamp);
// Returns { id, name, username, role } for the signed-in person, or null. Changing a password or
// switching an account off changes its stamp, which signs that person out everywhere.
export async function getAuth(request) {
  const data = await loadUsers();
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)rs_user=([A-Za-z0-9_-]+)\.([a-f0-9]{64})/);
  if (!m) return null;
  let id = '';
  try { id = Buffer.from(m[1], 'base64url').toString('utf8'); } catch { return null; }
  const u = data.users[id];
  if (!u || !u.active) return null;
  const a = Buffer.from(m[2], 'hex'), b = Buffer.from(sign(id, u.stamp), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id, name: u.name, username: u.username, role: u.role === 'admin' ? 'admin' : 'editor' };
}
