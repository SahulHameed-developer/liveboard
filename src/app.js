const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const CRDT = require('../public/crdt');
const { EventStore } = require('./eventStore');

const BOARD = /^[a-z0-9-]{1,40}$/;
const COLOR = /^#[0-9a-f]{6}$/i;

/**
 * Event-driven backend:
 *   socket 'op' -> validate -> EventStore.append -> 'event'
 *                                       ├─ projection: apply to in-memory board doc
 *                                       ├─ broadcaster: push to everyone else in the room
 *                                       └─ metrics
 */
function createServer({ dataFile = null, opsPerSecond = 40 } = {}) {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: '*' } });
  const store = new EventStore(dataFile);
  const boards = new Map(); // board -> CRDT doc (projection)
  const presence = new Map(); // board -> Map(socketId -> user)
  const metrics = { events: 0, connections: 0 };

  const docFor = b => boards.get(b) || boards.set(b, CRDT.createDoc()).get(b);
  const usersIn = b => [...(presence.get(b) || new Map()).values()];

  // --- subscribers ---------------------------------------------------------
  const project = e => CRDT.applyOp(docFor(e.board), e.op);
  store.replay(project);
  store.on('event', project);
  store.on('event', e => { metrics.events++; });
  store.on('event', (e, meta) => io.to(e.board).except(meta.origin || []).emit('op', e.op, e.seq));

  // --- HTTP ----------------------------------------------------------------
  app.disable('x-powered-by');
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get('/api/health', (req, res) => res.json({ status: 'ok', seq: store.seq, boards: boards.size, ...metrics }));
  app.get('/api/boards/:board', (req, res) => {
    if (!BOARD.test(req.params.board)) return res.status(400).json({ error: 'invalid board id' });
    res.json({ board: req.params.board, seq: store.seq, view: CRDT.view(docFor(req.params.board)) });
  });

  // --- realtime ------------------------------------------------------------
  io.on('connection', socket => {
    metrics.connections++;
    let board = null, user = null, budget = opsPerSecond, last = Date.now();
    const leave = () => {
      if (!board) return;
      presence.get(board)?.delete(socket.id);
      socket.to(board).emit('presence:leave', user.id);
      socket.leave(board);
    };

    socket.on('join', (msg, ack) => {
      if (typeof ack !== 'function') return;
      const u = msg && msg.user;
      if (!msg || !BOARD.test(msg.board || '') || !u || typeof u.id !== 'string' || typeof u.name !== 'string' || !COLOR.test(u.color || ''))
        return ack({ ok: false, error: 'invalid join' });
      leave();
      board = msg.board;
      user = { id: u.id.slice(0, 64), name: u.name.slice(0, 40), color: u.color, focus: null };
      socket.join(board);
      if (!presence.has(board)) presence.set(board, new Map());
      presence.get(board).set(socket.id, user);
      socket.to(board).emit('presence:join', user);
      ack({ ok: true, doc: docFor(board), seq: store.seq, users: usersIn(board).filter(x => x !== user) });
    });

    socket.on('op', (op, ack) => {
      if (typeof ack !== 'function') return;
      if (!board) return ack({ ok: false, error: 'join a board first' });
      const now = Date.now();
      budget = Math.min(opsPerSecond, budget + ((now - last) / 1000) * opsPerSecond); last = now;
      if (budget < 1) return ack({ ok: false, error: 'rate limited', retry: true });
      budget--;
      const err = CRDT.validateOp(op);
      if (err) return ack({ ok: false, error: err });
      if (store.has(op.id)) return ack({ ok: true, duplicate: true }); // idempotent replay from an offline outbox
      const clean = { id: op.id, card: op.card, fields: op.fields, ts: op.ts, by: op.by };
      const e = store.append(board, clean, { origin: socket.id });
      ack({ ok: true, seq: e.seq });
    });

    socket.on('cursor', p => {
      if (!board || !p || typeof p.x !== 'number' || typeof p.y !== 'number') return;
      socket.volatile.to(board).emit('cursor', { id: user.id, x: Math.max(0, Math.min(1, p.x)), y: Math.max(0, Math.min(1, p.y)) });
    });

    socket.on('focus', card => {
      if (!board) return;
      user.focus = typeof card === 'string' && card.length <= 64 ? card : null;
      socket.to(board).emit('presence:focus', { id: user.id, card: user.focus });
    });

    socket.on('disconnect', leave);
  });

  return { app, server, io, store, boards };
}

module.exports = { createServer };
