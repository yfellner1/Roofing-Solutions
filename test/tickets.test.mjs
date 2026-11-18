// Tickets, customers, pipelines, routing and reminders. Network calls are stubbed.
import assert from 'node:assert/strict';
const sent = [];
const COORDS = { '1 North St': [41.10, -74.00], '2 Far East Rd': [41.10, -73.50], '3 Middle Ave': [41.10, -73.75], '9 Shop West Rd': [41.10, -74.05] };
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes('geocoding.geo.census.gov')) {
    const a = new URL(url).searchParams.get('address');
    const c = COORDS[a];
    return new Response(JSON.stringify({ result: { addressMatches: c ? [{ coordinates: { y: c[0], x: c[1] } }] : [] } }));
  }
  if (url.includes('nominatim')) return new Response('[]');
  if (url.includes('api.twilio.com')) { sent.push(Object.fromEntries(opts.body)); return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }); }
  throw new Error('unexpected fetch ' + url);
};
const { default: auth } = await import('../api/auth.js');
const { default: op } = await import('../api/op.js');
const { default: remind } = await import('../api/remind.js');
const { todayYmd, addDays } = await import('../api/_lib.js');
const { bestRoute } = await import('../api/_geo.js');
const { e164 } = await import('../api/_sms.js');

const login = async (pin) => (await auth.fetch(new Request('https://x/api/auth', { method: 'POST', body: JSON.stringify({ pin }) }))).headers.get('set-cookie').split(';')[0];
const cookie = await login('11111111');
const post = async (b) => { const r = await op.fetch(new Request('https://x/api/op', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(b) })); return r.json(); };
const tomorrow = addDays(todayYmd(), 1);

// --- ticket first, schedule second; customer is remembered
let r = await post({ op: 'ticketCreate', data: { kind: 'estimate', trades: ['roof', 'gutters'], customer: { name: 'Dana Smith', phone: '(845) 555-0101', email: 'd@x.com' }, address: '1 North St', description: 'Leak by chimney', date: '', assignee: 'Ben' } });
const est = r.result.id;
assert.equal(r.board.tickets[est].stage, 'ticket', 'new ticket waits to be scheduled');
assert.equal(r.board.tickets[est].lat, 41.10, 'address was located');
assert.equal(Object.keys(r.board.customers).length, 1);
r = await post({ op: 'ticketCreate', data: { kind: 'repair', trades: ['siding'], customer: { name: 'D. Smith', phone: '845-555-0101' }, address: '2 Far East Rd' } });
const rep = r.result.id;
assert.equal(Object.keys(r.board.customers).length, 1, 'same phone = same customer, no duplicate');
assert.equal(r.board.tickets[rep].customerId, r.board.tickets[est].customerId);
assert.equal((await post({ op: 'ticketCreate', data: { kind: 'repair', customer: {} } })).error, 'Customer name is required.');

assert.ok((await post({ op: 'ticketStage', id: est, stage: 'scheduled' })).error, 'cannot be scheduled without a date');
r = await post({ op: 'ticketSchedule', id: est, date: tomorrow, time: '09:00', assignee: 'Ben' });
assert.equal(r.board.tickets[est].stage, 'scheduled');

// --- estimate pipeline, talking to the task board
r = await post({ op: 'ticketStage', id: est, stage: 'visited' });
let task = Object.entries(r.board.tasks).find(([, t]) => t.ticketId === est && t.type === 'estimate');
assert.ok(task, 'visiting creates a "send estimate" task');
assert.equal(task[1].assignee, 'Loriale');
assert.equal(task[1].customer, 'D. Smith');
assert.ok((await post({ op: 'ticketStage', id: est, stage: 'billed' })).error, 'estimates cannot use job steps');
r = await post({ op: 'status', id: task[0], status: 'done' });
assert.equal(r.board.tickets[est].stage, 'sent', 'finishing the task moves the estimate to sent');
r = await post({ op: 'ticketStage', id: est, stage: 'followup', followUp: tomorrow });
const fu = Object.entries(r.board.tasks).find(([, t]) => t.ticketId === est && t.type === 'estfollow');
assert.equal(fu[1].due, tomorrow);
r = await post({ op: 'ticketStage', id: est, stage: 'lost', lostReason: 'Went with someone cheaper' });
assert.equal(r.board.tickets[est].lostReason, 'Went with someone cheaper');
assert.equal(r.board.tasks[fu[0]].status, 'done', 'open follow-up task closes when lost');
r = await post({ op: 'ticketStage', id: est, stage: 'won', jobKind: 'installation', amount: '$12,400' });
const job = r.result.jobId;
assert.ok(job, 'winning creates a job ticket');
assert.deepEqual([r.board.tickets[job].kind, r.board.tickets[job].stage, r.board.tickets[job].amount, r.board.tickets[job].fromEstimateId], ['installation', 'ticket', '$12,400', est]);
r = await post({ op: 'ticketStage', id: est, stage: 'followup' });
r = await post({ op: 'ticketStage', id: est, stage: 'won' });
assert.equal(r.result.jobId, job, 'winning twice does not create a second job');

