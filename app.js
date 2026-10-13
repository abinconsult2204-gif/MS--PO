/* Mechery Silks – Purchase Order App (phone app). Plain JavaScript, no build step. */
(() => {
  'use strict';
  const VERSION = '1.0.0';
  const CFG = window.PO_CONFIG || {};
  const UNITS = CFG.units || ['Pcs', 'Mtr', 'Set'];
  const CONDITIONS = ['OK', 'Not as per photo', 'Wrong colour / design', 'Wrong size', 'Damaged / defective', 'Other'];
  const S = { apiUrl: '', session: null, suppliers: [], draft: null, syncing: false, pendingCount: 0, grn: null, amend: null, itemPhoto: null };

  // ---------- small helpers ----------
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = PDFGen.money, qtyf = PDFGen.qtyf, dmy = PDFGen.dmy;
  const pad = n => String(n).padStart(2, '0');
  const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
  const nowStr = () => { const d = new Date(); return today() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
  const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  const role = () => S.session && S.session.user.role;
  const can = {
    createPO: () => ['ADMIN', 'PURCHASER'].includes(role()),
    receive: () => ['ADMIN', 'GODOWN'].includes(role()),
    editSupplier: () => ['ADMIN', 'PURCHASER'].includes(role()),
    admin: () => role() === 'ADMIN'
  };
  const num = v => { const n = parseFloat(v); return isFinite(n) ? Math.round(n * 100) / 100 : NaN; };
  const val = id => { const e = document.getElementById(id); return e ? e.value.trim() : ''; };
  const on = (sel, ev, fn) => $$(sel).forEach(e => e.addEventListener(ev, fn));
  const go = h => { if (location.hash === h) render(); else location.hash = h; };

  function toast(msg, err) {
    const t = document.createElement('div');
    t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), err ? 4500 : 2600);
  }
  function busy(msg) {
    unbusy();
    const b = document.createElement('div'); b.className = 'busy'; b.id = 'busy';
    b.innerHTML = '<div class="spinner"></div><div>' + esc(msg || 'Please wait…') + '</div>';
    document.body.appendChild(b);
  }
  function unbusy() { const b = $('#busy'); if (b) b.remove(); }
  function zoom(src) {
    const o = document.createElement('div'); o.className = 'overlay';
    o.innerHTML = '<img src="' + src + '"><button class="btn close">Close</button>';
    o.onclick = () => o.remove(); document.body.appendChild(o);
  }
  document.addEventListener('click', e => { const z = e.target.closest('[data-zoom] img'); if (z && z.src) { e.stopPropagation(); zoom(z.src); } });

  function setTop(title, back) {
    $('#title').textContent = title;
    $('#backBtn').classList.toggle('hidden', !back);
    $('#backBtn').onclick = () => { if (typeof back === 'string') go(back); else if (history.length > 1) history.back(); else go('#home'); };
  }
  function setActions(html) { $('#actions').innerHTML = html ? '<div class="actions">' + html + '</div>' : ''; }
  function view(html, keepScroll) { const y = window.scrollY; $('#view').innerHTML = html; window.scrollTo(0, keepScroll ? y : 0); }
  function badgeFor(status) {
    const m = { 'Submitted': 'b-info', 'Partially Received': 'b-warn', 'Received': 'b-ok', 'Received with Discrepancy': 'b-bad', 'Cancelled': 'b-grey',
      'Pending upload': 'b-warn', 'Matched': 'b-ok', 'Excess': 'b-bad', 'Short': 'b-bad', 'Not Received': 'b-bad', 'Pending': 'b-grey', 'Partly Received': 'b-warn' };
    return '<span class="badge ' + (m[status] || 'b-grey') + '">' + esc(status) + '</span>';
  }

  // ---------- server calls ----------
  async function api(action, data, timeoutMs) {
    if (!S.apiUrl) throw new Error('Server link not set.');
    if (!navigator.onLine) { const e = new Error('No internet connection.'); e.offline = true; throw e; }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs || 90000);
    let res;
    try {
      res = await fetch(S.apiUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, signal: ctl.signal,
        body: JSON.stringify(Object.assign({ action, token: S.session && S.session.token }, data || {})) });
    } catch (e) {
      const err = new Error(e.name === 'AbortError' ? 'Server took too long. Try again.' : 'Cannot reach server. Check internet.'); err.offline = true; throw err;
    } finally { clearTimeout(t); }
    let out;
    try { out = await res.json(); } catch (e) { const err = new Error('Unexpected server reply. Check the server link.'); err.offline = true; throw err; }
    if (!out.ok) {
      const err = new Error(out.error || 'Server error'); err.server = true; err.code = out.code;
      if (out.code === 'AUTH' && S.session) { await logout(true); toast('Login expired. Please log in again.', true); }
      throw err;
    }
    return out;
  }

  // ---------- photos ----------
  function compress(file, max = 1280, q = 0.72) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        res(c.toDataURL('image/jpeg', q));
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read this photo.')); };
      img.src = url;
    });
  }
  /** Must be called directly inside a click handler. Resolves with saved photoId. */
  function pickPhoto(source) {
    return new Promise(resolve => {
      const inp = source === 'gallery' ? $('#galInput') : $('#camInput');
      inp.value = '';
      inp.onchange = async () => {
        const f = inp.files && inp.files[0]; if (!f) return;
        try {
          busy('Saving photo…');
          const data = await compress(f);
          const id = uid('p');
          await DB.set('photos', id, data);
          unbusy(); resolve(id);
        } catch (e) { unbusy(); toast(e.message, true); }
      };
      inp.click();
    });
  }
  async function photoSrc(id) { return id ? DB.get('photos', id) : null; }
  /** Fill <img data-pid> from phone storage; fetch missing photos from server in small batches. */
  async function loadPhotos() {
    const imgs = $$('img[data-pid]');
    const missing = [];
    for (const im of imgs) {
      const d = await photoSrc(im.dataset.pid);
      if (d) im.src = d; else if (!missing.includes(im.dataset.pid)) missing.push(im.dataset.pid);
    }
    if (!missing.length || !navigator.onLine || !S.session) return;
    for (let i = 0; i < missing.length; i += 8) {
      try {
        const r = await api('getPhotos', { ids: missing.slice(i, i + 8) });
        for (const [id, data] of Object.entries(r.photos)) {
          await DB.set('photos', id, data);
          $$('img[data-pid="' + id + '"]').forEach(im => { im.src = data; });
        }
      } catch (e) { break; }
    }
  }
  const thumb = (pid, cls) => '<div class="thumb ' + (cls || '') + '" data-zoom>' + (pid ? '<img data-pid="' + esc(pid) + '" alt="">' : 'No photo') + '</div>';

  // ---------- suppliers (work offline) ----------
  async function saveSuppliersLocal() { await DB.set('kv', 'suppliers', S.suppliers); }
  async function saveSupplierLocal(s) {
    const i = S.suppliers.findIndex(x => x.supplierId === s.supplierId);
    if (i >= 0) S.suppliers[i] = Object.assign({}, S.suppliers[i], s); else S.suppliers.push(s);
    S.suppliers.sort((a, b) => a.name.localeCompare(b.name));
    await saveSuppliersLocal();
    await DB.set('outbox', 'sup-' + s.supplierId, { id: 'sup-' + s.supplierId, type: 'supplier', supplier: s, createdAt: nowStr() });
    syncNow();
  }
  function supplierForm(s, prefix) {
    s = s || {};
    return '<label class="req">Supplier / shop name</label><input id="' + prefix + 'name" value="' + esc(s.name) + '" autocomplete="off">' +
      '<div class="grid2"><div><label>Place / market</label><input id="' + prefix + 'place" value="' + esc(s.place) + '"></div>' +
      '<div><label>Phone</label><input id="' + prefix + 'phone" inputmode="tel" value="' + esc(s.phone) + '"></div></div>' +
      '<div class="grid2"><div><label>Contact person</label><input id="' + prefix + 'contact" value="' + esc(s.contactPerson) + '"></div>' +
      '<div><label>GSTIN</label><input id="' + prefix + 'gstin" value="' + esc(s.gstin) + '" style="text-transform:uppercase"></div></div>' +
      '<label>Notes</label><input id="' + prefix + 'notes" value="' + esc(s.notes) + '">';
  }
  function readSupplierForm(prefix, existing) {
    const name = val(prefix + 'name');
    if (!name) { toast('Enter supplier name', true); return null; }
    const dup = S.suppliers.find(x => x.name.toLowerCase() === name.toLowerCase() && (!existing || x.supplierId !== existing.supplierId));
    if (dup && !confirm('A supplier named "' + dup.name + '" (' + (dup.place || '') + ') already exists. Create another one?')) return null;
    return { supplierId: existing ? existing.supplierId : 'SUP-' + S.session.user.userCode + '-' + Date.now().toString(36).toUpperCase(),
      name, place: val(prefix + 'place'), phone: val(prefix + 'phone'), contactPerson: val(prefix + 'contact'), gstin: val(prefix + 'gstin').toUpperCase(), notes: val(prefix + 'notes') };
  }

  // ---------- sync ----------
  async function countPending() {
    const keys = await DB.keys('outbox');
    S.pendingCount = keys.filter(k => !String(k).startsWith('sup-')).length;
    updatePill();
  }
  function updatePill() {
    const p = $('#syncPill');
    if (!S.session) { p.classList.add('hidden'); return; }
    p.classList.remove('hidden', 'pending', 'offline');
    if (!navigator.onLine) { p.classList.add('offline'); p.textContent = 'Offline' + (S.pendingCount ? ' · ' + S.pendingCount + ' to upload' : ''); }
    else if (S.syncing) { p.classList.add('pending'); p.textContent = 'Uploading…'; }
    else if (S.pendingCount) { p.classList.add('pending'); p.textContent = S.pendingCount + ' to upload'; }
    else p.textContent = '✓ Synced';
    p.onclick = () => go('#pending');
  }
  async function syncNow(manual) {
    if (S.syncing || !S.session) return;
    if (!navigator.onLine) { if (manual) toast('No internet. Orders are safe on this phone and will upload later.'); updatePill(); return; }
    S.syncing = true; updatePill();
    let failed = 0;
    try {
      const entries = (await DB.all('outbox')).sort((a, b) => (a.type === 'supplier' ? 0 : 1) - (b.type === 'supplier' ? 0 : 1) || a.createdAt.localeCompare(b.createdAt));
      const map = (await DB.get('kv', 'uuidmap')) || {};
      for (const e of entries) {
        try {
          if (e.type === 'supplier') {
            await api('saveSupplier', { supplier: e.supplier });
            await DB.del('outbox', e.id);
          } else if (e.type === 'po') {
            e.uploaded = e.uploaded || [];
            for (const it of e.po.items) {
              if (!it.photoId || e.uploaded.includes(it.photoId)) continue;
              const data = await DB.get('photos', it.photoId);
              if (!data) throw Object.assign(new Error('Photo of item "' + (it.itemName || it.description || '') + '" is missing on this phone.'), { server: true });
              await api('uploadPhoto', { photoId: it.photoId, data });
              e.uploaded.push(it.photoId);
              await DB.set('outbox', e.id, e);
            }
            const r = await api('submitPO', { po: e.po });
            map[e.id] = r.poNo; await DB.set('kv', 'uuidmap', map);
            await DB.del('outbox', e.id);
            if (r.renumbered) toast('PO ' + e.po.poNo + ' was saved as ' + r.poNo + ' (number already used).');
          }
        } catch (err) {
          if (err.offline) throw err;
          failed++;
          e.lastError = err.message; e.lastTry = nowStr();
          await DB.set('outbox', e.id, e);
        }
      }
      try {
        const b = await api('bootstrap');
        const localOnly = (await DB.all('outbox')).filter(x => x.type === 'supplier').map(x => x.supplier);
        S.suppliers = b.suppliers.concat(localOnly.filter(l => !b.suppliers.some(s => s.supplierId === l.supplierId)));
        S.session.user = b.user; await DB.set('kv', 'session', S.session);
        await saveSuppliersLocal();
      } catch (e) { /* ignore */ }
      await DB.set('kv', 'lastSync', nowStr());
      if (manual) toast(failed ? failed + ' item(s) could not upload – see Pending list.' : 'All orders uploaded.', !!failed);
    } catch (err) {
      if (manual) toast(err.message, true);
    } finally {
      S.syncing = false; await countPending();
      const h = location.hash;
      if (h.startsWith('#pending') || h.startsWith('#local/') || h === '#home' || h === '') render();
    }
  }

  // ---------- login / session ----------
  async function logout(silent) {
    if (!silent) {
      await countPending();
      if (S.pendingCount && !confirm(S.pendingCount + ' order(s) are not uploaded yet. If you log out they stay on this phone and upload after the next login. Log out?')) return;
      try { await api('logout'); } catch (e) {}
    }
    S.session = null; await DB.del('kv', 'session');
    updatePill(); go('#login');
  }

  function viewLogin() {
    setTop(CFG.company || 'Mechery Silks'); setActions('');
    view('<div class="login-wrap"><div class="brand-mark"><div class="logo">MS</div><h2>' + esc(CFG.company || 'Mechery Silks') + '</h2><div class="muted">Purchase Order App</div></div>' +
      '<div class="card">' +
      (S.apiUrl ? '' : '<div class="notice info">First time on this phone: paste the <b>Server link</b> given by your admin.</div><label class="req">Server link</label><input id="lg-api" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">') +
      '<label class="req">User ID</label><input id="lg-user" autocapitalize="characters" autocomplete="username" style="text-transform:uppercase">' +
      '<label class="req">PIN</label><input id="lg-pin" type="password" inputmode="numeric" autocomplete="current-password">' +
      '<button class="btn primary block" id="lg-go" style="margin-top:16px">Log in</button>' +
      (S.apiUrl && !CFG.apiUrl ? '<button class="btn ghost block sm" id="lg-reset" style="margin-top:10px">Change server link</button>' : '') +
      '</div><p class="muted tiny" style="text-align:center">Version ' + VERSION + '</p></div>');
    on('#lg-reset', 'click', async () => { if (confirm('Change the server link on this phone?')) { S.apiUrl = ''; await DB.del('kv', 'apiUrl'); render(); } });
    on('#lg-pin', 'keydown', e => { if (e.key === 'Enter') $('#lg-go').click(); });
    on('#lg-go', 'click', async () => {
      if (!S.apiUrl) {
        const u = val('lg-api');
        if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(u)) return toast('Paste the full server link starting with https://script.google.com/', true);
        S.apiUrl = u;
      }
      busy('Logging in…');
      try {
        const r = await api('login', { userId: val('lg-user'), pin: val('lg-pin') });
        await DB.set('kv', 'apiUrl', S.apiUrl);
        S.session = { token: r.token, user: r.user };
        await DB.set('kv', 'session', S.session);
        unbusy(); DB.persist();
        syncNow();
        go(r.user.mustChangePin ? '#changepin' : '#home');
      } catch (e) {
        unbusy(); if (!CFG.apiUrl && e.offline && !(await DB.get('kv', 'apiUrl'))) S.apiUrl = '';
        toast(e.message, true);
      }
    });
  }

  function viewChangePin() {
    const forced = S.session.user.mustChangePin;
    setTop('Change PIN', forced ? null : '#settings'); setActions('');
    view('<div class="card">' + (forced ? '<div class="notice warn">Please set your own PIN before continuing. Do not share it.</div>' : '') +
      '<label class="req">Current PIN</label><input id="cp-old" type="password" inputmode="numeric">' +
      '<label class="req">New PIN (4–8 digits)</label><input id="cp-new" type="password" inputmode="numeric">' +
      '<label class="req">Repeat new PIN</label><input id="cp-new2" type="password" inputmode="numeric">' +
      '<button class="btn primary block" id="cp-go" style="margin-top:16px">Save new PIN</button></div>' +
      (forced ? '<button class="btn ghost block" id="cp-out">Log out</button>' : ''));
    on('#cp-out', 'click', () => logout());
    on('#cp-go', 'click', async () => {
      if (val('cp-new') !== val('cp-new2')) return toast('New PINs do not match', true);
      busy('Saving…');
      try {
        const r = await api('changePin', { oldPin: val('cp-old'), newPin: val('cp-new') });
        S.session.user = r.user; await DB.set('kv', 'session', S.session);
        unbusy(); toast('PIN changed'); go('#home');
      } catch (e) { unbusy(); toast(e.message, true); }
    });
  }

  // ---------- home ----------
  async function viewHome() {
    const u = S.session.user;
    setTop(CFG.company || 'Mechery Silks'); setActions('');
    await countPending();
    const last = await DB.get('kv', 'lastSync');
    const tiles = [];
    if (can.createPO()) tiles.push('<button class="tile main" data-go="#newpo"><span class="ic">📷</span><b>' + (S.draft && S.draft.items.length ? 'Continue PO (' + S.draft.items.length + ' items)' : 'New Purchase Order') + '</b></button>');
    if (can.receive()) tiles.push('<button class="tile main" data-go="#orders?open=1"><span class="ic">📦</span><b>Receive Goods</b></button>');
    tiles.push('<button class="tile" data-go="#orders"><span class="ic">🔎</span><b>Purchase Orders</b><span class="muted small">Search & PDF</span></button>');
    tiles.push('<button class="tile" data-go="#suppliers"><span class="ic">🏬</span><b>Suppliers</b><span class="muted small">' + S.suppliers.length + ' saved</span></button>');
    if (can.createPO() || S.pendingCount) tiles.push('<button class="tile" data-go="#pending"><span class="ic">⏫</span><b>Waiting to upload</b><span class="muted small">' + S.pendingCount + ' order(s)</span></button>');
    if (can.admin()) tiles.push('<button class="tile" data-go="#users"><span class="ic">👥</span><b>Users</b><span class="muted small">Add / reset PIN</span></button>');
    tiles.push('<button class="tile" data-go="#settings"><span class="ic">⚙️</span><b>Settings</b><span class="muted small">PIN, server, logout</span></button>');
    view('<div class="card row"><div class="grow"><b>' + esc(u.name) + '</b><div class="muted small">' + esc(u.role) + ' · ' + esc(u.userId) + '</div></div>' +
      '<div class="muted tiny" style="text-align:right">' + (navigator.onLine ? 'Online' : 'Offline') + '<br>Last sync: ' + esc(last ? last.slice(5, 16) : 'never') + '</div></div>' +
      (S.pendingCount ? '<div class="notice warn">' + S.pendingCount + ' order(s) saved on this phone are waiting to upload. Keep internet on to upload.</div>' : '') +
      '<div class="tiles">' + tiles.join('') + '</div>');
    on('[data-go]', 'click', e => go(e.currentTarget.dataset.go));
  }

  // ---------- new PO ----------
  async function saveDraft() { if (S.draft) await DB.set('kv', 'draft', S.draft); else await DB.del('kv', 'draft'); }
  function newDraft() { return { clientUUID: uid('po'), poDate: today(), supplierId: '', remarks: '', items: [], startedAt: nowStr() }; }
  const itemValue = it => Math.round(it.qty * it.rate * 100) / 100;
  const draftTotals = d => d.items.reduce((t, it) => ({ qty: t.qty + it.qty, value: t.value + itemValue(it) }), { qty: 0, value: 0 });

  function viewNewPO() {
    if (!can.createPO()) return go('#home');
    if (!S.draft) { S.draft = newDraft(); saveDraft(); }
    const d = S.draft, sup = S.suppliers.find(s => s.supplierId === d.supplierId);
    setTop('New Purchase Order', '#home');
    const t = draftTotals(d);
    let supHtml;
    if (sup) {
      supHtml = '<div class="row"><div class="grow"><b>' + esc(sup.name) + '</b><div class="muted small">' + esc([sup.place, sup.phone].filter(Boolean).join(' · ')) + '</div></div><button class="btn sm ghost" id="np-chg">Change</button></div>';
    } else {
      supHtml = '<input id="np-search" placeholder="Search supplier name or place…" autocomplete="off"><div id="np-list" style="margin-top:8px"></div>' +
        '<button class="btn gold block" id="np-new" style="margin-top:6px">+ New supplier</button><div id="np-newform" class="hidden" style="margin-top:8px">' + supplierForm(null, 'ns-') +
        '<button class="btn primary block" id="ns-save" style="margin-top:12px">Save supplier</button></div>';
    }
    view('<div class="card"><h2>1. Supplier</h2>' + supHtml + '</div>' +
      '<div class="card"><h2>2. Order details</h2><div class="grid2"><div><label class="req">PO date</label><input type="date" id="np-date" value="' + esc(d.poDate) + '"></div>' +
      '<div><label>Items / Value</label><div style="padding-top:10px"><b>' + d.items.length + '</b> items · Rs. <b>' + money(t.value) + '</b></div></div></div>' +
      '<label>Order remarks (optional)</label><input id="np-rem" value="' + esc(d.remarks) + '" placeholder="e.g. delivery by transport, payment terms"></div>' +
      '<div class="card"><h2>3. Items</h2>' + (d.items.length ? d.items.map((it, i) =>
        '<div class="item-card" data-i="' + i + '" style="cursor:pointer">' + thumb(it.photoId) + '<div class="grow"><b>' + (i + 1) + '. ' + esc(it.itemName || it.description || 'Item') + '</b>' +
        '<div class="nums"><span>Qty <b>' + qtyf(it.qty) + ' ' + esc(it.unit) + '</b></span><span>Rate <b>' + money(it.rate) + '</b></span><span>MRP <b>' + money(it.mrp) + '</b></span></div>' +
        '<div class="muted small">Value Rs. ' + money(itemValue(it)) + ' · tap to edit</div></div></div>').join('') :
        '<p class="muted">No items yet. Tap <b>Add item</b> to take a photo of the first item.</p>') + '</div>' +
      '<button class="btn danger block sm" id="np-discard">Discard this PO</button>');
    setActions('<button class="btn gold" id="np-add">📷 Add item</button><button class="btn primary" id="np-review"' + (d.items.length && sup ? '' : ' disabled') + '>Review ›</button>');
    $('.item-card') && loadPhotos();
    on('#np-date', 'change', () => { d.poDate = val('np-date'); saveDraft(); });
    on('#np-rem', 'change', () => { d.remarks = val('np-rem'); saveDraft(); });
    on('#np-chg', 'click', () => { d.supplierId = ''; saveDraft(); render(); });
    on('.item-card[data-i]', 'click', e => go('#item/' + e.currentTarget.dataset.i));
    on('#np-add', 'click', () => { S.itemPhoto = null; pickPhoto('camera').then(id => { S.itemPhoto = id; go('#item/new'); }); });
    on('#np-review', 'click', () => go('#review'));
    on('#np-discard', 'click', async () => {
      if (!confirm('Discard this purchase order and all its items?')) return;
      for (const it of d.items) if (it.photoId) await DB.del('photos', it.photoId);
      S.draft = null; await saveDraft(); go('#home');
    });
    const list = $('#np-list');
    if (list) {
      const draw = () => {
        const q = val('np-search').toLowerCase();
        const res = S.suppliers.filter(s => !q || (s.name + ' ' + (s.place || '')).toLowerCase().includes(q)).slice(0, 25);
        list.innerHTML = res.length ? res.map(s => '<div class="list-item" data-sid="' + esc(s.supplierId) + '"><div class="grow"><b>' + esc(s.name) + '</b><div class="muted small">' + esc([s.place, s.phone].filter(Boolean).join(' · ')) + '</div></div>›</div>').join('')
          : '<p class="muted small">' + (S.suppliers.length ? 'No match. Add as new supplier.' : 'No suppliers yet. Add the first one.') + '</p>';
        on('#np-list [data-sid]', 'click', e => { d.supplierId = e.currentTarget.dataset.sid; saveDraft(); render(); });
      };
      draw(); on('#np-search', 'input', draw);
      on('#np-new', 'click', () => { $('#np-newform').classList.remove('hidden'); $('#np-new').classList.add('hidden'); $('#ns-name').value = val('np-search'); $('#ns-name').focus(); });
      on('#ns-save', 'click', async () => {
        const s = readSupplierForm('ns-'); if (!s) return;
        await saveSupplierLocal(s); d.supplierId = s.supplierId; await saveDraft(); toast('Supplier saved'); render();
      });
    }
  }

  async function viewItem(idx) {
    const d = S.draft; if (!d) return go('#newpo');
    const isNew = idx === 'new';
    const it = isNew ? { photoId: S.itemPhoto, unit: (d.items[d.items.length - 1] || {}).unit || UNITS[0] } : d.items[Number(idx)];
    if (!it) return go('#newpo');
    setTop(isNew ? 'Item ' + (d.items.length + 1) : 'Edit item ' + (Number(idx) + 1), '#newpo');
    const src = await photoSrc(it.photoId);
    view('<div class="card"><div class="photo-box" id="it-photo">' + (src ? '<img src="' + src + '">' : '<span style="font-size:34px">📷</span><b>Tap to take photo</b>') + '</div>' +
      '<div class="row" style="margin-top:8px"><button class="btn sm ghost grow" id="it-cam">📷 Retake</button><button class="btn sm ghost grow" id="it-gal">🖼 From gallery</button></div>' +
      '<div class="grid2"><div><label class="req">Quantity</label><input id="it-qty" type="number" inputmode="decimal" min="0" step="any" value="' + esc(it.qty) + '"></div>' +
      '<div><label>Unit</label><select id="it-unit">' + UNITS.map(u => '<option' + (u === it.unit ? ' selected' : '') + '>' + esc(u) + '</option>').join('') + '</select></div></div>' +
      '<div class="grid2"><div><label class="req">Purchase price / unit</label><input id="it-rate" type="number" inputmode="decimal" min="0" step="any" value="' + esc(it.rate) + '"></div>' +
      '<div><label>MRP / unit</label><input id="it-mrp" type="number" inputmode="decimal" min="0" step="any" value="' + esc(it.mrp) + '"></div></div>' +
      '<div id="it-val" class="muted small" style="margin-top:6px"></div>' +
      '<label>Item name (optional)</label><input id="it-name" value="' + esc(it.itemName) + '" placeholder="e.g. Kanchipuram silk saree">' +
      '<label>Description / design / colour / size (optional)</label><input id="it-desc" value="' + esc(it.description) + '">' +
      '<label>Remarks (optional)</label><input id="it-rem" value="' + esc(it.remarks) + '"></div>' +
      (isNew ? '' : '<button class="btn danger block sm" id="it-del">Delete this item</button>'));
    setActions(isNew ? '<button class="btn ghost" id="it-save">Save</button><button class="btn gold" id="it-next">Save & next 📷</button>' : '<button class="btn primary" id="it-save">Save changes</button>');
    const showVal = () => { const q = num(val('it-qty')), r = num(val('it-rate')), m = num(val('it-mrp'));
      $('#it-val').innerHTML = (q > 0 && r >= 0 ? 'Item value: <b>Rs. ' + money(q * r) + '</b>' : '') + (m >= 0 && r > 0 && m < r ? ' <span class="badge b-bad">MRP is below purchase price</span>' : ''); };
    showVal(); on('#it-qty,#it-rate,#it-mrp', 'input', showVal);
    if (isNew && it.photoId) setTimeout(() => { const q = $('#it-qty'); if (q) q.focus(); }, 150);
    const setPhoto = async id => { if (it.photoId && it.photoId !== id && isNew) await DB.del('photos', it.photoId); it.photoId = id; if (isNew) S.itemPhoto = id; const s = await photoSrc(id); $('#it-photo').innerHTML = '<img src="' + s + '">'; };
    on('#it-photo', 'click', () => pickPhoto('camera').then(setPhoto));
    on('#it-cam', 'click', () => pickPhoto('camera').then(setPhoto));
    on('#it-gal', 'click', () => pickPhoto('gallery').then(setPhoto));
    const collect = () => {
      const q = num(val('it-qty')), r = num(val('it-rate')), m = val('it-mrp') === '' ? 0 : num(val('it-mrp'));
      if (!it.photoId) { toast('Take a photo of the item', true); return null; }
      if (!(q > 0)) { toast('Enter quantity', true); $('#it-qty').focus(); return null; }
      if (!(r >= 0) || val('it-rate') === '') { toast('Enter purchase price', true); $('#it-rate').focus(); return null; }
      if (!(m >= 0)) { toast('MRP is not a valid number', true); return null; }
      return { photoId: it.photoId, qty: q, unit: val('it-unit'), rate: r, mrp: m, itemName: val('it-name'), description: val('it-desc'), remarks: val('it-rem') };
    };
    const commit = rec => { if (isNew) d.items.push(rec); else d.items[Number(idx)] = rec; S.itemPhoto = null; };
    on('#it-save', 'click', async () => { const rec = collect(); if (!rec) return; commit(rec); await saveDraft(); go('#newpo'); });
    on('#it-next', 'click', () => {
      const rec = collect(); if (!rec) return;
      commit(rec); saveDraft(); toast('Item ' + d.items.length + ' saved');
      pickPhoto('camera').then(id => { S.itemPhoto = id; render(); });   // camera opens straight away
      S.itemPhoto = null; render();
    });
    on('#it-del', 'click', async () => {
      if (!confirm('Delete this item?')) return;
      const [rm] = d.items.splice(Number(idx), 1); if (rm.photoId) await DB.del('photos', rm.photoId);
      await saveDraft(); go('#newpo');
    });
  }

  function viewReview() {
    const d = S.draft; if (!d || !d.items.length) return go('#newpo');
    const sup = S.suppliers.find(s => s.supplierId === d.supplierId);
    if (!sup) return go('#newpo');
    const t = draftTotals(d);
    setTop('Review order', '#newpo');
    view('<div class="card"><dl class="kv"><dt>Supplier</dt><dd>' + esc(sup.name) + (sup.place ? ', ' + esc(sup.place) : '') + '</dd><dt>PO date</dt><dd>' + dmy(d.poDate) + '</dd>' +
      '<dt>Purchaser</dt><dd>' + esc(S.session.user.name) + '</dd>' + (d.remarks ? '<dt>Remarks</dt><dd>' + esc(d.remarks) + '</dd>' : '') + '</dl></div>' +
      '<div class="card">' + d.items.map((it, i) => '<div class="item-card">' + thumb(it.photoId) + '<div class="grow"><b>' + (i + 1) + '. ' + esc(it.itemName || it.description || 'Item') + '</b>' +
        (it.itemName && it.description ? '<div class="small muted">' + esc(it.description) + '</div>' : '') +
        '<div class="nums"><span>Qty <b>' + qtyf(it.qty) + ' ' + esc(it.unit) + '</b></span><span>Rate <b>' + money(it.rate) + '</b></span><span>MRP <b>' + money(it.mrp) + '</b></span><span>Value <b>' + money(itemValue(it)) + '</b></span></div>' +
        (it.remarks ? '<div class="small">Note: ' + esc(it.remarks) + '</div>' : '') + '</div></div>').join('') +
      '<hr><div class="totals"><span>' + d.items.length + ' items · Qty ' + qtyf(t.qty) + '</span><span>Rs. ' + money(t.value) + '</span></div></div>' +
      '<div class="notice info">After submitting, the order is locked. Only ADMIN can correct it, and every correction is recorded.</div>');
    setActions('<button class="btn ghost" id="rv-back">‹ Edit</button><button class="btn primary" id="rv-submit">Submit order</button>');
    loadPhotos();
    on('#rv-back', 'click', () => go('#newpo'));
    on('#rv-submit', 'click', async () => {
      const u = S.session.user, d8 = today().replace(/-/g, '').slice(2);
      const seqKey = 'seq-' + u.userCode + '-' + d8;
      const seq = ((await DB.get('kv', seqKey)) || 0) + 1;
      await DB.set('kv', seqKey, seq);
      const poNo = 'MS-' + u.userCode + '-' + d8 + '-' + pad(seq);
      const entry = { id: d.clientUUID, type: 'po', createdAt: nowStr(), uploaded: [],
        po: { clientUUID: d.clientUUID, poNo, supplierId: sup.supplierId, supplier: sup, poDate: d.poDate, remarks: d.remarks, createdAt: nowStr(),
          purchaserName: u.name, items: d.items.map(it => Object.assign({}, it)) } };
      await DB.set('outbox', entry.id, entry);
      S.draft = null; await saveDraft();
      toast('Order ' + poNo + ' saved on phone');
      go('#local/' + entry.id);
      syncNow();
    });
  }

  // ---------- local (not yet uploaded) PO ----------
  function localToDetail(e) {
    const items = e.po.items.map((it, i) => Object.assign({ itemNo: i + 1, value: itemValue(it), active: true }, it));
    const t = draftTotals(e.po);
    return { po: { poNo: e.po.poNo, supplierName: e.po.supplier.name, poDate: e.po.poDate, purchaserName: e.po.purchaserName, remarks: e.po.remarks,
      totalQty: t.qty, totalValue: Math.round(t.value * 100) / 100, itemCount: items.length, status: 'Pending upload', rev: 0, pending: true },
      supplier: e.po.supplier, items, revisions: [], grns: [], receipt: { anyGrn: false, items: [], extras: [] } };
  }
  async function viewLocal(id) {
    const e = await DB.get('outbox', id);
    if (!e) { const map = (await DB.get('kv', 'uuidmap')) || {}; if (map[id]) return go('#po/' + encodeURIComponent(map[id])); return go('#home'); }
    renderDetail(localToDetail(e), e);
  }

  async function viewPending() {
    setTop('Waiting to upload', '#home');
    const list = (await DB.all('outbox')).filter(e => e.type === 'po');
    const sups = (await DB.all('outbox')).filter(e => e.type === 'supplier');
    view((navigator.onLine ? '' : '<div class="notice warn">You are offline. Orders are safe on this phone and will upload automatically when internet returns.</div>') +
      (list.length ? list.map(e => '<div class="list-item" data-id="' + esc(e.id) + '"><div class="grow"><b>' + esc(e.po.poNo) + '</b> <span class="badge b-warn">Not uploaded</span><div class="small">' + esc(e.po.supplier.name) + ' · ' + dmy(e.po.poDate) + ' · ' + e.po.items.length + ' items</div>' +
        '<div class="tiny muted">Photos uploaded: ' + (e.uploaded || []).length + '/' + e.po.items.length + '</div>' + (e.lastError ? '<div class="tiny" style="color:var(--bad)">Problem: ' + esc(e.lastError) + '</div>' : '') + '</div>›</div>').join('')
        : '<div class="card"><b>✓ Nothing waiting.</b><div class="muted small">All orders from this phone are on the server.</div></div>') +
      (sups.length ? '<p class="muted small">' + sups.length + ' new/edited supplier(s) also waiting to upload.</p>' : ''));
    setActions('<button class="btn primary" id="pd-sync"' + (S.syncing ? ' disabled' : '') + '>' + (S.syncing ? 'Uploading…' : 'Upload now') + '</button>');
    on('[data-id]', 'click', e => go('#local/' + e.currentTarget.dataset.id));
    on('#pd-sync', 'click', () => syncNow(true));
  }

  // ---------- orders list ----------
  function parseQuery() { const q = {}; const s = location.hash.split('?')[1]; if (s) s.split('&').forEach(p => { const [k, v] = p.split('='); q[k] = decodeURIComponent(v || ''); }); return q; }
  async function viewOrders() {
    const q = parseQuery();
    const sup = q.sup ? S.suppliers.find(s => s.supplierId === q.sup) : null;
    const mode = q.open ? 'open' : (q.mode || 'all');
    setTop(q.open ? 'Receive goods – open orders' : 'Purchase Orders', '#home');
    view('<div class="card">' + (sup ? '<div class="row" style="margin-bottom:8px"><span class="grow">Supplier: <b>' + esc(sup.name) + '</b></span><button class="btn sm ghost" id="or-clr">Clear</button></div>' : '') +
      '<input id="or-q" placeholder="Search PO number or supplier…" value="' + esc(q.q || '') + '" autocomplete="off">' +
      '<div class="grid2"><div><label>From date</label><input type="date" id="or-from" value="' + esc(q.from || '') + '"></div><div><label>To date</label><input type="date" id="or-to" value="' + esc(q.to || '') + '"></div></div>' +
      '<div class="seg" style="margin-top:10px"><button data-m="all" class="' + (mode === 'all' ? 'on' : '') + '">All</button><button data-m="open" class="' + (mode === 'open' ? 'on' : '') + '">Not fully received</button></div></div>' +
      '<div id="or-res"><div class="muted">Loading…</div></div>');
    setActions('');
    let m = mode, timer;
    const load = async () => {
      const box = $('#or-res');
      const params = { q: val('or-q'), from: val('or-from'), to: val('or-to'), supplierId: q.sup || '', openOnly: m === 'open', limit: 150 };
      // pending (local) orders first
      const pend = (await DB.all('outbox')).filter(e => e.type === 'po' && (!params.supplierId || e.po.supplierId === params.supplierId) &&
        (!params.q || (e.po.poNo + ' ' + e.po.supplier.name).toLowerCase().includes(params.q.toLowerCase())));
      const pendHtml = pend.map(e => '<div class="list-item" data-local="' + esc(e.id) + '"><div class="grow"><b>' + esc(e.po.poNo) + '</b><div class="small">' + esc(e.po.supplier.name) + ' · ' + dmy(e.po.poDate) + '</div></div>' + badgeFor('Pending upload') + '</div>').join('');
      let html = '';
      try {
        const r = await api('listPOs', params);
        await DB.set('kv', 'lastOrders', r.orders);
        html = r.orders.length ? '<p class="muted small">' + r.total + ' order(s)' + (r.total > r.orders.length ? ', showing latest ' + r.orders.length : '') + '</p>' + r.orders.map(orderRow).join('') : '<p class="muted">No orders found.</p>';
      } catch (e) {
        const cached = (await DB.get('kv', 'lastOrders')) || [];
        html = '<div class="notice warn">' + esc(e.message) + (cached.length ? ' Showing last loaded list.' : '') + '</div>' + cached.map(orderRow).join('');
      }
      box.innerHTML = pendHtml + html;
      on('#or-res [data-po]', 'click', e => go('#po/' + encodeURIComponent(e.currentTarget.dataset.po)));
      on('#or-res [data-local]', 'click', e => go('#local/' + e.currentTarget.dataset.local));
    };
    const orderRow = o => '<div class="list-item" data-po="' + esc(o.poNo) + '"><div class="grow"><b>' + esc(o.poNo) + '</b>' + (o.rev ? ' <span class="badge b-grey">Rev ' + o.rev + '</span>' : '') +
      '<div class="small">' + esc(o.supplierName) + ' · ' + dmy(o.poDate) + '</div><div class="tiny muted">' + o.itemCount + ' items · Qty ' + qtyf(o.totalQty) + ' · Rs. ' + money(o.totalValue) + ' · ' + esc(o.purchaserName) + '</div></div>' + badgeFor(o.status) + '</div>';
    load();
    on('#or-q', 'input', () => { clearTimeout(timer); timer = setTimeout(load, 450); });
    on('#or-from,#or-to', 'change', load);
    on('.seg button', 'click', e => { m = e.currentTarget.dataset.m; $$('.seg button').forEach(b => b.classList.toggle('on', b.dataset.m === m)); load(); });
    on('#or-clr', 'click', () => go('#orders'));
  }

  // ---------- PO detail ----------
  async function fetchPO(poNo) {
    try {
      const d = await api('getPO', { poNo });
      await DB.set('pocache', poNo, d);
      return d;
    } catch (e) {
      const c = await DB.get('pocache', poNo);
      if (c) { toast('Offline – showing saved copy', true); c._stale = true; return c; }
      throw e;
    }
  }
  async function viewPO(poNo) {
    setTop(poNo, true); setActions(''); view('<div class="muted">Loading…</div>');
    try { renderDetail(await fetchPO(poNo)); } catch (e) { view('<div class="notice bad">' + esc(e.message) + '</div>'); }
  }

  function renderDetail(d, localEntry) {
    const po = d.po, rc = d.receipt || { items: [], extras: [] };
    const rmap = {}; (rc.items || []).forEach(r => { rmap[r.itemNo] = r; });
    setTop(po.poNo, localEntry ? '#home' : true);
    const active = d.items.filter(i => i.active !== false), removed = d.items.filter(i => i.active === false);
    const itemHtml = it => {
      const r = rmap[it.itemNo];
      return '<div class="item-card' + (it.active === false ? ' removed' : '') + '">' + thumb(it.photoId, 'lg') + '<div class="grow"><b>' + it.itemNo + '. ' + esc(it.itemName || it.description || 'Item') + '</b>' +
        (it.active === false ? ' <span class="badge b-grey">Removed</span>' : '') +
        (it.itemName && it.description ? '<div class="small muted">' + esc(it.description) + '</div>' : '') +
        '<div class="nums"><span>Qty <b>' + qtyf(it.qty) + ' ' + esc(it.unit) + '</b></span><span>Rate <b>' + money(it.rate) + '</b></span><span>MRP <b>' + money(it.mrp) + '</b></span><span>Value <b>' + money(it.value) + '</b></span></div>' +
        (it.remarks ? '<div class="small">Note: ' + esc(it.remarks) + '</div>' : '') +
        (r && rc.anyGrn ? '<div class="rcv-status">' + badgeFor(r.status) + ' <span class="small">Received ' + qtyf(r.received) + ' / ' + qtyf(r.ordered) + '</span>' + (r.conditions.length ? ' <span class="badge b-bad">' + esc(r.conditions.join(', ')) + '</span>' : '') + '</div>' : '') +
        '</div></div>';
    };
    let html = '';
    if (localEntry) html += '<div class="notice warn"><b>Saved on this phone – not uploaded yet.</b> The godown can see it only after upload.' + (localEntry.lastError ? '<br>Problem: ' + esc(localEntry.lastError) : '') + '</div>';
    if (d._stale) html += '<div class="notice warn">Offline copy. Details may have changed.</div>';
    html += '<div class="card"><div class="row" style="margin-bottom:8px"><div class="grow"><b style="font-size:17px">' + esc(po.supplierName) + '</b>' + (d.supplier && d.supplier.place ? '<div class="muted small">' + esc(d.supplier.place) + (d.supplier.phone ? ' · ' + esc(d.supplier.phone) : '') + '</div>' : '') + '</div>' + badgeFor(po.status) + '</div>' +
      '<dl class="kv"><dt>PO No</dt><dd>' + esc(po.poNo) + (po.rev ? ' (Rev ' + po.rev + ')' : '') + '</dd><dt>PO date</dt><dd>' + dmy(po.poDate) + '</dd><dt>Purchaser</dt><dd>' + esc(po.purchaserName) + '</dd>' +
      (po.remarks ? '<dt>Remarks</dt><dd>' + esc(po.remarks) + '</dd>' : '') + '</dl><hr><div class="totals"><span>' + active.length + ' items · Qty ' + qtyf(po.totalQty) + '</span><span>Rs. ' + money(po.totalValue) + '</span></div></div>';
    html += '<div class="card"><h2>Items</h2>' + active.map(itemHtml).join('') + removed.map(itemHtml).join('') + '</div>';
    if (rc.extras && rc.extras.length) html += '<div class="card"><h2 style="color:var(--bad)">Received but NOT in this PO</h2>' + rc.extras.map(x => '<div class="item-card">' + thumb(x.photoId) + '<div class="grow"><b>' + esc(x.itemName) + '</b><div class="small">Qty ' + qtyf(x.receivedQty) + ' · ' + esc(x.condition) + '</div>' + (x.remarks ? '<div class="small muted">' + esc(x.remarks) + '</div>' : '') + '</div></div>').join('') + '</div>';
    if (d.grns && d.grns.length) html += '<div class="card"><h2>Deliveries received</h2>' + d.grns.map(g => '<div class="small" style="margin-bottom:6px"><b>' + esc(g.grnNo) + '</b> · ' + dmy(g.grnDate) + ' · ' + esc(g.receivedBy) + (g.invoiceNo ? ' · Inv ' + esc(g.invoiceNo) : '') + (g.transport ? ' · LR ' + esc(g.transport) : '') + (g.finalDelivery ? ' · <b>Final delivery</b>' : '') + (g.remarks ? '<br>' + esc(g.remarks) : '') + '</div>' +
      g.lines.filter(l => l.lineType === 'ORDERED' && (l.condition !== 'OK' || l.photoId)).map(l => '<div class="item-card">' + thumb(l.photoId) + '<div class="grow small"><b>Item ' + l.itemNo + ': ' + esc(l.condition) + '</b><div>' + esc(l.itemName) + ' · received ' + qtyf(l.receivedQty) + '</div>' + (l.remarks ? '<div class="muted">' + esc(l.remarks) + '</div>' : '') + '</div></div>').join('')).join('') + '</div>';
    if (d.revisions && d.revisions.length) html += '<div class="card"><h2>Correction history</h2>' + d.revisions.map(r => '<div class="small" style="margin-bottom:6px"><span class="badge b-grey">Rev ' + r.rev + '</span> ' + (r.itemNo ? 'Item ' + r.itemNo + ' – ' : '') + esc(r.field) + ': <s>' + esc(r.oldValue || '-') + '</s> → <b>' + esc(r.newValue || '-') + '</b><div class="tiny muted">' + esc(r.changedBy) + ', ' + esc(r.changedAt) + ' · Reason: ' + esc(r.reason) + '</div></div>').join('') + '</div>';
    html += '<div class="card"><h2>Documents</h2><div class="row wrap"><button class="btn gold grow" id="pd-share">📤 Share PO PDF</button><button class="btn ghost grow" id="pd-dl">⬇ Download PO PDF</button></div>' +
      (rc.anyGrn ? '<div class="row wrap" style="margin-top:8px"><button class="btn ghost grow" id="pd-grnshare">📤 Share receiving report</button><button class="btn ghost grow" id="pd-grndl">⬇ Download receiving report</button></div>' : '') + '</div>';
    if (!localEntry && can.admin() && po.status !== 'Cancelled') html += '<button class="btn danger block sm" id="pd-cancel">Cancel this PO</button>';
    view(html);
    const acts = [];
    if (!localEntry && can.receive() && po.status !== 'Cancelled') acts.push('<button class="btn primary" id="pd-rcv">📦 Receive goods</button>');
    if (!localEntry && can.admin() && po.status !== 'Cancelled') acts.push('<button class="btn ghost" id="pd-amend">✎ Correct</button>');
    if (localEntry) acts.push('<button class="btn primary" id="pd-sync">Upload now</button>');
    setActions(acts.join(''));
    loadPhotos();
    const makePdf = async (kind, share) => {
      busy('Preparing PDF…');
      try {
        const ids = d.items.map(i => i.photoId).concat((rc.extras || []).map(x => x.photoId)).concat((d.grns || []).flatMap(g => g.lines.map(l => l.photoId))).filter(Boolean);
        await loadPhotos();
        const pm = {}; for (const id of ids) pm[id] = await photoSrc(id);
        const missing = ids.filter(id => !pm[id]).length;
        const blob = kind === 'grn' ? await PDFGen.grnPdf(d, pm, CFG) : await PDFGen.poPdf(d, pm, CFG);
        const name = (kind === 'grn' ? 'Receiving_' : 'PO_') + po.poNo + '.pdf';
        unbusy();
        if (missing) toast(missing + ' photo(s) could not be loaded (offline?) – PDF made without them.', true);
        await deliverFile(blob, name, share);
      } catch (e) { unbusy(); toast('PDF error: ' + e.message, true); }
    };
    on('#pd-share', 'click', () => makePdf('po', true));
    on('#pd-dl', 'click', () => makePdf('po', false));
    on('#pd-grnshare', 'click', () => makePdf('grn', true));
    on('#pd-grndl', 'click', () => makePdf('grn', false));
    on('#pd-rcv', 'click', () => go('#grn/' + encodeURIComponent(po.poNo)));
    on('#pd-amend', 'click', () => go('#amend/' + encodeURIComponent(po.poNo)));
    on('#pd-sync', 'click', () => syncNow(true));
    on('#pd-cancel', 'click', async () => {
      const reason = prompt('Reason for cancelling ' + po.poNo + '?'); if (!reason) return;
      busy('Cancelling…');
      try { await api('cancelPO', { poNo: po.poNo, reason }); unbusy(); toast('PO cancelled'); viewPO(po.poNo); } catch (e) { unbusy(); toast(e.message, true); }
    });
  }

  async function deliverFile(blob, name, share) {
    const file = new File([blob], name, { type: 'application/pdf' });
    if (share && navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    if (share) toast('Sharing not supported here – PDF downloaded instead.');
  }

  // ---------- goods receiving ----------
  async function viewGRN(poNo, again) {
    if (!can.receive()) return go('#po/' + encodeURIComponent(poNo));
    setTop('Receive: ' + poNo, '#po/' + encodeURIComponent(poNo));
    let d;
    if (again && S.grn && S.grn.poNo === poNo && S.grn._d) d = S.grn._d;
    else {
      setActions(''); view('<div class="muted">Loading…</div>');
      try { d = await api('getPO', { poNo }); } catch (e) { return view('<div class="notice bad">' + esc(e.message) + '<br>Receiving needs internet.</div>'); }
      if (!S.grn || S.grn.poNo !== poNo) S.grn = { poNo, clientUUID: uid('grn'), grnDate: today(), invoiceNo: '', transport: '', remarks: '', finalDelivery: false, lines: {}, extras: [] };
      S.grn._d = d;
    }
    if (d.po.status === 'Cancelled') return view('<div class="notice bad">This PO is cancelled.</div>');
    const g = S.grn, rmap = {};
    d.receipt.items.forEach(r => { rmap[r.itemNo] = r; });
    const items = d.items.filter(i => i.active);
    const lineStatus = it => {
      const l = g.lines[it.itemNo] || {}, prev = rmap[it.itemNo].received, now = num(l.receivedQty) || 0, tot = prev + now;
      let s = tot === it.qty ? 'Matched' : tot > it.qty ? 'Excess' : tot === 0 ? 'Pending' : 'Short';
      return badgeFor(s) + ' <span class="small">Total received ' + qtyf(tot) + ' of ' + qtyf(it.qty) + (tot > it.qty ? ' (+' + qtyf(tot - it.qty) + ')' : tot < it.qty ? ' (' + qtyf(it.qty - tot) + ' short)' : '') + '</span>';
    };
    const extrasHtml = () => g.extras.map((x, i) => '<div class="item-card">' + thumb(x.photoId) + '<div class="grow"><b>' + esc(x.itemName || 'Item not in PO') + '</b><div class="small">Qty ' + qtyf(x.qty) + (x.remarks ? ' · ' + esc(x.remarks) : '') + '</div><button class="btn sm danger" data-xdel="' + i + '" style="margin-top:6px">Remove</button></div></div>').join('');
    view('<div class="card"><div class="row"><div class="grow"><b>' + esc(d.po.supplierName) + '</b><div class="small muted">PO date ' + dmy(d.po.poDate) + ' · ' + items.length + ' items · by ' + esc(d.po.purchaserName) + '</div></div>' + badgeFor(d.po.status) + '</div>' +
      '<label class="req">Received date</label><input type="date" id="g-date" value="' + esc(g.grnDate) + '"><div class="grid2"><div><label>Supplier bill no.</label><input id="g-inv" value="' + esc(g.invoiceNo) + '"></div><div><label>LR / transport</label><input id="g-tr" value="' + esc(g.transport) + '"></div></div></div>' +
      '<div class="notice info">Compare each bundle with the photo. Enter the quantity received <b>in this delivery</b>. Mark a problem if the item does not match the photo.</div>' +
      '<button class="btn ghost block sm" id="g-all" style="margin-bottom:12px">Fill all balance quantities (everything arrived as ordered)</button>' +
      items.map(it => { const r = rmap[it.itemNo], l = g.lines[it.itemNo] || {};
        return '<div class="card" data-item="' + it.itemNo + '"><div class="row" style="align-items:flex-start">' + thumb(it.photoId, 'lg') + '<div class="grow"><b>' + it.itemNo + '. ' + esc(it.itemName || it.description || 'Item') + '</b>' +
          (it.itemName && it.description ? '<div class="small muted">' + esc(it.description) + '</div>' : '') + (it.remarks ? '<div class="small">Note: ' + esc(it.remarks) + '</div>' : '') +
          '<div class="nums"><span>Ordered <b>' + qtyf(it.qty) + ' ' + esc(it.unit) + '</b></span><span>Earlier recd <b>' + qtyf(r.received) + '</b></span></div><div class="nums"><span>Rate ' + money(it.rate) + '</span><span>MRP ' + money(it.mrp) + '</span></div></div></div>' +
          '<div class="grid2"><div><label>Received now (' + esc(it.unit) + ')</label><input type="number" inputmode="decimal" min="0" step="any" class="g-qty" data-no="' + it.itemNo + '" value="' + esc(l.receivedQty == null ? '' : l.receivedQty) + '"></div>' +
          '<div><label>Matches photo?</label><select class="g-cond" data-no="' + it.itemNo + '">' + CONDITIONS.map(c => '<option' + (c === (l.condition || 'OK') ? ' selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></div></div>' +
          '<div class="g-more' + (l.condition && l.condition !== 'OK' ? '' : ' hidden') + '" data-no="' + it.itemNo + '"><label>Problem details</label><input class="g-rem" data-no="' + it.itemNo + '" value="' + esc(l.remarks) + '">' +
          '<div class="row" style="margin-top:8px">' + (l.photoId ? thumb(l.photoId) : '') + '<button class="btn sm ghost g-photo" data-no="' + it.itemNo + '">📷 ' + (l.photoId ? 'Retake' : 'Photo of received goods') + '</button></div></div>' +
          '<div class="rcv-status" id="gs-' + it.itemNo + '">' + lineStatus(it) + '</div></div>'; }).join('') +
      '<div class="card"><h2>Items received that are NOT in the PO</h2><div id="g-extras">' + extrasHtml() + '</div>' +
      '<div id="g-xform" class="hidden"><div class="photo-box" id="gx-photo" style="aspect-ratio:16/9"><span>📷 Tap for photo</span></div><label>Item name / description</label><input id="gx-name"><div class="grid2"><div><label class="req">Qty</label><input id="gx-qty" type="number" inputmode="decimal" min="0" step="any"></div><div><label>Remarks</label><input id="gx-rem"></div></div><button class="btn primary block" id="gx-add" style="margin-top:10px">Add to list</button></div>' +
      '<button class="btn gold block" id="g-xnew" style="margin-top:8px">+ Add item not in PO</button></div>' +
      '<div class="card"><label>Remarks for this delivery</label><textarea id="g-rem">' + esc(g.remarks) + '</textarea>' +
      '<label class="row" style="color:var(--text);font-size:15px;margin-top:12px"><input type="checkbox" id="g-final"' + (g.finalDelivery ? ' checked' : '') + '> <span>This is the <b>final delivery</b> for this PO (anything not received will be marked short)</span></label></div>', again);
    setActions('<button class="btn primary" id="g-save">Save receipt</button>');
    loadPhotos();
    const line = no => (g.lines[no] = g.lines[no] || { itemNo: no, condition: 'OK' });
    const refresh = no => { const it = items.find(i => i.itemNo === no); $('#gs-' + no).innerHTML = lineStatus(it); };
    on('.g-qty', 'input', e => { const no = Number(e.target.dataset.no); line(no).receivedQty = e.target.value; refresh(no); });
    on('.g-cond', 'change', e => { const no = Number(e.target.dataset.no); line(no).condition = e.target.value; $('.g-more[data-no="' + no + '"]').classList.toggle('hidden', e.target.value === 'OK'); });
    on('.g-rem', 'input', e => { line(Number(e.target.dataset.no)).remarks = e.target.value; });
    on('.g-photo', 'click', e => { const no = Number(e.currentTarget.dataset.no); pickPhoto('camera').then(id => { line(no).photoId = id; viewGRN(poNo, true); }); });
    on('#g-date', 'change', () => { g.grnDate = val('g-date'); });
    on('#g-inv', 'input', () => { g.invoiceNo = val('g-inv'); });
    on('#g-tr', 'input', () => { g.transport = val('g-tr'); });
    on('#g-rem', 'input', () => { g.remarks = val('g-rem'); });
    on('#g-final', 'change', e => { g.finalDelivery = e.target.checked; });
    on('#g-all', 'click', () => items.forEach(it => { const bal = Math.max(0, rmap[it.itemNo].balance); line(it.itemNo).receivedQty = String(bal); $('.g-qty[data-no="' + it.itemNo + '"]').value = bal; refresh(it.itemNo); }));
    let xPhoto = null;
    on('#g-xnew', 'click', () => { $('#g-xform').classList.remove('hidden'); $('#g-xnew').classList.add('hidden'); });
    on('#gx-photo', 'click', () => pickPhoto('camera').then(async id => { xPhoto = id; $('#gx-photo').innerHTML = '<img src="' + await photoSrc(id) + '">'; }));
    on('#gx-add', 'click', () => {
      const q = num(val('gx-qty'));
      if (!(q > 0)) return toast('Enter quantity', true);
      if (!xPhoto && !val('gx-name')) return toast('Take a photo or enter a name', true);
      g.extras.push({ photoId: xPhoto, itemName: val('gx-name'), qty: q, remarks: val('gx-rem') });
      viewGRN(poNo, true);
    });
    on('[data-xdel]', 'click', e => { g.extras.splice(Number(e.currentTarget.dataset.xdel), 1); viewGRN(poNo, true); });
    on('#g-save', 'click', async () => {
      const lines = Object.values(g.lines).map(l => ({ itemNo: l.itemNo, receivedQty: num(l.receivedQty) || 0, condition: l.condition || 'OK', remarks: (l.remarks || '').trim(), photoId: l.photoId || '' }));
      if (lines.some(l => l.receivedQty < 0)) return toast('Quantity cannot be negative', true);
      const qtyLines = lines.filter(l => l.receivedQty > 0 || l.condition !== 'OK');
      if (!qtyLines.length && !g.extras.length && !g.finalDelivery) return toast('Enter received quantity for at least one item', true);
      const ex = items.filter(it => { const t = rmap[it.itemNo].received + (num((g.lines[it.itemNo] || {}).receivedQty) || 0); return t > it.qty; }).length;
      const sh = g.finalDelivery ? items.filter(it => rmap[it.itemNo].received + (num((g.lines[it.itemNo] || {}).receivedQty) || 0) < it.qty).length : 0;
      const bad = lines.filter(l => l.condition !== 'OK').length;
      const msg = 'Save this receipt?\n\n' + qtyLines.length + ' item(s) entered' + (ex ? '\n⚠ ' + ex + ' item(s) EXCESS' : '') + (sh ? '\n⚠ ' + sh + ' item(s) SHORT (final delivery)' : '') + (bad ? '\n⚠ ' + bad + ' item(s) with problems' : '') + (g.extras.length ? '\n⚠ ' + g.extras.length + ' item(s) NOT in PO' : '');
      if (!confirm(msg)) return;
      busy('Uploading photos…');
      try {
        const pids = lines.map(l => l.photoId).concat(g.extras.map(x => x.photoId)).filter(Boolean);
        for (const id of pids) await api('uploadPhoto', { photoId: id, data: await photoSrc(id) });
        busy('Saving receipt…');
        const r = await api('saveGRN', { grn: { clientUUID: g.clientUUID, poNo, grnDate: g.grnDate, invoiceNo: g.invoiceNo, transport: g.transport, remarks: g.remarks, finalDelivery: g.finalDelivery, lines, extras: g.extras } });
        S.grn = null; unbusy(); toast('Saved as ' + r.grnNo); go('#po/' + encodeURIComponent(poNo));
      } catch (e) { unbusy(); toast(e.message + (e.offline ? ' Your entries are kept – try again.' : ''), true); }
    });
  }

  // ---------- admin correction ----------
  async function viewAmend(poNo, again) {
    if (!can.admin()) return go('#po/' + encodeURIComponent(poNo));
    setTop('Correct ' + poNo, '#po/' + encodeURIComponent(poNo)); setActions('');
    if (!S.amend || S.amend.poNo !== poNo) {
      view('<div class="muted">Loading…</div>');
      let d; try { d = await api('getPO', { poNo }); } catch (e) { return view('<div class="notice bad">' + esc(e.message) + '</div>'); }
      S.amend = { poNo, poDate: d.po.poDate, remarks: d.po.remarks, reason: '', items: d.items.map(i => Object.assign({}, i)) };
    }
    const a = S.amend;
    view('<div class="notice warn">Every change is recorded with your name, time and reason. The original values stay visible in the history.</div>' +
      '<div class="card"><div class="grid2"><div><label>PO date</label><input type="date" id="am-date" value="' + esc(a.poDate) + '"></div><div><label>Order remarks</label><input id="am-rem" value="' + esc(a.remarks) + '"></div></div></div>' +
      a.items.map((it, i) => '<div class="card' + (it.active === false ? ' item-card removed' : '') + '" style="display:block"><div class="row">' + thumb(it.photoId) + '<div class="grow"><b>' + (it.itemNo ? 'Item ' + it.itemNo : 'New item') + '</b>' + (it.active === false ? ' <span class="badge b-grey">Will be removed</span>' : '') +
        '<div class="row" style="margin-top:6px"><button class="btn sm ghost" data-aph="' + i + '">📷 Replace photo</button><button class="btn sm ' + (it.active === false ? 'gold' : 'danger') + '" data-atog="' + i + '">' + (it.active === false ? 'Restore' : 'Remove') + '</button></div></div></div>' +
        '<div class="grid3"><div><label>Qty</label><input type="number" step="any" inputmode="decimal" data-af="qty" data-i="' + i + '" value="' + esc(it.qty) + '"></div><div><label>Rate</label><input type="number" step="any" inputmode="decimal" data-af="rate" data-i="' + i + '" value="' + esc(it.rate) + '"></div><div><label>MRP</label><input type="number" step="any" inputmode="decimal" data-af="mrp" data-i="' + i + '" value="' + esc(it.mrp) + '"></div></div>' +
        '<div class="grid2"><div><label>Item name</label><input data-af="itemName" data-i="' + i + '" value="' + esc(it.itemName) + '"></div><div><label>Unit</label><select data-af="unit" data-i="' + i + '">' + UNITS.map(u => '<option' + (u === it.unit ? ' selected' : '') + '>' + esc(u) + '</option>').join('') + '</select></div></div>' +
        '<label>Description</label><input data-af="description" data-i="' + i + '" value="' + esc(it.description) + '"><label>Remarks</label><input data-af="remarks" data-i="' + i + '" value="' + esc(it.remarks) + '"></div>').join('') +
      '<button class="btn gold block" id="am-add">📷 Add new item</button>' +
      '<div class="card" style="margin-top:12px"><label class="req">Reason for correction</label><textarea id="am-reason" placeholder="e.g. Supplier confirmed only 8 pcs available">' + esc(a.reason) + '</textarea></div>', again);
    setActions('<button class="btn ghost" id="am-cancel">Discard</button><button class="btn primary" id="am-save">Save correction</button>');
    loadPhotos();
    on('[data-af]', 'input', e => { const it = a.items[Number(e.target.dataset.i)]; it[e.target.dataset.af] = e.target.value; });
    on('select[data-af]', 'change', e => { a.items[Number(e.target.dataset.i)].unit = e.target.value; });
    on('#am-date', 'change', () => { a.poDate = val('am-date'); });
    on('#am-rem', 'input', () => { a.remarks = val('am-rem'); });
    on('#am-reason', 'input', () => { a.reason = val('am-reason'); });
    on('[data-atog]', 'click', e => { const it = a.items[Number(e.currentTarget.dataset.atog)]; if (!it.itemNo) a.items.splice(Number(e.currentTarget.dataset.atog), 1); else it.active = it.active === false; viewAmend(poNo, true); });
    on('[data-aph]', 'click', e => { const i = Number(e.currentTarget.dataset.aph); pickPhoto('camera').then(id => { a.items[i].photoId = id; a.items[i]._newPhoto = true; viewAmend(poNo, true); }); });
    on('#am-add', 'click', () => pickPhoto('camera').then(id => { a.items.push({ photoId: id, _newPhoto: true, qty: '', rate: '', mrp: '', unit: UNITS[0], itemName: '', description: '', remarks: '', active: true }); viewAmend(poNo); }));
    on('#am-cancel', 'click', () => { S.amend = null; go('#po/' + encodeURIComponent(poNo)); });
    on('#am-save', 'click', async () => {
      if (!a.reason.trim()) return toast('Enter reason for correction', true);
      const keep = a.items.filter(i => i.active !== false);
      for (const it of keep) {
        if (!(num(it.qty) > 0)) return toast('Quantity must be more than 0 for every item', true);
        if (!(num(it.rate) >= 0)) return toast('Enter purchase price for every item', true);
      }
      busy('Saving correction…');
      try {
        for (const it of keep) if (it._newPhoto) await api('uploadPhoto', { photoId: it.photoId, data: await photoSrc(it.photoId) });
        const r = await api('amendPO', { poNo, reason: a.reason, poDate: a.poDate, remarks: a.remarks,
          items: keep.map(it => ({ itemNo: it.itemNo, itemName: it.itemName, description: it.description, qty: num(it.qty), unit: it.unit, rate: num(it.rate), mrp: num(it.mrp) || 0, remarks: it.remarks, photoId: it.photoId })) });
        S.amend = null; unbusy(); toast('Saved as Rev ' + r.rev + ' (' + r.changes + ' changes)'); go('#po/' + encodeURIComponent(poNo));
      } catch (e) { unbusy(); toast(e.message, true); }
    });
  }

  // ---------- suppliers ----------
  function viewSuppliers() {
    setTop('Suppliers', '#home');
    view('<input id="sp-q" placeholder="Search supplier or place…" autocomplete="off" style="margin-bottom:10px"><div id="sp-list"></div>');
    setActions(can.editSupplier() ? '<button class="btn gold" id="sp-new">+ New supplier</button>' : '');
    const draw = () => {
      const q = val('sp-q').toLowerCase();
      const res = S.suppliers.filter(s => !q || (s.name + ' ' + (s.place || '') + ' ' + (s.phone || '')).toLowerCase().includes(q));
      $('#sp-list').innerHTML = res.length ? res.map(s => '<div class="list-item" data-sid="' + esc(s.supplierId) + '"><div class="grow"><b>' + esc(s.name) + '</b><div class="muted small">' + esc([s.place, s.phone].filter(Boolean).join(' · ')) + '</div></div>›</div>').join('') : '<p class="muted">No suppliers found.</p>';
      on('#sp-list [data-sid]', 'click', e => go('#supplier/' + encodeURIComponent(e.currentTarget.dataset.sid)));
    };
    draw(); on('#sp-q', 'input', draw);
    on('#sp-new', 'click', () => go('#supplier/new'));
  }
  function viewSupplier(id) {
    const s = id === 'new' ? null : S.suppliers.find(x => x.supplierId === id);
    if (id !== 'new' && !s) return go('#suppliers');
    setTop(s ? s.name : 'New supplier', '#suppliers');
    if (can.editSupplier()) {
      view('<div class="card">' + supplierForm(s, 'sf-') + '</div>' + (s ? '<button class="btn ghost block" id="sf-orders">View orders from this supplier</button>' : ''));
      setActions('<button class="btn primary" id="sf-save">Save supplier</button>');
      on('#sf-save', 'click', async () => { const rec = readSupplierForm('sf-', s); if (!rec) return; await saveSupplierLocal(rec); toast('Supplier saved'); go('#suppliers'); });
    } else {
      view('<div class="card"><dl class="kv"><dt>Name</dt><dd>' + esc(s.name) + '</dd><dt>Place</dt><dd>' + esc(s.place || '-') + '</dd><dt>Phone</dt><dd>' + esc(s.phone || '-') + '</dd><dt>Contact</dt><dd>' + esc(s.contactPerson || '-') + '</dd><dt>GSTIN</dt><dd>' + esc(s.gstin || '-') + '</dd></dl></div><button class="btn primary block" id="sf-orders">View orders from this supplier</button>');
      setActions('');
    }
    on('#sf-orders', 'click', () => go('#orders?sup=' + encodeURIComponent(s.supplierId)));
  }

  // ---------- users (admin) ----------
  async function viewUsers() {
    if (!can.admin()) return go('#home');
    setTop('Users', '#home'); setActions('<button class="btn gold" id="us-new">+ Add user</button>'); view('<div class="muted">Loading…</div>');
    on('#us-new', 'click', () => go('#user/new'));
    try {
      const r = await api('listUsers'); S.users = r.users;
      view(r.users.map(u => '<div class="list-item" data-uid="' + esc(u.userId) + '"><div class="grow"><b>' + esc(u.name) + '</b> <span class="muted small">' + esc(u.userId) + ' · code ' + esc(u.userCode) + '</span><div>' +
        '<span class="badge b-info">' + esc(u.role) + '</span> ' + (u.active ? '' : '<span class="badge b-grey">Inactive</span> ') + (u.locked ? '<span class="badge b-bad">Locked</span> ' : '') + (u.mustChangePin && u.active ? '<span class="badge b-warn">PIN not yet changed</span>' : '') + '</div></div>›</div>').join('') +
        '<p class="muted small">Roles: <b>PURCHASER</b> creates suppliers and POs · <b>GODOWN</b> views POs and records goods received · <b>ADMIN</b> everything, plus corrections and users.</p>');
      on('[data-uid]', 'click', e => go('#user/' + encodeURIComponent(e.currentTarget.dataset.uid)));
    } catch (e) { view('<div class="notice bad">' + esc(e.message) + '</div>'); }
  }
  function viewUser(id) {
    if (!can.admin()) return go('#home');
    const u = id === 'new' ? null : (S.users || []).find(x => x.userId === id);
    if (id !== 'new' && !u) return go('#users');
    setTop(u ? u.name : 'Add user', '#users');
    view('<div class="card"><label class="req">Full name</label><input id="uf-name" value="' + esc(u && u.name) + '">' +
      '<div class="grid2"><div><label class="req">User ID (for login)</label><input id="uf-id" value="' + esc(u && u.userId) + '"' + (u ? ' disabled' : '') + ' style="text-transform:uppercase" placeholder="e.g. ROBIN"></div>' +
      '<div><label class="req">Short code (2–3 letters)</label><input id="uf-code" maxlength="3" value="' + esc(u && u.userCode) + '" style="text-transform:uppercase" placeholder="e.g. RB"></div></div>' +
      '<label class="req">Role</label><select id="uf-role">' + ['PURCHASER', 'GODOWN', 'ADMIN'].map(r => '<option' + (u && u.role === r ? ' selected' : '') + '>' + r + '</option>').join('') + '</select>' +
      '<label' + (u ? '' : ' class="req"') + '>' + (u ? 'Reset PIN (leave blank to keep)' : 'Starting PIN (user changes it at first login)') + '</label><input id="uf-pin" inputmode="numeric" placeholder="4–8 digits">' +
      (u ? '<label class="row" style="color:var(--text);font-size:15px;margin-top:12px"><input type="checkbox" id="uf-active"' + (u.active ? ' checked' : '') + '> Active (untick to block this user immediately)</label>' : '') +
      '<p class="muted tiny">The short code appears in PO numbers, e.g. MS-RB-261010-01.</p></div>');
    setActions('<button class="btn primary" id="uf-save">Save user</button>');
    on('#uf-save', 'click', async () => {
      busy('Saving…');
      try {
        const r = await api('saveUser', { user: { userId: u ? u.userId : val('uf-id'), name: val('uf-name'), userCode: val('uf-code'), role: val('uf-role'), pin: val('uf-pin'), active: u ? $('#uf-active').checked : true } });
        S.users = r.users; unbusy(); toast('User saved'); go('#users');
      } catch (e) { unbusy(); toast(e.message, true); }
    });
  }

  // ---------- settings ----------
  async function viewSettings() {
    setTop('Settings', '#home'); setActions('');
    let est = '';
    try { const e = await navigator.storage.estimate(); est = (e.usage / 1048576).toFixed(1) + ' MB used on this phone'; } catch (e) {}
    const u = S.session.user;
    view('<div class="card"><dl class="kv"><dt>Name</dt><dd>' + esc(u.name) + '</dd><dt>User ID</dt><dd>' + esc(u.userId) + '</dd><dt>Role</dt><dd>' + esc(u.role) + '</dd><dt>Code</dt><dd>' + esc(u.userCode) + '</dd></dl></div>' +
      '<div class="card"><button class="btn ghost block" id="st-pin">Change my PIN</button><button class="btn ghost block" id="st-sync" style="margin-top:8px">Upload & refresh now</button>' +
      '<button class="btn ghost block" id="st-clear" style="margin-top:8px">Free up phone space (clear downloaded photos)</button><p class="muted tiny">' + esc(est) + '</p></div>' +
      (can.admin() ? '<div class="card"><h2>Share app with staff</h2><p class="small muted">Send this link on WhatsApp. It opens the app with the server already set.</p><button class="btn gold block" id="st-link">Copy staff setup link</button></div>' : '') +
      '<button class="btn danger block" id="st-out">Log out</button><p class="muted tiny" style="text-align:center">Mechery Silks PO App · version ' + VERSION + '</p>');
    on('#st-pin', 'click', () => go('#changepin'));
    on('#st-sync', 'click', () => syncNow(true));
    on('#st-out', 'click', () => logout());
    on('#st-link', 'click', async () => {
      const link = location.origin + location.pathname + '?api=' + encodeURIComponent(S.apiUrl);
      try { await navigator.clipboard.writeText(link); toast('Link copied – paste it in WhatsApp'); } catch (e) { prompt('Copy this link:', link); }
    });
    on('#st-clear', 'click', async () => {
      if (!confirm('Remove downloaded photos from this phone? Photos of orders not yet uploaded are kept. Photos download again when needed.')) return;
      const keep = new Set();
      (await DB.all('outbox')).forEach(e => e.po && e.po.items.forEach(i => keep.add(i.photoId)));
      if (S.draft) S.draft.items.forEach(i => keep.add(i.photoId));
      if (S.itemPhoto) keep.add(S.itemPhoto);
      let n = 0; for (const k of await DB.keys('photos')) if (!keep.has(k)) { await DB.del('photos', k); n++; }
      await DB.clear('pocache');
      toast(n + ' photos removed'); render();
    });
  }

  // ---------- router ----------
  async function render() {
    const h = decodeURIComponent(location.hash.replace(/^#/, '').split('?')[0]);
    unbusy();
    if (!S.session) return h === 'login' ? viewLogin() : go('#login');
    if (S.session.user.mustChangePin && h !== 'changepin') return go('#changepin');
    const [p, ...rest] = h.split('/'); const arg = rest.join('/');
    switch (p) {
      case 'login': return go('#home');
      case 'changepin': return viewChangePin();
      case 'newpo': return viewNewPO();
      case 'item': return viewItem(arg);
      case 'review': return viewReview();
      case 'local': return viewLocal(arg);
      case 'pending': return viewPending();
      case 'orders': return viewOrders();
      case 'po': return viewPO(arg);
      case 'grn': return viewGRN(arg);
      case 'amend': return viewAmend(arg);
      case 'suppliers': return viewSuppliers();
      case 'supplier': return viewSupplier(arg);
      case 'users': return viewUsers();
      case 'user': return viewUser(arg);
      case 'settings': return viewSettings();
      default: return viewHome();
    }
  }

  async function init() {
    try {
      const qs = new URLSearchParams(location.search);
      if (qs.get('api')) { await DB.set('kv', 'apiUrl', qs.get('api')); history.replaceState(null, '', location.pathname + location.hash); }
      S.apiUrl = CFG.apiUrl || (await DB.get('kv', 'apiUrl')) || '';
      S.session = (await DB.get('kv', 'session')) || null;
      S.suppliers = (await DB.get('kv', 'suppliers')) || [];
      S.draft = (await DB.get('kv', 'draft')) || null;
    } catch (e) {
      view('<div class="notice bad">This browser is blocking app storage (private mode?). Open the app in normal Chrome/Safari.</div>'); return;
    }
    window.addEventListener('hashchange', render);
    window.addEventListener('online', () => { updatePill(); syncNow(); });
    window.addEventListener('offline', updatePill);
    setInterval(() => { if (S.pendingCount) syncNow(); }, 60000);
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
    await countPending();
    render();
    if (S.session) syncNow();
  }
  init();
})();
