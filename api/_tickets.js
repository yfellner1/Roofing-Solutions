// Service tickets (estimates, repairs, installations), customers, scheduling and
// the links between tickets and office tasks. Everything here runs inside mutate(),
// so it must stay synchronous — network work (address lookup) is done beforehand
// in op.js and handed in as `pre`.
import { PEOPLE, TRADES, TICKET_KINDS, stagesFor, getSettings, DEFAULT_SMS, uid, str, addActivity, isYmd, todayYmd, addDays } from './_lib.js';
import { bestRoute } from './_geo.js';

const pick = (v, allowed) => (allowed.includes(v) ? v : '');
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const last10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);
const prettyDate = (ymd) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }); };
const hasGeo = (x) => x && Number.isFinite(x.lat) && Number.isFinite(x.lng);

function cleanTicket(d) {
  const date = isYmd(d.date) ? d.date : '';
  return {
    kind: pick(d.kind, Object.keys(TICKET_KINDS)),
    trades: Array.isArray(d.trades) ? TRADES.filter((x) => d.trades.includes(x)) : [],
    address: str(d.address, 300),
    description: str(d.description, 6000),
    amount: str(d.amount, 40),
    date,
    time: date && isTime(d.time) ? d.time : '',
    assignee: pick(d.assignee, PEOPLE),
  };
}

// Finds the customer a ticket belongs to (by id, then phone, then name + address),
// or creates one. Returns the customer id, or '' if there is no name to save.
function resolveCustomer(db, d, by, now) {
  const c = d.customer || {};
  const f = { name: str(c.name, 200), phone: str(c.phone, 60), email: str(c.email, 200), address: str(c.address || d.address, 300) };
  let id = db.customers[d.customerId] ? d.customerId : '';
  if (!id && last10(f.phone).length === 10) id = Object.keys(db.customers).find((k) => last10(db.customers[k].phone) === last10(f.phone)) || '';
  if (!id && f.name) {
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    id = Object.keys(db.customers).find((k) => same(db.customers[k].name, f.name) && same(db.customers[k].address, f.address)) || '';
  }
  if (!id) {
    if (!f.name) return '';
    id = uid();
    db.customers[id] = { ...f, notes: '', smsOk: c.smsOk !== false, createdBy: by, createdAt: now, updatedAt: now };
    return id;
  }
  const cur = db.customers[id];
  if (f.name) cur.name = f.name;
  if (f.phone) cur.phone = f.phone;
  if (f.email) cur.email = f.email;
  if (f.address && !cur.address) cur.address = f.address;
  if (typeof c.smsOk === 'boolean') cur.smsOk = c.smsOk;
  cur.updatedAt = now;
  return id;
}

// Creates an office task tied to a ticket, unless an open one of that type already exists.
function officeTask(db, by, ticketId, type, description, due) {
  const s = getSettings(db);
  if (!s.autoTasks || !PEOPLE.includes(s.officeAssignee)) return;
  const t = db.tickets[ticketId];
  if (Object.values(db.tasks).some((x) => x.ticketId === ticketId && x.type === type && x.status !== 'done')) return;
  const c = db.customers[t.customerId] || {};
  const id = uid(), now = Date.now();
  db.seq = (db.seq || 0) + 1;
  db.tasks[id] = {
    trades: t.trades || [], type, assignee: s.officeAssignee, customer: c.name || '', phone: c.phone || '', email: c.email || '',
    address: t.address || '', description, due: due || '', amount: type === 'other' ? '' : t.amount || '',
    kind: '', deposit: '', depositPaid: '', colorStatus: '', color: '',
    status: 'todo', createdBy: by, createdAt: now, updatedAt: now, number: db.seq, ticketId, auto: true,
  };
  addActivity(db, id, by, 'moved ticket T-' + t.number + ' forward, which created this task for ' + s.officeAssignee);
  addActivity(db, ticketId, by, 'added task #' + db.seq + ' for ' + s.officeAssignee);
}

function closeTasks(db, by, ticketId, types, why) {
  for (const [id, x] of Object.entries(db.tasks)) {
    if (x.ticketId !== ticketId || !types.includes(x.type) || x.status === 'done') continue;
    x.status = 'done'; x.updatedAt = Date.now();
    addActivity(db, id, by, 'closed this automatically — ' + why);
  }
}

