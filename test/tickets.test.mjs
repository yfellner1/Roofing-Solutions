// Tickets, customers, pipelines, routing and reminders. Network calls are stubbed.
import assert from 'node:assert/strict';
const sent = [], routeCalls = [];
const COORDS = { '1 North St': [41.10, -74.00], '2 Far East Rd': [41.10, -73.50], '3 Middle Ave': [41.10, -73.75], '9 Shop West Rd': [41.10, -74.05] };
globalThis.fetch = async (url, opts) => {
  url = String(url);
  if (url.includes('geocoding.geo.census.gov')) {
    const a = new URL(url).searchParams.get('address');
    const c = COORDS[a];
    return new Response(JSON.stringify({ result: { addressMatches: c ? [{ coordinates: { y: c[0], x: c[1] } }] : [] } }));
  }
  if (url.includes('nominatim')) return new Response('[]');
  if (url.includes('photon.komoot.io')) return new Response(JSON.stringify({ features: [
    { geometry: { coordinates: [-74.07, 41.11] }, properties: { countrycode: 'US', housenumber: '14', street: 'Maple Avenue', city: 'Monsey', state: 'New York', postcode: '10952', type: 'house' } },
    { geometry: { coordinates: [2.3, 48.8] }, properties: { countrycode: 'FR', street: 'Rue Maple', city: 'Paris' } },
    { geometry: { coordinates: [-74.0, 41.0] }, properties: { countrycode: 'US', name: 'Maple Avenue', city: 'Suffern', state: 'New York', type: 'street' } },
  ] }));
  if (url.includes('places.googleapis.com/v1/places:autocomplete')) {
    const b = JSON.parse(opts.body);
    return new Response(JSON.stringify({ suggestions: b.locationRestriction ? [] : [{ placePrediction: { placeId: 'pid_1', text: { text: '14 Maple Ave, Monsey, NY, USA' } } }] }));
  }
  if (url.includes('places.googleapis.com/v1/places/pid_1')) return new Response(JSON.stringify({ formattedAddress: '14 Maple Ave, Monsey, NY 10952, USA', location: { latitude: 41.1, longitude: -74.07 } }));
  if (url.includes('routes.googleapis.com')) {
    const b = JSON.parse(opts.body);
    routeCalls.push(b);
    const n = b.intermediates.length;
    // Pretend Google reverses the middle stops when asked to optimise.
    return new Response(JSON.stringify({ routes: [{ optimizedIntermediateWaypointIndex: b.optimizeWaypointOrder ? [...Array(n).keys()].reverse() : [], legs: [...Array(n + 1)].map((_, i) => ({ duration: (600 + i * 60) + 's', distanceMeters: 8046.72 })) }] }));
  }
  if (url.includes('api.twilio.com')) { sent.push(Object.fromEntries(opts.body)); return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }); }
  throw new Error('unexpected fetch ' + url);
};
const { default: auth } = await import('../api/auth.js');
const { default: op } = await import('../api/op.js');
const { default: remind } = await import('../api/remind.js');
const { todayYmd, addDays } = await import('../api/_lib.js');
const { bestRoute, planOrder } = await import('../api/_geo.js');
const { default: nightly } = await import('../api/nightly.js');
const { default: backup } = await import('../api/backup.js');
const { default: push } = await import('../api/push.js');
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

// --- address suggestions
const { default: places } = await import('../api/places.js');
assert.equal((await places.fetch(new Request('https://x/api/places?q=14+maple'))).status, 401);
const pl = await (await places.fetch(new Request('https://x/api/places?q=14+maple', { headers: { cookie } }))).json();
assert.deepEqual(pl.results, [{ label: '14 Maple Avenue, Monsey, NY 10952', lat: 41.11, lng: -74.07 }, { label: '14 Maple Avenue, Suffern, NY' }], 'US only, formatted, typed number kept when the map lacks it');
process.env.GOOGLE_MAPS_KEY = 'k';
const gq = (qs) => places.fetch(new Request('https://x/api/places?' + qs, { headers: { cookie } })).then((x) => x.json());
assert.deepEqual((await gq('q=14+maple&lat=41.1&lng=-74')).results, [{ label: '14 Maple Ave, Monsey, NY', id: 'pid_1' }], 'Google: nothing nearby widens the search');
assert.deepEqual((await gq('id=pid_1&s=abc')).result, { label: '14 Maple Ave, Monsey, NY 10952', lat: 41.1, lng: -74.07 }, 'picked suggestion gets ZIP + map point');
delete process.env.GOOGLE_MAPS_KEY;
r = await post({ op: 'ticketCreate', data: { kind: 'repair', customer: { name: 'Geo Pick' }, address: 'Nowhere Known Rd', geo: { address: 'Nowhere Known Rd', lat: 40.5, lng: -74.5 } } });
assert.equal(r.board.tickets[r.result.id].lat, 40.5, 'picked suggestion supplies the map point');

