const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../src/app');
const CRDT = require('../public/crdt');

const start = (opts) => new Promise(r => { const s = createServer(opts); s.server.listen(0, () => r({ ...s, url: `http://127.0.0.1:${s.server.address().port}` })); });
const stop = (s) => new Promise(r => { s.io.close(); s.server.close(() => r()); });
const client = (url) => connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
const emit = (sock, ev, data) => new Promise(r => sock.emit(ev, data, r));
const once = (sock, ev) => new Promise(r => sock.once(ev, (...a) => r(a)));
const user = (id, color = '#2563eb') => ({ id, name: 'User ' + id, color });
let n = 0;
const op = (clock, card, fields) => ({ id: 'opid' + (++n) + 'abcd', card, fields, ts: clock.tick(), by: 'tester' });

test('ops are acknowledged, broadcast to other clients and not echoed to the sender', async () => {
  const s = await start();
  const a = client(s.url), b = client(s.url);
  await emit(a, 'join', { board: 'team', user: user('alice') });
  const joinB = once(a, 'presence:join');
  await emit(b, 'join', { board: 'team', user: user('bob', '#7c3aed') });
  assert.strictEqual((await joinB)[0].id, 'bob');

  let echoed = false; a.on('op', () => { echoed = true; });
  const got = once(b, 'op');
  const o = op(CRDT.createClock('alice'), 'card001', { title: 'Ship it', column: 'todo', order: 1 });
  const ack = await emit(a, 'op', o);
  assert.deepStrictEqual(ack, { ok: true, seq: 1 });
  assert.strictEqual((await got)[0].id, o.id);
  await new Promise(r => setTimeout(r, 50));
  assert.strictEqual(echoed, false);
  a.close(); b.close(); await stop(s);
});

test('invalid ops are rejected; duplicate ops (offline replay) are idempotent', async () => {
  const s = await start();
  const a = client(s.url);
  await emit(a, 'join', { board: 'team', user: user('alice') });
  const bad = await emit(a, 'op', { id: 'x', card: 'y', fields: {}, ts: 'z', by: 'q' });
  assert.strictEqual(bad.ok, false);
  const o = op(CRDT.createClock('alice'), 'card001', { title: 'Once', column: 'todo', order: 1 });
  assert.strictEqual((await emit(a, 'op', o)).ok, true);
  assert.deepStrictEqual(await emit(a, 'op', o), { ok: true, duplicate: true });
  assert.strictEqual(s.store.seq, 1);
  a.close(); await stop(s);
});

test('late joiners get a snapshot; boards are isolated', async () => {
  const s = await start();
  const a = client(s.url);
  await emit(a, 'join', { board: 'one', user: user('alice') });
  await emit(a, 'op', op(CRDT.createClock('alice'), 'card001', { title: 'On board one', column: 'doing', order: 1 }));
  const b = client(s.url), c = client(s.url);
  const r1 = await emit(b, 'join', { board: 'one', user: user('bob') });
  const r2 = await emit(c, 'join', { board: 'two', user: user('carol') });
  assert.strictEqual(CRDT.view(r1.doc).doing[0].title, 'On board one');
  assert.strictEqual(Object.keys(r2.doc.cards).length, 0);
  [a, b, c].forEach(x => x.close()); await stop(s);
});

test('event log is persisted and replayed into the same state after restart', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lb-')), 'events.jsonl');
  let s = await start({ dataFile: file });
  const a = client(s.url);
  await emit(a, 'join', { board: 'team', user: user('alice') });
  const clock = CRDT.createClock('alice');
  await emit(a, 'op', op(clock, 'card001', { title: 'Persist me', column: 'todo', order: 1 }));
  await emit(a, 'op', op(clock, 'card001', { column: 'done' }));
  const before = JSON.stringify(CRDT.view(s.boards.get('team')));
  a.close(); await stop(s);
  s = await start({ dataFile: file });
  assert.strictEqual(s.store.seq, 2);
  assert.strictEqual(JSON.stringify(CRDT.view(s.boards.get('team'))), before);
  await stop(s);
});

test('cursor and focus presence are relayed; leave is broadcast on disconnect', async () => {
  const s = await start();
  const a = client(s.url), b = client(s.url);
  await emit(a, 'join', { board: 'team', user: user('alice') });
  await emit(b, 'join', { board: 'team', user: user('bob') });
  const cur = once(b, 'cursor'); a.emit('cursor', { x: 0.25, y: 2 });
  assert.deepStrictEqual((await cur)[0], { id: 'alice', x: 0.25, y: 1 }, 'coordinates are clamped');
  const foc = once(b, 'presence:focus'); a.emit('focus', 'card001');
  assert.deepStrictEqual((await foc)[0], { id: 'alice', card: 'card001' });
  const left = once(b, 'presence:leave'); a.close();
  assert.strictEqual((await left)[0], 'alice');
  b.close(); await stop(s);
});

test('per-socket rate limiting', async () => {
  const s = await start({ opsPerSecond: 5 });
  const a = client(s.url);
  await emit(a, 'join', { board: 'team', user: user('alice') });
  const clock = CRDT.createClock('alice');
  const acks = await Promise.all(Array.from({ length: 10 }, (_, i) => emit(a, 'op', op(clock, 'card00' + i, { title: 't', column: 'todo', order: i }))));
  assert.ok(acks.some(x => x.error === 'rate limited' && x.retry));
  a.close(); await stop(s);
});