function applySchedule(db, id, { date, time, assignee }, by, now) {
  const t = db.tickets[id];
  const prev = t.date || '';
  t.date = date; t.time = date ? time : '';
  if (assignee !== undefined) t.assignee = assignee;
  if (date !== prev) { delete t.ord; t.reminder = null; }
  const label = date ? prettyDate(date) + (t.assignee ? ' with ' + t.assignee : '') : '';
  if (date && t.stage === 'ticket') { t.stage = 'scheduled'; t.stageAt = now; addActivity(db, id, by, 'scheduled this for ' + label); }
  else if (!date && t.stage === 'scheduled') { t.stage = 'ticket'; t.stageAt = now; addActivity(db, id, by, 'took this off the schedule'); }
  else if (date && date !== prev) addActivity(db, id, by, 'rescheduled this to ' + label);
}

function setStage(db, id, stage, by, o = {}) {
  const t = db.tickets[id], now = Date.now();
  const stages = stagesFor(t.kind);
  if (!stages[stage]) return { error: 'That step does not apply to this ticket.' };
  if (t.stage === stage) return { id };
  if (stage === 'scheduled' && !t.date) return { error: 'Pick a date to put this on the schedule.' };
  if (stage === 'ticket') { t.date = ''; t.time = ''; delete t.ord; t.reminder = null; }
  t.stage = stage; t.stageAt = now; t.updatedAt = now;
  if (str(o.amount, 40)) t.amount = str(o.amount, 40);
  addActivity(db, id, by, 'moved this to ' + stages[stage] + (o.via ? ' (' + o.via + ')' : ''));
  const result = { id };
  switch (stage) {
    case 'visited':
      officeTask(db, by, id, 'estimate', 'Site visit is done — write up and send the estimate.', addDays(todayYmd(), 2));
      break;
    case 'followup':
      t.followUp = isYmd(o.followUp) ? o.followUp : addDays(todayYmd(), 3);
      officeTask(db, by, id, 'estfollow', 'Check in with the customer about the estimate we sent.', t.followUp);
      break;
    case 'lost':
      t.lostReason = str(o.lostReason, 500);
      closeTasks(db, by, id, ['estimate', 'estfollow'], 'the estimate was marked lost');
      break;
    case 'won': {
      closeTasks(db, by, id, ['estimate', 'estfollow'], 'the estimate was won');
      if (t.jobId && db.tickets[t.jobId]) { result.jobId = t.jobId; break; }
      const jid = uid();
      db.tseq = (db.tseq || 0) + 1;
      db.tickets[jid] = {
        kind: pick(o.jobKind, ['repair', 'installation']) || 'installation', trades: t.trades || [], customerId: t.customerId,
        address: t.address || '', lat: t.lat ?? null, lng: t.lng ?? null, description: t.description || '', amount: t.amount || '',
        date: '', time: '', assignee: '', stage: 'ticket', stageAt: now, number: db.tseq, fromEstimateId: id,
        createdBy: by, createdAt: now, updatedAt: now,
      };
      t.jobId = jid;
      addActivity(db, jid, by, 'created this job from won estimate T-' + t.number);
      addActivity(db, id, by, 'created job ticket T-' + db.tseq + ' — it is waiting to be scheduled');
      result.jobId = jid; result.jobNumber = db.tseq;
      break;
    }
    case 'completed':
      officeTask(db, by, id, 'invoice', 'Job is complete — send the invoice.', addDays(todayYmd(), 1));
      break;
    case 'billed':
      officeTask(db, by, id, 'followup', 'Invoice went out — confirm the payment comes in.', addDays(todayYmd(), 14));
      break;
    case 'paid':
      closeTasks(db, by, id, ['invoice', 'followup'], 'the job was marked paid');
      break;
  }
  return result;
}

