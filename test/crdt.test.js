const test = require('node:test');
const assert = require('node:assert');
const CRDT = require('../public/crdt');

const mkOp = (clock, card, fields, by = 'x') => ({ id: 'op' + Math.random().toString(36).slice(2, 12), card, fields, ts: clock.tick(), by });
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

test('HLC timestamps are strictly increasing and causal', () => {
  let t = 1000;
  const a = CRDT.createClock('alice', () => t), b = CRDT.createClock('bob', () => t - 500); // bob's wall clock is behind
  const t1 = a.tick(), t2 = a.tick();
  assert.ok(t2 > t1);
  b.observe(t2);
  assert.ok(b.tick() > t2, 'a clock that observed a remote ts must issue a larger ts, even with clock skew');
});

test('ops converge regardless of delivery order (commutativity)', () => {
  const clocks = ['a1', 'b2', 'c3'].map(id => CRDT.createClock(id));
  const cards = ['card001', 'card002', 'card003'];
  const ops = [];
  for (let i = 0; i < 300; i++) {
    const c = clocks[i % 3], card = cards[i % 3];
    const choice = i % 4;
    const fields = choice === 0 ? { title: 'T' + i, column: 'todo', order: i, deleted: false }
      : choice === 1 ? { column: CRDT.COLUMNS[i % 4], order: i * 1.5 }
      : choice === 2 ? { priority: CRDT.PRIORITIES[i % 3] } : { description: 'd' + i };
    ops.push(mkOp(c, card, fields));
  }
  const states = [];
  for (let r = 0; r < 20; r++) { const d = CRDT.createDoc(); shuffle(ops).forEach(op => CRDT.applyOp(d, op)); states.push(JSON.stringify(CRDT.view(d))); }
  assert.ok(states.every(s => s === states[0]));
});

test('applying an op twice changes nothing (idempotence)', () => {
  const c = CRDT.createClock('a1'), d = CRDT.createDoc();
  const op = mkOp(c, 'card001', { title: 'Hello', column: 'todo', order: 1 });
  assert.deepStrictEqual(CRDT.applyOp(d, op).sort(), ['column', 'order', 'title']);
  const before = JSON.stringify(d);
  assert.deepStrictEqual(CRDT.applyOp(d, op), []);
  assert.strictEqual(JSON.stringify(d), before);
});

test('concurrent edits to different fields are both kept; same field resolves to latest', () => {
  let now = 5000;
  const a = CRDT.createClock('alice', () => now), b = CRDT.createClock('bob', () => now);
  const base = mkOp(a, 'card001', { title: 'Task', column: 'todo', order: 1 });
  const moveByA = mkOp(a, 'card001', { column: 'done' });          // offline edit by Alice
  const renameByB = mkOp(b, 'card001', { title: 'Task (renamed)' }); // concurrent edit by Bob
  now++;
  const renameByA = mkOp(a, 'card001', { title: 'Final title' });
  for (const order of [[base, moveByA, renameByB, renameByA], [renameByA, renameByB, moveByA, base]]) {
    const d = CRDT.createDoc(); order.forEach(op => CRDT.applyOp(d, op));
    const card = CRDT.view(d).done[0];
    assert.strictEqual(card.column, 'done');
    assert.strictEqual(card.title, 'Final title');
  }
});

test('state-based merge equals op-based apply (snapshots + outbox mix safely)', () => {
  const a = CRDT.createClock('a1'), b = CRDT.createClock('b2');
  const opsA = [mkOp(a, 'card001', { title: 'A', column: 'todo', order: 1 }), mkOp(a, 'card002', { title: 'B', column: 'doing', order: 1 })];
  const opsB = [mkOp(b, 'card001', { column: 'review' }), mkOp(b, 'card002', { deleted: true })];
  const docA = CRDT.createDoc(), docB = CRDT.createDoc(), all = CRDT.createDoc();
  opsA.forEach(o => CRDT.applyOp(docA, o)); opsB.forEach(o => CRDT.applyOp(docB, o));
  [...opsA, ...opsB].forEach(o => CRDT.applyOp(all, o));
  CRDT.merge(docA, docB);
  assert.deepStrictEqual(CRDT.view(docA), CRDT.view(all));
  assert.strictEqual(CRDT.view(all).doing.length, 0, 'deleted card is a tombstone, hidden from the view');
});

test('fractional ordering inserts between neighbours', () => {
  assert.strictEqual(CRDT.orderBetween(null, null), 1024);
  assert.strictEqual(CRDT.orderBetween(1024, 2048), 1536);
  assert.ok(CRDT.orderBetween(null, 10) < 10);
  assert.ok(CRDT.orderBetween(10, null) > 10);
});

test('validateOp rejects malformed or malicious ops', () => {
  const c = CRDT.createClock('a1');
  const ok = mkOp(c, 'card001', { title: 'x' });
  assert.strictEqual(CRDT.validateOp(ok), null);
  assert.match(CRDT.validateOp({ ...ok, fields: { column: 'nope' } }), /column/);
  assert.match(CRDT.validateOp({ ...ok, fields: { __proto__x: 1 } }), /unknown field/);
  assert.match(CRDT.validateOp({ ...ok, card: '../etc' }), /card id/);
  assert.match(CRDT.validateOp({ ...ok, fields: { title: 'x'.repeat(141) } }), /title/);
  assert.match(CRDT.validateOp({ ...ok, ts: 'zzz' }), /timestamp/);
});