// --- route planning: fixed times stay in clock order, real drive times from Google
const tp = [{ id: 'late', lat: 0, lng: 1, time: '14:00' }, { id: 'early', lat: 0, lng: 5, time: '08:00' }, { id: 'free', lat: 0, lng: 4.5 }, { id: 'free2', lat: 0, lng: 0.5 }];
assert.equal(planOrder(tp, { lat: 0, lng: 0 }).map((x) => x.id).join(','), 'free2,free,early,late', 'untimed stops slot in around the appointments (early stays before late)');
const day = addDays(tomorrow, 5);
const mkStop = async (name, addr, time) => (await post({ op: 'ticketCreate', data: { kind: 'repair', customer: { name, phone: '845555' + String(1000 + name.charCodeAt(5)) }, address: addr, date: day, time } })).result.id;
const sA = await mkStop('Stop A', '1 North St', ''), sB = await mkStop('Stop B', '3 Middle Ave', ''), sC = await mkStop('Stop C', '2 Far East Rd', '');
r = await post({ op: 'route', date: day });
assert.equal(r.result.drive, 'estimate', 'no Google key: straight-line estimate');
assert.ok(!r.board.tickets[sA].leg);
process.env.GOOGLE_MAPS_KEY = 'k';
r = await post({ op: 'route', date: day });
assert.equal(r.result.drive, 'google');
assert.ok(routeCalls.at(-1).optimizeWaypointOrder, 'no fixed times: Google may reorder');
assert.deepEqual([r.board.tickets[sC].ord, r.board.tickets[sB].ord, r.board.tickets[sA].ord], [1, 2, 3], "Google's order is saved");
assert.deepEqual(r.board.tickets[sC].leg, { mi: 5, min: 10, d: day }, 'real minutes and miles are stored per stop');
await post({ op: 'ticketSchedule', id: sB, date: day, time: '07:30', assignee: '' });
r = await post({ op: 'route', date: day });
assert.equal(routeCalls.at(-1).optimizeWaypointOrder, false, 'a fixed time stops Google reordering');
assert.equal(r.board.tickets[sB].ord, 2, 'shop → A (on the way) → B at 7:30');
r = await post({ op: 'reorder', ids: [sC, sA, sB] });
assert.ok(!r.board.tickets[sA].leg, 'moving a stop by hand clears the stale drive time');
delete process.env.GOOGLE_MAPS_KEY;

// --- on-my-way and thank-you texts
const before = sent.length;
let tx = await rp({ id: sA, kind: 'omw', preview: true });
assert.ok(tx.text.includes('on the way to 1 North St'), tx.text);
r = await rp({ id: sA, kind: 'omw' });
assert.equal(sent.length, before + 1);
assert.ok(r.board.tickets[sA].texts.omw.at && !r.board.tickets[sA].reminder, 'logged as on-my-way, not as the reminder');
await post({ op: 'settings', data: { shopAddress: '9 Shop West Rd', companyPhone: '845-555-0000', reviewLink: 'https://g.page/r/abc', autoThanks: true } });
tx = await rp({ id: sA, kind: 'thanks', preview: true });
assert.ok(tx.text.includes('https://g.page/r/abc'), tx.text);
await post({ op: 'ticketCreate', data: { kind: 'repair', customer: { name: 'Pay Me', phone: '8455550303' }, address: '1 North St', date: day } }).then(async (x) => {
  for (const st of ['completed', 'billed']) await post({ op: 'ticketStage', id: x.result.id, stage: st });
  const n = sent.length;
  const done = await post({ op: 'ticketStage', id: x.result.id, stage: 'paid' });
  assert.equal(sent.length, n + 1, 'paid sends the thank-you automatically when that is switched on');
  assert.ok(done.board.tickets[x.result.id].texts.thanks && !('sendThanks' in done.result));
});

// --- nightly backup + restore
assert.equal((await nightly.fetch(new Request('https://x/api/nightly'))).status, 401);
const nb = await (await nightly.fetch(new Request('https://x/api/nightly', { headers: { authorization: 'Bearer cronsecret' } }))).json();
assert.ok(nb.backup.ok && nb.backup.name.startsWith('backups/board-') && nb.reminders.ok, JSON.stringify(nb));
const bk = (m, body, c = cookie) => backup.fetch(new Request('https://x/api/backup', { method: m, headers: { cookie: c }, body: body && JSON.stringify(body) })).then(async (x) => ({ status: x.status, ...(await x.json()) }));
let bl = await bk('GET');
assert.equal(bl.backups.length, 1);
const countBefore = Object.keys((await post({ op: 'reorder', ids: [] })).board.tickets).length;
await post({ op: 'ticketDelete', id: sA }); await post({ op: 'ticketDelete', id: sB });
const benCookie = await login('22222222');
assert.equal((await bk('POST', { action: 'restore', name: bl.backups[0].name }, benCookie)).status, 403, 'foremen cannot restore');
assert.equal((await bk('POST', { action: 'restore', name: '../db/board.json' })).status, 400);
const rs = await bk('POST', { action: 'restore', name: bl.backups[0].name });
assert.equal(Object.keys(rs.board.tickets).length, countBefore, 'restore brings deleted tickets back');
bl = await bk('GET');
assert.ok(bl.backups.some((x) => x.name.startsWith('backups/before-restore-')), 'the board as it was is kept, so a restore can be undone');
assert.ok((await bk('POST', { action: 'now' })).ok);

// --- alerts endpoint (no keys in tests: reports not set up, saving still works)
const pg = await (await push.fetch(new Request('https://x/api/push', { headers: { cookie } }))).json();
assert.equal(pg.configured, false);
r = await post({ op: 'create', data: { type: 'other', assignee: 'Ben', customer: 'Alert Check' } });
assert.ok(r.ok, 'saving works when alerts are not configured');

// --- cleanup rules
assert.ok((await post({ op: 'customerDelete', id: r.board.tickets[mid].customerId })).error);
r = await post({ op: 'ticketDelete', id: rep });
assert.ok(!r.board.tickets[rep] && !Object.values(r.board.tasks).some((t) => t.ticketId === rep) && !Object.values(r.board.notes).some((x) => x.taskId === rep));
console.log('ticket checks passed');