// Called when an office task is marked done: finishing "Send estimate" or
// "Send invoice" moves the linked ticket along so nobody has to do it twice.
export function advanceFromTask(db, task, by) {
  const t = db.tickets[task.ticketId];
  if (!t) return;
  const via = 'task #' + task.number + ' done';
  if (task.type === 'estimate' && t.kind === 'estimate' && ['ticket', 'scheduled', 'visited'].includes(t.stage)) {
    t.date = t.date || ''; // an estimate can be sent without a visit on the calendar
    const r = setStage(db, task.ticketId, 'sent', by, { via });
    if (r.error) return;
  } else if (task.type === 'invoice' && t.kind !== 'estimate' && t.stage === 'completed') {
    setStage(db, task.ticketId, 'billed', by, { via });
  }
}

export function recordReminder(db, id, by, res, via) {
  const t = db.tickets[id];
  if (!t) return;
  t.reminder = { forDate: t.date || '', at: Date.now(), by, via, status: res.ok ? 'sent' : 'failed', error: res.ok ? '' : str(res.error, 200) };
  addActivity(db, id, by, res.ok ? (via === 'auto' ? 'texted the customer a reminder (automatic)' : 'texted the customer a reminder') : 'tried to text a reminder but it failed: ' + t.reminder.error);
}

