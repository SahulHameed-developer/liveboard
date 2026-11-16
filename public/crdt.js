/**
 * LiveBoard CRDT — a Last-Writer-Wins (LWW) map of cards, keyed by a
 * Hybrid Logical Clock (HLC). Shared verbatim by the Node.js server and the browser.
 *
 * Every card field is an LWW register { v, ts }. An operation sets one or more
 * fields of one card, all stamped with the same HLC timestamp. Because "apply"
 * keeps the field with the greater timestamp, operations are:
 *   - commutative  (any delivery order converges to the same state)
 *   - idempotent   (re-delivering an op changes nothing)
 *   - associative  (batches/snapshots can be merged in any grouping)
 * which is what lets offline clients replay their outbox safely.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CRDT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const COLUMNS = ['todo', 'doing', 'review', 'done'];
  const PRIORITIES = ['low', 'medium', 'high'];
  const FIELDS = {
    title: v => typeof v === 'string' && v.trim().length > 0 && v.length <= 140,
    description: v => typeof v === 'string' && v.length <= 2000,
    column: v => COLUMNS.includes(v),
    order: v => typeof v === 'number' && Number.isFinite(v),
    priority: v => PRIORITIES.includes(v),
    deleted: v => typeof v === 'boolean',
  };
  const ID = /^[A-Za-z0-9_-]{6,64}$/;
  const TS = /^[0-9a-z]{10}\.[0-9a-z]{4}\.[A-Za-z0-9_-]{1,64}$/;

  /** Hybrid Logical Clock: wall-clock ms + counter + actor id, encoded so string comparison = causal order. */
  function createClock(actor, now = () => Date.now()) {
    let l = 0, c = 0;
    const enc = () => `${l.toString(36).padStart(10, '0')}.${c.toString(36).padStart(4, '0')}.${actor}`;
    return {
      actor,
      tick() {
        const p = now();
        if (p > l) { l = p; c = 0; } else c++;
        return enc();
      },
      observe(ts) {
        const [rl, rc] = parseTs(ts);
        const p = now(), nl = Math.max(l, rl, p);
        if (nl === l && nl === rl) c = Math.max(c, rc) + 1;
        else if (nl === l) c++;
        else if (nl === rl) c = rc + 1;
        else c = 0;
        l = nl;
      },
    };
  }
  function parseTs(ts) { const [a, b] = ts.split('.'); return [parseInt(a, 36), parseInt(b, 36)]; }

  function createDoc() { return { cards: {} }; }

  /** Returns null if valid, otherwise an error message. */
  function validateOp(op) {
    if (!op || typeof op !== 'object') return 'op must be an object';
    if (!ID.test(op.id || '')) return 'invalid op id';
    if (!ID.test(op.card || '')) return 'invalid card id';
    if (!TS.test(op.ts || '')) return 'invalid timestamp';
    if (typeof op.by !== 'string' || op.by.length > 40) return 'invalid author';
    if (!op.fields || typeof op.fields !== 'object') return 'fields required';
    const keys = Object.keys(op.fields);
    if (!keys.length) return 'fields required';
    for (const k of keys) {
      if (!FIELDS[k]) return `unknown field "${k}"`;
      if (!FIELDS[k](op.fields[k])) return `invalid value for "${k}"`;
    }
    return null;
  }

  /** Apply an op; returns the list of fields that actually changed. */
  function applyOp(doc, op) {
    const card = doc.cards[op.card] || (doc.cards[op.card] = {});
    const changed = [];
    for (const [k, v] of Object.entries(op.fields)) {
      const cur = card[k];
      if (!cur || cur.ts < op.ts) { card[k] = { v, ts: op.ts }; changed.push(k); }
    }
    return changed;
  }

  /** Merge doc b into doc a (state-based merge). Returns ids of cards that changed. */
  function merge(a, b) {
    const changed = new Set();
    for (const [id, fields] of Object.entries(b.cards || {})) {
      const card = a.cards[id] || (a.cards[id] = {});
      for (const [k, reg] of Object.entries(fields)) {
        if (!card[k] || card[k].ts < reg.ts) { card[k] = { v: reg.v, ts: reg.ts }; changed.add(id); }
      }
    }
    return [...changed];
  }

  /** Highest timestamp in a doc (to advance a clock after loading a snapshot). */
  function maxTs(doc) {
    let m = '';
    for (const card of Object.values(doc.cards)) for (const r of Object.values(card)) if (r.ts > m) m = r.ts;
    return m || null;
  }

  /** Materialised view: live cards grouped by column and sorted by order. */
  function view(doc) {
    const cols = Object.fromEntries(COLUMNS.map(c => [c, []]));
    for (const [id, f] of Object.entries(doc.cards)) {
      if (!f.title || (f.deleted && f.deleted.v)) continue;
      const col = f.column ? f.column.v : 'todo';
      cols[col].push({ id, title: f.title.v, description: f.description ? f.description.v : '',
        column: col, order: f.order ? f.order.v : 0, priority: f.priority ? f.priority.v : 'medium' });
    }
    for (const c of COLUMNS) cols[c].sort((x, y) => x.order - y.order || (x.id < y.id ? -1 : 1));
    return cols;
  }

  /** Fractional index between two neighbours, so moves only touch the moved card. */
  function orderBetween(before, after) {
    if (before == null && after == null) return 1024;
    if (before == null) return after - 1024;
    if (after == null) return before + 1024;
    return (before + after) / 2;
  }

  return { COLUMNS, PRIORITIES, createClock, createDoc, validateOp, applyOp, merge, maxTs, view, orderBetween };
});
