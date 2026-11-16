/**
 * Two interchangeable transports with the same interface:
 *  - SocketTransport: Socket.IO to the Node.js server (the real deployment)
 *  - LocalTransport:  BroadcastChannel between browser tabs (static demo on GitHub Pages,
 *                     where there is no server) — every tab is a peer.
 * Interface: connect(), disconnect(), send(op) -> Promise<ack>, cursor(p), focus(card), on(event, fn)
 */
(function () {
  class Emitter {
    constructor() { this.h = {}; }
    on(e, f) { (this.h[e] = this.h[e] || []).push(f); return this; }
    emit(e, ...a) { (this.h[e] || []).forEach(f => f(...a)); }
  }

  class SocketTransport extends Emitter {
    constructor(board, user) {
      super(); this.board = board; this.user = user; this.kind = 'server';
      this.socket = io({ autoConnect: false, transports: ['websocket', 'polling'] });
      const s = this.socket;
      s.on('connect', () => s.emit('join', { board, user }, res => res.ok ? this.emit('ready', res) : this.emit('error', res.error)));
      s.on('disconnect', () => this.emit('down'));
      s.on('connect_error', () => this.emit('down'));
      s.on('op', (op, seq) => this.emit('op', op, seq));
      s.on('cursor', p => this.emit('cursor', p));
      s.on('presence:join', u => this.emit('join', u));
      s.on('presence:leave', id => this.emit('leave', id));
      s.on('presence:focus', f => this.emit('focus', f));
    }
    get online() { return this.socket.connected; }
    connect() { this.socket.connect(); }
    disconnect() { this.socket.disconnect(); this.emit('down'); }
    send(op) {
      return new Promise(res => this.socket.timeout(5000).emit('op', op, (err, ack) => res(err ? { ok: false, error: 'timeout', retry: true } : ack)));
    }
    cursor(p) { if (this.online) this.socket.volatile.emit('cursor', p); }
    focus(card) { if (this.online) this.socket.emit('focus', card); }
  }

  class LocalTransport extends Emitter {
    constructor(board, user, getDoc) {
      super(); this.board = board; this.user = user; this.getDoc = getDoc; this.kind = 'local'; this._online = false;
      this.ch = new BroadcastChannel('liveboard:' + board);
      this.ch.onmessage = ({ data: m }) => {
        if (!this._online || m.from === user.id) return;
        if (m.t === 'hello') { this.emit('join', m.user); this.post({ t: 'welcome', to: m.user.id, user: this.user, doc: this.getDoc() }); }
        if (m.t === 'welcome' && m.to === user.id) { this.emit('join', m.user); this.emit('snapshot', m.doc); }
        if (m.t === 'bye') this.emit('leave', m.from);
        if (m.t === 'op') this.emit('op', m.op);
        if (m.t === 'cursor') this.emit('cursor', { id: m.from, ...m.p });
        if (m.t === 'focus') this.emit('focus', { id: m.from, card: m.card });
      };
      addEventListener('pagehide', () => this.post({ t: 'bye' }));
    }
    post(m) { this.ch.postMessage({ ...m, from: this.user.id }); }
    get online() { return this._online; }
    connect() { this._online = true; this.emit('ready', { ok: true, doc: null, users: [] }); this.post({ t: 'hello', user: this.user }); }
    disconnect() { this.post({ t: 'bye' }); this._online = false; this.emit('down'); }
    send(op) { if (!this._online) return Promise.resolve({ ok: false, retry: true }); this.post({ t: 'op', op }); return Promise.resolve({ ok: true }); }
    cursor(p) { if (this._online) this.post({ t: 'cursor', p }); }
    focus(card) { if (this._online) this.post({ t: 'focus', card }); }
  }

  window.Transports = { SocketTransport, LocalTransport };
})();