// --- job pipeline
await post({ op: 'ticketSchedule', id: job, date: tomorrow, time: '', assignee: 'Ben' });
r = await post({ op: 'ticketStage', id: job, stage: 'completed' });
const inv = Object.entries(r.board.tasks).find(([, t]) => t.ticketId === job && t.type === 'invoice');
assert.ok(inv, 'completing creates a "send invoice" task');
r = await post({ op: 'status', id: inv[0], status: 'done' });
assert.equal(r.board.tickets[job].stage, 'billed', 'invoice task done moves job to billed');
const pay = Object.entries(r.board.tasks).find(([, t]) => t.ticketId === job && t.type === 'followup');
assert.ok(pay, 'billing creates a payment follow-up task');
r = await post({ op: 'ticketStage', id: job, stage: 'paid' });
assert.equal(r.board.tasks[pay[0]].status, 'done');

// --- manual task linked to a ticket, notes on tickets
r = await post({ op: 'create', data: { type: 'deposit', assignee: 'Loriale', ticketId: rep } });
assert.equal(r.board.tasks[r.result.id].ticketId, rep);
r = await post({ op: 'note', id: rep, text: 'Gate code 1234' });
assert.ok(r.ok);

// --- routing: shop is west, so the day should run west → east
await post({ op: 'settings', data: { shopAddress: '9 Shop West Rd', companyPhone: '845-555-0000' } });
r = await post({ op: 'ticketCreate', data: { kind: 'repair', customer: { name: 'Mid Person', phone: '8455550202' }, address: '3 Middle Ave', date: tomorrow } });
const mid = r.result.id;
await post({ op: 'ticketSchedule', id: rep, date: tomorrow, time: '', assignee: '' });
r = await post({ op: 'route', date: tomorrow });
const order = Object.entries(r.board.tickets).filter(([, t]) => t.date === tomorrow && t.ord).sort((a, b) => a[1].ord - b[1].ord).map(([, t]) => t.address);
assert.deepEqual(order, ['3 Middle Ave', '2 Far East Rd'], 'route runs nearest-first from the shop');
const pts = [{ id: 'a', lat: 0, lng: 0 }, { id: 'b', lat: 0, lng: 3 }, { id: 'c', lat: 0, lng: 1 }, { id: 'd', lat: 0, lng: 2 }, { id: 'e' }];
assert.equal(bestRoute(pts, null).map((p) => p.id).join(''), 'acdbe', 'no shop: still a straight line, unlocated stop last');
r = await post({ op: 'reorder', ids: [mid, rep] });
assert.equal(r.board.tickets[mid].ord, 1);

// --- reminders
assert.equal(e164('(845) 555-0101'), '+18455550101');
assert.equal(e164('555-0101'), '');
const cron = (h) => remind.fetch(new Request('https://x/api/remind', { headers: h }));
assert.equal((await cron({})).status, 401, 'cron endpoint is locked');
let c = await (await cron({ authorization: 'Bearer cronsecret' })).json();
assert.equal(c.sent, 2, 'only still-scheduled tickets for tomorrow are texted: ' + JSON.stringify(c));
assert.ok(sent[0].Body.includes('tomorrow') && sent[0].To.startsWith('+1845555'), sent[0].Body);
c = await (await cron({ authorization: 'Bearer cronsecret' })).json();
assert.equal(c.sent, 0, 'nobody is texted twice');
const rp = (b) => remind.fetch(new Request('https://x/api/remind', { method: 'POST', headers: { cookie }, body: JSON.stringify(b) })).then((x) => x.json());
const pv = await rp({ id: mid, preview: true });
assert.ok(pv.text.includes('Mid') && pv.text.includes('repair') && pv.text.includes('845-555-0000'), pv.text);
const n = sent.length;
r = await rp({ id: mid, text: 'Custom words' });
assert.equal(sent[n].Body, 'Custom words');
assert.equal(r.board.tickets[mid].reminder.status, 'sent');
r = await post({ op: 'ticketSchedule', id: mid, date: addDays(tomorrow, 1), time: '', assignee: '' });
assert.equal(r.board.tickets[mid].reminder, null, 'rescheduling clears the reminder so a new one goes out');

// --- cleanup rules
assert.ok((await post({ op: 'customerDelete', id: r.board.tickets[mid].customerId })).error);
r = await post({ op: 'ticketDelete', id: rep });
assert.ok(!r.board.tickets[rep] && !Object.values(r.board.tasks).some((t) => t.ticketId === rep) && !Object.values(r.board.notes).some((x) => x.taskId === rep));
console.log('ticket checks passed');
