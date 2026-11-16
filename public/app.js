(function () {
  const { COLUMNS, createClock, createDoc, applyOp, merge, maxTs, view, orderBetween, validateOp } = window.CRDT;
  const $ = (s, el = document) => el.querySelector(s);
  const params = new URLSearchParams(location.search);
  const board = (params.get('board') || 'demo').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'demo';
  const LABELS = { todo: 'To do', doing: 'In progress', review: 'Review', done: 'Done' };
  const COLORS = ['#2563eb', '#7c3aed', '#db2777', '#ea580c', '#16a34a', '#0891b2', '#ca8a04', '#dc2626'];
  const uid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
  const ls = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  // ---- identity -----------------------------------------------------------
  // Per-tab id (sessionStorage) so two tabs are two collaborators; name/colour persist.
  let tabId; try { tabId = sessionStorage.getItem('lb:id') || uid(); sessionStorage.setItem('lb:id', tabId); } catch { tabId = uid(); }
  const user = {
    id: tabId,
    name: ls.get('lb:name') || 'Guest ' + tabId.slice(0, 3).toUpperCase(),
    color: ls.get('lb:color') || COLORS[Math.floor(Math.random() * COLORS.length)],
  };
  ls.set('lb:color', user.color);

  // ---- state --------------------------------------------------------------
  const clock = createClock(user.id);
  let doc = createDoc();
  const pending = new Set();      // card ids with un-acked ops (optimistic)
  const peers = new Map();        // id -> {name,color,focus}
  const activity = [];
  let editing = null;             // card id open in the editor

  const useServer = typeof window.io === 'function' && params.get('mode') !== 'local';
  const t = useServer ? new Transports.SocketTransport(board, user) : new Transports.LocalTransport(board, user, () => doc);

  // ---- operations (optimistic) ------------------------------------------
  async function commit(card, fields) {
    const op = { id: uid(16), card, fields, ts: clock.tick(), by: user.name };
    const err = validateOp(op);
    if (err) return toast(err);
    applyOp(doc, op);                // 1. apply locally right away (optimistic UI)
    pending.add(card);
    render();
    await LocalStore.enqueue(board, op); // 2. durable outbox in IndexedDB
    LocalStore.saveDoc(board, doc);
    log(op, true);
    if (t.online) deliver(op);       // 3. send; if offline it stays queued
    else updateStatus();
  }

  async function deliver(op) {
    const ack = await t.send(op);
    if (ack.ok) {
      await LocalStore.dequeue(op.id);
    } else if (!ack.retry) {
      // Server rejected the op: drop it and resync from the authoritative snapshot.
      await LocalStore.dequeue(op.id);
      toast('Change rejected: ' + ack.error);
      if (t.kind === 'server') { t.disconnect(); t.connect(); }
    }
    await refreshPending();
  }

  async function flush() {
    const ops = await LocalStore.pending(board);
    for (const op of ops) { if (!t.online) break; await deliver(op); }
    await refreshPending();
  }

  async function refreshPending() {
    const ops = await LocalStore.pending(board);
    pending.clear(); ops.forEach(o => pending.add(o.card));
    render(); updateStatus(ops.length);
  }

  // ---- transport events ---------------------------------------------------
  t.on('ready', async res => {
    peers.clear();
    (res.users || []).forEach(u => peers.set(u.id, u));
    if (res.doc) receiveSnapshot(res.doc);
    renderPeers(); updateStatus();
    await flush();
  });
  t.on('snapshot', receiveSnapshot);
  t.on('down', () => { peers.clear(); renderPeers(); clearCursors(); updateStatus(); });
  t.on('op', op => {
    if (validateOp(op)) return;
    clock.observe(op.ts);
    if (applyOp(doc, op).length) { LocalStore.saveDoc(board, doc); render(op.card); log(op, false); }
  });
  t.on('join', u => { peers.set(u.id, { ...u, focus: u.focus || null }); renderPeers(); });
  t.on('leave', id => { peers.delete(id); renderPeers(); removeCursor(id); render(); });
  t.on('focus', f => { const p = peers.get(f.id); if (p) { p.focus = f.card; render(); } });
  t.on('cursor', moveCursor);
  t.on('error', e => toast(String(e)));

  function receiveSnapshot(remote) {
    const changed = merge(doc, remote);
    const m = maxTs(doc); if (m) clock.observe(m);
    if (changed.length) { LocalStore.saveDoc(board, doc); render(); }
  }

  // ---- rendering ----------------------------------------------------------
  const boardEl = $('#board');
  function render(flashId) {
    const cols = view(doc);
    const focusBy = {};
    peers.forEach(p => { if (p.focus) (focusBy[p.focus] = focusBy[p.focus] || []).push(p); });
    for (const c of COLUMNS) {
      const list = $(`[data-col="${c}"] .cards`, boardEl);
      $(`[data-col="${c}"] .count`, boardEl).textContent = cols[c].length;
      const html = cols[c].map(card => {
        const who = focusBy[card.id] || [];
        const ring = who[0] ? `style="--ring:${who[0].color}"` : '';
        return `<article class="card prio-${card.priority}${who.length ? ' focused' : ''}${pending.has(card.id) ? ' pending' : ''}" draggable="true" data-id="${card.id}" ${ring} tabindex="0">
          ${who.map(p => `<span class="editing-tag" style="background:${p.color}">${esc(p.name)} is editing</span>`).join('')}
          <div class="card-top"><span class="prio">${card.priority}</span><span class="sync" title="${pending.has(card.id) ? 'Waiting to sync' : 'Synced'}"></span></div>
          <h3>${esc(card.title)}</h3>
          ${card.description ? `<p>${esc(card.description).slice(0, 140)}</p>` : ''}
          <div class="card-actions">
            <button data-act="left" aria-label="Move left" ${c === COLUMNS[0] ? 'disabled' : ''}>←</button>
            <button data-act="edit">Edit</button>
            <button data-act="delete" aria-label="Delete">✕</button>
            <button data-act="right" aria-label="Move right" ${c === COLUMNS[3] ? 'disabled' : ''}>→</button>
          </div></article>`;
      }).join('');
      if (list._html !== html) { list.innerHTML = html; list._html = html; }
    }
    if (flashId) { const el = $(`[data-id="${flashId}"]`, boardEl); if (el) { el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 900); } }
    if (editing && !doc.cards[editing]?.title) closeEditor();
  }

  function renderPeers() {
    const all = [{ ...user, me: true }, ...peers.values()];
    $('#peers').innerHTML = all.map(p => `<span class="avatar" style="background:${p.color}" title="${esc(p.name)}${p.me ? ' (you)' : ''}">${esc(initials(p.name))}</span>`).join('');
    $('#peerCount').textContent = all.length === 1 ? 'Only you' : `${all.length} online`;
  }

  function updateStatus(n) {
    const run = count => {
      const el = $('#status');
      el.className = 'status ' + (t.online ? 'on' : 'off');
      el.textContent = t.online ? (t.kind === 'server' ? 'Live · server' : 'Live · tabs') : `Offline${count ? ` · ${count} queued` : ''}`;
      $('#netBtn').textContent = t.online ? 'Go offline' : 'Go online';
    };
    if (n === undefined) LocalStore.pending(board).then(o => run(o.length)); else run(n);
  }

  function log(op, mine) {
    const card = doc.cards[op.card], title = card?.title?.v || 'a card';
    let what = 'updated';
    if (op.fields.deleted) what = 'deleted';
    else if (op.fields.deleted === false && op.fields.title) what = 'created';
    else if (op.fields.column) what = `moved to ${LABELS[op.fields.column]}`;
    activity.unshift({ who: mine ? 'You' : op.by, what, title, at: new Date() });
    activity.length = Math.min(activity.length, 25);
    $('#activity').innerHTML = activity.map(a => `<li><b>${esc(a.who)}</b> ${a.what} <i>${esc(a.title)}</i><time>${a.at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time></li>`).join('');
  }

  // ---- live cursors -------------------------------------------------------
  const cursors = new Map();
  let lastCursor = 0;
  boardEl.addEventListener('pointermove', e => {
    const now = performance.now(); if (now - lastCursor < 40) return; lastCursor = now;
    const r = boardEl.getBoundingClientRect();
    t.cursor({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  });
  function moveCursor(p) {
    const peer = peers.get(p.id); if (!peer) return;
    let el = cursors.get(p.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'cursor';
      el.innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20"><path d="M3 2l7 19 2.5-7.5L20 11z" fill="${peer.color}" stroke="#fff" stroke-width="1.5"/></svg><span style="background:${peer.color}">${esc(peer.name)}</span>`;
      boardEl.appendChild(el); cursors.set(p.id, el);
    }
    el.style.transform = `translate(${p.x * boardEl.clientWidth}px, ${p.y * boardEl.clientHeight}px)`;
    clearTimeout(el._t); el._t = setTimeout(() => el.classList.add('idle'), 4000); el.classList.remove('idle');
  }
  function removeCursor(id) { cursors.get(id)?.remove(); cursors.delete(id); }
  function clearCursors() { cursors.forEach(c => c.remove()); cursors.clear(); }

  // ---- interactions -------------------------------------------------------
  boardEl.addEventListener('submit', e => {
    e.preventDefault();
    const form = e.target, col = form.closest('[data-col]').dataset.col, input = form.elements.title;
    const title = input.value.trim(); if (!title) return;
    const list = view(doc)[col];
    commit(uid(), { title, column: col, order: orderBetween(list.length ? list[list.length - 1].order : null, null), priority: 'medium', description: '', deleted: false });
    input.value = '';
  });

  boardEl.addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]'); if (!btn) return;
    const id = btn.closest('.card').dataset.id, act = btn.dataset.act;
    if (act === 'edit') return openEditor(id);
    if (act === 'delete') return commit(id, { deleted: true });
    const cur = doc.cards[id].column?.v || 'todo', i = COLUMNS.indexOf(cur) + (act === 'right' ? 1 : -1);
    moveTo(id, COLUMNS[i], null);
  });
  boardEl.addEventListener('dblclick', e => { const c = e.target.closest('.card'); if (c) openEditor(c.dataset.id); });

  function moveTo(id, col, beforeId) {
    const list = view(doc)[col].filter(c => c.id !== id);
    const idx = beforeId ? list.findIndex(c => c.id === beforeId) : list.length;
    const prev = list[idx - 1], next = list[idx];
    commit(id, { column: col, order: orderBetween(prev ? prev.order : null, next ? next.order : null) });
  }

  // drag & drop
  let dragId = null;
  boardEl.addEventListener('dragstart', e => { const c = e.target.closest('.card'); if (!c) return; dragId = c.dataset.id; c.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  boardEl.addEventListener('dragend', () => { dragId = null; boardEl.querySelectorAll('.dragging,.drop').forEach(n => n.classList.remove('dragging', 'drop')); });
  boardEl.addEventListener('dragover', e => {
    const col = e.target.closest('[data-col]'); if (!col || !dragId) return;
    e.preventDefault(); boardEl.querySelectorAll('.drop').forEach(n => n.classList.remove('drop')); col.classList.add('drop');
  });
  boardEl.addEventListener('drop', e => {
    const col = e.target.closest('[data-col]'); if (!col || !dragId) return;
    e.preventDefault();
    const after = [...col.querySelectorAll('.card:not(.dragging)')].find(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    moveTo(dragId, col.dataset.col, after ? after.dataset.id : null);
  });

  // editor
  const dlg = $('#editor'), form = dlg.querySelector('form');
  function openEditor(id) {
    const c = doc.cards[id]; if (!c) return;
    editing = id;
    form.elements.title.value = c.title.v; form.elements.description.value = c.description?.v || ''; form.elements.priority.value = c.priority?.v || 'medium';
    dlg.showModal(); t.focus(id);
  }
  function closeEditor() { if (dlg.open) dlg.close(); }
  dlg.addEventListener('close', () => { editing = null; t.focus(null); });
  dlg.addEventListener('submit', e => {
    if (e.submitter?.value !== 'save' || !editing) return;
    const c = doc.cards[editing], f = {};
    const title = form.elements.title.value.trim(), description = form.elements.description.value, priority = form.elements.priority.value;
    if (title && title !== c.title.v) f.title = title;
    if (description !== (c.description?.v || '')) f.description = description;
    if (priority !== (c.priority?.v || 'medium')) f.priority = priority;
    if (Object.keys(f).length) commit(editing, f);
  });

  // header controls
  $('#netBtn').addEventListener('click', () => (t.online ? t.disconnect() : t.connect()));
  $('#nameBtn').addEventListener('click', () => {
    const n = prompt('Your display name', user.name); if (!n || !n.trim()) return;
    user.name = n.trim().slice(0, 40); ls.set('lb:name', user.name); renderPeers();
    if (t.online) { t.disconnect(); t.connect(); }
  });
  $('#shareBtn').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied. Open it in another tab or browser to collaborate.'); } catch { toast(location.href); }
  });
  $('#boardName').textContent = board;
  $('#mode').textContent = t.kind === 'server' ? 'Socket.IO server' : 'Local demo: open this page in 2+ tabs';

  function toast(msg) { const el = $('#toast'); el.textContent = msg; el.classList.add('show'); clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3200); }
  function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function initials(n) { return n.split(/\s+/).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }

  // ---- boot: render from IndexedDB first (offline-first), then connect ------
  (async () => {
    const saved = await LocalStore.loadDoc(board);
    if (saved) { doc = saved; const m = maxTs(doc); if (m) clock.observe(m); }
    else if (t.kind === 'local') seed();
    renderPeers(); await refreshPending();
    t.connect();
  })();

  function seed() {
    const s = [['todo', 'Design onboarding flow', 'high'], ['todo', 'Write API docs', 'low'], ['doing', 'Socket.IO presence', 'high'], ['review', 'IndexedDB outbox', 'medium'], ['done', 'Set up CRDT model', 'medium']];
    const seedClock = createClock('seed', () => 1);
    s.forEach(([column, title, priority], i) => applyOp(doc, { id: 'seed' + i + 'xxxx', card: 'seedcard' + i, ts: seedClock.tick(), by: 'seed', fields: { title, column, priority, order: 1024 * (i + 1), description: '', deleted: false } }));
  }
})();
