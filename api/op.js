import { json, getUser, mutate, PEOPLE, TYPES, STATUSES, uid, str, addActivity, removeBlob } from './_lib.js';

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
    const by = getUser(request);
    if (!by) return json({ error: 'Sign in required' }, 401);
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let b;
    try { b = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
    const blobsToDelete = [];

    try {
      const { db, result } = await mutate((db) => {
        const now = Date.now();
        switch (b.op) {
          case 'create': {
            const t = cleanTask(b.data || {});
            if (!t.type || !t.assignee) return { error: 'Task type and assigned person are required.' };
            const id = uid();
            db.seq = (db.seq || 0) + 1;
            db.tasks[id] = { ...t, status: 'todo', createdBy: by, createdAt: now, updatedAt: now, number: db.seq };
            addActivity(db, id, by, 'created this task and assigned it to ' + t.assignee);
            return { id, number: db.seq };
          }
          case 'update': {
            const old = db.tasks[b.id];
            if (!old) return { error: 'That task no longer exists.' };
            const t = cleanTask(b.data || {});
            if (!t.type || !t.assignee) return { error: 'Task type and assigned person are required.' };
            db.tasks[b.id] = { ...old, ...t, updatedAt: now };
            addActivity(db, b.id, by, old.assignee !== t.assignee ? 'reassigned this to ' + t.assignee : 'edited the task details');
            return { id: b.id };
          }
          case 'status': {
            const old = db.tasks[b.id];
            if (!old) return { error: 'That task no longer exists.' };
            if (!STATUSES[b.status] || old.status === b.status) return { id: b.id };
            old.status = b.status; old.updatedAt = now;
            addActivity(db, b.id, by, 'moved this to ' + STATUSES[b.status]);
            return { id: b.id };
          }
          case 'note': {
            const task = db.tasks[b.id];
            const text = str(b.text, 6000);
            if (!task) return { error: 'That task no longer exists.' };
            if (!text) return { error: 'Write a note first.' };
            db.notes[uid()] = { taskId: b.id, by, at: now, text, kind: 'note' };
            task.updatedAt = now;
            return { id: b.id };
          }
          case 'delete': {
            if (!db.tasks[b.id]) return { id: b.id };
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
            if (db.tasks[p.taskId]) addActivity(db, p.taskId, by, 'removed a photo');
            return { id: b.photoId };
          }
          default:
            return { error: 'Unknown action.' };
        }
      });
      for (const p of blobsToDelete) await removeBlob(p);
      if (result && result.error) return json({ error: result.error, board: db }, 400);
      return json({ ok: true, result, board: db });
    } catch (e) {
      console.error(e);
      return json({ error: 'Could not save. Try again.' }, 500);
    }
  },
};
