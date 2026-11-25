import { json, getAuth, mutate, readDb, getSettings, PEOPLE, TYPES, STATUSES, uid, str, addActivity, removeBlob } from './_lib.js';
import { ticketOp, advanceFromTask, setNotify, dayStops, recordText } from './_tickets.js';
import { geocode, planOrder, driveRoute } from './_geo.js';
import { sendPush } from './_push.js';
import { smsConfigured, sendSms, buildMessage } from './_sms.js';

const TYPE_LABEL = { schedule: 'Schedule job', estimate: 'Send estimate', estfollow: 'Follow up on estimate', invoice: 'Send invoice', check: 'Prepare check', followup: 'Follow up on payment', deposit: 'Collect deposit', other: 'Task' };

// Address lookups talk to the network, so they happen before the save, never inside it.
async function prepare(b) {
  const pre = {};
  try {
    if (b.op === 'ticketCreate' || b.op === 'ticketUpdate') {
      const d = b.data || {};
      const address = str(d.address, 300) || (b.op === 'ticketCreate' ? str(d.customer?.address, 300) : '');
      if (!address) return pre;
      if (b.op === 'ticketUpdate') {
        const old = (await readDb()).db.tickets[b.id];
        if (old && old.address === address && old.lat != null) return pre;
      }
      // An address picked from the suggestion list already comes with its map point.
      const g = d.geo;
      const picked = g && g.address === address && Number.isFinite(g.lat) && Number.isFinite(g.lng) && Math.abs(g.lat) <= 90 && Math.abs(g.lng) <= 180;
      pre.geoAddr = address; pre.geo = picked ? { lat: g.lat, lng: g.lng } : await geocode(address);
    } else if (b.op === 'settings') {
      const address = str(b.data?.shopAddress, 300);
      const cur = getSettings((await readDb()).db);
      if (address && !(cur.shopAddress === address && cur.shopLat != null)) { pre.geoAddr = address; pre.geo = await geocode(address); }
    } else if (b.op === 'route') {
      const { db } = await readDb();
      const s = getSettings(db);
      if (s.shopAddress && s.shopLat == null) { const g = await geocode(s.shopAddress); pre.shop = { address: s.shopAddress, lat: g?.lat ?? null, lng: g?.lng ?? null }; }
      const todo = Object.entries(db.tickets).filter(([, t]) => t.date === b.date && t.address && t.lat == null).slice(0, 15);
      pre.geos = {};
      await Promise.all(todo.map(async ([id, t]) => { const g = await geocode(t.address); pre.geos[id] = { address: t.address, lat: g?.lat ?? null, lng: g?.lng ?? null }; }));
      // Real drive times (and Google's ordering when no stop has a fixed time), if a Google key is set.
      if (process.env.GOOGLE_MAPS_KEY) {
        for (const [id, g] of Object.entries(pre.geos)) if (g.lat != null) { db.tickets[id].lat = g.lat; db.tickets[id].lng = g.lng; }
        const lat = pre.shop?.lat ?? s.shopLat, lng = pre.shop?.lng ?? s.shopLng;
        const start = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
        const stops = dayStops(db, b.date, pick(b.assignee, PEOPLE));
        const timed = stops.some((x) => x.time);
        pre.route = await driveRoute(planOrder(stops, start), start, !timed);
      }
    }
  } catch (e) { console.warn('prepare failed', e); }
  return pre;
}

const pick = (v, allowed) => (allowed.includes(v) ? v : '');

function cleanTask(d) {
  const t = {
    trades: Array.isArray(d.trades) ? d.trades.filter((x) => ['roof', 'siding', 'gutters'].includes(x)) : [],
    type: pick(d.type, TYPES),
    assignee: pick(d.assignee, PEOPLE),
    customer: str(d.customer, 200),
    phone: str(d.phone, 60),
    email: str(d.email, 200),
    address: str(d.address, 300),
    description: str(d.description, 6000),
    due: /^\d{4}-\d{2}-\d{2}$/.test(d.due || '') ? d.due : '',
    amount: str(d.amount, 40),
    kind: '', deposit: '', depositPaid: '', colorStatus: '', color: '',
  };
  if (t.type === 'schedule') {
    t.kind = pick(d.kind, ['Installation', 'Repair', 'Inspection']);
    t.deposit = pick(d.deposit, ['yes', 'no']);
    t.depositPaid = t.deposit === 'yes' ? pick(d.depositPaid, ['yes', 'no']) : '';
    t.colorStatus = pick(d.colorStatus, ['selected', 'pending', 'na']);
    t.color = t.colorStatus === 'selected' ? str(d.color, 200) : '';
  }
  if (!['estimate', 'invoice', 'check', 'followup', 'deposit'].includes(t.type)) t.amount = '';
  return t;
}

