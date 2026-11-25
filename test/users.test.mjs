// Accounts: username + password sign-in, admin / editor roles, user management.
import assert from 'node:assert/strict';
const { default: auth } = await import('../api/auth.js');
const { default: op } = await import('../api/op.js');
const { default: board } = await import('../api/board.js');
const { default: users } = await import('../api/users.js');

const signIn = async (username, password) => { const r = await auth.fetch(new Request('https://x/api/auth', { method: 'POST', body: JSON.stringify({ username, password }) })); return { status: r.status, body: await r.json(), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };
const call = async (h, cookie, method, body) => { const r = await h.fetch(new Request('https://x/api/x', { method, headers: { cookie }, body: body && JSON.stringify(body) })); return { status: r.status, ...(await r.json()), cookie: (r.headers.get('set-cookie') || '').split(';')[0] }; };

// first run: the original six become accounts; their old 8-digit code is the password
const L = await signIn('ReliableOS ', 'adminpass1');
assert.deepEqual([L.status, L.body.name, L.body.role], [200, 'ReliableOS', 'admin'], 'username is not case-sensitive');
for (const [u, p] of [['loriale', '11111111'], ['mayer', '33333333']]) assert.equal((await signIn(u, p)).body.role, 'editor', 'everyone else starts as an editor');
const B = await signIn('ben', '22222222');
assert.equal(B.body.role, 'editor');
assert.equal((await signIn('ben', 'wrong-password')).status, 401);
assert.equal((await signIn('nobody', '22222222')).body.error, (await signIn('ben', 'nope')).body.error, 'same message whether or not the username exists');
assert.equal((await signIn('klein', '')).status, 400);
assert.ok(L.body.people.some((p) => p.name === 'Mr. Klein' && p.title === 'Foreman') && !JSON.stringify(L.body).includes('hash'));

// editors: everyday work yes; users, settings and deleting tickets no
assert.equal((await call(users, B.cookie, 'GET')).status, 403);
assert.equal((await call(users, B.cookie, 'POST', { action: 'add', name: 'X', username: 'xxx', role: 'admin', password: 'password1' })).status, 403);
assert.equal((await call(op, B.cookie, 'POST', { op: 'settings', data: {} })).status, 403);
let r = await call(op, B.cookie, 'POST', { op: 'ticketCreate', data: { kind: 'repair', customer: { name: 'Role Check' }, address: '' } });
assert.ok(r.ok, 'editor can create a ticket');
const tid = r.result.id;
assert.equal((await call(op, B.cookie, 'POST', { op: 'ticketDelete', id: tid })).status, 403);
r = await call(op, L.cookie, 'POST', { op: 'create', data: { type: 'other', assignee: 'Ben' } });
const lorialesTask = r.result.id;
assert.ok((await call(op, B.cookie, 'POST', { op: 'delete', id: lorialesTask })).error, "an editor can't delete someone else's task");
r = await call(op, B.cookie, 'POST', { op: 'create', data: { type: 'other', assignee: 'Ben' } });
assert.ok((await call(op, B.cookie, 'POST', { op: 'delete', id: r.result.id })).ok, 'but can delete their own');
assert.ok((await call(op, L.cookie, 'POST', { op: 'ticketDelete', id: tid })).ok, 'admin can delete a ticket');

// admin adds a person
const U = (b) => call(users, L.cookie, 'POST', b);
assert.ok((await U({ action: 'add', name: 'Dovid', username: 'D', role: 'editor', password: 'password1' })).error.startsWith('Username'));
assert.ok((await U({ action: 'add', name: 'Dovid', username: 'dovid', role: 'editor', password: 'short' })).error.startsWith('Password'));
assert.ok((await U({ action: 'add', name: 'Dovid', username: 'ben', role: 'editor', password: 'password1' })).error.includes('taken'));
assert.ok((await U({ action: 'add', name: 'ben', username: 'ben2', role: 'editor', password: 'password1' })).error.includes('name'));
r = await U({ action: 'add', name: 'Dovid', username: 'dovid', role: 'editor', title: 'Crew', password: 'password1' });
assert.ok(r.ok && r.users.length === 8);
const did = r.users.find((u) => u.username === 'dovid').id;
let D = await signIn('dovid', 'password1');
assert.equal(D.body.name, 'Dovid');
r = await call(op, L.cookie, 'POST', { op: 'create', data: { type: 'other', assignee: 'Dovid', customer: 'New person task' } });
assert.equal(r.board.tasks[r.result.id].assignee, 'Dovid', 'a new person can be given work straight away');
const dTask = r.result.id;

// rename keeps their work; role change; guards
r = await U({ action: 'update', id: did, name: 'Dovid K.', role: 'editor', title: 'Foreman', active: true });
assert.ok(r.ok);
const bd = await call(board, L.cookie, 'GET');
assert.equal(bd.tasks[dTask].assignee, 'Dovid K.', 'renaming moves their tasks to the new name');
assert.ok(bd.people.some((p) => p.name === 'Dovid K.' && p.title === 'Foreman'));
const lid = r.users.find((u) => u.username === 'reliableos').id, mid = r.users.find((u) => u.username === 'mayer').id;
assert.ok((await U({ action: 'update', id: lid, name: 'ReliableOS', role: 'editor', active: true })).error.includes('own admin'));
assert.ok((await U({ action: 'update', id: lid, name: 'ReliableOS', role: 'admin', active: false })).error.includes('own account'));
assert.ok((await U({ action: 'update', id: mid, name: 'Mayer', role: 'admin', active: true })).ok, 'an editor can be made an admin');
assert.equal((await signIn('mayer', '33333333')).body.role, 'admin');
assert.ok((await U({ action: 'update', id: mid, name: 'Mayer', role: 'editor', active: true })).ok, 'and back to an editor');

// switching an account off signs them out and blocks sign-in; back on works again
await U({ action: 'update', id: did, name: 'Dovid K.', role: 'editor', title: 'Foreman', active: false });
assert.equal((await call(board, D.cookie, 'GET')).status, 401, 'signed out at once');
assert.equal((await signIn('dovid', 'password1')).status, 401);
r = await call(op, L.cookie, 'POST', { op: 'create', data: { type: 'other', assignee: 'Dovid K.' } });
assert.ok(r.error, 'work cannot be given to a switched-off account');
await U({ action: 'update', id: did, name: 'Dovid K.', role: 'editor', title: 'Foreman', active: true });

// passwords: admin reset signs the person out; people change their own
D = await signIn('dovid', 'password1');
assert.ok((await U({ action: 'reset', id: did, password: 'brand-new-pw' })).ok);
assert.equal((await call(board, D.cookie, 'GET')).status, 401, 'old sign-in stops working after a reset');
D = await signIn('dovid', 'brand-new-pw');
assert.ok((await call(users, D.cookie, 'POST', { action: 'password', current: 'nope', password: 'my-own-password' })).error.includes('current'));
assert.ok((await call(users, D.cookie, 'POST', { action: 'password', current: 'brand-new-pw', password: 'brand-new-pw' })).error.includes("haven't used"));
r = await call(users, D.cookie, 'POST', { action: 'password', current: 'brand-new-pw', password: 'my-own-password' });
assert.ok(r.ok && r.cookie, 'changing your own password keeps this device signed in');
assert.equal((await call(board, r.cookie, 'GET')).status, 200);
assert.equal((await call(board, D.cookie, 'GET')).status, 401);
assert.equal((await signIn('dovid', 'my-own-password')).status, 200);

// too many wrong guesses locks the account for a while
const realTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realTimeout(fn, 0);
for (let i = 0; i < 8; i++) await signIn('yehuda', 'guess' + i);
globalThis.setTimeout = realTimeout;
assert.equal((await signIn('yehuda', 'whatever')).status, 429);
console.log('user checks passed');
