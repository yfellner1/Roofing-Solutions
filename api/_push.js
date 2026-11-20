// Phone/desktop alerts (Web Push). Needs VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY.
// Each device that turns alerts on is remembered in db/push.json, apart from the board
// so device addresses are never sent to other people's browsers.
import { put, get, PEOPLE } from './_lib.js';
import crypto from 'node:crypto';

const PATH = 'db/push.json';
export const pushConfigured = () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
const keyOf = (endpoint) => crypto.createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 24);

async function readSubs() {
  try {
    const r = await get(PATH, { access: 'private', useCache: false, headers: { 'accept-encoding': 'identity' } });
    if (!r || r.statusCode !== 200 || !r.stream) return {};
    return JSON.parse(await new Response(r.stream).text()).subs || {};
  } catch { return {}; }
}
const writeSubs = (subs) => put(PATH, JSON.stringify({ subs }), { access: 'private', contentType: 'application/json', allowOverwrite: true, addRandomSuffix: false });

export async function saveSub(name, sub) {
  if (!PEOPLE.includes(name) || !sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys?.p256dh || !sub.keys?.auth) return false;
  const subs = await readSubs();
  subs[keyOf(sub.endpoint)] = { name, at: Date.now(), sub: { endpoint: String(sub.endpoint).slice(0, 1000), keys: { p256dh: String(sub.keys.p256dh).slice(0, 200), auth: String(sub.keys.auth).slice(0, 100) } } };
  // A person keeps at most 6 devices; the oldest drop off.
  const mine = Object.entries(subs).filter(([, v]) => v.name === name).sort((a, b) => b[1].at - a[1].at);
  for (const [k] of mine.slice(6)) delete subs[k];
  await writeSubs(subs);
  return true;
}
export async function removeSub(endpoint) {
  const subs = await readSubs();
  if (!subs[keyOf(endpoint)]) return;
  delete subs[keyOf(endpoint)];
  await writeSubs(subs);
}

// list = [{ to: 'Ben', title, body }]. Never throws and never holds a save up for long.
export async function sendPush(list) {
  if (!pushConfigured() || !list.length) return;
  try {
    const subs = await readSubs();
    const targets = [];
    for (const n of list) for (const [k, v] of Object.entries(subs)) if (v.name === n.to) targets.push([k, v.sub, n]);
    if (!targets.length) return;
    const webpush = (await import('web-push')).default;
    webpush.setVapidDetails('mailto:' + (process.env.VAPID_CONTACT || 'office@example.com'), process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    const dead = [];
    const work = Promise.allSettled(targets.map(([k, sub, n]) =>
      webpush.sendNotification(sub, JSON.stringify({ title: String(n.title).slice(0, 120), body: String(n.body || '').slice(0, 200), url: '/' }), { TTL: 6 * 3600, timeout: 4000 })
        .catch((e) => { if (e?.statusCode === 404 || e?.statusCode === 410) dead.push(k); else console.warn('push failed', e?.statusCode || e?.message); })));
    await Promise.race([work, new Promise((r) => setTimeout(r, 5000))]);
    if (dead.length) { for (const k of dead) delete subs[k]; await writeSubs(subs); }
  } catch (e) { console.warn('push skipped', e?.message); }
}