// Returns a result for ticket/customer/settings actions, or undefined if `b.op` is not one.
export function ticketOp(db, b, by, pre = {}) {
  const now = Date.now();
  const geoFor = (address, old) => {
    if (pre.geoAddr !== undefined && pre.geoAddr === address) return pre.geo || { lat: null, lng: null };
    if (old && old.address === address) return { lat: old.lat ?? null, lng: old.lng ?? null };
    return { lat: null, lng: null };
  };
  switch (b.op) {
    case 'ticketCreate': {
      const d = b.data || {};
      const t = cleanTicket(d);
      if (!t.kind) return { error: 'Choose estimate, repair or installation.' };
      const customerId = resolveCustomer(db, d, by, now);
      if (!customerId) return { error: 'Customer name is required.' };
      if (!t.address) t.address = db.customers[customerId].address || '';
      const id = uid();
      db.tseq = (db.tseq || 0) + 1;
      db.tickets[id] = { ...t, ...geoFor(t.address), customerId, stage: t.date ? 'scheduled' : 'ticket', stageAt: now, number: db.tseq, createdBy: by, createdAt: now, updatedAt: now };
      addActivity(db, id, by, 'created this ticket' + (t.date ? ' and scheduled it for ' + prettyDate(t.date) : ''));
      const task = db.tasks[d.fromTaskId];
      if (task) { task.ticketId = id; task.updatedAt = now; addActivity(db, d.fromTaskId, by, 'created ticket T-' + db.tseq + ' from this task'); }
      return { id, number: db.tseq };
    }
    case 'ticketUpdate': {
      const old = db.tickets[b.id];
      if (!old) return { error: 'That ticket no longer exists.' };
      const d = b.data || {};
      const t = cleanTicket(d);
      t.kind = old.kind === 'estimate' ? 'estimate' : pick(t.kind, ['repair', 'installation']) || old.kind;
      const customerId = resolveCustomer(db, { ...d, customerId: d.customerId || old.customerId }, by, now) || old.customerId;
      const { date, time, assignee, ...rest } = t;
      Object.assign(old, rest, geoFor(t.address, old), { customerId, updatedAt: now });
      const before = old.stage + old.date;
      applySchedule(db, b.id, { date, time, assignee }, by, now);
      if (before === old.stage + old.date) addActivity(db, b.id, by, 'edited the ticket details');
      return { id: b.id };
    }
    case 'ticketSchedule': {
      const t = db.tickets[b.id];
      if (!t) return { error: 'That ticket no longer exists.' };
      const date = isYmd(b.date) ? b.date : '';
      applySchedule(db, b.id, { date, time: isTime(b.time) ? b.time : '', assignee: pick(b.assignee, PEOPLE) }, by, now);
      t.updatedAt = now;
      return { id: b.id };
    }
    case 'ticketStage': {
      if (!db.tickets[b.id]) return { error: 'That ticket no longer exists.' };
      return setStage(db, b.id, b.stage, by, { jobKind: b.jobKind, lostReason: b.lostReason, followUp: b.followUp, amount: b.amount });
    }
    case 'ticketDelete': {
      const t = db.tickets[b.id];
      if (!t) return { id: b.id };
      delete db.tickets[b.id];
      const blobs = [];
      for (const [nid, n] of Object.entries(db.notes)) if (n.taskId === b.id) delete db.notes[nid];
      for (const [pid, p] of Object.entries(db.photos)) if (p.taskId === b.id) { blobs.push(p.path); delete db.photos[pid]; }
      for (const x of Object.values(db.tasks)) if (x.ticketId === b.id) x.ticketId = '';
      for (const x of Object.values(db.tickets)) { if (x.jobId === b.id) x.jobId = ''; if (x.fromEstimateId === b.id) x.fromEstimateId = ''; }
      return { id: b.id, blobs };
    }
    case 'customerSave': {
      const d = b.data || {};
      const f = { name: str(d.name, 200), phone: str(d.phone, 60), email: str(d.email, 200), address: str(d.address, 300), notes: str(d.notes, 4000), smsOk: d.smsOk !== false };
      if (!f.name) return { error: 'Customer name is required.' };
      if (b.id) {
        if (!db.customers[b.id]) return { error: 'That customer no longer exists.' };
        Object.assign(db.customers[b.id], f, { updatedAt: now });
        return { id: b.id };
      }
      const id = uid();
      db.customers[id] = { ...f, createdBy: by, createdAt: now, updatedAt: now };
      return { id };
    }
    case 'customerDelete': {
      if (Object.values(db.tickets).some((t) => t.customerId === b.id)) return { error: 'This customer has tickets. Delete those first.' };
      delete db.customers[b.id];
      return { id: b.id };
    }
    case 'settings': {
      const d = b.data || {};
      const cur = getSettings(db);
      const shopAddress = str(d.shopAddress, 300);
      const g = geoFor(shopAddress, { address: cur.shopAddress, lat: cur.shopLat, lng: cur.shopLng });
      db.settings = {
        shopAddress, shopLat: g.lat, shopLng: g.lng,
        companyPhone: str(d.companyPhone, 60),
        smsTemplate: str(d.smsTemplate, 600) || DEFAULT_SMS,
        autoSms: d.autoSms !== false,
        skipDays: Array.isArray(d.skipDays) ? [0, 1, 2, 3, 4, 5, 6].filter((n) => d.skipDays.includes(n)) : [],
        autoTasks: d.autoTasks !== false,
        officeAssignee: pick(d.officeAssignee, PEOPLE) || cur.officeAssignee,
      };
      return { ok: true };
    }
    case 'route': {
      if (!isYmd(b.date)) return { error: 'Pick a day first.' };
      for (const [id, g] of Object.entries(pre.geos || {})) {
        const t = db.tickets[id];
        if (t && t.address === g.address && g.lat != null) { t.lat = g.lat; t.lng = g.lng; }
      }
      const s = getSettings(db);
      if (pre.shop && pre.shop.address === s.shopAddress && pre.shop.lat != null) db.settings = { ...s, shopLat: pre.shop.lat, shopLng: pre.shop.lng };
      const shop = getSettings(db);
      const stops = Object.entries(db.tickets)
        .filter(([, t]) => t.date === b.date && t.stage === 'scheduled' && (!b.assignee || t.assignee === b.assignee))
        .map(([id, t]) => ({ id, lat: t.lat, lng: t.lng, ord: t.ord ?? 999, time: t.time || '99', at: t.createdAt }))
        .sort((x, y) => x.ord - y.ord || (x.time < y.time ? -1 : x.time > y.time ? 1 : 0) || x.at - y.at);
      const ordered = bestRoute(stops, hasGeo({ lat: shop.shopLat, lng: shop.shopLng }) ? { lat: shop.shopLat, lng: shop.shopLng } : null);
      ordered.forEach((x, i) => { db.tickets[x.id].ord = i + 1; });
      return { count: ordered.length, missing: ordered.filter((x) => !hasGeo(x)).length };
    }
    case 'reorder': {
      (Array.isArray(b.ids) ? b.ids : []).forEach((id, i) => { if (db.tickets[id]) db.tickets[id].ord = i + 1; });
      return { ok: true };
    }
    case 'reminded': {
      if (!db.tickets[b.id]) return { error: 'That ticket no longer exists.' };
      recordReminder(db, b.id, by, { ok: true }, 'phone');
      return { id: b.id };
    }
  }
  return undefined;
}
