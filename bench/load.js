/**
 * Load test: opens CLIENTS socket connections spread across BOARDS boards.
 * In each board one client sends OPS operations; every other client in that board
 * records the time from send to receive (fan-out latency).
 *
 *   node bench/load.js                    # starts an in-process server on a random port
 *   URL=http://host:3000 node bench/load.js   # target a running server
 *   CLIENTS=1000 BOARDS=20 OPS=50 node bench/load.js
 */
const { io: connect } = require('socket.io-client');
const CRDT = require('../public/crdt');
const { performance } = require('perf_hooks');

const CLIENTS = +process.env.CLIENTS || 1000, BOARDS = +process.env.BOARDS || 20, OPS = +process.env.OPS || 50, GAP = +process.env.GAP_MS || 20;

(async () => {
  let url = process.env.URL, srv;
  if (!url) {
    const { createServer } = require('../src/app');
    srv = createServer({ opsPerSecond: 1000 });
    await new Promise(r => srv.server.listen(0, r));
    url = `http://127.0.0.1:${srv.server.address().port}`;
  }
  const sent = new Map(), lat = [];
  const sockets = [];
  const t0 = performance.now();
  for (let i = 0; i < CLIENTS; i++) {
    const s = connect(url, { transports: ['websocket'], forceNew: true, reconnection: false });
    const board = 'bench-' + (i % BOARDS);
    s.on('op', op => { const st = sent.get(op.id); if (st) lat.push(performance.now() - st); });
    sockets.push(new Promise((res, rej) => {
      s.once('connect_error', rej);
      s.once('connect', () => s.emit('join', { board, user: { id: 'u' + i, name: 'User ' + i, color: '#2563eb' } }, () => res({ s, board, i })));
    }));
  }
  const clients = await Promise.all(sockets);
  const connectMs = performance.now() - t0;
  console.log(`connected ${clients.length} clients on ${BOARDS} boards in ${connectMs.toFixed(0)} ms`);

  const writers = clients.filter(c => c.i < BOARDS);
  const ackLat = [];
  const t1 = performance.now();
  await Promise.all(writers.map(async w => {
    const clock = CRDT.createClock('w' + w.i);
    for (let k = 0; k < OPS; k++) {
      const op = { id: `op${w.i}x${k}xxxx`, card: `card${k % 10}xx`, fields: { title: 'Load ' + k, column: CRDT.COLUMNS[k % 4], order: k }, ts: clock.tick(), by: 'bench' };
      const st = performance.now(); sent.set(op.id, st);
      await new Promise(r => w.s.emit('op', op, ack => { ackLat.push(performance.now() - st); r(ack); }));
      await new Promise(r => setTimeout(r, GAP));
    }
  }));
  await new Promise(r => setTimeout(r, 500)); // let the last broadcasts land
  const dur = (performance.now() - t1) / 1000;

  const pct = (a, p) => { const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p / 100 * b.length))]; };
  const expected = BOARDS * OPS * (CLIENTS / BOARDS - 1);
  console.log(JSON.stringify({
    clients: CLIENTS, boards: BOARDS, opsSent: BOARDS * OPS,
    deliveries: lat.length, expectedDeliveries: expected, deliveryRate: +(lat.length / expected * 100).toFixed(2) + '%',
    deliveriesPerSec: Math.round(lat.length / dur),
    fanoutLatencyMs: { p50: +pct(lat, 50).toFixed(1), p95: +pct(lat, 95).toFixed(1), p99: +pct(lat, 99).toFixed(1) },
    ackLatencyMs: { p50: +pct(ackLat, 50).toFixed(1), p95: +pct(ackLat, 95).toFixed(1) },
  }, null, 2));
  clients.forEach(c => c.s.close());
  if (srv) { srv.io.close(); srv.server.close(); }
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