export default {
  async fetch(request) {
    const me = await getAuth(request);
    if (!me) return json({ error: 'Sign in required' }, 401);
    const by = me.name, admin = me.role === 'admin';
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let b;
    try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
    // Editors do the everyday work; settings and deleting tickets or customers are for admins.
    if (!admin && ['settings', 'ticketDelete', 'customerDelete'].includes(b.op)) return json({ error: 'Only an admin can do that.' }, 403);
    const blobsToDelete = [];
    const notify = [];
    const tell = (to, title, body) => { if (to && to !== by) notify.push({ to, title, body }); };
    const pre = await prepare(b);

    try {
      let { db, result } = await mutate((db) => {
        const now = Date.now();
        notify.length = 0; // a retried save must not double up alerts
        setNotify(notify);
        switch (b.op) {
          case 'create': {
            const t = cleanTask(b.data || {});
            if (!t.type || !t.assignee) return { error: 'Task type and assigned person are required.' };
            t.ticketId = db.tickets[b.data?.ticketId] ? b.data.ticketId : '';
            const id = uid();
            db.seq = (db.seq || 0) + 1;
            db.tasks[id] = { ...t, status: 'todo', createdBy: by, createdAt: now, updatedAt: now, number: db.seq };
            addActivity(db, id, by, 'created this task and assigned it to ' + t.assignee);
            if (t.ticketId) addActivity(db, t.ticketId, by, 'added task #' + db.seq + ' for ' + t.assignee);
            tell(t.assignee, by + ' gave you a task: ' + TYPE_LABEL[t.type], [t.customer, t.due ? 'due ' + t.due.slice(5).replace('-', '/') : ''].filter(Boolean).join(' · '));
            return { id, number: db.seq };
          }
          case 'update': {
            const old = db.tasks[b.id];
            if (!old) return { error: 'That task no longer exists.' };
            const t = cleanTask(b.data || {});
            if (!t.type || !t.assignee) return { error: 'Task type and assigned person are required.' };
            t.ticketId = db.tickets[b.data?.ticketId] ? b.data.ticketId : (db.tickets[old.ticketId] && b.data?.ticketId === undefined ? old.ticketId : '');
            db.tasks[b.id] = { ...old, ...t, updatedAt: now };
            addActivity(db, b.id, by, old.assignee !== t.assignee ? 'reassigned this to ' + t.assignee : 'edited the task details');
            if (old.assignee !== t.assignee) tell(t.assignee, by + ' gave you a task: ' + TYPE_LABEL[t.type], t.customer);
            return { id: b.id };
          }
          case 'status': {
            const old = db.tasks[b.id];
            if (!old) return { error: 'That task no longer exists.' };
            if (!STATUSES[b.status] || old.status === b.status) return { id: b.id };
            old.status = b.status; old.updatedAt = now;
            addActivity(db, b.id, by, 'moved this to ' + STATUSES[b.status]);
            if (b.status === 'done' && old.ticketId) advanceFromTask(db, old, by);
            return { id: b.id };
          }
          case 'note': {
            const task = db.tasks[b.id] || db.tickets[b.id];
            const text = str(b.text, 6000);
            if (!task) return { error: 'That no longer exists.' };
            if (!text) return { error: 'Write a note first.' };
            db.notes[uid()] = { taskId: b.id, by, at: now, text, kind: 'note' };
            task.updatedAt = now;
            const what = db.tasks[b.id] ? 'task #' + task.number : 'ticket T-' + task.number;
            for (const to of new Set([task.assignee, db.tasks[b.id] ? task.createdBy : ''])) tell(to, by + ' added a note on ' + what, text.slice(0, 120));
            return { id: b.id };
          }
          case 'delete': {
            if (!db.tasks[b.id]) return { id: b.id };
            if (!admin && db.tasks[b.id].createdBy !== by) return { error: 'Only an admin or the person who created this task can delete it.' };
            delete db.tasks[b.id];
            for (const [nid, n] of Object.entries(db.notes)) if (n.taskId === b.id) delete db.notes[nid];
            for (const [pid, p] of Object.entries(db.photos)) if (p.taskId === b.id) { blobsToDelete.push(p.path); delete db.photos[pid]; }
            return { id: b.id };
          }
          case 'removePhoto': {
            const p = db.photos[b.photoId];
            if (!p) return { id: b.photoId };
            blobsToDelete.push(p.path);
            delete db.photos[b.photoId];
            if (db.tasks[p.taskId] || db.tickets[p.taskId]) addActivity(db, p.taskId, by, 'removed a photo');
            return { id: b.photoId };
          }
          default: {
            const r = ticketOp(db, b, by, pre);
            if (r === undefined) return { error: 'Unknown action.' };
            if (r.blobs) { blobsToDelete.push(...r.blobs); delete r.blobs; }
            return r;
          }
        }
      });
      setNotify(null);
      for (const p of blobsToDelete) await removeBlob(p);
      if (result && result.error) return json({ error: result.error, board: db }, 400);
      if (notify.length) await sendPush(notify);
      // Optional automatic thank-you text when a job is marked paid.
      if (result && result.sendThanks) {
        const id = result.sendThanks; delete result.sendThanks;
        const t = db.tickets[id], c = t && db.customers[t.customerId];
        if (t && c && smsConfigured()) {
          const s = getSettings(db);
          const res = await sendSms(c.phone, buildMessage(s.thanksTemplate, t, c, s));
          db = (await mutate((db) => { recordText(db, id, 'Automatic text', res, 'auto', 'thanks'); })).db;
        }
      }
      return json({ ok: true, result, board: db });
    } catch (e) {
      console.error(e);
      return json({ error: 'Could not save. Try again.' }, 500);
    }
  },
};
