const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

/**
 * Append-only event log (event sourcing). Every accepted operation is stored as one
 * JSON line and emitted as an 'event'. Subscribers (projection, broadcaster, metrics)
 * react to events instead of calling each other directly.
 */
class EventStore extends EventEmitter {
  constructor(file) {
    super();
    this.file = file;
    this.seq = 0;
    this.seen = new Set(); // op ids, for idempotent appends
    this.events = [];
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (fs.existsSync(file)) {
        for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { this._index(JSON.parse(line)); } catch { /* skip a torn last line */ }
        }
      }
    }
  }

  _index(e) {
    this.seq = Math.max(this.seq, e.seq);
    this.seen.add(e.op.id);
    this.events.push(e);
  }

  has(opId) { return this.seen.has(opId); }

  /** Replay all stored events through a handler (used to rebuild projections on startup). */
  replay(handler) { for (const e of this.events) handler(e); }

  /** meta is passed to subscribers but not persisted (e.g. the originating socket id). */
  append(board, op, meta = {}) {
    const e = { seq: this.seq + 1, board, type: 'card.changed', op, at: new Date().toISOString() };
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(e) + '\n');
    this._index(e);
    this.emit('event', e, meta);
    return e;
  }
}

module.exports = { EventStore };
