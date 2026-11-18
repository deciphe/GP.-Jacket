// ==UserScript==
// @name         GP. Pulse for Vest
// @namespace    https://github.com/deciphe/gp-pulse
// @version      1.2.3
// @description  Spend, payouts and live PnL breathing in Vest's header, Zone sessions with a certificate, a risk-locked one-click order ticket, the trade managed from the ticket and the chart, a Vest-to-Vest copier and a desk to close any account.
// @author       GP.
// @homepageURL  https://github.com/deciphe/gp-pulse
// @updateURL    https://raw.githubusercontent.com/deciphe/gp-pulse/main/gp-pulse.user.js
// @downloadURL  https://raw.githubusercontent.com/deciphe/gp-pulse/main/gp-pulse.user.js
// @match        https://next.vestmarkets.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.top !== W.self) return;

  // ---------- Vest session: reuse the sign-in Vest's own page already sends. Kept in memory only, never saved. ----------
  // A user token (no accountId claim) reads everything and mints short-lived account tokens; an account token
  // places orders for that one account (Vest's own rule: POST /v3/auth/account-token).
  let AUTH = null, AUTH_ANY = null;
  const ACCT = {}; // accountId -> { tok, exp }
  const claims = v => { try { let p = String(v).replace(/^Bearer\s+/i, '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'); p += '='.repeat((4 - p.length % 4) % 4); return JSON.parse(atob(p)); } catch (e) { return null; } };
  function offer(v) {
    if (!v || !/^Bearer\s+/i.test(v)) return;
    const c = claims(v); if (!c) return;
    if (c.accountId) { ACCT[c.accountId] = { tok: v.replace(/^Bearer\s+/i, ''), exp: (c.exp || 0) * 1000 }; if (!AUTH_ANY) AUTH_ANY = v; return; }
    if (c.userId) { const first = !AUTH; AUTH = v; if (first) kick(); }
  }
  const GATE = /api-gateway[^/]*vestmarkets\.com/, TRADE_RE = /\/v3\/positions\/(open|append|reduce|close|cancel-order|stop-loss|take-profit)/;
  const XO = W.XMLHttpRequest.prototype.open, XH = W.XMLHttpRequest.prototype.setRequestHeader, XS = W.XMLHttpRequest.prototype.send;
  W.XMLHttpRequest.prototype.open = function (m, u) { this.__gpzu = String(u); this.__gpzm = String(m || 'GET').toUpperCase(); return XO.apply(this, arguments); };
  W.XMLHttpRequest.prototype.setRequestHeader = function (k, v) { try { if (/^authorization$/i.test(k) && GATE.test(this.__gpzu || '')) offer(v); } catch (e) {} return XH.apply(this, arguments); };
  W.XMLHttpRequest.prototype.send = function () { try { if (this.__gpzm !== 'GET' && TRADE_RE.test(this.__gpzu || '')) this.addEventListener('loadend', () => kickFast(250)); } catch (e) {} return XS.apply(this, arguments); };
  const F0 = W.fetch;
  W.fetch = function (i, o) {
    let trade = false;
    try { const u = (i && i.url) || String(i); if (GATE.test(u)) { offer(new W.Headers((o && o.headers) || (i && i.headers) || {}).get('authorization')); trade = TRADE_RE.test(u) && String((o && o.method) || (i && i.method) || 'GET').toUpperCase() !== 'GET'; } } catch (e) {}
    const r = F0.apply(this, arguments); if (trade) r.then(() => kickFast(250), () => {}); return r;
  };
  setTimeout(() => { if (!AUTH && AUTH_ANY) { AUTH = AUTH_ANY; kick(); } }, 20000);

  const API = 'https://api-gateway.hz.vestmarkets.com';
  let backoff = 0;
  async function api(path, pub) {
    if (!pub && !AUTH) throw new Error('noauth');
    const r = await F0.call(W, API + path, { headers: pub ? { Accept: 'application/json' } : { Accept: 'application/json', Authorization: AUTH } });
    if (r.status === 401) { AUTH = null; throw new Error('noauth'); }
    if (r.status === 429) { backoff = Date.now() + 30000; throw new Error('busy'); }
    if (!r.ok) throw new Error('http ' + r.status);
    return r.json();
  }
  async function pages(path, key, nk, seen, full) {
    let out = [], cur = null, n = 0;
    do {
      const j = await api(path + (cur ? (path.includes('?') ? '&' : '?') + 'cursor=' + encodeURIComponent(cur) : ''));
      const items = j[key] || []; out = out.concat(items);
      if (!full && items.some(seen)) break;
      const nx = j[nk]; if (!nx || nx === cur) break; cur = nx;
    } while (++n < 80);
    return out;
  }

  // ---------- saved locally in Tampermonkey ----------
  const DB = Object.assign({ purch: {}, pay: {}, aff: {}, wd: {}, full: 0, win: 'today', zone: null, zones: [], name: '', hero: '', layout: 'land', dayBase: {} }, GM_getValue('pulse', {}) || {});
  let saveT = 0;
  const save = now => { clearTimeout(saveT); if (now) GM_setValue('pulse', DB); else saveT = setTimeout(() => GM_setValue('pulse', DB), 800); };

  async function syncHistory(full) {
    const P = await pages('/v3/payments/purchases', 'items', 'nextCursor', x => DB.purch[x.purchaseId || x.id], full);
    P.forEach(x => {
      if (!/paid|refund/i.test(x.status || '')) return;
      DB.purch[x.purchaseId || x.id] = { t: Date.parse(x.paidAt || x.createdAt) || 0, amt: ((+x.amountPaidMinor || 0) - (+x.refundedMinor || 0)) / 100, n: +x.quantity || 1, name: x.productName || '', type: x.productType || '', size: +x.accountSize || 0 };
    });
    const Y = await pages('/v3/history/payouts?sort_by=created_at&sort_dir=desc&limit=50', 'items', 'next', x => DB.pay[x.id] && DB.pay[x.id].st === x.status, full);
    Y.forEach(x => { DB.pay[x.id] = { t: x.executed_at || x.created_at, c: x.created_at, amt: +x.trader_amount || 0, req: +x.requested_amount || 0, acct: x.account_id, st: String(x.status || '') }; });
    const D = await pages('/v3/history/withdrawals?sort_by=created_at&sort_dir=desc&limit=50', 'items', 'next', x => DB.wd[x.id] && DB.wd[x.id].st === x.status, full);
    D.forEach(x => { DB.wd[x.id] = { t: x.created_at, amt: +x.amount || 0, st: String(x.status || '') }; });
    // affiliate payouts (commissions paid to you), separate from trading payouts
    for (let off = 0, k = 0; k < 40; k++, off += 200) {
      const j = await api('/v3/affiliate/payout-requests?limit=200&offset=' + off).catch(() => null);
      const R = (j && j.requests) || [];
      let seen = 0; R.forEach(x => { if (DB.aff[x.id] && DB.aff[x.id].st === x.status) seen++; DB.aff[x.id] = { t: x.processed_at_ms || x.requested_at_ms || 0, c: x.requested_at_ms || 0, amt: (+x.amount_cents || 0) / 100, st: String(x.status || '') }; });
      if (R.length < 200 || (!full && seen)) break;
    }
    if (full) DB.full = Date.now();
    DB.synced = Date.now(); save();
  }

  // ---------- live funded accounts ----------
  const L = { cap: null, bal: {}, pos: [], mark: {}, at: 0, err: '', ok: false };
  const planShort = (p, size) => {
    p = String(p || '').replace('Vest Capital ', ''); const sz = size ? (size >= 1000 ? '$' + size / 1000 + 'K' : '$' + size) + ' ' : '';
    if (/Instant/i.test(p)) return sz + 'Instant';
    const tier = (p.split('|').pop() || '').trim();
    return sz + (/2-Step/.test(p) ? '2-Step ' : '1-Step ') + tier;
  };
  const vestDay = () => { // Vest resets daily limits at 8pm New York time
    const now = new Date(), ny = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' })), off = now - ny;
    const d = new Date(ny); d.setHours(20, 0, 0, 0); if (ny < d) d.setDate(d.getDate() - 1); return +d + off;
  };

  // An account's cash balance (closed PnL in, open PnL out). Vest's /v3/accounts `amount` is only FREE collateral: it
  // drops by the margin an open trade holds, so reading it as the balance shows a winning trade as a loss. With nothing
  // open, free = balance exactly. With a trade open, the balance is Vest's own equity series less its open PnL (one
  // point a minute; closed PnL only moves when a trade closes), else free plus the margin the open trades hold.
  function cashOf(id) {
    if (L.bal[id] == null) return null;
    const open = L.pos.filter(p => (p.accountId || p.account_id) === id).length, s = L.cashS && L.cashS[id];
    if (open && s && Date.now() - s.at < 10 * 6e4 && s.n === open) return s.cash;
    return L.cash && L.cash[id] != null ? L.cash[id] : L.bal[id];
  }
  // free collateral and positions read in the same round: balance = free + the margin those positions hold. Only
  // taken from a matching pair, so a trade opened between two balance reads can't count its margin as money.
  const marginOf = id => L.pos.filter(p => (p.accountId || p.account_id) === id).reduce((a, p) => a + Math.abs(+p.quantity) * (+p.openPrice) / (+p.leverage || 1), 0);
  function snapCash() { const o = {}; for (const id in L.bal) o[id] = L.bal[id] + marginOf(id); L.cash = o; }
  let seriesAt = 0;
  async function loadSeries() {
    if (Date.now() - seriesAt < 15000 || !L.pos.length) return; seriesAt = Date.now();
    try {
      const now = Date.now(), j = await api('/v3/trading-performance/series?from=' + (now - 30 * 6e4) + '&to=' + now + '&points=30');
      const last = {}; (j.items || []).forEach(it => { const id = it.account_id; if (!last[id] || (it.ts || 0) > (last[id].ts || 0)) last[id] = it; });
      L.cashS = L.cashS || {};
      for (const id in last) { const it = last[id], eqv = +it.equity_value, u = +it.total_unrealized_pnl || 0; if (isFinite(eqv)) L.cashS[id] = { cash: eqv - u, at: Date.now(), n: L.pos.filter(p => (p.accountId || p.account_id) === id).length }; }
    } catch (e) {}
  }
  function liveRows() {
    if (!L.cap) return [];
    const d0 = vestDay(), key = String(d0);
    if (!DB.dayBase[key]) DB.dayBase = { [key]: {} };
    const rows = [];
    L.cap.filter(c => c.account_type === 3 && c.status === 2).forEach(c => {
      if (!(c.id in L.bal)) return;
      let u = 0, open = 0;
      L.pos.forEach(p => { if ((p.accountId || p.account_id) !== c.id) return; open++; const m = L.mark[p.symbol]; if (m) u += (m - +p.openPrice) * Math.abs(+p.quantity) * (/^s/i.test(p.side || '') ? -1 : 1); });
      const eq = cashOf(c.id) + u;
      let base = +c.daily_reset_equity;
      if (!(c.daily_reset_at >= d0 - 3 * 36e5) || !isFinite(base)) { const b = DB.dayBase[key]; if (b[c.id] == null) { b[c.id] = eq; save(); } base = b[c.id]; }
      rows.push({ id: c.id, name: planShort(c.plan_name, +c.initial_capital), size: +c.initial_capital || 0, eq, u, today: eq - base, open });
    });
    return rows.sort((a, b) => b.today - a.today);
  }
  W.__gpzLive = () => liveRows().map(r => ({ id: r.id, eq: +r.eq.toFixed(2), today: +r.today.toFixed(2) }));

  // ---------- money ----------
  const fm = (v, o = {}) => { const a = Math.abs(v), s = v < 0 ? '−' : o.sign && v > 0 ? '+' : ''; const d = o.short && a >= 1e4 ? 0 : 2; return s + '$' + a.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); };
  const fk = v => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return s + '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a >= 1000 ? Math.round(a).toLocaleString('en-US') : a.toFixed(a >= 100 ? 0 : 2).replace(/\.00$/, '')); };
  const fdur = ms => { const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(x).padStart(2, '0'); };
  const fdurWords = ms => { if (ms < 6e4) return Math.max(1, Math.round(ms / 1000)) + 's'; const m = Math.round(ms / 6e4), h = Math.floor(m / 60); return h ? h + 'h ' + (m % 60) + 'm' : m + 'm'; };

  const WINS = [['1m', 'last minute', 6e4], ['1h', 'last hour', 36e5], ['today', 'today', 0], ['24h', 'last 24h', 864e5], ['7d', '7 days', 6048e5], ['30d', '30 days', 2592e6], ['all', 'all time', Infinity]];
  const since = w => { if (w === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return +d; } const ms = WINS.find(x => x[0] === w)[2]; return ms === Infinity ? 0 : Date.now() - ms; };
  const BAD = /fail|reject|cancel/i;
  function sums(w, t1) {
    const t0 = typeof w === 'number' ? w : since(w), end = t1 || Infinity, inW = t => t >= t0 && t <= end;
    let spend = 0, bought = 0, pay = 0, payPend = 0, aff = 0, affPend = 0, wd = 0, wdPend = 0;
    Object.values(DB.purch).forEach(p => { if (inW(p.t)) { spend += p.amt; bought += p.n; } });
    Object.values(DB.pay).forEach(p => { if (BAD.test(p.st)) return; if (/execut|complet|paid/i.test(p.st)) { if (inW(p.t)) pay += p.amt; } else if (inW(p.c || p.t)) payPend += p.amt; });
    Object.values(DB.aff || {}).forEach(p => { if (BAD.test(p.st)) return; if (/paid|execut|complet/i.test(p.st)) { if (inW(p.t)) aff += p.amt; } else if (inW(p.c || p.t)) affPend += p.amt; });
    Object.values(DB.wd).forEach(x => { if (BAD.test(x.st) || !inW(x.t)) return; if (/complet|execut|confirm|success/i.test(x.st)) wd += x.amt; else wdPend += x.amt; });
    return { spend, bought, pay, payPend, aff, affPend, wd, wdPend, net: pay - spend };
  }
  function rate(w, spend) {
    if (w === '1m') return [spend, 'a minute'];
    const t0 = w === 'all' ? Math.min(...Object.values(DB.purch).map(p => p.t), Date.now()) : since(w), hrs = Math.max(1 / 60, (Date.now() - t0) / 36e5);
    return hrs > 72 ? [spend / (hrs / 24), 'a day'] : [spend / hrs, 'an hour'];
  }
  function dailySpend(days) {
    const out = [], d = new Date(); d.setHours(0, 0, 0, 0);
    for (let i = days - 1; i >= 0; i--) { const a = +d - i * 864e5; out.push({ t: a, v: 0 }); }
    Object.values(DB.purch).forEach(p => { const i = Math.floor((p.t - out[0].t) / 864e5); if (i >= 0 && i < days) out[i].v += p.amt; });
    return out;
  }

  // ---------- zone ----------
  function zoneStart() {
    DB.zone = { t0: Date.now(), base: {}, last: {}, seen: {}, open: {}, trades: [], peak: 0, low: 0, samples: [[Date.now(), 0]], liveSeen: false, status0: null };
    save(true);
    api('/v3/capital/accounts?limit=500').then(j => { if (DB.zone) { DB.zone.status0 = Object.fromEntries((j.accounts || []).map(c => [c.id, c.status])); save(); } }).catch(() => {});
    zoneTick(); render();
  }
  function zoneLive(z) {
    let v = 0; for (const id in z.last) v += z.last[id] - z.base[id];
    Object.values(DB.pay).forEach(p => { if (!BAD.test(p.st) && (p.c || p.t) >= z.t0 && p.acct in z.base) v += p.req || p.amt; });
    return v;
  }
  function zoneTick() {
    const z = DB.zone; if (!z) return;
    liveRows().forEach(r => { if (z.base[r.id] == null) z.base[r.id] = r.eq; z.last[r.id] = r.eq; z.liveSeen = true; });
    // trades closed during the zone, any account
    const nowOpen = {}; L.pos.forEach(p => { nowOpen[p.positionId] = p.accountId || p.account_id; });
    if (L.ok) {
      for (const id in z.open) if (!(id in nowOpen)) { const acct = z.open[id]; delete z.open[id]; closedPnl(acct, id); }
      Object.assign(z.open, nowOpen);
    }
    const pl = zoneLive(z); z.peak = Math.max(z.peak, pl); z.low = Math.min(z.low, pl);
    const last = z.samples[z.samples.length - 1]; if (Date.now() - last[0] > 15000) { z.samples.push([Date.now(), pl]); if (z.samples.length > 1500) z.samples = z.samples.filter((s, i) => i % 2 === 0); }
    save();
  }
  async function closedPnl(acct, id) {
    for (let k = 0; k < 3; k++) {
      await new Promise(r => setTimeout(r, 1500 + k * 4000));
      try { const j = await api(`/v3/positions?account_id=${acct}&limit=25&offset=0`); const p = (j.positions || []).find(x => x.positionId === id); if (p && p.closeDate) { if (DB.zone) { DB.zone.trades.push({ pnl: +p.pnl || 0, fee: +p.fee || 0, sym: String(p.symbol || '').replace(/-USD-PERP$|-PERP$/, '') }); save(); render(); } return; } } catch (e) {}
    }
    if (DB.zone) { DB.zone.trades.push({ pnl: null }); save(); }
  }
  async function zoneEnd() {
    const z = DB.zone; if (!z) return;
    zoneTick();
    const t1 = Date.now(), s = sums(z.t0, t1);
    let passed = 0, blown = 0;
    try {
      const j = await api('/v3/capital/accounts?limit=500');
      (j.accounts || []).forEach(c => { const was = z.status0 && z.status0[c.id]; const fresh = !was && c.created_at >= z.t0; if ((was === 2 || fresh) && c.status === 6) passed++; if ((was === 2 || fresh) && (c.status === 4 || c.status === 5)) blown++; });
    } catch (e) {}
    const live = zoneLive(z), tr = z.trades.filter(t => t.pnl != null);
    const sum = { id: t1, t0: z.t0, t1, spend: s.spend, bought: s.bought, pay: s.pay, wd: s.wd, live, liveSeen: z.liveSeen, peak: z.peak, low: z.low, net: live - s.spend, trades: z.trades.length, wins: tr.filter(t => t.pnl > 0).length, tradePnl: tr.reduce((a, t) => a + t.pnl, 0), passed, blown, samples: z.samples.filter((x, i, a) => a.length < 160 || i % Math.ceil(a.length / 160) === 0).concat([[t1, live]]) };
    DB.zones = [sum].concat(DB.zones || []).slice(0, 40); DB.zone = null; save(true);
    render(); openCert(sum);
  }

  // ---------- polling ----------
  let tick = 0, OPEN = false, T = 0, busy = false, booted = false;
  function kick() { if (booted && !busy) { clearTimeout(T); T = setTimeout(loop, 250); } }
  async function loop() {
    if (busy) return; busy = true; clearTimeout(T);
    let wait = OPEN || DB.zone ? 4000 : 9000;
    if (!document.hidden && AUTH && Date.now() > backoff) {
      tick++;
      try {
        await Promise.all([
          api('/v3/accounts?active=true&limit=500').then(j => { L.bal = {}; (j.accounts || []).forEach(a => { L.bal[a.account_id] = +a.amount || 0; }); L.balAt = Date.now(); }),
          api('/v3/positions/opened').then(j => { L.pos = j.positions || []; }),
          (!L.cap || tick % 6 === 0) ? api('/v3/capital/accounts/active').then(j => { L.cap = j.accounts || []; }) : null
        ]);
        snapCash();
        if (L.pos.length) { await readMarks(); await loadSeries(); }
        L.ok = true; L.at = Date.now(); L.err = '';
        if (!DB.full || Date.now() - DB.full > 6 * 36e5) await syncHistory(true);
        else if (tick % (OPEN ? 8 : 7) === 2) await syncHistory(false);
      } catch (e) { L.err = String(e.message || e); if (L.err === 'busy') wait = 30000; }
      zoneTick();
    }
    busy = false; render();
    T = setTimeout(loop, wait);
  }

  // ---------- look ----------
  function fonts() { if (document.getElementById('gpz-font')) return; const l = document.createElement('link'); l.id = 'gpz-font'; l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=STIX+Two+Text:ital,wght@1,500&display=swap'; (document.head || document.documentElement).appendChild(l); }
  const VEST_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 549 340" aria-hidden="true"><defs><linearGradient id="fv1" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#b4b0a7"/><stop offset="1" stop-color="#4c4a46"/></linearGradient><linearGradient id="fv2" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a968e"/><stop offset="1" stop-color="#3e3c39"/></linearGradient><linearGradient id="fv3" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3835"/><stop offset="1" stop-color="#8e8a82"/></linearGradient></defs><path d="M130.463 1.64132L2.10114 104.296C0.259255 105.778 0.259255 108.571 2.10114 110.032L136.429 217.472V4.52427C136.429 1.43111 132.865 -0.260628 130.453 1.64132H130.463Z" fill="url(#fv1)"/><path d="M546.559 104.307L418.198 1.6418C415.785 -0.290179 412.222 1.43159 412.222 4.52475V217.483L546.559 110.043C548.401 108.561 548.401 105.768 546.559 104.307Z" fill="url(#fv2)"/><path d="M272.038 325.934L136.429 217.482V335.143C136.429 337.165 138.06 338.827 140.112 338.827H408.597C410.62 338.827 412.281 337.195 412.281 335.143V217.482L276.672 325.934C275.331 327.005 273.439 327.005 272.068 325.934H272.038Z" fill="url(#fv3)"/></svg>';
  // halftone moon: lit from the upper left, sparse toward the limb
  function moon(x, W_, H_, cx, cy, R, st, alpha) {
    const hh = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
    for (let j = 0; ; j++) { const py = j * st; if (py > H_ + st) break;
      for (let px = 0; px < W_ + st; px += st) {
        const dx = (px - cx) / R, dy = (py - cy) / R, d2 = dx * dx + dy * dy; if (d2 >= 1) continue;
        let l = Math.max(0, dx * -.5 + dy * -.55 + Math.sqrt(1 - d2) * .67) * (.82 + .18 * hh(Math.floor(px / (st * 6)), Math.floor(py / (st * 6))));
        const edge = Math.min(1, Math.max(0, (1 - Math.sqrt(d2)) / .4)), a = (.05 + .3 * l) * (.3 + .7 * edge) * alpha, r = st * .26 * (.4 + .6 * l) * (.55 + .45 * edge);
        if (a < .015 || r < .3) continue; x.fillStyle = `rgba(226,226,232,${a.toFixed(3)})`; x.beginPath(); x.arc(px, py, r, 0, 6.283); x.fill();
      } }
  }

  // ---------- the pill in Vest's header ----------
  const PCSS = `:host{all:initial;display:inline-flex;align-items:center}
  .p{position:relative;display:inline-flex;align-items:center;gap:10px;height:34px;padding:0 15px 0 13px;border-radius:8px;border:1px solid rgba(238,234,226,.12);background:#0b0b0b;color:#eeeae2;font:700 13px Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;cursor:pointer;white-space:nowrap;transition:border-color .4s,background .4s,opacity .4s}
  .p:hover{border-color:rgba(238,234,226,.32);background:#101010}
  .p.open{opacity:.45}
  .dot{position:relative;flex:none;width:8px;height:8px;border-radius:50%;background:#e6e3dc;animation:br 7s ease-in-out infinite}
  .dot:after{content:"";position:absolute;inset:-6px;border-radius:50%;border:1px solid rgba(230,227,220,.55);animation:ring 7s ease-out infinite}
  @keyframes br{0%,100%{transform:scale(.62);opacity:.5}42%{transform:scale(1.06);opacity:1}}
  @keyframes ring{0%,8%{transform:scale(.35);opacity:0}38%{opacity:.55}100%{transform:scale(1.75);opacity:0}}
  .p.zone{border-color:rgba(230,227,220,.42)}.p.zone .dot{animation-duration:5s}.p.zone .dot:after{animation-duration:5s}
  .p.wait .dot{background:#6d6d73}.p.wait .dot:after{display:none}
  b{font-weight:600;letter-spacing:-.035em}
  .v{font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .l{font-weight:600;color:#9e9ea5}
  .s{width:1px;height:14px;background:rgba(238,234,226,.14)}
  .up{color:#9fd7b2}.dn{color:#e8988c}
  [hidden]{display:none!important}
  @media (prefers-reduced-motion:reduce){.dot,.dot:after{animation:none}}`;
  let PILL = null;
  function pill() {
    if (PILL) return PILL;
    const host = document.createElement('div'); host.id = 'gpz-home';
    const R = host.attachShadow({ mode: 'open' });
    R.innerHTML = `<style>${PCSS}</style><button class="p wait" aria-label="Open GP. Pulse"><i class="dot"></i><b>GP.</b><span class="v" data-k="a">—</span><span class="l" data-k="al">spent today</span><i class="s" data-k="sep" hidden></i><span class="v" data-k="b" hidden></span><span class="l" data-k="bl" hidden>live</span></button>`;
    R.querySelector('.p').onclick = e => { e.stopPropagation(); OPEN ? closePanel() : openPanel(); };
    PILL = { host, R, btn: R.querySelector('.p'), k: n => R.querySelector(`[data-k="${n}"]`) };
    return PILL;
  }
  function slot() {
    const hdr = document.querySelector('header'); if (!hdr || !hdr.offsetParent && getComputedStyle(hdr).position !== 'fixed') return null;
    const kids = [...hdr.children]; const right = kids.filter(k => k.querySelector && k.querySelector('button')).pop();
    return right && right.getBoundingClientRect().width ? right : null;
  }
  function placePill() {
    if (!document.body) return;
    const P = pill(), s = slot();
    if (s) { if (P.host.parentElement !== s) { P.host.style.cssText = 'margin-right:4px;flex:none'; s.insertBefore(P.host, s.firstChild); } }
    else if (P.host.parentElement !== document.body) { P.host.style.cssText = 'position:fixed;left:14px;bottom:14px;z-index:2147483645'; document.body.appendChild(P.host); }
  }

  // ---------- the panel ----------
  const CSS = `:host{all:initial}
  *{box-sizing:border-box}
  .ov{position:fixed;inset:0;z-index:2147483646;font-family:Inter,system-ui,sans-serif;color:#f1f1f3;-webkit-font-smoothing:antialiased}
  .dim{position:absolute;inset:0;background:rgba(4,4,5,.7);backdrop-filter:blur(10px) saturate(.7);-webkit-backdrop-filter:blur(10px) saturate(.7);opacity:0;transition:opacity .7s ease}
  .ov.on .dim{opacity:1}
  .pn{position:absolute;left:50%;top:50%;width:min(1240px,calc(100vw - 28px));height:min(800px,calc(100vh - 28px));transform:translate(-50%,-50%);background:#0b0b0b;border:1px solid rgba(238,234,226,.08);border-radius:24px;overflow:hidden;box-shadow:0 80px 160px -50px rgba(0,0,0,.95)}
  .pn.anim{transition:clip-path .78s cubic-bezier(.16,1,.3,1)}
  .moon{position:absolute;right:-12%;bottom:-38%;width:min(1100px,92vw);aspect-ratio:1;pointer-events:none;animation:breathe 11s ease-in-out infinite;-webkit-mask-image:linear-gradient(115deg,rgba(0,0,0,.5) 35%,#000 50%,rgba(0,0,0,.5) 65%);mask-image:linear-gradient(115deg,rgba(0,0,0,.5) 35%,#000 50%,rgba(0,0,0,.5) 65%);-webkit-mask-size:320% 100%;mask-size:320% 100%;transform-origin:70% 70%}
  .moon canvas{width:100%;height:100%;display:block}
  @keyframes breathe{0%,100%{transform:scale(1);opacity:.78;-webkit-mask-position:100% 0;mask-position:100% 0}50%{transform:scale(1.03);opacity:1;-webkit-mask-position:0 0;mask-position:0 0}}
  .vm{position:absolute;right:46px;bottom:40px;width:120px;opacity:.85;pointer-events:none}.vm svg{display:block;width:100%;height:auto}
  .in{position:relative;height:100%;display:flex;flex-direction:column;padding:30px 44px 30px;overflow:auto;scrollbar-width:none}
  .in::-webkit-scrollbar{display:none}
  .f{opacity:0;transform:translateY(14px);transition:opacity .9s ease,transform 1.1s cubic-bezier(.16,1,.3,1)}
  .ov.shown .f{opacity:1;transform:none}
  .ov.shown .f1{transition-delay:.12s}.ov.shown .f2{transition-delay:.22s}.ov.shown .f3{transition-delay:.32s}.ov.shown .f4{transition-delay:.42s}.ov.shown .f5{transition-delay:.52s}
  .top{display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap}
  .brand{display:flex;align-items:baseline;gap:13px;font-size:30px;font-weight:600;letter-spacing:-.05em}
  .brand span{font-size:11px;letter-spacing:.34em;font-weight:700;color:#9e9ea5}
  .acts{display:flex;align-items:center;gap:10px}
  .st{display:flex;align-items:center;gap:9px;font-size:12.5px;font-weight:600;color:#9e9ea5;margin-right:6px}
  .st i{width:7px;height:7px;border-radius:50%;background:#9fd7b2;animation:br2 7s ease-in-out infinite}
  .st.bad i{background:#e8988c}.st.wait i{background:#6d6d73;animation:none}
  @keyframes br2{0%,100%{opacity:.35;transform:scale(.7)}45%{opacity:1;transform:scale(1)}}
  .btn{height:38px;padding:0 17px;border-radius:8px;border:1px solid rgba(238,234,226,.13);background:transparent;color:#f1f1f3;font:700 13px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;transition:border-color .3s,background .3s}
  .btn:hover{border-color:rgba(238,234,226,.38)}
  .btn.hi{background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b}.btn.hi:hover{background:#fff}
  .btn.ic{width:38px;padding:0;font-size:15px;color:#9e9ea5}.btn.ic:hover{color:#f1f1f3}
  .main{flex:1;display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,1fr);gap:56px;margin-top:34px;min-height:0}
  .lab{font-size:14px;font-weight:600;color:#9e9ea5}.lab b{color:#f1f1f3;font-weight:600;margin-right:8px}
  .giant{margin-top:10px;font-size:clamp(84px,10.5vw,158px);font-weight:600;letter-spacing:-.065em;line-height:.86;color:#e6e3dc;font-variant-numeric:tabular-nums;white-space:nowrap;animation:glow 9s ease-in-out infinite}
  .giant small{font-size:.36em;letter-spacing:-.03em;color:#bdbbb5;margin-left:.04em}
  @keyframes glow{0%,100%{opacity:.9}50%{opacity:1}}
  .sub{margin-top:18px;font-size:18px;font-weight:500;color:#8b8b92;letter-spacing:-.01em}
  .sub b{font-style:normal;font-weight:600;color:#f1f1f3}.sub b.up{color:#9fd7b2}.sub b.dn{color:#e8988c}
  .hero>div{display:flex;flex-direction:column;height:100%}
  .lad{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));margin-top:38px;border-top:1px solid rgba(238,234,226,.08)}
  .lad button{position:relative;padding:16px 4px 4px 0;border:0;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
  .lad button:before{content:"";position:absolute;left:0;right:12px;top:-1px;height:2px;background:#e6e3dc;transform:scaleX(0);transform-origin:left;transition:transform .6s cubic-bezier(.16,1,.3,1)}
  .lad button.on:before{transform:scaleX(1)}
  .lad b{display:block;font-size:20px;font-weight:600;letter-spacing:-.03em;color:#8d8d93;font-variant-numeric:tabular-nums;transition:color .3s;white-space:nowrap}
  .lad span{display:block;margin-top:5px;font-size:12px;font-weight:600;color:#6f6f75}
  .lad button:hover b,.lad button.on b{color:#f1f1f3}.lad button.on span{color:#9e9ea5}
  .bars{display:flex;align-items:flex-end;gap:4px;height:64px;margin-top:auto;padding-top:30px;box-sizing:content-box}
  .bars i{flex:1;min-height:2px;border-radius:2px;background:rgba(238,234,226,.16);transition:height 1.1s cubic-bezier(.16,1,.3,1),background .3s}
  .bars i.t{background:#e6e3dc;animation:glow 4s ease-in-out infinite}
  .bars i:hover{background:rgba(238,234,226,.5)}
  .bl{display:flex;justify-content:space-between;margin-top:8px;font-size:11.5px;font-weight:600;color:#6f6f75}
  .live{display:flex;flex-direction:column;min-height:0;padding-left:44px;border-left:1px solid rgba(238,234,226,.07)}
  .lbig{margin-top:10px;font-size:clamp(52px,5.6vw,84px);font-weight:600;letter-spacing:-.06em;line-height:.9;font-variant-numeric:tabular-nums;color:#e6e3dc;white-space:nowrap}
  .lbig.up{color:#bfe6cb}.lbig.dn{color:#efb1a7}
  .lsub{margin-top:14px;font-size:14px;font-weight:600;color:#9e9ea5}.lsub b{color:#f1f1f3;font-weight:600}
  .rows{margin-top:24px;display:flex;flex-direction:column;gap:2px;overflow:auto;scrollbar-width:none;min-height:0;flex:1}
  .rows::-webkit-scrollbar{display:none}
  .row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:13px 0;border-bottom:1px solid rgba(238,234,226,.06)}
  .row .n{font-size:15px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.row .n em{font-style:normal;font-weight:600;color:#6f6f75;margin-left:8px;font-size:12.5px}
  .row .v{font-size:17px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums;text-align:right}
  .row .q{grid-column:1/-1;font-size:12px;font-weight:600;color:#6f6f75;margin-top:-4px}
  .none{margin-top:20px;font-size:15px;font-weight:600;color:#6f6f75;line-height:1.5}
  .foot{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:24px;margin-top:30px;padding:24px 170px 0 0;border-top:1px solid rgba(238,234,226,.08)}
  .ft b{display:block;font-size:30px;font-weight:600;letter-spacing:-.045em;font-variant-numeric:tabular-nums;white-space:nowrap}
  .ft span{display:block;margin-top:6px;font-size:12.5px;font-weight:600;color:#9e9ea5}
  .ft em{font-style:normal;color:#6f6f75}
  .split{grid-column:1/-1;display:flex;height:4px;border-radius:4px;overflow:hidden;background:rgba(238,234,226,.07);margin-top:-6px}
  .split i{height:100%;transition:width 1.2s cubic-bezier(.16,1,.3,1)}
  .up{color:#9fd7b2}.dn{color:#e8988c}
  [hidden]{display:none!important}
  /* zone */
  .zone .giant{font-size:clamp(84px,11.5vw,172px)}
  .spark{margin-top:auto!important}
  .zrow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:18px;margin-top:38px;padding-top:20px;border-top:1px solid rgba(238,234,226,.08)}
  .zrow b{display:block;font-size:26px;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums;white-space:nowrap}
  .zrow span{display:block;margin-top:6px;font-size:12.5px;font-weight:600;color:#9e9ea5}
  .spark{display:block;width:100%;height:84px;margin-top:26px}
  .ring{position:absolute;right:15%;bottom:18%;width:190px;height:190px;border-radius:50%;border:1px solid rgba(230,227,220,.35);pointer-events:none;animation:inhale 10s ease-in-out infinite;display:grid;place-items:center}
  .ring:before{content:"";position:absolute;inset:18px;border-radius:50%;border:1px solid rgba(230,227,220,.14)}
  .ring span{font-size:11px;letter-spacing:.34em;font-weight:700;color:rgba(230,227,220,.55);animation:word 10s ease-in-out infinite}
  @keyframes inhale{0%,100%{transform:scale(.72);opacity:.45}40%{transform:scale(1.08);opacity:1}55%{transform:scale(1.08);opacity:1}}
  .past{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap}
  .past button{height:30px;padding:0 12px;border-radius:8px;border:1px solid rgba(238,234,226,.1);background:none;color:#9e9ea5;font:700 12px Inter,system-ui,sans-serif;cursor:pointer}
  .past button:hover{color:#f1f1f3;border-color:rgba(238,234,226,.3)}
  /* certificate */
  .cert{position:absolute;inset:0;z-index:5;display:grid;place-items:center;background:rgba(5,5,6,.84);opacity:0;transition:opacity .6s;padding:18px}
  .cert.on{opacity:1}
  .cbox{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:26px;width:min(1160px,100%);max-height:100%;overflow:auto;background:#0f0f0f;border:1px solid rgba(241,241,243,.09);border-radius:24px;padding:22px}
  .cbox canvas{display:block;width:100%;height:auto;border-radius:12px;background:#0b0b0b}
  .cc{display:flex;flex-direction:column;gap:16px}
  .cc label{display:flex;flex-direction:column;gap:7px;font-size:13px;font-weight:600;color:#9e9ea5}
  .cc input{height:42px;border-radius:12px;border:1px solid rgba(241,241,243,.12);background:#0b0b0b;color:#f1f1f3;padding:0 14px;font:600 15px Inter,system-ui,sans-serif;outline:none}
  .cc input:focus{border-color:rgba(241,241,243,.35)}
  .seg{display:flex;flex-wrap:wrap;gap:3px;padding:3px;border-radius:14px;border:1px solid rgba(241,241,243,.1)}
  .seg button{flex:1;border:0;background:none;color:#9e9ea5;font:700 12.5px Inter,system-ui,sans-serif;padding:8px 8px;border-radius:8px;cursor:pointer;white-space:nowrap}
  .seg button.on{background:#e8e8ec;color:#0b0b0b}
  .cgo{margin-top:auto;display:flex;flex-direction:column;gap:10px}
  .cmsg{min-height:16px;font-size:12px;font-weight:600;color:#9fd7b2;text-align:center}
  @media (max-width:900px){.main{flex:none;min-height:auto}.live{min-height:auto}.rows{flex:none}.lbig{font-size:64px}.foot{padding-right:0;grid-template-columns:repeat(2,minmax(0,1fr))}.hero>div{height:auto}.bars{margin-top:30px}.main{grid-template-columns:1fr;gap:34px}.live{padding-left:0;border-left:0;border-top:1px solid rgba(238,234,226,.07);padding-top:26px}.rows{overflow:visible}.in{padding:22px 20px}.foot{grid-template-columns:repeat(2,minmax(0,1fr))}.lad{grid-template-columns:repeat(4,minmax(0,1fr));row-gap:6px}.zrow{grid-template-columns:repeat(2,minmax(0,1fr))}.cbox{grid-template-columns:1fr}.vm{display:none}.ring{display:none}.pn{border-radius:16px}}
  @media (prefers-reduced-motion:reduce){.moon,.giant,.ring,.bars i.t{animation:none}}`;
  let P = null;
  function panel() {
    if (P) return P;
    const host = document.createElement('div'); host.id = 'gpz-panel'; host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:auto';
    ['pointerdown', 'mousedown', 'click', 'keydown', 'focusin', 'wheel', 'touchstart'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    const R = host.attachShadow({ mode: 'open' });
    R.innerHTML = `<style>${CSS}</style><div class="ov"><div class="dim"></div><div class="pn">
      <div class="moon"><canvas width="1400" height="1400"></canvas></div><div class="vm">${VEST_SVG}</div><div class="ring" hidden><span>BREATHE</span></div>
      <div class="in">
        <div class="top f"><div class="brand">GIGAPROP.<span>PULSE</span></div><div class="acts"><div class="st wait"><i></i><span data-k="st">connecting</span></div><button class="btn hi" data-a="zone">Enter the zone</button><button class="btn ic" data-a="skin" title="Massive skin for Vest">◐</button><button class="btn ic" data-a="sync" title="Sync now">↻</button><button class="btn ic" data-a="min" title="Minimize">—</button></div></div>
        <div class="main">
          <div class="hero">
            <div data-v="spend">
              <div class="lab f f1"><b>Spent</b><span data-k="wl">today</span></div>
              <div class="giant f f1" data-k="big">$0<small>.00</small></div>
              <div class="sub f f2" data-k="rate"></div>
              <div class="lad f f3" data-k="lad"></div>
              <div class="bars f f4" data-k="bars"></div><div class="bl f f4"><span>30 days ago</span><span>today</span></div>
            </div>
            <div data-v="zone" class="zone" hidden>
              <div class="lab"><b>In the zone</b><span data-k="zs">since —</span></div>
              <div class="giant" data-k="zt">0:00</div>
              <div class="sub" data-k="zsub"></div>
              <div class="zrow"><div><b data-k="z1">$0</b><span>live PnL</span></div><div><b data-k="z2">$0</b><span>spent</span></div><div><b data-k="z3">0</b><span>accounts bought</span></div><div><b data-k="z4">0</b><span>trades closed</span></div></div>
              <svg class="spark" data-k="zsp" viewBox="0 0 600 84" preserveAspectRatio="none"></svg>
            </div>
          </div>
          <div class="live f f3">
            <div class="lab"><b>Live accounts</b>since the 8pm ET reset</div>
            <div class="lbig" data-k="lt">$0.00</div>
            <div class="lsub" data-k="ls"></div>
            <div class="rows" data-k="rows"></div>
            <div class="past" data-k="past"></div>
          </div>
        </div>
        <div class="foot f f5">
          <div class="ft"><b data-k="f1">$0</b><span>trading payouts <em data-k="f1w"></em></span></div>
          <div class="ft"><b data-k="f5">$0</b><span>affiliate payouts <em data-k="f5w"></em></span></div>
          <div class="ft"><b data-k="f2">$0</b><span>withdrawn <em data-k="f2w"></em></span></div>
          <div class="ft"><b data-k="f3">$0</b><span>spent</span></div>
          <div class="ft"><b data-k="f4">$0</b><span>trading payouts minus spend</span></div>
          <div class="split"><i data-k="sp1" style="background:#e6e3dc;width:0"></i><i data-k="sp2" style="background:rgba(238,234,226,.4);width:0"></i></div>
        </div>
      </div>
    </div></div>`;
    document.documentElement.appendChild(host);
    const cv = R.querySelector('.moon canvas'); moon(cv.getContext('2d'), 1400, 1400, 760, 760, 700, 15, 1);
    const k = n => R.querySelector(`[data-k="${n}"]`);
    // window ladder
    k('lad').innerHTML = WINS.map(w => `<button data-w="${w[0]}"><b>$0</b><span>${w[1]}</span></button>`).join('');
    k('lad').onclick = e => { const b = e.target.closest('button'); if (!b) return; DB.win = b.dataset.w; save(); render(); };
    k('bars').innerHTML = Array.from({ length: 30 }, () => '<i></i>').join('');
    R.querySelector('[data-a=min]').onclick = closePanel;
    R.querySelector('.dim').onclick = closePanel;
    R.querySelector('[data-a=sync]').onclick = async e => { const b = e.currentTarget; b.textContent = '·'; try { await syncHistory(true); } catch (er) {} b.textContent = '↻'; render(); };
    R.querySelector('[data-a=zone]').onclick = () => { DB.zone ? zoneEnd() : zoneStart(); };
    R.querySelector('[data-a=skin]').onclick = toggleSkin;
    host.addEventListener('keydown', e => { if (e.key === 'Escape') { const c = R.querySelector('.cert'); c ? c.remove() : closePanel(); } });
    P = { host, R, k, ov: R.querySelector('.ov'), pn: R.querySelector('.pn') };
    host.style.display = 'none';
    return P;
  }

  // smooth number roll
  const tw = new WeakMap();
  function roll(el, v, f) {
    if (!el) return;
    const cur = tw.get(el); const from = cur ? cur.v : 0;
    if (cur && cur.to === v) return;
    const t0 = performance.now(), dur = cur ? 900 : 1300, start = cur ? cur.v : (OPEN ? 0 : v);
    const st = { v: start, to: v }; tw.set(el, st);
    const step = now => { const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4); st.v = start + (v - start) * e; el.innerHTML = f(st.v); if (p < 1 && tw.get(el) === st) requestAnimationFrame(step); };
    requestAnimationFrame(step); void from;
  }
  const bigMoney = v => { const s = fm(v), i = s.lastIndexOf('.'); return i > 0 ? s.slice(0, i) + '<small>' + s.slice(i) + '</small>' : s; };

  function render() {
    // pill
    const P0 = pill(), rows = liveRows(), live = rows.reduce((a, r) => a + r.today, 0), today = sums('today');
    P0.btn.classList.toggle('wait', !L.ok); P0.btn.classList.toggle('zone', !!DB.zone); P0.btn.classList.toggle('open', OPEN);
    if (DB.zone) {
      P0.k('a').textContent = fdur(Date.now() - DB.zone.t0); P0.k('al').textContent = 'in the zone';
      const zl = zoneLive(DB.zone) - sums(DB.zone.t0).spend; P0.k('b').textContent = fm(zl, { sign: true, short: true }); P0.k('b').className = 'v ' + (zl > 0 ? 'up' : zl < 0 ? 'dn' : ''); P0.k('bl').textContent = 'net';
      ['sep', 'b', 'bl'].forEach(n => P0.k(n).hidden = false);
    } else {
      P0.k('a').textContent = L.ok || DB.full ? fk(today.spend) : '—'; P0.k('al').textContent = AUTH || DB.full ? 'spent today' : performance.now() < 45000 ? 'connecting' : 'sign in to Vest';
      const has = rows.length > 0; ['sep', 'b', 'bl'].forEach(n => P0.k(n).hidden = !has);
      if (has) { P0.k('b').textContent = fm(live, { sign: true, short: true }); P0.k('b').className = 'v ' + (live > 0 ? 'up' : live < 0 ? 'dn' : ''); P0.k('bl').textContent = 'live'; }
    }
    if (!OPEN || !P) return;
    const k = P.k, w = DB.win, s = sums(w);
    // status
    const stEl = P.R.querySelector('.st'); stEl.className = 'st' + (L.err === 'noauth' || !AUTH ? ' wait' : L.err ? ' bad' : '');
    k('st').textContent = !AUTH ? 'waiting for Vest sign-in' : L.err && L.err !== 'noauth' ? 'retrying' : L.at ? 'live · ' + Math.max(0, Math.round((Date.now() - L.at) / 1000)) + 's' : 'connecting';
    // zone vs spend hero
    const z = DB.zone;
    P.R.querySelector('[data-v=spend]').hidden = !!z; P.R.querySelector('[data-v=zone]').hidden = !z; P.R.querySelector('.ring').hidden = !z;
    P.R.querySelector('[data-a=skin]').style.color = DB.skin === false ? '' : '#f1f1f3'; P.R.querySelector('[data-a=skin]').title = DB.skin === false ? 'Massive skin is off — click to put it on Vest' : 'Massive skin is on — click for Vest’s own colours';
    const zb = P.R.querySelector('[data-a=zone]'); zb.textContent = z ? 'End zone' : 'Enter the zone';
    if (z) {
      const zs = sums(z.t0), zl = zoneLive(z);
      k('zt').textContent = fdur(Date.now() - z.t0);
      k('zs').textContent = 'since ' + new Date(z.t0).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const net = zl - zs.spend; k('zsub').innerHTML = `net <b class="${net > 0 ? 'up' : net < 0 ? 'dn' : ''}">${fm(net, { sign: true })}</b> · peak ${fm(z.peak, { sign: true })} · low ${fm(z.low, { sign: true })}`;
      roll(k('z1'), zl, v => fm(v, { sign: true })); k('z1').className = zl > 0 ? 'up' : zl < 0 ? 'dn' : '';
      roll(k('z2'), zs.spend, v => fm(v)); k('z3').textContent = zs.bought; const tr = z.trades.filter(t => t.pnl != null);
      k('z4').textContent = z.trades.length + (tr.length ? ' · ' + tr.filter(t => t.pnl > 0).length + ' won' : '');
      spark(k('zsp'), z.samples.concat([[Date.now(), zl]]));
    } else {
      k('wl').textContent = WINS.find(x => x[0] === w)[1];
      roll(k('big'), s.spend, bigMoney);
      const [rv, ru] = rate(w, s.spend);
      k('rate').innerHTML = s.spend ? `≈ <b>${fm(rv)}</b> ${ru} · <b>${s.bought}</b> account${s.bought === 1 ? '' : 's'} bought` : `nothing spent ${w === 'all' ? 'yet' : 'in this window'} · stay sharp`;
      [...k('lad').children].forEach((b, i) => { const ww = WINS[i][0]; b.classList.toggle('on', ww === w); b.querySelector('b').textContent = fk(sums(ww).spend); });
      const days = dailySpend(30), mx = Math.max(1, ...days.map(d => d.v));
      [...k('bars').children].forEach((b, i) => { b.style.height = Math.max(3, days[i].v / mx * 64) + 'px'; b.classList.toggle('t', i === 29); b.title = new Date(days[i].t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' · ' + fm(days[i].v); });
    }
    // live column
    roll(k('lt'), live, v => fm(v, { sign: true }));
    k('lt').className = 'lbig' + (live > 0.005 ? ' up' : live < -0.005 ? ' dn' : '');
    const eq = rows.reduce((a, r) => a + r.eq, 0), openN = rows.reduce((a, r) => a + r.open, 0);
    k('ls').innerHTML = rows.length ? `<b>${rows.length}</b> live · equity <b>${fm(eq)}</b>${openN ? ' · <b>' + openN + '</b> open' : ''}` : '';
    k('rows').innerHTML = rows.length ? rows.map(r => `<div class="row"><div class="n">${r.name}<em>…${r.id.slice(-4)}</em></div><div class="v ${r.today > 0.005 ? 'up' : r.today < -0.005 ? 'dn' : ''}">${fm(r.today, { sign: true })}</div><div class="q">equity ${fm(r.eq)}${r.open ? ' · ' + r.open + ' open · unrealized ' + fm(r.u, { sign: true }) : ''}</div></div>`).join('')
      : `<div class="none">${L.ok ? 'No live funded accounts right now.<br>Evals stay out of this number.' : 'Waiting for Vest…'}</div>`;
    const zs = (DB.zones || []).slice(0, 6);
    k('past').innerHTML = zs.length ? '<span class="lab" style="width:100%">past zones</span>' + zs.map((x, i) => `<button data-z="${i}">${new Date(x.t0).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${fdurWords(x.t1 - x.t0)}</button>`).join('') : '';
    k('past').onclick = e => { const b = e.target.closest('[data-z]'); if (b) openCert(DB.zones[+b.dataset.z]); };
    // footer: payouts vs withdrawals in the window
    const lab = z ? 'this zone' : WINS.find(x => x[0] === w)[1], fs = z ? sums(z.t0) : s;
    roll(k('f1'), fs.pay, v => fm(v)); roll(k('f5'), fs.aff, v => fm(v)); roll(k('f2'), fs.wd, v => fm(v)); roll(k('f3'), fs.spend, v => fm(v)); roll(k('f4'), fs.net, v => fm(v, { sign: true }));
    k('f4').className = fs.net > 0 ? 'up' : fs.net < 0 ? 'dn' : '';
    k('f1w').textContent = (fs.payPend ? '· ' + fk(fs.payPend) + ' pending ' : '') + '· ' + lab;
    k('f5w').textContent = (fs.affPend ? '· ' + fk(fs.affPend) + ' pending' : '');
    k('f2w').textContent = (fs.wdPend ? '· ' + fk(fs.wdPend) + ' processing ' : '') + '· ' + lab;
    const tot = Math.max(1, fs.pay + fs.aff); k('sp1').style.width = (fs.pay / tot * 100) + '%'; k('sp2').style.width = (fs.aff / tot * 100) + '%';
  }
  function spark(svg, pts) {
    if (!svg || pts.length < 2) { if (svg) svg.innerHTML = ''; return; }
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1, vs = pts.map(p => p[1]), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), sp = hi - lo || 1;
    const X = t => (t - t0) / Math.max(1, t1 - t0) * 600, Y = v => 80 - (v - lo) / sp * 76;
    const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1)).join(' ');
    svg.innerHTML = `<line x1="0" x2="600" y1="${Y(0)}" y2="${Y(0)}" stroke="rgba(238,234,226,.12)" stroke-dasharray="3 5"/><path d="${d}" fill="none" stroke="#e6e3dc" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>`;
  }

  // open: the panel grows out of the pill; minimize folds it back in
  function pillRect() { const r = PILL && PILL.host.isConnected ? PILL.btn.getBoundingClientRect() : null; return r && r.width ? r : { left: innerWidth / 2 - 60, top: innerHeight - 60, right: innerWidth / 2 + 60, bottom: innerHeight - 26, width: 120, height: 34 }; }
  function clipFrom(pn) { const a = pn.getBoundingClientRect(), r = pillRect(); return `inset(${r.top - a.top}px ${a.right - r.right}px ${a.bottom - r.bottom}px ${r.left - a.left}px round 17px)`; }
  function openPanel() {
    if (OPEN) return; fonts(); OPEN = true;
    const p = panel(); p.host.style.display = '';
    p.pn.classList.remove('anim'); p.pn.style.clipPath = clipFrom(p.pn); void p.pn.offsetWidth;
    p.pn.classList.add('anim'); p.pn.style.clipPath = 'inset(0px 0px 0px 0px round 30px)';
    p.ov.classList.add('on'); setTimeout(() => p.ov.classList.add('shown'), 160);
    [...p.R.querySelectorAll('[data-k]')].forEach(el => tw.delete(el));
    render(); p.R.querySelector('[data-a=min]').focus({ preventScroll: true });
    if (L.ok && Date.now() - (DB.synced || 0) > 60000) syncHistory(false).then(render).catch(() => {});
  }
  function closePanel() {
    if (!OPEN || !P) return; OPEN = false;
    const p = P; p.ov.classList.remove('shown'); p.ov.classList.remove('on');
    p.pn.classList.add('anim'); p.pn.style.clipPath = clipFrom(p.pn);
    setTimeout(() => { if (!OPEN) p.host.style.display = 'none'; }, 760);
    render();
  }

  // ---------- certificate ----------
  function drawCert(c, z, o) {
    const land = o.layout !== 'sq', Wd = c.width = land ? 2400 : 2000, Ht = c.height = land ? 1600 : 2000, x = c.getContext('2d');
    const F = (w, s, it) => (it ? 'italic ' : '') + w + ' ' + s + 'px Inter, system-ui, sans-serif';
    const ls = v => { try { x.letterSpacing = v + 'px'; } catch (e) {} };
    x.fillStyle = '#0b0b0b'; x.fillRect(0, 0, Wd, Ht);
    if (land) moon(x, Wd, Ht, 2520, 1900, 1420, 15, 1); else moon(x, Wd, Ht, 2150, 2500, 1250, 16, 1);
    const mk = certMark(); if (mk.complete && mk.naturalWidth) { const mw = land ? 400 : 300, mh = mw * 340 / 549, m = land ? [170, 150] : [150, 150]; x.globalAlpha = .9; x.drawImage(mk, Wd - m[0] - mw, Ht - m[1] - mh, mw, mh); x.globalAlpha = 1; }
    const P_ = land ? 150 : 160, maxW = land ? 1500 : 1680;
    const fit = (t, w, s, max, it) => { x.font = F(w, s, it); while (s > 20 && x.measureText(t).width > max) { s -= 4; x.font = F(w, s, it); } return s; };
    x.textBaseline = 'alphabetic';
    const wm = land ? 76 : 72, wy = land ? 210 : 225;
    x.fillStyle = '#eeeae2'; x.font = F(800, wm); ls(-.045 * wm); x.fillText('GIGAPROP.', P_, wy); const bw = x.measureText('GIGAPROP.').width;
    x.font = F(700, wm * .34); ls(wm * .34 * .32); x.fillStyle = '#9e9ea5'; x.fillText('ZONE', P_ + bw + wm * .45, wy);
    const dur = z.t1 - z.t0, hero = o.hero;
    const big = hero === 'time' ? fdurWords(dur) : hero === 'net' ? fm(z.net, { sign: true }) : hero === 'pay' ? fm(z.pay, { sign: true }) : fm(z.live, { sign: true });
    const hv = hero === 'time' ? 1 : hero === 'net' ? z.net : hero === 'pay' ? z.pay : z.live;
    const by = land ? 770 : 930, bs = fit(big, 800, land ? 330 : 300, maxW); ls(-.055 * bs);
    x.fillStyle = hv < 0 ? '#e8988c' : '#e6e3dc'; x.font = F(800, bs); x.fillText(big, P_ - bs * .02, by);
    let y = land ? 945 : 1105; const nmS = land ? 96 : 92, sb = land ? 58 : 56;
    if (o.name) { const nm = /^@|\s/.test(o.name) ? o.name : '@' + o.name; ls(-.02 * nmS); x.fillStyle = '#d9d9de'; x.font = F(700, fit(nm, 700, nmS, maxW)); x.fillText(nm, P_, y); } else y -= nmS * .9;
    const d0 = new Date(z.t0), tm = d => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const heroLab = { time: 'in the zone', net: 'net', pay: 'payouts', live: 'live PnL' }[hero];
    const sub = heroLab + ' · ' + d0.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + tm(d0) + ' → ' + tm(new Date(z.t1));
    ls(0); x.fillStyle = '#a7a7ae'; x.font = F(500, fit(sub, 500, sb, maxW, 1), 1); x.fillText(sub, P_, y + (land ? 100 : 95));
    const pool = [['time', fdurWords(dur), 'in the zone'], ['live', fm(z.live, { sign: true }), 'live PnL'], ['net', fm(z.net, { sign: true }), 'net'], ['spend', fm(z.spend), 'spent'], ['trades', z.trades ? z.trades + (z.trades ? ' · ' + z.wins + ' won' : '') : '0', 'trades'], ['acc', z.bought + (z.passed || z.blown ? ' · ' + z.passed + '/' + z.blown : ''), z.passed || z.blown ? 'bought · passed/blown' : 'accounts bought']];
    const want = (hero === 'time' ? ['live', 'spend', 'trades'] : hero === 'live' ? ['time', 'spend', 'trades'] : hero === 'net' ? ['time', 'live', 'spend'] : ['time', 'live', 'spend']).map(id => pool.find(p => p[0] === id));
    if (!z.liveSeen) want.forEach((s, i) => { if (s[0] === 'live') want[i] = pool.find(p => p[0] === (want.some(q => q[0] === 'trades') ? 'acc' : 'trades')); });
    const sy = land ? 1380 : 1650, ly = land ? 1455 : 1725, ss = land ? 64 : 62, sl = land ? 42 : 40, gap = land ? 520 : 470;
    want.forEach(([, v, l], i) => { const sx = P_ + i * gap; ls(-.02 * ss); x.fillStyle = '#eeeae2'; x.font = F(800, fit(v, 800, ss, gap - 40)); x.fillText(v, sx, sy); ls(0); x.fillStyle = '#9e9ea5'; x.font = F(600, sl); x.fillText(l, sx, ly); });
  }
  let mkImg = null;
  const certMark = () => { if (!mkImg) { mkImg = new Image(); mkImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(VEST_SVG); } return mkImg; };
  function openCert(z) {
    if (!z) return; if (!OPEN) openPanel();
    const R = P.R, old = R.querySelector('.cert'); if (old) old.remove();
    const el = document.createElement('div'); el.className = 'cert';
    const def = z.liveSeen ? 'live' : 'time'; const o = { name: DB.name || '', layout: DB.layout || 'land', hero: DB.hero && (DB.hero !== 'live' || z.liveSeen) ? DB.hero : def };
    el.innerHTML = `<div class="cbox"><canvas></canvas><div class="cc">
      <div class="top"><div class="brand" style="font-size:20px">GIGAPROP.<span>ZONE</span></div><button class="btn ic" data-a="x">✕</button></div>
      <label>Name on the card<input data-i="name" maxlength="28" placeholder="@yourhandle"></label>
      <label>Big number<div class="seg" data-s="hero"><button data-v="live">Live PnL</button><button data-v="net">Net</button><button data-v="time">Time</button><button data-v="pay">Payouts</button></div></label>
      <label>Layout<div class="seg" data-s="layout"><button data-v="land">Landscape</button><button data-v="sq">Square</button></div></label>
      <div class="cgo"><button class="btn hi" data-a="dl">Download PNG</button><button class="btn" data-a="cp">Copy image</button><div class="cmsg"></div></div>
    </div></div>`;
    P.R.querySelector('.pn').appendChild(el);
    requestAnimationFrame(() => el.classList.add('on'));
    const cv = el.querySelector('canvas'), msg = el.querySelector('.cmsg');
    const draw = () => { el.querySelectorAll('.seg').forEach(s => s.querySelectorAll('button').forEach(b => b.classList.toggle('on', o[s.dataset.s] === b.dataset.v))); drawCert(cv, z, o); };
    const inp = el.querySelector('[data-i=name]'); inp.value = o.name; inp.oninput = () => { o.name = DB.name = inp.value; save(); draw(); };
    el.querySelectorAll('.seg').forEach(s => s.onclick = e => { const b = e.target.closest('button'); if (!b) return; o[s.dataset.s] = b.dataset.v; DB[s.dataset.s] = b.dataset.v; save(); draw(); });
    el.querySelector('[data-a=x]').onclick = () => { el.classList.remove('on'); setTimeout(() => el.remove(), 500); };
    el.onclick = e => { if (e.target === el) el.querySelector('[data-a=x]').click(); };
    const name = () => 'gp-zone-' + new Date(z.t0).toISOString().slice(0, 16).replace(/[:T]/g, '-') + '.png';
    el.querySelector('[data-a=dl]').onclick = () => cv.toBlob(b => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = name(); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); msg.textContent = 'Saved'; });
    el.querySelector('[data-a=cp]').onclick = () => cv.toBlob(async b => { try { await navigator.clipboard.write([new W.ClipboardItem({ 'image/png': b })]); msg.textContent = 'Copied, paste it anywhere'; } catch (e) { msg.textContent = 'Copy blocked here, use Download'; } });
    certMark().addEventListener('load', draw); draw();
    if (document.fonts) Promise.all(['800 100px Inter', '700 100px Inter', '600 100px Inter', '500 100px Inter'].map(f => document.fonts.load(f))).then(draw, draw);
  }

  // =====================================================================================================
  // GP. Shot: the order ticket over Vest's own. Risk-locked size, fee-aware stop and target, always max leverage,
  // sent straight to Vest's order endpoint for the account you're on. Once in, the same card runs the trade.
  // =====================================================================================================
  const IS_TRADE = () => /^\/trade\//.test(location.pathname);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const uuid = () => (W.crypto && W.crypto.randomUUID) ? W.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const trimNum = x => { const t = String(x); return t.indexOf('.') >= 0 ? t.replace(/0+$/, '').replace(/\.$/, '') : t; };
  const accOf = p => p.accountId || p.account_id;
  const SPEC = {}; let specAt = 0;
  async function loadSpecs() {
    if (Date.now() - specAt < 30 * 6e4 && Object.keys(SPEC).length) return;
    const j = await api('/v3/exchangeInfo', true); (j.symbols || []).forEach(x => { SPEC[x.symbol] = x; }); specAt = Date.now();
  }
  const dec = sym => (SPEC[sym] ? +SPEC[sym].sizeDecimals : 4);
  const pdec = sym => (SPEC[sym] ? +SPEC[sym].priceDecimals : 2);
  const tickOf = sym => (SPEC[sym] && +SPEC[sym].minTickSize) || Math.pow(10, -pdec(sym));
  const fmtQ = (q, sym) => { const d = dec(sym), f = Math.pow(10, d); return trimNum((Math.floor(Math.abs(q) * f + 1e-7) / f).toFixed(d)); };
  const fmtP = (p, sym) => { const t = tickOf(sym); return trimNum((Math.round(p / t) * t).toFixed(pdec(sym))); };
  const fmtPx = (p, sym) => (+p).toLocaleString('en-US', { minimumFractionDigits: pdec(sym), maximumFractionDigits: pdec(sym) });
  const pts = v => { const a = Math.abs(v); return a >= 100 ? a.toFixed(1) : a >= 1 ? a.toFixed(2) : a.toPrecision(3); };
  const shortSym = sym => { const x = SPEC[sym]; return x ? String(x.displaySymbol || x.symbol).replace(/-PERP$/, '') : String(sym || '').replace(/(-USD)?-PERP$/, ''); };
  const userId = () => { const c = claims(AUTH); return c && c.userId; };
  function activeAcct() {
    const u = userId(); if (!u) return null; const k = 'vest-active-account:' + u; let v = null;
    try { v = W.sessionStorage.getItem(k) || W.localStorage.getItem(k); } catch (e) {}
    if (!v) return null; try { const j = JSON.parse(v); return typeof j === 'string' ? j : (j && (j.id || j.accountId)) || null; } catch (e) { return v; }
  }
  function curSymbol() {
    const slug = decodeURIComponent(location.pathname.split('/')[2] || '').toUpperCase(); if (!slug) return null;
    const all = Object.values(SPEC), base = slug.replace(/-PERP$/, '');
    const x = all.find(s => s.symbol === slug) || all.find(s => s.displaySymbol === slug) || all.find(s => String(s.displaySymbol || '').replace(/-PERP$/, '') === base) || all.find(s => s.base === base);
    return x ? x.symbol : null;
  }
  const capAcct = id => (L.cap || []).find(c => c.id === id);
  const balOf = id => { const c = cashOf(id); if (c != null) return c; const a = capAcct(id); const v = a && (+a.daily_reset_equity || +a.initial_capital); return v > 0 ? v : null; };
  function maxLev(sym, id) {
    const x = SPEC[sym]; if (!x) return null; const r = v => (v > 0 ? Math.floor(1 / v + 1e-9) : null), a = capAcct(id);
    if (a && Array.isArray(x.capitalPlans)) { const p = x.capitalPlans.find(c => c.planId === a.plan_id && (c.accountType == null || c.accountType === a.account_type)); if (p && +p.initMarginRatio > 0) return r(+p.initMarginRatio); }
    const cr = a && a.account_type === 3 ? +x.fundedInitMarginRatio : +x.capitalInitMarginRatio;
    return r(cr) || r(+x.initMarginRatio);
  }
  function acctLabel(id) {
    const a = capAcct(id), nm = L.names && L.names[id];
    if (nm) return nm;
    if (!a) return 'Account …' + String(id).slice(-4);
    const sz = +a.initial_capital >= 1000 ? '$' + (+a.initial_capital / 1000) + 'K' : '$' + (+a.initial_capital);
    const kind = a.account_type === 3 ? (/instant/i.test(a.plan_product_type || '') ? 'Instant' : 'Funded') : 'Eval' + (a.steps_total > 1 ? ' ' + a.step + '/' + a.steps_total : '');
    return 'Account ' + ((+a.attempt_index || 0) + 1) + ' · ' + sz + ' ' + kind;
  }

  // ---------- writes: the account's own token, an Idempotency-Key on every order ----------
  async function acctToken(id) {
    const a = ACCT[id]; if (a && a.exp - Date.now() > 60000) return a.tok;
    if (!AUTH) throw new Error('waiting for Vest sign-in');
    const r = await F0.call(W, API + '/v3/auth/account-token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: AUTH }, body: JSON.stringify({ accountId: id }) });
    if (!r.ok) throw new Error('Vest refused an account token (' + r.status + ')');
    const j = await r.json(); ACCT[id] = { tok: j.accessToken, exp: +j.accessExpiresAtMs || Date.now() + 6e5 }; return j.accessToken;
  }
  async function send(id, method, path, body, key) {
    const tok = await acctToken(id);
    const r = await F0.call(W, API + path, { method, headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok, 'Idempotency-Key': key || uuid() }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 401) delete ACCT[id];
    if (r.status === 429) backoff = Date.now() + 3000;
    if (!r.ok) { const m = j && (j.msg || j.message || (j.detail && (j.detail.msg || j.detail.message)) || (typeof j.detail === 'string' && j.detail)); const e = new Error(String(m || 'Vest said no (' + r.status + ')')); e.status = r.status; throw e; }
    return j || {};
  }
  // an exit gets one retry on a rate limit or server error, with the same key so it can never run twice
  async function sendExit(id, path, body) { const key = uuid(); try { return await send(id, 'POST', path, body, key); } catch (e) { if (e.status && e.status < 429) throw e; await sleep(700); return send(id, 'POST', path, body, key); } }
  const LEVSET = {};
  async function ensureLev(id, sym, lev) {
    const k = id + '|' + sym; if (LEVSET[k] === lev) return;
    const saved = L.levs && L.levs[id] && +L.levs[id][sym]; if (saved === lev) { LEVSET[k] = lev; return; }
    await send(id, 'PUT', '/v3/user-state/accounts/' + id + '/leverages/' + encodeURIComponent(sym), { leverage: String(lev) });
    LEVSET[k] = lev; if (L.levs) (L.levs[id] = L.levs[id] || {})[sym] = lev;
  }

  // ---------- fast feed for the ticket ----------
  let fastT = 0, fastBusy = false;
  function kickFast(ms) { clearTimeout(fastT); fastT = setTimeout(fastLoop, ms || 50); }
  const readMarks = () => api('/v3/ticker/latest', true).then(j => { (j.tickers || []).forEach(t => { L.mark[t.symbol] = +t.markPrice; }); L.markAt = Date.now(); });
  async function fastLoop() {
    clearTimeout(fastT);
    const need = (SH.on && IS_TRADE() && !document.hidden) || C.on || (DK.open && !document.hidden);
    if (need && AUTH && Date.now() > backoff && !fastBusy) {
      fastBusy = true;
      try {
        await loadSpecs();
        const T = [api('/v3/positions/opened').then(j => { L.pos = j.positions || []; L.posAt = Date.now(); }), readMarks()];
        const balNow = Date.now() - (L.balAt || 0) > 4000;
        if (balNow) T.push(api('/v3/accounts?active=true&limit=500').then(j => { L.bal = {}; (j.accounts || []).forEach(a => { L.bal[a.account_id] = +a.amount || 0; }); L.balAt = Date.now(); }));
        if (!L.cap || Date.now() - (L.capAt || 0) > 30000) T.push(api('/v3/capital/accounts/active').then(j => { L.cap = j.accounts || []; L.capAt = Date.now(); }));
        if (!L.levs || Date.now() - (L.levAt || 0) > 60000) T.push(api('/v3/user-state').then(j => { const o = {}, n = {}; (j.accounts || []).forEach(a => { o[a.accountId] = {}; (a.leverages || []).forEach(l => { o[a.accountId][l.symbol] = +l.leverage; }); if (a.name) n[a.accountId] = a.name; }); L.levs = o; L.names = n; L.levAt = Date.now(); }).catch(() => { L.levAt = Date.now(); }));
        await Promise.all(T); if (balNow) snapCash(); await loadSeries();
        L.ok = true; L.at = Date.now(); L.err = '';
        if (C.on && ownCopier()) await copierSync();
      } catch (e) { L.err = String(e.message || e); }
      fastBusy = false;
      try { zoneTick(); } catch (e) {}
    }
    if (need) { try { renderShot(); drawChart(); } catch (e) {} try { renderDesk(); } catch (e) {} }
    fastT = setTimeout(fastLoop, C.on ? 1500 : 1100);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) kickFast(0); });

  // ---------- the plan: risk-locked size and fee-aware stop / target ----------
  const SH = Object.assign({ on: true, risk: 2, R: 1, tmode: 'R', usd: 0, size: 100, fees: true, chart: true, side: 'long', dock: true, x: null, y: null }, DB.shot || {});
  SH.chart = true;
  const saveSH = () => { DB.shot = SH; save(); };
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const loadOf = (x = SH) => ({ risk: +x.risk, R: +x.R, tmode: x.tmode || 'R', usd: +x.usd || 0, size: +x.size, fees: !!x.fees });
  const FRESH = 3500; // a price older than this never sizes or sends an order
  function plan() {
    const sym = curSymbol(), id = activeAcct(), x = sym && SPEC[sym];
    if (!sym || !x) return { ok: false, why: 'reading the market' };
    if (!id) return { ok: false, why: 'pick an account on Vest', sym };
    const px = L.mark[sym], bal = balOf(id);
    if (!px || !(bal > 0)) return { ok: false, why: 'reading your account', sym, id };
    const lev = maxLev(sym, id) || 1, f = +x.takerFee || 0;
    const mine = L.pos.filter(p => accOf(p) === id);
    const used = mine.reduce((a, p) => a + Math.abs(+p.quantity) * (+p.openPrice) / (+p.leverage || lev), 0);
    const free = L.bal[id] != null ? Math.max(0, L.bal[id]) : Math.max(0, bal - used), maxN = free * lev * 0.985, notional = maxN * (SH.size / 100);
    const d = dec(sym), qty = Math.floor(notional / px * Math.pow(10, d) + 1e-7) / Math.pow(10, d);
    const base = { sym, id, x, px, bal, lev, f, maxN };
    if (!(qty > 0)) return { ...base, ok: false, why: 'no free margin' };
    // the pass line: an evaluation's target equity, less what the account holds now (open trades included)
    const ca = capAcct(id), tgtEq = ca && ca.account_type === 2 ? +ca.target_equity : 0;
    const openU = mine.reduce((a, p) => { const m = L.mark[p.symbol]; return m ? a + (m - +p.openPrice) * Math.abs(+p.quantity) * (/^s/i.test(p.side || '') ? -1 : 1) : a; }, 0);
    const passNeed = tgtEq > 0 ? Math.max(0, tgtEq - bal - openU) : 0;
    const N = qty * px, fees = 2 * N * f, risk = bal * SH.risk / 100;
    const reward = SH.tmode === 'pass' && passNeed > 0 ? passNeed : SH.tmode === 'usd' && SH.usd > 0 ? SH.usd : risk * SH.R;
    const slG = SH.fees ? risk - fees : risk, tpG = SH.fees ? reward + fees : reward;
    const passG = passNeed > 0 ? passNeed + (SH.fees ? fees : 0) : 0;
    const out = { ...base, qty, qtyS: fmtQ(qty, sym), N, fees, risk, reward, slG, tpG, passNeed, dPass: passG ? passG / qty : 0, long: { pass: px + passG / qty }, short: { pass: px - passG / qty } };
    if (slG <= 0) return { ...out, ok: false, why: 'fees over risk · size down' };
    const dSL = slG / qty, dTP = tpG / qty, liq = px * (1 / lev - (+x.maintMarginRatio || 0));
    Object.assign(out.long, { sl: px - dSL, tp: px + dTP }); Object.assign(out.short, { sl: px + dSL, tp: px - dTP }); Object.assign(out, { dSL, dTP });
    if (dSL >= liq * 0.92) return { ...out, ok: false, why: 'stop past liquidation · size down' };
    if (dSL < tickOf(sym) * 2) return { ...out, ok: false, why: 'stop under a tick · size down' };
    if (!(Date.now() - (L.markAt || 0) < FRESH)) return { ...out, ok: false, why: 'price stale' };
    return { ...out, ok: true };
  }
  // the chart's stop line dragged: the dollars at risk stay, the size moves to fit the distance
  function sizeFromStop(price) {
    const p = plan(); if (!p.px || !p.maxN || !p.risk) return;
    const d = Math.abs(price - p.px); if (!(d > 0)) return;
    SH.side = price < p.px ? 'long' : 'short';
    const q = SH.fees ? p.risk / (d + 2 * p.px * p.f) : p.risk / d;
    SH.size = Math.max(1, Math.min(100, Math.round(q * p.px / p.maxN * 1000) / 10)); saveSH(); renderShot(); drawChart();
  }
  function targetFromLine(price) {
    const p = plan(); if (!p.qty || !p.risk) return;
    const d = Math.abs(price - p.px), rew = SH.fees ? d * p.qty - p.fees : d * p.qty; if (!(rew > 0)) return;
    SH.R = Math.max(0.1, Math.min(20, Math.round(rew / p.risk * 10) / 10)); SH.tmode = 'R'; saveSH(); renderShot(); drawChart();
  }

  // ---------- zone lock: the ticket stops taking entries once the session's limit is hit (exits always work) ----------
  const ZL = Object.assign({ loss: 0, n: 0 }, DB.zl || {});
  function zoneStats() {
    const z = DB.zone; if (!z) return null;
    const tr = (z.trades || []).filter(t => t.pnl != null), sum = tr.reduce((a, t) => a + t.pnl, 0);
    return { sum, lost: tr.filter(t => t.pnl < 0).length, won: tr.filter(t => t.pnl > 0).length };
  }
  function zoneLocked() {
    const z = DB.zone, s = zoneStats(); if (!z || !s) return false;
    if (!z.locked && ((ZL.loss > 0 && s.sum <= -ZL.loss) || (ZL.n > 0 && s.lost >= ZL.n))) { z.locked = Date.now(); save(); }
    return !!z.locked;
  }

  // ---------- firing ----------
  const SHOT = { busy: false, msg: '', tone: '', hover: null, visible: false, cool: 0, zopen: false };
  function shotMsg(m, tone) { SHOT.msg = m; SHOT.tone = tone || ''; SHOT.msgAt = Date.now(); renderShot(); }
  const myPos = p => p && p.sym ? L.pos.find(x => accOf(x) === p.id && x.symbol === p.sym) : null;
  async function fire(side) {
    if (SHOT.busy || Date.now() < SHOT.cool) return;
    if (zoneLocked()) return shotMsg('zone locked', 'bad');
    let p = plan(); if (!p.ok) return shotMsg(p.why, 'bad');
    if (myPos(p)) return shotMsg('already in ' + shortSym(p.sym), 'bad');
    SHOT.busy = side; SH.side = side; renderShot();
    let sent = false;
    try {
      await ensureLev(p.id, p.sym, p.lev).catch(() => {});
      await Promise.race([readMarks(), sleep(350)]).catch(() => {}); // stop and target come off the newest price
      p = plan(); if (!p.ok) throw new Error(p.why);
      if (myPos(p)) throw new Error('already in ' + shortSym(p.sym));
      const g = p[side];
      const body = { orderType: 'market', leverage: String(p.lev), side, symbol: p.sym, quantity: p.qtyS, timeInForce: 'IOC', takeProfits: [{ executionType: 'market', triggerPrice: fmtP(g.tp, p.sym) }], stopLosses: [{ executionType: 'market', triggerPrice: fmtP(g.sl, p.sym) }] };
      sent = true; await send(p.id, 'POST', '/v3/positions/open', body);
      shotMsg((side === 'long' ? 'Long ' : 'Short ') + p.qtyS + ' ' + shortSym(p.sym) + ' · stop ' + fmtPx(g.sl, p.sym), 'ok');
    } catch (e) { if (e.status && e.status < 500 && e.status !== 429) sent = false; shotMsg(e.message, 'bad'); }
    SHOT.cool = Date.now() + (sent ? 2500 : 600); // no second shot until the position list has caught up
    SHOT.busy = false; saveSH(); kickFast(150); setTimeout(renderShot, 2600);
  }
  async function act(tag, fn) {
    if (SHOT.busy) return; SHOT.busy = tag; renderShot();
    try { const m = await fn(); if (m) shotMsg(m, 'ok'); } catch (e) { shotMsg(e.message, 'bad'); }
    SHOT.busy = false; kickFast(150);
  }
  const curPos = () => myPos(plan());
  if (DB.run || DB.runNext) { delete DB.run; delete DB.runNext; save(); } // the held-TP experiment is gone
  function closeMine() {
    const pos = curPos(); if (!pos) return;
    return act('close', async () => { await sendExit(accOf(pos), '/v3/positions/close', { symbol: pos.symbol, positionId: pos.positionId, orderType: 'market', leverage: trimNum(pos.leverage || maxLev(pos.symbol, accOf(pos)) || 1) }); return 'Closed ' + shortSym(pos.symbol); });
  }

  // ---------- in a trade: the numbers, and every way to manage it ----------
  const liveLegs = legs => (legs || []).filter(l => l && l.triggerPrice != null && (!l.status || /await|pend|new|open|active/i.test(l.status)));
  const legFixed = l => !!(l && l.sizeMode && /fix/i.test(l.sizeMode) && +l.quantity > 0);
  function tradeOf(pos) {
    const sym = pos.symbol, m = L.mark[sym], q = Math.abs(+pos.quantity), long = /^l/i.test(pos.side), dir = long ? 1 : -1, op = +pos.openPrice, f = (SPEC[sym] && +SPEC[sym].takerFee) || 0;
    const sls = liveLegs(pos.stopLosses), tps = liveLegs(pos.takeProfits).slice().sort((a, b) => (a.triggerPrice - b.triggerPrice) * dir);
    const sl = sls.slice().sort((a, b) => (b.triggerPrice - a.triggerPrice) * dir)[0] || null; // the stop nearest the price fills first
    const tp = tps.filter(l => !legFixed(l)).pop() || null, scales = tps.filter(l => l !== tp);
    const at = px => (px - op) * dir * q - q * (op + px) * f; // dollars banked if it closes there, both fees paid
    // the risk it was opened with, kept for the R count after the stop moves
    DB.r0 = DB.r0 || {}; let r0 = DB.r0[pos.positionId];
    if (!r0 && sl && (+sl.triggerPrice - op) * dir < 0) { const keep = {}; L.pos.forEach(x => { if (DB.r0[x.positionId]) keep[x.positionId] = DB.r0[x.positionId]; }); r0 = keep[pos.positionId] = { r: -at(+sl.triggerPrice), q, d: Math.abs(op - sl.triggerPrice) }; DB.r0 = keep; save(); }
    const d0 = r0 ? r0.d : sl ? Math.abs(op - sl.triggerPrice) || op * 0.002 : op * 0.002, risk = r0 ? r0.r * q / r0.q : 0;
    const u = m ? (m - op) * q * dir : 0;
    return { sym, m, q, long, dir, op, f, sl, tp, scales, at, d0, risk, u, R: risk > 0 ? u / risk : null, s: px => (px - op) * dir };
  }
  function cut(pct) {
    const pos = curPos(); if (!pos) return; if (pct >= 100) return closeMine();
    const sym = pos.symbol, qs = fmtQ(Math.abs(+pos.quantity) * pct / 100, sym); if (!(+qs > 0)) return shotMsg('too small to cut', 'bad');
    act('cut' + pct, async () => { await sendExit(accOf(pos), '/v3/positions/reduce', { symbol: sym, positionId: pos.positionId, orderType: 'market', leverage: trimNum(pos.leverage), quantity: qs, timeInForce: 'IOC', reduceOnly: true }); return 'Closed ' + pct + '% · ' + qs + ' ' + shortSym(sym); });
  }
  function setStop(price, word, tag) {
    const pos = curPos(); if (!pos) return; const t = tradeOf(pos), sym = pos.symbol;
    if (t.m && (price - t.m) * t.dir >= 0) return shotMsg('price has not cleared it', 'bad');
    const px = fmtP(price, sym);
    act(tag || 'stop', async () => {
      if (t.sl) await send(accOf(pos), 'PUT', '/v3/positions/stop-loss', { positionId: pos.positionId, executionType: t.sl.executionType || 'market', triggerPrice: px, stopLossId: t.sl.id });
      else await send(accOf(pos), 'POST', '/v3/positions/stop-loss', { positionId: pos.positionId, executionType: 'market', triggerPrice: px });
      return word + ' ' + fmtPx(px, sym);
    });
  }
  function breakEven() { // the stop where both fees are paid and nothing is lost
    const pos = curPos(); if (!pos) return; const t = tradeOf(pos), tk = tickOf(t.sym);
    const be = t.long ? t.op * (1 + t.f) / (1 - t.f) : t.op * (1 - t.f) / (1 + t.f);
    setStop(t.long ? Math.ceil(be / tk - 1e-9) * tk : Math.floor(be / tk + 1e-9) * tk, 'Stop at break even', 'be');
  }
  function halfRisk() {
    const pos = curPos(); if (!pos) return; const t = tradeOf(pos);
    if (!t.sl || (+t.sl.triggerPrice - t.op) * t.dir >= 0) return shotMsg('stop is already at entry or better', 'bad');
    setStop((+t.sl.triggerPrice + t.op) / 2, 'Stop halved', 'half');
  }
  function addStop() {
    const pos = curPos(); if (!pos) return; const t = tradeOf(pos), p = plan();
    const d = p.risk ? Math.max(tickOf(t.sym) * 2, (p.risk - 2 * t.q * t.op * t.f) / t.q) : t.op * 0.003;
    setStop(t.op - t.dir * d, 'Stop', 'addstop');
  }
  // adding: the order ticket comes back over the open trade; SIZE picks how much more, the trade's own stop and target stay
  function addOn(v) { SHOT.adding = v == null ? !SHOT.adding : !!v; renderShot(); drawChart(); }
  function addMore() {
    const pos = curPos(); if (!pos) { SHOT.adding = false; return; } if (zoneLocked()) return shotMsg('zone locked', 'bad');
    const p = plan(), id = accOf(pos), sym = pos.symbol, lev = +pos.leverage || maxLev(sym, id) || 1;
    if (!(Date.now() - (L.markAt || 0) < FRESH)) return shotMsg('price stale', 'bad');
    if (!(p.qty > 0)) return shotMsg('not enough margin', 'bad');
    const qs = fmtQ(p.qty, sym); if (!(+qs > 0)) return shotMsg('too small to add', 'bad');
    act('add', async () => {
      await send(id, 'POST', '/v3/positions/append', { symbol: sym, positionId: pos.positionId, orderType: 'market', quantity: qs, leverage: trimNum(lev), isBuy: /^l/i.test(pos.side), timeInForce: 'IOC' });
      SHOT.adding = false; return 'Added ' + qs + ' ' + shortSym(sym);
    });
  }
  // a partial close resting at a price: lands halfway to the target, then it is dragged on the chart
  function scaleOut(pct) {
    const pos = curPos(); if (!pos) return; const t = tradeOf(pos), sym = pos.symbol; if (!t.m) return;
    const qs = fmtQ(t.q * pct / 100, sym); if (!(+qs > 0)) return shotMsg('too small to cut', 'bad');
    const far = t.tp ? +t.tp.triggerPrice : t.op + t.dir * 2 * t.d0; let price = (t.m + far) / 2;
    if ((price - t.m) * t.dir <= tickOf(sym) * 2) price = t.m + t.dir * t.d0;
    const px = fmtP(price, sym);
    act('lim' + pct, async () => { await send(accOf(pos), 'POST', '/v3/positions/take-profit', { positionId: pos.positionId, executionType: 'market', triggerPrice: px, quantity: qs }); return pct + '% at ' + fmtPx(px, sym); });
  }
  function moveLeg(kind, legId, price) {
    const pos = curPos(); if (!pos) return; const sym = pos.symbol, m = L.mark[sym], dir = /^l/i.test(pos.side) ? 1 : -1, isSl = kind === 'sl';
    const leg = liveLegs(isSl ? pos.stopLosses : pos.takeProfits).find(l => l.id === legId); if (!leg) return;
    if (m && (isSl ? (price - m) * dir >= 0 : (price - m) * dir <= 0)) { for (const k in HOLD) delete HOLD[k]; drawChart(); return shotMsg(isSl ? 'stop is past the price' : 'target is behind the price', 'bad'); }
    const px = fmtP(price, sym), body = { positionId: pos.positionId, executionType: leg.executionType || 'market', triggerPrice: px, [isSl ? 'stopLossId' : 'takeProfitId']: leg.id };
    if (legFixed(leg)) body.quantity = trimNum(leg.quantity);
    act('leg', async () => { await send(accOf(pos), 'PUT', '/v3/positions/' + (isSl ? 'stop-loss' : 'take-profit'), body); return (isSl ? 'Stop ' : 'Target ') + fmtPx(px, sym); });
  }
  function dropLeg(legId) {
    const pos = curPos(); if (!pos) return; const leg = liveLegs(pos.takeProfits).find(l => l.id === legId); if (!leg) return;
    act('leg', async () => { await send(accOf(pos), 'DELETE', '/v3/positions/take-profit', { positionId: pos.positionId, takeProfitId: leg.id }); return 'Removed'; });
  }


  // ---------- the ticket ----------
  const SCSS = `:host{all:initial}
  *{box-sizing:border-box}
  .s{position:relative;height:100%;display:flex;flex-direction:column;gap:10px;padding:14px 18px 14px;background:radial-gradient(at 85% -8%,rgba(230,227,220,.08),transparent 62%),#0b0b0b;border:1px solid rgba(238,234,226,.12);border-radius:14px;box-shadow:inset 0 1px 0 rgba(238,234,226,.06);color:#f1f1f3;font:600 13px Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;overflow:hidden auto;scrollbar-width:none}
  .s::-webkit-scrollbar{display:none}
  .s>*{position:relative;flex:none}
  .s>.mw{position:absolute;inset:0;overflow:hidden;pointer-events:none;border-radius:14px}
  .moon{position:absolute;right:-90px;bottom:-120px;width:330px;height:330px;opacity:.55;animation:mb 11s ease-in-out infinite}
  @keyframes mb{0%,100%{transform:scale(1);opacity:.42}50%{transform:scale(1.04);opacity:.62}}
  @keyframes br{0%,100%{transform:scale(.62);opacity:.5}42%{transform:scale(1.06);opacity:1}}
  .hd{display:flex;align-items:center;gap:6px;cursor:grab;user-select:none}
  .hd:active{cursor:grabbing}
  .dot{flex:none;width:7px;height:7px;border-radius:50%;background:#e6e3dc;animation:br 7s ease-in-out infinite}
  .s.in .dot{background:#9fd7b2;animation-duration:3.5s}.s.in.neg .dot{background:#e8988c}
  .brand{flex:none;margin-left:3px;font-size:15px;font-weight:600;letter-spacing:-.045em;white-space:nowrap}.brand span{margin-left:6px;font-size:9px;letter-spacing:.26em;font-weight:700;color:#8b8b92}
  .sp{flex:1;min-width:4px}
  .ib{flex:none;height:24px;min-width:24px;padding:0 8px;border-radius:8px;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:700 11px/1 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:border-color .25s,color .25s,background .25s;font-variant-numeric:tabular-nums}
  .ib:hover{color:#f1f1f3;border-color:rgba(238,234,226,.34)}
  .ib.on{color:#0b0b0b;background:#e6e3dc;border-color:#e6e3dc}
  .ib i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.6}
  .ib.armed{color:#0b0b0b;background:#9fd7b2;border-color:#9fd7b2}.ib.armed i{opacity:1;animation:br 4s ease-in-out infinite;background:#0b0b0b}
  .s>.menu{position:absolute}
  .hd .brand span{display:none}.hd{gap:5px}
  .mr{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center}.mr label{font-size:10.5px;font-weight:700;letter-spacing:.06em;color:#6f6f75}
  .menu{position:absolute;left:10px;right:10px;top:46px;z-index:5;padding:14px;border-radius:16px;background:#101010;border:1px solid rgba(238,234,226,.12);box-shadow:0 30px 60px -20px rgba(0,0,0,.9);display:flex;flex-direction:column;gap:10px;opacity:0;transform:translateY(-6px);pointer-events:none;transition:opacity .25s,transform .35s cubic-bezier(.16,1,.3,1);max-height:calc(100% - 60px);overflow:auto;scrollbar-width:none}
  .menu.open{opacity:1;transform:none;pointer-events:auto}
  .mh{display:flex;justify-content:space-between;align-items:center}
  .mh .mx{display:flex;align-items:center;gap:8px}.mh .mx .sw{margin-left:0}
  .mh b{font-size:12px;font-weight:600;letter-spacing:.24em;color:#9e9ea5}
  .ml{font-size:11.5px;font-weight:600;color:#8b8b92}.ml b{color:#f1f1f3;font-weight:600}
  .fl{display:flex;flex-direction:column;gap:2px}
  .f{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:center;padding:8px 2px;border-bottom:1px solid rgba(238,234,226,.06);cursor:pointer}
  .f .t{font-size:12.5px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .f .v{font-size:11.5px;font-weight:700;color:#8b8b92;font-variant-numeric:tabular-nums}
  .f .e{grid-column:2/-1;margin-top:-3px;font-size:10.5px;font-weight:600;color:#efb1a7}
  .f .e.ok{color:#6f6f75}
  .bx{width:16px;height:16px;border-radius:5px;border:1px solid rgba(238,234,226,.3);display:grid;place-items:center}
  .f.on .bx{background:#e6e3dc;border-color:#e6e3dc}.f.on .bx:after{content:"";width:7px;height:4px;border:2px solid #0b0b0b;border-top:0;border-right:0;transform:rotate(-45deg) translate(1px,-1px)}
  .f.lead{cursor:default;opacity:.55}
  .clg{font-size:10.5px;font-weight:600;color:#6f6f75;line-height:1.55;max-height:84px;overflow:auto;scrollbar-width:none}
  .clg:empty{display:none}
  .clg div.bad{color:#efb1a7}
  .ib.lock{color:#0b0b0b;background:#e8988c;border-color:#e8988c}.ib.lock i{opacity:1;background:#0b0b0b}
  .mk{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
  .mk b{font-size:19px;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums;white-space:nowrap;transition:color .4s}
  .mk b.old{color:#5f5f66}
  .mk span{font-size:11px;font-weight:600;color:#8b8b92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
  .mk span em{font-style:normal;color:#f1f1f3;font-weight:600}
  .zr{display:flex;align-items:center;gap:6px;height:28px;font-size:11.5px;font-weight:600;color:#8b8b92;font-variant-numeric:tabular-nums}
  .zr label{font-size:10.5px;font-weight:700;color:#6f6f75;letter-spacing:.06em;margin-right:2px}
  .zr .zs{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.zr .zs b{color:#f1f1f3;font-weight:600}
  .zr .zi{display:flex;align-items:center;gap:6px;flex:1}
  .zr .n{flex:1;width:0}
  .n{flex:none;width:72px;height:24px;border-radius:6px;border:1px solid rgba(238,234,226,.1);background:#0b0b0b;color:#f1f1f3;font:600 11.5px Inter,system-ui,sans-serif;text-align:center;outline:none;font-variant-numeric:tabular-nums}
  .n:focus{border-color:rgba(238,234,226,.4)}.n.on{border-color:#e6e3dc;background:#e6e3dc;color:#0b0b0b}
  .n::placeholder{color:#6f6f75;font-weight:700}
  .c{flex:1;min-width:0;height:30px;padding:0 4px;border-radius:8px;border:1px solid rgba(238,234,226,.12);background:none;color:#c9c7c2;font:700 11.5px Inter,system-ui,sans-serif;cursor:pointer;transition:all .25s;font-variant-numeric:tabular-nums;position:relative;overflow:hidden;white-space:nowrap}
  .c:hover{color:#f1f1f3;border-color:rgba(238,234,226,.42)}
  .c:active{transform:scale(.96)}
  .c.on{background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b}
  .c[disabled]{opacity:.3;cursor:not-allowed}
  .c.pass{flex:none;width:54px;height:24px;font-size:10.5px;letter-spacing:.06em;color:#9e9ea5}.c.pass.on{background:#e3c98e;border-color:#e3c98e;color:#0b0b0b}
  .c.gold{color:#e3c98e;border-color:rgba(227,201,142,.3)}.c.gold:hover{border-color:#e3c98e}
  .c.rose{color:#efb1a7;border-color:rgba(232,152,140,.45)}
  .c.mint{color:#9fd7b2;border-color:rgba(159,215,178,.32)}.c.mint:hover{border-color:#9fd7b2}
  .pv,.tv{display:flex;flex-direction:column;gap:10px}
  /* the bet: risk on the left, target on the right, the beam between them */
  .pl{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding-top:12px;border-top:1px solid rgba(238,234,226,.07)}
  .pl div:last-child{text-align:right}
  .pl small{display:block;font-size:10.5px;font-weight:700;color:#6f6f75;letter-spacing:.06em}
  .pl b{display:block;margin-top:3px;font-size:30px;font-weight:600;letter-spacing:-.055em;line-height:1;font-variant-numeric:tabular-nums}
  .pl .sl b{color:#efb1a7}.pl .tp b{color:#bfe6cb}
  .pl b.m{font-size:24px}.pl b.x{font-size:20px}.pu b.m{font-size:36px}.pu b.x{font-size:29px}
  .pl em{display:block;margin-top:5px;font-style:normal;font-size:11px;font-weight:600;color:#8b8b92;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pl em i{font-style:normal;color:#5f5f66}
  .bm{position:relative;height:22px;margin:0 5px}
  .bm i{position:absolute;display:block}
  .bm .tr{left:-5px;right:-5px;top:10px;height:2px;border-radius:2px;background:rgba(238,234,226,.09)}
  .bm .zl,.bm .zh,.bm .fl{top:10px;height:2px;border-radius:2px;transition:left .8s cubic-bezier(.16,1,.3,1),width .8s cubic-bezier(.16,1,.3,1),background .4s}
  .bm .zl{background:rgba(232,152,140,.5)}.bm .zh{background:rgba(159,215,178,.5)}
  .bm .fl{top:9px;height:4px}.bm .fl.up{background:#bfe6cb;box-shadow:0 0 14px rgba(159,215,178,.55)}.bm .fl.dn{background:#efb1a7;box-shadow:0 0 14px rgba(232,152,140,.5)}
  .bm .bk{top:5px;width:2px;height:12px;margin-left:-1px;border-radius:2px;transition:left .8s cubic-bezier(.16,1,.3,1)}
  .bm .ks{background:#e8988c}.bm .kt{background:#9fd7b2}.bm .ke{background:#e6e3dc;top:7px;height:8px;opacity:.55}.bm .kg{background:#e3c98e;top:7px;height:8px}
  .bm .pd{top:5px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#e6e3dc;border:3px solid #0b0b0b;box-shadow:0 0 0 1px #e6e3dc,0 0 16px rgba(230,227,220,.45);transition:left .9s cubic-bezier(.16,1,.3,1),background .4s,box-shadow .4s}
  .bm.up .pd{background:#bfe6cb;box-shadow:0 0 0 1px #bfe6cb,0 0 18px rgba(159,215,178,.7)}.bm.dn .pd{background:#efb1a7;box-shadow:0 0 0 1px #efb1a7,0 0 18px rgba(232,152,140,.65)}
  .bm .pd:after{content:"";position:absolute;inset:-7px;border-radius:50%;border:1px solid currentColor;color:rgba(230,227,220,.5);animation:ring 3.5s ease-out infinite}
  @keyframes ring{0%,8%{transform:scale(.4);opacity:0}38%{opacity:.6}100%{transform:scale(1.5);opacity:0}}
  /* fees against the stop: the gold part of the risk goes to Vest, the rest is room for price */
  .bal{display:flex;flex-direction:column;gap:5px}
  .bb{height:3px;border-radius:3px;background:rgba(238,234,226,.14);overflow:hidden}
  .bb i{display:block;height:100%;border-radius:3px;background:#e3c98e;transition:width .7s cubic-bezier(.16,1,.3,1),background .3s}
  .bb i.hot{background:#e8988c}
  .bt{display:flex;justify-content:space-between;gap:8px;font-size:11px;font-weight:600;color:#8b8b92;font-variant-numeric:tabular-nums;white-space:nowrap}
  .bt b{color:#e3c98e;font-weight:600}.bt b.hot{color:#efb1a7}.bt span:last-child b{color:#f1f1f3}
  .sw{position:relative;width:26px;height:15px;border-radius:99px;border:0;background:rgba(238,234,226,.14);cursor:pointer;flex:none;vertical-align:-3px;margin-left:6px}
  .sw:after{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#8b8b92;transition:transform .25s}
  .sw.on{background:#e3c98e}.sw.on:after{transform:translateX(11px);background:#0b0b0b}
  /* in the trade */
  .tv{padding-top:12px;border-top:1px solid rgba(238,234,226,.07)}
  .th{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;font-weight:700;color:#6f6f75;letter-spacing:.06em;white-space:nowrap}
  .th b{font-weight:600}.th b.up{color:#bfe6cb}.th b.dn{color:#efb1a7}
  .pu{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-top:-2px}
  .pu b{font-size:44px;font-weight:600;letter-spacing:-.065em;line-height:.95;font-variant-numeric:tabular-nums;white-space:nowrap;transition:color .4s}
  .pu span{font-size:17px;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums;color:#8b8b92;white-space:nowrap}
  .pu span small{display:block;margin-top:3px;font-size:11px;font-weight:600;letter-spacing:0;color:#6f6f75;text-align:right}
  .ends{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:-4px}
  .ends div:last-child{text-align:right}
  .ends b{display:block;font-size:13px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .ends em{display:block;margin-top:2px;font-style:normal;font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;color:#8b8b92}
  .ends .a em{color:#efb1a7}.ends .b em{color:#bfe6cb}.ends .a em.up{color:#bfe6cb}
  .ends b.none{color:#efb1a7;letter-spacing:.06em;font-size:11.5px;animation:glow 1.6s ease-in-out infinite}
  @keyframes glow{0%,100%{opacity:.55}50%{opacity:1}}
  .ar{display:grid;grid-template-columns:46px minmax(0,1fr);align-items:center;gap:8px}
  .ar>label{font-size:10.5px;font-weight:700;color:#6f6f75;letter-spacing:.06em}
  .ch{display:flex;gap:5px;min-width:0}
  .lgs{display:flex;flex-wrap:wrap;gap:5px}.lgs:empty{display:none}
  .lg{display:inline-flex;align-items:center;height:26px;padding:0 4px 0 11px;border-radius:6px;border:1px solid rgba(227,201,142,.35);color:#e3c98e;font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums;animation:lin .35s ease-out}
  .lg button{border:0;background:none;color:#8b8b92;font:700 13px Inter,system-ui,sans-serif;cursor:pointer;padding:0 7px}.lg button:hover{color:#efb1a7}
  .busy:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:sweep 1s linear infinite}
  @keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
  /* the triggers */
  .s>.go{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:auto;position:sticky;bottom:32px;z-index:3;padding:8px 0 0;background:linear-gradient(180deg,rgba(11,11,11,0),#0b0b0b 10px)}
  .L,.S,.X{position:relative;height:50px;border-radius:10px;font:600 16px Inter,system-ui,sans-serif;letter-spacing:-.03em;cursor:pointer;transition:transform .12s,background .25s,border-color .25s,opacity .25s,box-shadow .3s;overflow:hidden}
  .L{border:0;background:#e6e3dc;color:#0b0b0b}.L:hover{background:#fff;box-shadow:0 0 26px -6px rgba(230,227,220,.55)}
  .S{border:1px solid rgba(238,234,226,.3);background:rgba(11,11,11,.6);color:#f1f1f3}.S:hover{border-color:#e6e3dc;box-shadow:0 0 26px -10px rgba(230,227,220,.5)}
  .A{position:relative;height:50px;border-radius:10px;font:600 16px Inter,system-ui,sans-serif;letter-spacing:-.03em;cursor:pointer;overflow:hidden;border:1px solid rgba(238,234,226,.3);background:rgba(11,11,11,.6);color:#f1f1f3;transition:transform .12s,border-color .25s,box-shadow .3s}.A:hover{border-color:#e6e3dc;box-shadow:0 0 26px -10px rgba(230,227,220,.5)}.A:active{transform:scale(.975)}.A small{display:block;font-size:9.5px;font-weight:700;opacity:.5;letter-spacing:.08em;margin-top:1px}
  .go .X:not(:only-child){grid-column:auto}
  .adh{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:2px 0 10px;font-size:11px;font-weight:600;letter-spacing:.14em;color:#9fd7b2}.adh.dn{color:#efb1a7}
  .adh button{height:24px;padding:0 11px;border-radius:8px;border:1px solid rgba(238,234,226,.16);background:none;color:#c9c7c2;font:600 11px Inter,system-ui,sans-serif;letter-spacing:0;cursor:pointer}.adh button:hover{color:#f1f1f3;border-color:rgba(238,234,226,.45)}
  .s.add .sr[data-sr=risk],.s.add .sr[data-sr=R],.s.add .ld{display:none}
  .X{grid-column:1/-1;border:1px solid rgba(232,152,140,.45);background:rgba(11,11,11,.6);color:#efb1a7}.X:hover{border-color:#efb1a7;box-shadow:0 0 26px -10px rgba(232,152,140,.6)}
  .L:active,.S:active,.X:active{transform:scale(.975)}
  .L[disabled],.S[disabled]{opacity:.32;cursor:not-allowed;box-shadow:none}
  .L small,.S small,.X small{display:block;font-size:9.5px;font-weight:700;opacity:.5;letter-spacing:.08em;margin-top:1px}
  .lk{grid-column:1/-1;display:flex;align-items:center;gap:12px;height:50px;padding:0 6px 0 16px;border-radius:10px;border:1px solid rgba(232,152,140,.35)}
  .lk i{flex:none;width:9px;height:9px;border-radius:50%;background:#e8988c;animation:br 4s ease-in-out infinite}
  .lk b{font-size:13px;font-weight:600;letter-spacing:.22em;color:#efb1a7}
  .lk span{flex:1;min-width:0;font-size:11.5px;font-weight:600;color:#8b8b92;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lk button{flex:none;height:36px;padding:0 14px;border-radius:8px;border:0;background:#e6e3dc;color:#0b0b0b;font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
  .s>.ft{position:sticky;bottom:0;z-index:3;display:flex;align-items:center;gap:8px;min-height:32px;margin-top:-10px;margin-bottom:-14px;padding:4px 0 6px;background:#0b0b0b}
  .msg{flex:1;min-width:0;font-size:11px;font-weight:600;color:#8b8b92;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .msg.ok{color:#9fd7b2}.msg.bad{color:#efb1a7}
  [hidden]{display:none!important}
  @media (prefers-reduced-motion:reduce){.dot,.moon,.bm .pd:after{animation:none}}`;
  const SL_FMT = { risk: v => trimNum(v) + '%', R: v => trimNum(v) + 'R', size: v => (v >= 100 ? 'max' : trimNum(Math.round(v * 10) / 10) + '%') };
  // the reward dial runs on a log scale, so 0.5R and 1R get as much room as 2R to 5R
  const RLO = 0.25, RHI = 5, LOGD = { R: { to: v => 1000 * Math.log(Math.max(RLO, Math.min(RHI, v)) / RLO) / Math.log(RHI / RLO), from: p => { const v = RLO * Math.exp(p / 1000 * Math.log(RHI / RLO)); return v < 1 ? Math.round(v * 20) / 20 : Math.round(v * 10) / 10; } } };
  // a slider with the benchmarks as tick marks under it (click one to snap to it)
  function slider(key, label, min, max, step, ticks, extra) {
    const lg = LOGD[key]; if (lg) { min = 0; max = 1000; step = 1; }
    const at = v => ((lg ? lg.to(v) : v) - min) / (max - min) * 100;
    return `<div class="sr" data-sr="${key}"><label>${label}</label>
      <div class="rg"><input type="range" data-r="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label}">
      <div class="tk">${ticks.map(([v, t]) => `<button data-tk="${key}" data-v="${v}" style="left:${at(v)}%">${t}</button>`).join('')}</div></div><b data-sv="${key}"></b>${extra ? `<div class="ex">${extra}</div>` : ''}</div>`;
  }
  const SLCSS = `
  .sr{display:grid;grid-template-columns:50px 1fr 44px;align-items:start;column-gap:4px}
  .sr>label{font-size:10.5px;font-weight:700;color:#6f6f75;letter-spacing:.06em;line-height:18px}
  .sr>b{font-size:14px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:#f1f1f3;text-align:right;line-height:18px;transition:color .25s}
  .sr.off>b{color:#4f4f55}
  .ex{grid-column:1/-1;display:flex;justify-content:flex-end;gap:5px;margin-top:2px}
  .rg{position:relative;padding:0 4px 14px}
  .rg input{-webkit-appearance:none;appearance:none;display:block;width:100%;height:18px;margin:0;background:none;cursor:pointer;outline:none}
  .rg input::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:linear-gradient(90deg,#e6e3dc 0,#e6e3dc var(--p,0%),rgba(238,234,226,.12) var(--p,0%))}
  .rg input::-moz-range-track{height:4px;border-radius:99px;background:linear-gradient(90deg,#e6e3dc 0,#e6e3dc var(--p,0%),rgba(238,234,226,.12) var(--p,0%))}
  .rg input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:#e6e3dc;border:3px solid #0b0b0b;box-shadow:0 0 0 1px #e6e3dc,0 0 14px rgba(230,227,220,.28);transition:transform .2s}
  .rg input::-moz-range-thumb{width:10px;height:10px;border-radius:50%;background:#e6e3dc;border:3px solid #0b0b0b;box-shadow:0 0 0 1px #e6e3dc,0 0 14px rgba(230,227,220,.28)}
  .rg input:hover::-webkit-slider-thumb,.rg input:active::-webkit-slider-thumb{transform:scale(1.18)}
  .rg input:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 2px #e3c98e}
  .sr.off .rg input::-webkit-slider-runnable-track{background:rgba(238,234,226,.1)}
  .sr.off .rg input::-webkit-slider-thumb{background:#4f4f55;box-shadow:0 0 0 1px #4f4f55}
  .tk{position:absolute;left:12px;right:12px;bottom:0;height:13px}
  .tk button{position:absolute;transform:translateX(-50%);padding:0 3px;border:0;background:none;color:#5c5c62;font:700 9.5px Inter,system-ui,sans-serif;cursor:pointer;letter-spacing:.02em;transition:color .2s}
  .tk button:before{content:"";position:absolute;left:50%;top:-6px;width:1px;height:4px;background:rgba(238,234,226,.18)}
  .tk button:hover{color:#f1f1f3}.tk button.on{color:#e6e3dc}
  .ld{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
  .ls{flex:none;height:26px;padding:0 10px;border-radius:8px;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:700 11px Inter,system-ui,sans-serif;cursor:pointer;transition:all .25s;white-space:nowrap}
  .ls:hover{color:#f1f1f3;border-color:rgba(238,234,226,.34)}.ls.on{background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b}
  .ln{display:flex;gap:5px;flex:1 1 100%}
  .ln input{flex:1;min-width:0;height:26px;padding:0 12px;border-radius:8px;border:1px solid rgba(227,201,142,.55);background:#0b0b0b;color:#f1f1f3;font:700 12px Inter,system-ui,sans-serif;outline:none}
  .ll{display:contents}
  .lc{display:inline-flex;align-items:center;height:26px;border-radius:8px;border:1px solid rgba(238,234,226,.12);overflow:hidden;transition:all .25s;animation:lin .35s ease-out}
  @keyframes lin{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}
  .lc button{height:100%;border:0;background:none;color:#c9c7c2;font:700 11.5px Inter,system-ui,sans-serif;cursor:pointer;padding:0 4px 0 11px}
  .lc button small{margin-left:6px;font-size:9.5px;font-weight:600;color:#6f6f75;font-variant-numeric:tabular-nums}.lc.on button small{color:#9e9ea5}
  .lc button.x{padding:0 9px 0 4px;color:#55555b;font-size:13px;opacity:0;transition:opacity .2s}
  .lc:hover{border-color:rgba(238,234,226,.34)}.lc:hover button.x{opacity:1}.lc button.x:hover{color:#efb1a7}
  .lc.on{background:#e6e3dc;border-color:#e6e3dc}.lc.on button{color:#0b0b0b}.lc.on button small{color:#55524b}.lc.on button.x{color:#55524b}`;
  let SP = null;
  const BEAM = '<i class="tr"></i><i class="zl"></i><i class="zh"></i><i class="fl"></i><span data-g></span><i class="bk ks"></i><i class="bk ke"></i><i class="bk kt"></i><i class="pd"></i>';
  // the beam: stop on the left, target on the right, entry between, the price riding along it. o is in points from entry.
  function setBeam(el, o) {
    const q = c => el.querySelector(c), span = (o.b - o.a) || 1, X = v => Math.max(0, Math.min(100, (v - o.a) / span * 100)), e = X(0);
    const seg = (c, x0, x1) => { const n = q(c); n.style.left = Math.min(x0, x1) + '%'; n.style.width = Math.abs(x1 - x0) + '%'; };
    const tick = (c, v) => { const n = q(c); n.hidden = v == null; if (v != null) n.style.left = X(v) + '%'; };
    seg('.zl', o.stop != null ? X(Math.min(0, o.stop)) : e, e); seg('.zh', e, o.tgt != null ? X(o.tgt) : e);
    tick('.ks', o.stop); tick('.ke', 0); tick('.kt', o.tgt);
    const p = o.price || 0; seg('.fl', e, X(p)); q('.fl').className = 'fl' + (p > 0 ? ' up' : p < 0 ? ' dn' : '');
    q('.pd').style.left = X(p) + '%'; el.className = 'bm' + (p > 0 ? ' up' : p < 0 ? ' dn' : '');
    const g = q('[data-g]'), gh = (o.legs || []).map(v => `<i class="bk kg" style="left:${X(v)}%"></i>`).join(''); if (g.dataset.h !== gh) g.innerHTML = g.dataset.h = gh;
  }
  function shotHost() {
    if (SP) return SP;
    const host = document.createElement('div'); host.id = 'gpz-shot'; host.style.cssText = 'position:fixed;z-index:2147483639;display:none';
    ['keydown', 'keyup', 'keypress'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    const R = host.attachShadow({ mode: 'open' });
    const cuts = (attr, cls) => [25, 50, 75].map(v => `<button class="c${cls || ''}" data-${attr}="${v}">${v}%</button>`).join('');
    R.innerHTML = `<style>${SCSS}${SLCSS}</style><div class="s">
      <div class="mw"><canvas class="moon" width="660" height="660"></canvas></div>
      <div class="hd" data-a="drag"><i class="dot"></i><div class="brand">GP.<span>SHOT</span></div><div class="sp"></div>
        <button class="ib" data-a="zone" title="Zone"><i></i><span data-k="zc">zone</span></button><button class="ib" data-a="copy" title="Copier"><i></i><span data-k="cp">desk</span></button><button class="ib" data-a="vest" title="Vest's ticket">Vest</button></div>
      <div class="mk"><b data-k="px">—</b><span data-k="ac">—</span></div>
      <div class="zr" data-k="zr" hidden><div class="zs" data-k="zs"></div>
        <div class="zi" data-k="zi"><label>LOCK</label><input class="n" data-z="loss" inputmode="decimal" placeholder="−$ loss" aria-label="Lock after this loss"><input class="n" data-z="n" inputmode="numeric" placeholder="losers" aria-label="Lock after this many losers"><button class="ls on" data-a="zgo">enter</button></div>
        <button class="ls" data-a="zend" hidden>end</button></div>
      <div class="pv" data-v="plan">
        <div class="adh" data-k="adh" hidden><span data-k="adt">—</span><button data-a="addback">back</button></div>
        <div class="pl"><div class="sl"><small>STOP</small><b data-k="slv">—</b><em data-k="slp">—</em></div><div class="tp"><small>TARGET</small><b data-k="tpv">—</b><em data-k="tpp">—</em></div></div>
        <div class="bm" data-k="bm0">${BEAM}</div>
        ${slider('risk', 'RISK', 0.2, 8, 0.1, [[1, '1%'], [2, '2%'], [3, '3%'], [5, '5%'], [8, '8%']])}
        ${slider('R', 'REWARD', RLO, RHI, 0.05, [[0.5, '.5R'], [1, '1R'], [2, '2R'], [3, '3R']], '<button class="c pass" data-a="pass" title="Pass line">PASS</button><input class="n" data-n="usd" inputmode="decimal" placeholder="$ gain" aria-label="Dollar target">')}
        ${slider('size', 'SIZE', 5, 100, 1, [[25, '25%'], [50, '50%'], [75, '75%'], [100, 'max']])}
        <div class="bal"><div class="bb"><i data-k="fb" style="width:0"></i></div><div class="bt"><span>fees <b data-k="fe">—</b><button class="sw" data-t="fees" title="Fees inside the risk" aria-label="Fees inside the risk"></button></span><span data-k="qz"></span></div></div>
        <div class="ld"><div class="ll" data-k="ll"></div><button class="ls" data-a="lsave" title="Save loadout" data-k="lsv">+</button>
          <div class="ln" data-k="ln" hidden><input data-k="lname" maxlength="18" placeholder="name it" aria-label="Loadout name"><button class="ls on" data-a="lok">save</button><button class="ls" data-a="lno">×</button></div></div>
      </div>
      <div class="tv" data-v="pos" hidden>
        <div class="th"><span data-k="ph">—</span><span data-k="pe">—</span></div>
        <div class="pu"><b data-k="pu">—</b><span data-k="pr"></span></div>
        <div class="bm" data-k="bm1">${BEAM}</div>
        <div class="ends"><div class="a"><b data-k="e1">—</b><em data-k="e1s"></em></div><div class="b"><b data-k="e2">—</b><em data-k="e2s"></em></div></div>
        <div class="ar"><label>CLOSE</label><div class="ch">${cuts('cut')}</div></div>
        <div class="ar"><label>LIMIT</label><div class="ch">${cuts('lim', ' gold')}</div></div>
        <div class="ar"><label>STOP</label><div class="ch"><button class="c" data-a="half">½ risk</button><button class="c" data-a="be">break even</button><button class="c rose" data-a="addstop" hidden>add stop</button></div></div>
        <div class="lgs" data-k="lgs"></div>
      </div>
      <div class="go" data-v="go"><button class="L" data-a="long">Long<small>ALT B</small></button><button class="S" data-a="short">Short<small>ALT S</small></button></div>
      <div class="go" data-v="go2" hidden><button class="A" data-a="addmode">Add<small>MORE</small></button><button class="X" data-a="close">Close<small>ALT X</small></button></div>
      <div class="go" data-v="go4" hidden><button class="L" data-a="addgo"><span data-k="addq">Add</span><small data-k="addk">ALT B</small></button><button class="X" data-a="close2">Close<small>ALT X</small></button></div>
      <div class="go" data-v="go3" hidden><div class="lk"><i></i><b>LOCKED</b><span data-k="lk"></span><button data-a="zend2">end zone</button></div></div>
      <div class="ft"><div class="msg" data-k="msg"></div></div>
    </div>`;
    document.documentElement.appendChild(host);
    const peek = document.createElement('div'); peek.id = 'gpz-peek'; peek.style.cssText = 'position:fixed;z-index:2147483639;display:none';
    const PR = peek.attachShadow({ mode: 'open' }); PR.innerHTML = `<style>:host{display:flex;gap:6px}button{height:26px;padding:0 12px;border-radius:8px;border:1px solid rgba(238,234,226,.25);background:#0b0b0b;color:#f1f1f3;font:600 11.5px Inter,system-ui,sans-serif;letter-spacing:-.02em;cursor:pointer;box-shadow:0 10px 24px -10px #000}button:hover{border-color:#e6e3dc}</style><button data-a="desk">Desk</button><button data-a="shot">GP. Shot</button>`;
    PR.querySelector('[data-a=shot]').onclick = () => { SH.on = true; saveSH(); placeShot(); renderShot(); kickFast(); };
    PR.querySelector('[data-a=desk]').onclick = () => deskToggle();
    document.documentElement.appendChild(peek);
    const k = n => R.querySelector(`[data-k="${n}"]`), on = (a, fn) => { R.querySelector(`[data-a=${a}]`).onclick = fn; };
    moon(R.querySelector('.moon').getContext('2d'), 660, 660, 360, 360, 320, 11, 1);
    const redo = () => { renderShot(); drawChart(); };
    on('pass', () => { SH.tmode = SH.tmode === 'pass' ? 'R' : 'pass'; saveSH(); redo(); });
    const usd = R.querySelector('[data-n=usd]');
    usd.onchange = () => { const v = parseFloat(String(usd.value).replace(/[$,\s]/g, '')); if (v > 0) { SH.usd = Math.round(v * 100) / 100; SH.tmode = 'usd'; } else if (SH.tmode === 'usd') SH.tmode = 'R'; saveSH(); redo(); };
    usd.onkeydown = e => { if (e.key === 'Enter') usd.blur(); };
    R.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { SH[b.dataset.t] = !SH[b.dataset.t]; saveSH(); redo(); });
    const setSl = (key, v) => { v = Math.round(+v * 100) / 100; if (!(v > 0)) return; SH[key] = v; if (key === 'R') SH.tmode = 'R'; redo(); };
    R.querySelectorAll('[data-r]').forEach(i => { i.oninput = () => setSl(i.dataset.r, LOGD[i.dataset.r] ? LOGD[i.dataset.r].from(+i.value) : i.value); i.onchange = () => saveSH(); });
    R.querySelectorAll('[data-tk]').forEach(b => b.onclick = () => { setSl(b.dataset.tk, b.dataset.v); saveSH(); });
    // loadouts: the three dials, the target mode and the fees switch, under a name
    const ln = k('ln'), lname = k('lname');
    const openName = v => { ln.hidden = !v; R.querySelector('[data-a=lsave]').hidden = v; if (v) { lname.value = ''; lname.focus(); } };
    on('lsave', () => openName(true)); on('lno', () => openName(false));
    const keep = () => { const n = lname.value.trim().slice(0, 18); if (!n) return lname.focus(); const L0 = (DB.loads || []).filter(x => x.n.toLowerCase() !== n.toLowerCase()); L0.push(Object.assign({ n }, loadOf())); DB.loads = L0.slice(-12); save(); openName(false); renderShot(); };
    on('lok', keep);
    lname.onkeydown = e => { if (e.key === 'Enter') keep(); else if (e.key === 'Escape') openName(false); };
    k('ll').onclick = e => { const c = e.target.closest('.lc'); if (!c) return; const L0 = DB.loads || [], x = L0[+c.dataset.i]; if (!x) return;
      if (e.target.closest('.x')) { L0.splice(+c.dataset.i, 1); DB.loads = L0; save(); renderShot(); return; }
      Object.assign(SH, { risk: x.risk, R: x.R, tmode: x.tmode, usd: x.usd, size: x.size, fees: x.fees }); saveSH(); redo(); };
    on('long', () => fire('long')); on('short', () => fire('short')); on('close', closeMine); on('close2', closeMine);
    on('addmode', () => addOn(true)); on('addback', () => addOn(false)); on('addgo', addMore);
    ['long', 'short'].forEach(sd => { const b = R.querySelector(`[data-a=${sd}]`); b.onmouseenter = () => { SHOT.hover = sd; redo(); }; b.onmouseleave = () => { SHOT.hover = null; redo(); }; });
    on('vest', () => { SH.on = false; saveSH(); placeShot(); clearLines(); });
    // in the trade
    R.querySelectorAll('[data-cut]').forEach(b => b.onclick = () => cut(+b.dataset.cut));
    R.querySelectorAll('[data-lim]').forEach(b => b.onclick = () => scaleOut(+b.dataset.lim));
    on('be', breakEven); on('half', halfRisk); on('addstop', addStop);
    k('lgs').onclick = e => { const b = e.target.closest('button'); if (b) dropLeg(b.dataset.id); };
    // zone: entered from the ticket with its lock, ended from it
    on('zone', () => { SHOT.zopen = !SHOT.zopen; renderShot(); });
    R.querySelectorAll('[data-z]').forEach(i => { i.value = ZL[i.dataset.z] > 0 ? ZL[i.dataset.z] : ''; i.onchange = () => { const v = Math.abs(parseFloat(String(i.value).replace(/[^\d.]/g, ''))); ZL[i.dataset.z] = v > 0 ? (i.dataset.z === 'n' ? Math.round(v) : Math.round(v * 100) / 100) : 0; DB.zl = ZL; save(); renderShot(); }; i.onkeydown = e => { if (e.key === 'Enter') i.blur(); }; });
    on('zgo', () => { SHOT.zopen = false; if (!DB.zone) zoneStart(); renderShot(); });
    const end = () => { SHOT.zopen = false; if (DB.zone) zoneEnd(); renderShot(); };
    on('zend', end); on('zend2', end);
    // drag to float anywhere; double-click the header to dock it back over Vest's ticket
    const hd = R.querySelector('[data-a=drag]');
    hd.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return; e.preventDefault();
      const r = host.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = ev => { SH.dock = false; SH.x = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - ox)); SH.y = Math.max(0, Math.min(innerHeight - 80, ev.clientY - oy)); host.style.left = SH.x + 'px'; host.style.top = SH.y + 'px'; };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); saveSH(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    hd.addEventListener('dblclick', () => { SH.dock = true; saveSH(); placeShot(); });
    R.querySelector('[data-a=copy]').onclick = () => { DK.tab = 'acc'; deskToggle(); };
    SP = { host, R, k, peek };
    return SP;
  }
  function vestTicket() {
    const tabs = [...document.querySelectorAll('[role=tablist]')].find(t => /^MarketLimitScale$/.test((t.textContent || '').replace(/\s+/g, '')));
    if (!tabs) return null; let c = tabs;
    while (c && c !== document.body && !c.querySelector('button[type=submit]')) c = c.parentElement;
    return c && c !== document.body ? c : null;
  }
  // ---------- layout: the order side gets as much room as the chart (drag the seam; double-click it for 50/50) ----------
  let SPL = null;
  if (DB.colV !== 3) { DB.colF = null; DB.colV = 3; save(); } // Vest's own width until the seam is dragged
  function orderCol() { // the column that holds Vest's ticket: the child of the row that also holds the chart
    const card = vestTicket(), fr = document.querySelector('iframe[id^=tradingview_]'); if (!card || !fr) return null;
    let c = card; while (c.parentElement && c.parentElement !== document.body && !c.parentElement.contains(fr)) c = c.parentElement;
    return c.parentElement && c.parentElement.contains(fr) && !c.contains(fr) ? c : null;
  }
  function splitTotal(col) { // chart column + order column: the two that share the room
    const fr = document.querySelector('iframe[id^=tradingview_]'), ch = [...col.parentElement.children].find(e => e.contains(fr));
    return col.getBoundingClientRect().width + (ch ? ch.getBoundingClientRect().width : 0);
  }
  let bookDone = '';
  function bookFold() {
    if (!SH.on || !IS_TRADE() || bookDone === location.pathname) return;
    const tab = [...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Book'), card = tab && tab.closest('[data-slot=card]');
    if (!card) return; const w = card.getBoundingClientRect().width; if (!w) return;
    bookDone = location.pathname;
    const btn = card.previousElementSibling && card.previousElementSibling.querySelector('button');
    if (w > 90 && btn && btn.querySelector('.lucide-list-collapse, svg')) btn.click();
  }
  W.__gpzBook = () => { const tab = [...document.querySelectorAll('[role=tab]')].find(t => t.textContent.trim() === 'Book'), c = tab && tab.closest('[data-slot=card]'); return c ? Math.round(c.getBoundingClientRect().width) : null; };
  function layoutCols() {
    const on = SH.on && IS_TRADE() && !!AUTH && SH.wide !== false, col = on ? orderCol() : null;
    document.querySelectorAll('[data-gpz-col]').forEach(e => { if (e !== col) e.removeAttribute('data-gpz-col'); });
    if (!col) { if (SPL) SPL.style.display = 'none'; return; }
    const own = DB.colF == null || !(DB.colF > 0); // no drag yet: Vest's layout as it is
    if (own) col.removeAttribute('data-gpz-col');
    if (!own && !document.getElementById('gpz-col-css')) { const st = document.createElement('style'); st.id = 'gpz-col-css'; st.textContent = '[data-gpz-col]{flex:0 0 var(--gpz-colw)!important;width:var(--gpz-colw)!important;max-width:none!important;min-width:0!important;box-sizing:border-box!important}'; document.documentElement.appendChild(st); }
    if (!own) { const f = Math.max(0.18, Math.min(0.6, DB.colF)), tot = splitTotal(col);
      const w = Math.max(300, Math.round(tot * f)); document.documentElement.style.setProperty('--gpz-colw', w + 'px');
      col.setAttribute('data-gpz-col', ''); }
    if (!SPL) {
      SPL = document.createElement('div'); SPL.id = 'gpz-split'; SPL.title = 'Drag to widen · double-click for Vest\'s own';
      SPL.style.cssText = 'position:fixed;z-index:2147483630;width:10px;cursor:col-resize;display:none';
      SPL.innerHTML = '<i style="position:absolute;left:4px;top:0;bottom:0;width:2px;border-radius:2px;background:#e6e3dc;opacity:0;transition:opacity .2s"></i>';
      const ln = SPL.firstChild; SPL.onmouseenter = () => { ln.style.opacity = '.35'; }; SPL.onmouseleave = () => { if (!SPL.drag) ln.style.opacity = '0'; };
      SPL.addEventListener('pointerdown', e => {
        e.preventDefault(); SPL.drag = true; ln.style.opacity = '.6';
        const fr = document.querySelector('iframe[id^=tradingview_]'); if (fr) fr.style.pointerEvents = 'none'; // the chart would swallow the drag
        const mv = ev => { const c = orderCol(); if (!c) return; const r = c.getBoundingClientRect(); DB.colF = Math.max(0.18, Math.min(0.6, (r.right - ev.clientX) / splitTotal(c))); layoutCols(); placeShot(); placeDesk(); };
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); SPL.drag = false; ln.style.opacity = '0'; if (fr) fr.style.pointerEvents = ''; save(); };
        addEventListener('pointermove', mv); addEventListener('pointerup', up);
      });
      SPL.addEventListener('dblclick', () => { DB.colF = null; save(); layoutCols(); placeShot(); placeDesk(); });
      document.documentElement.appendChild(SPL);
    }
    const cr = col.getBoundingClientRect(), gap = Math.max(0, cr.left - (col.previousElementSibling ? col.previousElementSibling.getBoundingClientRect().right : cr.left));
    Object.assign(SPL.style, { display: '', left: Math.round(cr.left - gap / 2 - 5) + 'px', top: Math.round(cr.top) + 'px', height: Math.round(cr.height) + 'px' });
  }
  W.__gpzCols = () => { const c = document.querySelector('[data-gpz-col]'); return c ? { col: Math.round(c.getBoundingClientRect().width), row: Math.round(splitTotal(c)) } : null; };
  function placeShot() {
    const S = shotHost(), on = SH.on && IS_TRADE() && !!AUTH;
    const card = IS_TRADE() ? vestTicket() : null, r = card && card.getBoundingClientRect();
    SHOT.visible = on;
    if (!on) { S.host.style.display = 'none'; const pk = S.peek; if (IS_TRADE() && r && r.width > 150) { pk.style.display = ''; pk.style.left = (r.right - 160) + 'px'; pk.style.top = (r.top + 4) + 'px'; } else pk.style.display = 'none'; return; }
    S.peek.style.display = 'none';
    let x, y, w, h;
    if (SH.dock && r && r.width > 200 && r.height > 300) { x = r.left; y = r.top; w = r.width; h = r.height; }
    else { w = 320; h = Math.min(640, innerHeight - 24); x = SH.x != null ? SH.x : innerWidth - w - 16; y = SH.y != null ? SH.y : Math.max(12, innerHeight - h - 16); }
    const st = S.host.style; st.display = ''; st.left = Math.round(x) + 'px'; st.top = Math.round(y) + 'px'; st.width = Math.round(w) + 'px'; st.height = Math.round(h) + 'px';
  }
  const acctShort = id => (L.names && L.names[id]) || (capAcct(id) ? 'Account ' + ((+capAcct(id).attempt_index || 0) + 1) : '…' + String(id).slice(-4));
  const fit = t => (t.length > 10 ? ' x' : t.length > 8 ? ' m' : ''); // long numbers step down a size, never clip
  function zoneBits() { // the zone chip and its line: the clock, the closed PnL, the count, the lock
    if (!SP) return; const { R, k } = SP, z = DB.zone, zs = zoneStats(), locked = zoneLocked();
    const chip = R.querySelector('[data-a=zone]'); chip.classList.toggle('armed', !!z && !locked); chip.classList.toggle('lock', locked);
    k('zc').textContent = z ? fdur(Date.now() - z.t0) : 'zone';
    k('zr').hidden = !(z || SHOT.zopen); k('zi').hidden = !!z; k('zs').hidden = !z; R.querySelector('[data-a=zend]').hidden = !z;
    if (z) k('zs').innerHTML = `<b class="${zs.sum > 0 ? 'up' : zs.sum < 0 ? 'dn' : ''}">${fm(zs.sum, { sign: true })}</b> · ${zs.won}W ${zs.lost}L` + (ZL.loss > 0 || ZL.n > 0 ? ' · lock ' + [ZL.loss > 0 ? '−' + fk(ZL.loss) : '', ZL.n > 0 ? ZL.n + 'L' : ''].filter(Boolean).join(' / ') : '');
    return { locked, zs };
  }
  function renderShot() {
    if (!SP) return; const { R, k } = SP, p = plan(), pos = myPos(p), box = R.querySelector('.s');
    renderCopy(p);
    const zb = zoneBits(), locked = zb.locked && !pos;
    const stale = !(Date.now() - (L.markAt || 0) < FRESH);
    k('px').textContent = p.sym && L.mark[p.sym] ? shortSym(p.sym) + '  ' + fmtPx(L.mark[p.sym], p.sym) : '—'; k('px').classList.toggle('old', stale);
    k('ac').innerHTML = p.id && p.bal ? `${esc(acctShort(p.id))} · <em>${p.lev || '—'}x</em> · ${fm(p.bal, { short: true }).replace(/\.00$/, '')}` : '';
    if (!pos) SHOT.adding = false; const adding = !!pos && !!SHOT.adding;
    R.querySelector('[data-v=plan]').hidden = !!pos && !adding; R.querySelector('[data-v=pos]').hidden = !pos || adding;
    R.querySelector('[data-v=go]').hidden = !!pos || locked; R.querySelector('[data-v=go2]').hidden = !pos || adding; R.querySelector('[data-v=go3]').hidden = !locked; R.querySelector('[data-v=go4]').hidden = !adding;
    box.classList.toggle('in', !!pos && !adding); box.classList.toggle('add', adding); k('adh').hidden = !adding;
    if (pos && !adding) {
      const t = tradeOf(pos), sym = pos.symbol, slP = t.sl ? +t.sl.triggerPrice : null, tpP = t.tp ? +t.tp.triggerPrice : null;
      box.classList.toggle('neg', t.u < 0);
      k('ph').innerHTML = `<b class="${t.long ? 'up' : 'dn'}">${t.long ? 'LONG' : 'SHORT'}</b> ${trimNum(pos.quantity)} ${shortSym(sym)}`; k('pe').textContent = 'ENTRY ' + fmtPx(t.op, sym);
      k('pu').textContent = fm(t.u, { sign: true }); k('pu').className = (t.u > 0 ? 'up' : t.u < 0 ? 'dn' : '') + fit(k('pu').textContent);
      k('pr').innerHTML = (t.R != null ? (t.R >= 0 ? '+' : '−') + Math.abs(t.R).toFixed(2) + 'R' : '') + (t.m ? `<small>${(t.s(t.m) >= 0 ? '+' : '−') + pts(t.s(t.m))} pts</small>` : '');
      const sm = t.m ? t.s(t.m) : 0, sS = slP != null ? t.s(slP) : null, sT = tpP != null ? t.s(tpP) : null;
      const a = Math.min(sS != null ? sS : -t.d0, sm, -t.d0 * 0.2), b = Math.max(sT != null ? sT : t.d0 * 2, sm, t.d0 * 0.2);
      setBeam(k('bm1'), { a, b, stop: sS, tgt: sT, price: sm, legs: t.scales.map(l => t.s(+l.triggerPrice)) });
      k('e1').textContent = slP != null ? fmtPx(slP, sym) : 'NO STOP'; k('e1').className = slP != null ? '' : 'none';
      const slUsd = slP != null ? t.at(slP) : 0; k('e1s').textContent = slP != null ? fm(slUsd, { sign: true }) + (t.m ? ' · ' + pts(t.m - slP) + ' pts' : '') : ''; k('e1s').className = slUsd > 0 ? 'up' : '';
      k('e2').textContent = tpP != null ? fmtPx(tpP, sym) : '—'; k('e2s').textContent = tpP != null ? (t.m ? pts(tpP - t.m) + ' pts · ' : '') + fm(t.at(tpP), { sign: true }) : '';
      R.querySelector('[data-a=addstop]').hidden = slP != null; R.querySelector('[data-a=half]').hidden = R.querySelector('[data-a=be]').hidden = slP == null;
      R.querySelectorAll('[data-v=pos] .c').forEach(c => { const tag = c.dataset.cut ? 'cut' + c.dataset.cut : c.dataset.lim ? 'lim' + c.dataset.lim : c.dataset.a; c.classList.toggle('busy', SHOT.busy === tag); c.disabled = !!SHOT.busy; });
      const lh = t.scales.map(l => `<span class="lg">${legFixed(l) ? Math.round(Math.abs(+l.quantity) / t.q * 100) + '% · ' : ''}${fmtPx(l.triggerPrice, sym)}<button data-id="${esc(l.id)}" title="Remove">×</button></span>`).join('');
      if (k('lgs').dataset.h !== lh) k('lgs').innerHTML = k('lgs').dataset.h = lh;
    } else {
      box.classList.remove('neg');
      R.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', !!SH[b.dataset.t]));
      R.querySelectorAll('[data-r]').forEach(i => { const key = i.dataset.r, v = LOGD[key] ? LOGD[key].to(+SH[key]) : +SH[key], mn = +i.min, mx = +i.max; if (R.activeElement !== i) i.value = v; i.style.setProperty('--p', Math.max(0, Math.min(100, ((v - mn) / (mx - mn)) * 100)) + '%'); });
      R.querySelectorAll('[data-sv]').forEach(b => { b.textContent = SL_FMT[b.dataset.sv](+SH[b.dataset.sv]); });
      R.querySelectorAll('[data-tk]').forEach(b => b.classList.toggle('on', +b.dataset.v === +SH[b.dataset.tk] && (b.dataset.tk !== 'R' || SH.tmode === 'R')));
      R.querySelector('[data-sr=R]').classList.toggle('off', SH.tmode !== 'R');
      const pb = R.querySelector('[data-a=pass]'); pb.classList.toggle('on', SH.tmode === 'pass'); pb.disabled = !(p.passNeed > 0); pb.hidden = !(p.passNeed > 0) && SH.tmode !== 'pass';
      const usd = R.querySelector('[data-n=usd]'); if (R.activeElement !== usd) { usd.value = SH.tmode === 'usd' && SH.usd > 0 ? '$' + SH.usd : ''; usd.classList.toggle('on', SH.tmode === 'usd'); }
      { const cur = JSON.stringify(loadOf()), L0 = DB.loads || [], h = L0.map((x, i) => `<div class="lc${JSON.stringify(loadOf(x)) === cur ? ' on' : ''}" data-i="${i}"><button title="${trimNum(x.risk)}% risk · ${x.tmode === 'pass' ? 'pass' : x.tmode === 'usd' ? '$' + trimNum(x.usd) : trimNum(x.R) + 'R'} · size ${x.size >= 100 ? 'max' : x.size + '%'}${x.fees ? ' · fees in' : ''}">${esc(x.n)}<small>${trimNum(x.risk)}% · ${x.tmode === 'pass' ? 'pass' : x.tmode === 'usd' ? '$' + trimNum(x.usd) : trimNum(x.R) + 'R'} · ${x.size >= 100 ? 'max' : x.size + '%'}</small></button><button class="x" title="Delete">×</button></div>`).join('');
        if (k('ll').dataset.h !== h) k('ll').innerHTML = k('ll').dataset.h = h; k('lsv').textContent = L0.length ? '+' : '+ loadout'; }
      const side = SHOT.hover || SH.side || 'long';
      if (p.qty) {
        k('slv').textContent = '−' + fm(SH.fees ? p.risk : p.slG).replace('−', '');
        k('tpv').textContent = '+' + fm(SH.fees ? p.reward : p.tpG);
        k('slv').className = fit(k('slv').textContent); k('tpv').className = fit(k('tpv').textContent);
        k('slp').innerHTML = p.dSL ? pts(p.dSL) + ' pts <i>· ' + fmtPx(p[side].sl, p.sym) + '</i>' : '—';
        k('tpp').innerHTML = p.dTP ? pts(p.dTP) + ' pts <i>· ' + fmtPx(p[side].tp, p.sym) + '</i>' : '—';
        if (p.dSL) setBeam(k('bm0'), { a: -p.dSL, b: p.dTP, stop: -p.dSL, tgt: p.dTP, price: 0, legs: p.dPass && SH.tmode !== 'pass' && p.dPass < p.dTP ? [p.dPass] : [] });
        const share = p.risk > 0 ? p.fees / p.risk : 0, hot = share >= 0.4;
        k('fb').style.width = Math.min(100, share * 100) + '%'; k('fb').classList.toggle('hot', hot);
        k('fe').textContent = fm(p.fees) + ' · ' + Math.round(share * 100) + '%'; k('fe').classList.toggle('hot', hot);
        k('qz').innerHTML = `<b>${p.qtyS} ${shortSym(p.sym)}</b> · ${fk(p.N)}`;
      } else { k('slv').textContent = '—'; k('tpv').textContent = '—'; k('slp').textContent = ''; k('tpp').textContent = ''; k('fe').textContent = '—'; k('qz').textContent = ''; k('fb').style.width = '0'; }
      const cool = Date.now() < SHOT.cool;
      const L1 = R.querySelector('[data-a=long]'), S1 = R.querySelector('[data-a=short]');
      L1.disabled = S1.disabled = !p.ok || !!SHOT.busy || cool; L1.classList.toggle('busy', SHOT.busy === 'long'); S1.classList.toggle('busy', SHOT.busy === 'short');
      if (locked) k('lk').textContent = fm(zb.zs.sum, { sign: true }) + ' · ' + zb.zs.lost + 'L';
    }
    if (adding) { // the whole trade after the add, at its own stop and target
      const t = tradeOf(pos), sym = pos.symbol, aq = p.qty > 0 ? +fmtQ(p.qty, sym) : 0, Q = t.q + aq, m = t.m || t.op, avg = (t.op * t.q + m * aq) / Q;
      const at = px => (px - avg) * t.dir * Q - Q * (avg + px) * t.f, slP = t.sl ? +t.sl.triggerPrice : null, tpP = t.tp ? +t.tp.triggerPrice : null;
      k('adt').textContent = 'ADD TO ' + (t.long ? 'LONG ' : 'SHORT ') + trimNum(pos.quantity) + ' ' + shortSym(sym); k('adh').className = 'adh' + (t.long ? '' : ' dn');
      k('slv').textContent = slP != null ? fm(at(slP), { sign: true }) : 'NO STOP'; k('slv').className = fit(k('slv').textContent);
      k('tpv').textContent = tpP != null ? fm(at(tpP), { sign: true }) : '—'; k('tpv').className = fit(k('tpv').textContent);
      k('slp').innerHTML = slP != null ? pts(m - slP) + ' pts <i>· ' + fmtPx(slP, sym) + '</i>' : '';
      k('tpp').innerHTML = tpP != null ? pts(tpP - m) + ' pts <i>· ' + fmtPx(tpP, sym) + '</i>' : '';
      const sS = slP != null ? t.s(slP) - t.s(m) : null, sT = tpP != null ? t.s(tpP) - t.s(m) : null;
      setBeam(k('bm0'), { a: Math.min(sS != null ? sS : -t.d0, -t.d0 * 0.2), b: Math.max(sT != null ? sT : t.d0, t.d0 * 0.2), stop: sS, tgt: sT, price: 0, legs: [] });
      k('qz').innerHTML = aq ? `<b>+${trimNum(aq)} ${shortSym(sym)}</b> · ${trimNum(Q)} total` : '';
      k('addq').textContent = aq ? 'Add ' + trimNum(aq) : 'Add'; k('addk').textContent = t.long ? 'ALT B' : 'ALT S';
      const ag = R.querySelector('[data-a=addgo]'); ag.className = t.long ? 'L' : 'S'; ag.disabled = !aq || !!SHOT.busy || stale; ag.classList.toggle('busy', SHOT.busy === 'add');
      R.querySelector('[data-a=close2]').classList.toggle('busy', SHOT.busy === 'close');
    }
    R.querySelector('[data-a=close]').classList.toggle('busy', SHOT.busy === 'close');
    const old = SHOT.msgAt && Date.now() - SHOT.msgAt > 9000;
    const m = SHOT.msg && !old ? SHOT.msg : (!pos && !p.ok && !locked ? p.why : '');
    k('msg').textContent = m || ''; k('msg').className = 'msg ' + (SHOT.msg && !old ? SHOT.tone : '');
  }


  // ---------- chart: the plan and the open trade as lines you can grab ----------
  // Before a trade: drag the stop and the size follows (the dollars at risk stay); drag the target and the R follows.
  // In a trade: drag the stop, the target or a partial; × on a line removes it. If Vest already draws its own stop
  // and target lines, those are used (with the distance added to their labels) and nothing is drawn twice.
  const CHL = {}, HOLD = {}; let CHDOWN = false;
  function chartApi() { try { const f = document.querySelector('iframe[id^="tradingview_"]'); const a = f && f.contentWindow && f.contentWindow.tradingViewApi; return a ? a.activeChart() : null; } catch (e) { return null; } }
  function chLine(key, price, text, color, style, o) {
    const ch = chartApi(); if (!ch) return; o = o || {};
    let l = CHL[key];
    const set = (m, ...a) => { try { if (l && typeof l[m] === 'function') l[m](...a); } catch (e) {} };
    try {
      if (!l) {
        l = CHL[key] = ch.createOrderLine({ disableUndo: true }); l.__gpzOwn = 1; VL.delete(l);
        set('setExtendLeft', true); set('setLineLength', 22, 'percentage'); set('setLineWidth', 1);
        set('setBodyFont', '600 11px Inter, system-ui, sans-serif'); set('setQuantityFont', '700 11px Inter, system-ui, sans-serif');
        set('setBodyBackgroundColor', 'rgba(11,11,11,0.78)'); set('setBodyBorderColor', 'rgba(0,0,0,0)');
        set('setQuantityBackgroundColor', 'rgba(11,11,11,0.78)'); set('setQuantityBorderColor', 'rgba(0,0,0,0)');
        set('setCancelButtonBackgroundColor', 'rgba(11,11,11,0.78)'); set('setCancelButtonBorderColor', 'rgba(0,0,0,0)');
        const line = l, k0 = key;
        set('onMove', () => { let px = null; try { px = line.getPrice(); } catch (e) {} if (px == null || !isFinite(px) || !line.__gpzMove) return; HOLD[k0] = { px, until: Date.now() + 2500 }; line.__gpzMove(px); });
        set('onCancel', () => { if (line.__gpzCancel) line.__gpzCancel(); });
      }
      l.__gpzMove = o.move || null; l.__gpzCancel = o.cancel || null;
      set('setEditable', !!o.move); set('setCancellable', !!o.cancel); set('setCancelButtonIconColor', o.cancel ? color : 'rgba(0,0,0,0)');
      const h = HOLD[key]; if (h && Date.now() > h.until) delete HOLD[key];
      if (!CHDOWN) set('setPrice', HOLD[key] ? HOLD[key].px : price); // never fight a line that is being dragged
      set('setText', text); set('setQuantity', ''); set('setLineColor', color); set('setBodyTextColor', color); set('setQuantityTextColor', color); set('setLineStyle', style);
    } catch (e) { CHL[key] = null; }
  }
  function clearLines(keep) { for (const key in CHL) if (!keep || keep.indexOf(key) < 0) { try { CHL[key] && CHL[key].remove(); } catch (e) {} delete CHL[key]; delete HOLD[key]; } }
  function vestSuffix(m) { // returns how many of Vest's TP / SL labels now carry the distance
    let n = 0;
    VL.forEach(l => {
      if (l.__gpzOwn) return; const b = String(l.__gpzBase || ''); const tp = /^\s*TP\b|take profit/i.test(b), sl = /^\s*SL\b|stop loss/i.test(b);
      let suf = '';
      if ((tp || sl) && m != null) { let px = null; try { px = l.getPrice(); } catch (e) {} if (px != null && isFinite(px)) { suf = '   ' + pts(m - px) + ' pts'; n++; } }
      if (l.__gpzSuf !== suf) { l.__gpzSuf = suf; try { l.__gpzSetText.call(l, b + suf); } catch (e) {} }
    });
    return n;
  }
  const ROSE = 'rgba(232,152,140,0.7)', MINT = 'rgba(159,215,178,0.7)', GOLD = 'rgba(227,201,142,0.75)';
  function drawChart() {
    const ch0 = chartApi(); if (ch0) wrapChart(ch0);
    if (!SHOT.visible) { vestSuffix(null); return clearLines(); }
    const p = plan(); if (!p.sym || !ch0) return clearLines();
    const pos = myPos(p), m = L.mark[p.sym];
    if (pos && vestSuffix(m)) return clearLines(); // Vest's labels now read "TP +$107.36   199.2 pts"
    if (!pos) vestSuffix(null);
    if (pos) {
      const t = tradeOf(pos), keys = [], usd = v => fm(v, { sign: true });
      if (t.sl) { const px = +t.sl.triggerPrice, id = t.sl.id; chLine('psl', px, 'SL  ' + usd(t.at(px)) + (m ? '  ·  ' + pts(m - px) + ' pts' : ''), ROSE, 2, { move: v => moveLeg('sl', id, v) }); keys.push('psl'); }
      if (t.tp) { const px = +t.tp.triggerPrice, id = t.tp.id; chLine('ptp', px, 'TP  ' + usd(t.at(px)) + (m ? '  ·  ' + pts(px - m) + ' pts' : ''), MINT, 2, { move: v => moveLeg('tp', id, v), cancel: () => dropLeg(id) }); keys.push('ptp'); }
      t.scales.forEach(l => { const px = +l.triggerPrice, id = l.id, key = 'pl' + id, part = legFixed(l) ? Math.round(Math.abs(+l.quantity) / t.q * 100) + '%' : 'TP'; chLine(key, px, part + (m ? '  ·  ' + pts(px - m) + ' pts' : ''), GOLD, 2, { move: v => moveLeg('tp', id, v), cancel: () => dropLeg(id) }); keys.push(key); });
      return clearLines(keys);
    }
    if (!p.qty || !p.dSL) return clearLines();
    const side = SHOT.hover || SH.side || 'long', g = p[side];
    chLine('tp', g.tp, (SH.tmode === 'pass' ? 'PASS  +' : 'TP  +') + fm(p.reward) + '  ·  ' + pts(p.dTP) + ' pts', MINT, 2, { move: targetFromLine });
    chLine('sl', g.sl, 'SL  −' + fm(p.risk).replace('−', '') + '  ·  ' + pts(p.dSL) + ' pts', ROSE, 2, { move: sizeFromStop });
    chLine('en', p.px, (side === 'long' ? 'long ' : 'short ') + p.qtyS + '  ·  ' + p.lev + 'x', 'rgba(230,227,220,0.32)', 1);
    const keep = ['tp', 'sl', 'en'];
    if (p.passNeed > 0 && SH.tmode !== 'pass') { chLine('pass', g.pass, 'PASS  +' + fm(p.passNeed) + '  ·  ' + pts(p.dPass) + ' pts', 'rgba(227,201,142,0.6)', 2); keep.push('pass'); }
    clearLines(keep);
  }

  // =====================================================================================================
  // The copier: copies the leader account's positions to the followers you tick, by desired state.
  // Every pass compares what each follower should hold with what it holds, and fixes only the difference:
  // one order per follower and market at a time, never a blind retry, never touching a position it didn't open.
  // =====================================================================================================
  const C = Object.assign({ on: false, leader: null, followers: {}, mode: 'same', owned: {}, share: {}, opened: {}, pre: {}, log: [], err: {} }, DB.copier || {});
  const saveC = () => { DB.copier = C; save(); };
  const BUSY = {}, PENDING = {};
  const TAB = Math.random().toString(36).slice(2, 8);
  function ownCopier() { // one tab copies at a time; the others watch
    let cur = null; try { cur = JSON.parse(W.localStorage.getItem('gpz-copier') || 'null'); } catch (e) {}
    if (cur && cur.tab !== TAB && Date.now() - cur.at < 5000) { C.elsewhere = true; return false; }
    C.elsewhere = false; try { W.localStorage.setItem('gpz-copier', JSON.stringify({ tab: TAB, at: Date.now() })); } catch (e) {} return true;
  }
  function clog(msg, bad) { C.log.unshift({ t: Date.now(), msg, bad: !!bad }); C.log = C.log.slice(0, 40); saveC(); }
  function arm(on) {
    if (on) {
      const id = activeAcct(); if (!id) return shotMsg('pick the leader account on Vest first', 'bad');
      C.leader = id; delete C.followers[id]; C.pre = {}; L.pos.filter(p => accOf(p) === id).forEach(p => { C.pre[p.positionId] = 1; });
      C.on = true; C.err = {}; clog('copying ' + acctLabel(id) + ' → ' + Object.keys(C.followers).filter(f => C.followers[f]).length + ' accounts');
    } else { C.on = false; clog('copying off'); }
    saveC(); renderShot(); kickFast(50);
  }
  const live = legs => (legs || []).filter(l => l && l.triggerPrice != null && (!l.status || /await|pend|new|open|active/i.test(l.status)));
  function legsFor(legs, lq, fq, sym) {
    return live(legs).map(l => {
      const o = { executionType: l.executionType || 'market', triggerPrice: trimNum(l.triggerPrice) };
      if (l.limitPrice != null && l.limitPrice !== '') o.limitPrice = trimNum(l.limitPrice);
      if (l.sizeMode && /fix/i.test(l.sizeMode) && +l.quantity > 0) { const q = Math.abs(+l.quantity) * fq / lq; if (q * (L.mark[sym] || 0) < 1) return null; o.quantity = fmtQ(q, sym); }
      return o;
    }).filter(Boolean);
  }
  function sizeFor(f, lq, sym) {
    const lb = balOf(C.leader) || 0, fb = balOf(f) || 0; if (!(lb > 0) || !(fb > 0)) return 0;
    let q = C.mode === 'bal' ? lq * fb / lb : (fb < lb * 0.995 ? lq * fb / lb * 0.97 : lq); // same size, cut to fit a smaller account
    const px = L.mark[sym], lev = maxLev(sym, f) || 1, ff = L.bal[f] != null ? L.bal[f] : fb; if (px) q = Math.min(q, ff * lev * 0.99 / px); // never more than its free margin holds
    const d = dec(sym); return Math.floor(q * Math.pow(10, d) + 1e-7) / Math.pow(10, d);
  }
  async function copierSync() {
    if (!C.on || !C.leader) return;
    const lead = L.pos.filter(p => accOf(p) === C.leader && !C.pre[p.positionId]);
    const exits = [], rest = [];
    for (const f in C.followers) {
      if (!C.followers[f] || f === C.leader || L.bal[f] == null) continue;
      const mine = L.pos.filter(p => accOf(p) === f), syms = new Set(lead.map(p => p.symbol));
      mine.forEach(p => { if (C.owned[p.positionId]) syms.add(p.symbol); });
      for (const sym of syms) {
        const key = f + '|' + sym; if ((BUSY[key] || 0) > Date.now()) continue;
        const lp = lead.find(p => p.symbol === sym), fp = mine.find(p => p.symbol === sym);
        (lp ? rest : exits).push(() => stepPair(f, sym, lp, fp).catch(e => { C.err[f] = e.message; clog(acctLabel(f) + ': ' + e.message, true); }));
      }
    }
    await Promise.all(exits.map(j => j())); // exits go first
    await Promise.all(rest.map(j => j()));
  }
  async function stepPair(f, sym, lp, fp) {
    const key = f + '|' + sym, hold = ms => { BUSY[key] = Date.now() + ms; }, own = fp && C.owned[fp.positionId];
    if (!lp) { // the leader is out: close the copy we made
      if (fp && own) { hold(3000); await sendExit(f, '/v3/positions/close', { symbol: sym, positionId: fp.positionId, orderType: 'market', leverage: trimNum(fp.leverage || maxLev(sym, f)) }); clog('closed ' + shortSym(sym) + ' on ' + acctLabel(f)); delete C.owned[fp.positionId]; saveC(); }
      return;
    }
    const lq = Math.abs(+lp.quantity), okey = lp.positionId + '|' + f;
    if (!fp) {
      if (C.opened[okey]) return; // already copied this trade once (its own stop or target may have closed it): don't re-enter
      const want = sizeFor(f, lq, sym); if (!(want > 0)) { C.err[f] = 'too small to hold any ' + shortSym(sym); return; }
      hold(4000); C.opened[okey] = Date.now(); PENDING[key] = { at: Date.now(), lead: lp.positionId }; saveC();
      const lev = Math.min(+lp.leverage || 1e9, maxLev(sym, f) || 1e9);
      await ensureLev(f, sym, lev).catch(() => {});
      const r = await send(f, 'POST', '/v3/positions/open', { orderType: 'market', leverage: trimNum(lev), side: lp.side, symbol: sym, quantity: fmtQ(want, sym), timeInForce: 'IOC', takeProfits: legsFor(lp.takeProfits, lq, want, sym), stopLosses: legsFor(lp.stopLosses, lq, want, sym) });
      if (r.positionId) { C.owned[r.positionId] = { f, sym, lead: lp.positionId }; C.share[r.positionId] = want / lq; delete PENDING[key]; }
      C.err[f] = ''; clog((/^l/i.test(lp.side) ? 'long ' : 'short ') + fmtQ(want, sym) + ' ' + shortSym(sym) + ' on ' + acctLabel(f)); saveC();
      return;
    }
    if (!own) { // a copy that came back without an id is adopted; anything else on that market is the trader's, left alone
      const pd = PENDING[key];
      if (pd && Date.now() - pd.at < 20000 && pd.lead === lp.positionId) { C.owned[fp.positionId] = { f, sym, lead: lp.positionId }; C.share[fp.positionId] = Math.abs(+fp.quantity) / lq; delete PENDING[key]; saveC(); }
      else { C.err[f] = 'holds its own ' + shortSym(sym) + ' position: left alone'; return; }
    }
    if (String(fp.side).toLowerCase() !== String(lp.side).toLowerCase()) { hold(3000); await sendExit(f, '/v3/positions/close', { symbol: sym, positionId: fp.positionId, orderType: 'market', leverage: trimNum(fp.leverage) }); delete C.owned[fp.positionId]; delete C.opened[okey]; saveC(); return; }
    // size: hold the same share of the leader as when it was copied
    const share = C.share[fp.positionId] || Math.abs(+fp.quantity) / lq, d = dec(sym), step = Math.pow(10, -d);
    const want = Math.floor(lq * share * Math.pow(10, d) + 1e-7) / Math.pow(10, d), have = Math.abs(+fp.quantity), diff = want - have;
    if (Math.abs(diff) >= step && Math.abs(diff) / Math.max(want, have) > 0.015) {
      hold(3000);
      if (diff > 0) await send(f, 'POST', '/v3/positions/append', { symbol: sym, positionId: fp.positionId, orderType: 'market', quantity: fmtQ(diff, sym), leverage: trimNum(fp.leverage), isBuy: /^l/i.test(fp.side), timeInForce: 'IOC' });
      else await sendExit(f, '/v3/positions/reduce', { symbol: sym, positionId: fp.positionId, orderType: 'market', leverage: trimNum(fp.leverage), quantity: fmtQ(-diff, sym), timeInForce: 'IOC', reduceOnly: true });
      clog((diff > 0 ? 'added ' : 'reduced ') + fmtQ(Math.abs(diff), sym) + ' ' + shortSym(sym) + ' on ' + acctLabel(f));
      return;
    }
    // stop and targets: match the leader's, paired by kind and price order
    const tick = tickOf(sym), byPx = (a, b) => +a.triggerPrice - +b.triggerPrice;
    for (const [kind, path, idk] of [['takeProfits', 'take-profit', 'takeProfitId'], ['stopLosses', 'stop-loss', 'stopLossId']]) {
      const A = live(lp[kind]).sort(byPx), B = live(fp[kind]).sort(byPx);
      for (let i = 0; i < Math.max(A.length, B.length); i++) {
        const a = A[i], b = B[i];
        if (a && b && Math.abs(+a.triggerPrice - +b.triggerPrice) > tick / 2) { hold(2500); await send(f, 'PUT', '/v3/positions/' + path, { positionId: fp.positionId, executionType: a.executionType || 'market', triggerPrice: trimNum(a.triggerPrice), [idk]: b.id }); clog('moved ' + (kind === 'stopLosses' ? 'stop' : 'target') + ' to ' + fmtPx(a.triggerPrice, sym) + ' on ' + acctLabel(f)); }
        else if (a && !b) { const leg = legsFor([a], lq, have, sym)[0]; if (leg) { hold(2500); await send(f, 'POST', '/v3/positions/' + path, { positionId: fp.positionId, ...leg }); clog('added ' + (kind === 'stopLosses' ? 'stop' : 'target') + ' on ' + acctLabel(f)); } }
        else if (!a && b) { hold(2500); await send(f, 'DELETE', '/v3/positions/' + path, { positionId: fp.positionId, [idk]: b.id }); clog('removed ' + (kind === 'stopLosses' ? 'stop' : 'target') + ' on ' + acctLabel(f)); }
      }
    }
    if (C.err[f] && !/left alone|too small/.test(C.err[f])) C.err[f] = '';
  }
  const copyLeader = () => C.on ? C.leader : activeAcct();
  // switch Vest's active account the way a person would: its account menu, then the row with that name
  let switching = 0;
  async function switchAcct(id) {
    if (switching) return; const nm = acctShort(id), trig = document.querySelector('[data-testid=account-selector-trigger]');
    if (!trig) return deskSay('switch on Vest\'s account menu', true), renderDesk();
    switching = 1;
    try {
      const press = el => { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' })); el.click(); };
      if (trig.getAttribute('aria-expanded') !== 'true') press(trig);
      let item = null;
      for (let i = 0; i < 20 && !item; i++) { await new Promise(r => setTimeout(r, 60)); item = [...document.querySelectorAll('[role=menuitem]')].find(e => e.innerText.split('\n').map(t => t.trim()).includes(nm)); }
      if (!item) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); deskSay(nm + ' is not in Vest\'s menu', true); }
      else { item.click(); deskSay('On ' + nm); }
    } finally { switching = 0; }
    renderDesk(); kickFast(300);
  }
  function renderCopy() { // the chip on the ticket: desk, or how many it copies to
    if (!SP) return; const { R, k } = SP, n = Object.keys(C.followers).filter(f => C.followers[f]).length;
    R.querySelector('[data-a=copy]').classList.toggle('armed', !!C.on); R.querySelector('[data-a=copy]').classList.toggle('on', !!DK.open);
    k('cp').textContent = C.on ? 'copying ' + n : 'desk';
    if (DS && DK.open) renderDesk();
  }
  // ---------- GP. Desk: every account's open and today PnL, closed whole or in part with one click ----------
  // Docks under the ticket (over Vest's Account Health card); drag it out to float, double-click its header to dock it back.
  // A cut on a copy follower moves its share down first, so the copier keeps the smaller size instead of topping it back up.
  // A cut on the leader is mirrored by the copier on every follower.
  if (DB.deskV !== 2) { DB.desk = Object.assign({}, DB.desk, { open: true, side: true }); DB.deskV = 2; } // the desk loads open, at the chart's left
  const DK = Object.assign({ open: true, dock: true, side: true, all: false, tab: 'acc', x: null, y: null }, DB.desk || {});
  DK.busy = {}; DK.msg = ''; DK.tone = ''; DK.msgAt = 0;
  const saveDK = () => { DB.desk = { open: DK.open, dock: DK.dock, side: DK.side, all: DK.all, tab: DK.tab, x: DK.x, y: DK.y }; save(); };
  let DS = null;
  const DCSS = `:host{all:initial}
  *{box-sizing:border-box}
  .d{position:relative;display:flex;flex-direction:column;height:100%;background:#0b0b0b;border:1px solid rgba(238,234,226,.1);border-radius:14px;color:#f1f1f3;font:600 12px Inter,system-ui,sans-serif;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;overflow:hidden;box-shadow:0 30px 70px -30px rgba(0,0,0,.95);animation:in .3s cubic-bezier(.16,1,.3,1)}
  @keyframes in{from{opacity:0;transform:translateY(6px)}}
  .mw{position:absolute;inset:0;pointer-events:none;overflow:hidden}
  .moon{position:absolute;right:-70px;top:-90px;width:220px;height:220px;opacity:.45;animation:mb 11s ease-in-out infinite}
  @keyframes mb{0%,100%{transform:scale(1);opacity:.35}50%{transform:scale(1.04);opacity:.55}}
  @keyframes br{0%,100%{transform:scale(.62);opacity:.5}42%{transform:scale(1.06);opacity:1}}
  .d>*{position:relative;flex:none}
  .hd{display:flex;align-items:center;gap:6px;padding:10px 10px 0 14px;cursor:grab;user-select:none}.hd:active{cursor:grabbing}
  .dot{width:6px;height:6px;border-radius:50%;background:#e6e3dc;animation:br 7s ease-in-out infinite}
  .d.live .dot{background:#9fd7b2;animation-duration:3.5s}
  .hd b{font-size:10px;font-weight:600;letter-spacing:.24em;color:#9e9ea5;margin-left:2px}
  .sp{flex:1}
  .fx{position:relative;overflow:hidden;height:24px;padding:0 10px;border-radius:8px;border:1px solid rgba(232,152,140,.45);background:none;color:#efb1a7;font:600 11px Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;transition:all .2s}
  .fx:hover{background:#e8988c;border-color:#e8988c;color:#0b0b0b}.fx:active{transform:scale(.95)}
  .x{width:24px;height:24px;border-radius:50%;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:700 13px/1 Inter,system-ui,sans-serif;cursor:pointer}.x:hover{color:#f1f1f3;border-color:rgba(238,234,226,.4)}
  .top{display:flex;align-items:baseline;gap:12px;padding:6px 14px 8px;border-bottom:1px solid rgba(238,234,226,.08)}
  .top .o{font-size:26px;font-weight:600;letter-spacing:-.06em;line-height:1;white-space:nowrap}
  .top .t{margin-left:auto;text-align:right;font-size:13px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
  .top small{font-size:9.5px;font-weight:700;letter-spacing:.16em;color:#5f5f66;margin-right:6px}
  .up{color:#bfe6cb}.dn{color:#efb1a7}.flat{color:#e6e3dc}.dim{color:#4a4a4f}
  .rows{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-width:none}
  .rows::-webkit-scrollbar{display:none}
  .r{display:grid;grid-template-columns:minmax(0,1fr) 62px 62px 82px;align-items:center;gap:6px;height:32px;padding:0 8px 0 14px;border-bottom:1px solid rgba(238,234,226,.05)}
  .r:hover{background:rgba(238,234,226,.03)}
  .x.sd{font-size:12px}.d.side .x.sd{background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b}
  .d.side{border-radius:14px}.d.side .hd{cursor:default}
  .d.side .rh{display:none}
  .d.side .r{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"nm ac" "vo vt";height:auto;row-gap:5px;padding:10px 10px 10px 14px}
  .d.side .nm{grid-area:nm}.d.side .ac{grid-area:ac}.d.side .vo{grid-area:vo;text-align:left}.d.side .vt{grid-area:vt}
  .d.side .vo:before,.d.side .vt:before{font-size:8.5px;font-weight:700;letter-spacing:.16em;color:#5f5f66;margin-right:6px}.d.side .vo:before{content:"OPEN"}.d.side .vt:before{content:"TODAY"}
  .tb{display:flex;gap:2px;padding:2px;border-radius:8px;background:#111111;border:1px solid rgba(238,234,226,.06)}
  .tb button{height:22px;padding:0 9px;border:0;border-radius:6px;background:none;color:#8b8b92;font:600 10.5px Inter,system-ui,sans-serif;letter-spacing:.02em;cursor:pointer}.tb button:hover{color:#f1f1f3}
  .tb button.on{background:#e6e3dc;color:#0b0b0b}
  .d.acc [data-a=flat],.d.acc .rh:not(.ra),.d.pnl .rh.ra,.d.pnl .cpy{display:none}
  .cpy{display:flex;align-items:center;gap:8px;padding:8px 12px 8px 14px;border-bottom:1px solid rgba(238,234,226,.06)}
  .cpy>b{font-size:9.5px;font-weight:600;letter-spacing:.2em;color:#8b8b92}
  .sw{position:relative;flex:none;width:30px;height:17px;border-radius:99px;border:1px solid rgba(238,234,226,.2);background:#151515;cursor:pointer;transition:background .2s,border-color .2s}
  .sw:after{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#8b8b92;transition:transform .2s cubic-bezier(.34,1.2,.64,1),background .2s}
  .sw.on{background:#14231b;border-color:rgba(159,215,178,.6)}.sw.on:after{transform:translateX(13px);background:#9fd7b2}
  .cm{display:flex;gap:2px}.cm button{height:20px;padding:0 7px;white-space:nowrap;border-radius:6px;border:1px solid rgba(238,234,226,.1);background:none;color:#8b8b92;font:600 10px Inter,system-ui,sans-serif;cursor:pointer}.cm button.on{color:#f1f1f3;border-color:rgba(238,234,226,.35)}
  .ld{margin-left:auto;font-size:10.5px;color:#6f6f75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.ld b{color:#c9c7c2;font-weight:600}
  .r.a{grid-template-columns:minmax(0,1fr) 66px 62px 34px;cursor:pointer}
  .r.a.cur{background:rgba(238,234,226,.045)}.r.a.cur .nm b:before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:#e6e3dc;margin-right:6px;vertical-align:2px}
  .r.a .v.b{color:#c9c7c2}
  .fo{justify-self:end;width:18px;height:18px;border-radius:5px;border:1px solid rgba(238,234,226,.22);background:none;cursor:pointer;display:grid;place-items:center;padding:0;color:#0b0b0b;font:700 11px/1 Inter,system-ui,sans-serif}
  .fo.on{background:#9fd7b2;border-color:#9fd7b2}.fo.on:after{content:"✓"}.fo:hover{border-color:rgba(238,234,226,.5)}
  .fo.lead{width:auto;padding:0 5px;border:0;background:#e6e3dc;font-size:8px;letter-spacing:.12em;cursor:default}
  .r .er{display:block;font-style:normal;font-size:9.5px;color:#efb1a7;overflow:hidden;text-overflow:ellipsis}
  .d.side .r.a{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"nm fo" "vb vt";height:auto;row-gap:4px;padding:9px 10px 9px 14px}
  .d.side .r.a .nm{grid-area:nm}.d.side .r.a .fo{grid-area:fo}.d.side .r.a .vb{grid-area:vb;text-align:left}.d.side .r.a .vt{grid-area:vt}
  .d.side .rh.ra{display:none}
  .rh{display:grid;grid-template-columns:minmax(0,1fr) 62px 62px 82px;align-items:center;gap:6px;height:22px;padding:0 8px 0 14px}.rh .v{font-size:9px;font-weight:700;letter-spacing:.16em;color:#5f5f66}
  .nm{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}
  .nm b{font-size:12.5px;font-weight:600;letter-spacing:-.02em}
  .nm em{font-style:normal;font-size:10.5px;font-weight:600;color:#6f6f75;overflow:hidden;text-overflow:ellipsis}
  .tg{flex:none;font-size:8px;font-weight:600;letter-spacing:.14em;padding:2px 5px;border-radius:6px}
  .tg.lead{background:#e6e3dc;color:#0b0b0b}.tg.copy{border:1px solid rgba(159,215,178,.5);color:#9fd7b2}
  .v{text-align:right;font-size:12px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
  .ac{display:flex;gap:3px;justify-content:flex-end}
  .k{position:relative;overflow:hidden;width:25px;height:22px;padding:0;border-radius:7px;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:600 10px Inter,system-ui,sans-serif;cursor:pointer;transition:all .2s}
  .k:hover{color:#f1f1f3;border-color:rgba(238,234,226,.45)}.k:active{transform:scale(.92)}
  .k.cl{color:#efb1a7;border-color:rgba(232,152,140,.4);font-size:12px}.k.cl:hover{background:#e8988c;border-color:#e8988c;color:#0b0b0b}
  .k[disabled],.fx[disabled]{opacity:.2;pointer-events:none}
  .busy:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:sweep 1s linear infinite}
  @keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
  .ft{display:flex;align-items:center;gap:8px;height:28px;padding:0 12px 0 14px;font-size:10.5px;font-weight:600;color:#6f6f75;border-top:1px solid rgba(238,234,226,.05)}
  .ft .m{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.ft .m.ok{color:#9fd7b2}.ft .m.bad{color:#efb1a7}
  .ft button{border:0;background:none;padding:0;color:#9e9ea5;font:600 10.5px Inter,system-ui,sans-serif;cursor:pointer}.ft button:hover{color:#f1f1f3}
  .none{padding:12px 14px;font-size:11px;color:#5f5f66}
  @media (prefers-reduced-motion:reduce){.dot,.moon,.d{animation:none}}`;
  function deskHost() {
    if (DS) return DS;
    const host = document.createElement('div'); host.id = 'gpz-desk'; host.style.cssText = 'position:fixed;z-index:2147483638;display:none';
    ['keydown', 'keyup', 'keypress'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    const R = host.attachShadow({ mode: 'open' });
    R.innerHTML = `<style>${DCSS}</style><div class="d">
      <div class="mw"><canvas class="moon" width="440" height="440"></canvas></div>
      <div class="hd" data-a="drag"><i class="dot"></i><div class="tb"><button data-t="acc">Accounts</button><button data-t="pnl">PnL</button></div><div class="sp"></div><button class="fx" data-a="flat"><span data-k="fx">flatten</span></button><button class="x sd" data-a="side" aria-label="Beside the chart" title="Beside the chart">⇤</button><button class="x" data-a="x" aria-label="Close desk">×</button></div>
      <div class="top"><span class="o" data-k="open">—</span><span class="t"><small>TODAY</small><span data-k="today">—</span></span></div>
      <div class="cpy" data-k="cpy"><b>COPY</b><button class="sw" data-a="arm" aria-label="Copy on or off"></button><div class="cm"><button data-cm="same">same</button><button data-cm="bal">by bal</button></div><span class="ld" data-k="ld"></span></div>
      <div class="rh"><span></span><span class="v">OPEN</span><span class="v">TODAY</span><span></span></div>
      <div class="rh ra"><span></span><span class="v">BALANCE</span><span class="v">TODAY</span><span class="v">COPY</span></div>
      <div class="rows" data-k="rows"></div>
      <div class="ft"><span class="m" data-k="m"></span><button data-a="all" data-k="all"></button></div>
    </div>`;
    document.documentElement.appendChild(host);
    moon(R.querySelector('.moon').getContext('2d'), 440, 440, 220, 220, 200, 9, 1);
    const k = n => R.querySelector(`[data-k="${n}"]`);
    R.querySelector('[data-a=x]').onclick = () => deskToggle(false);
    R.querySelector('[data-a=flat]').onclick = () => deskFlatten();
    R.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { DK.tab = b.dataset.t; saveDK(); renderDesk(); });
    R.querySelector('[data-a=arm]').onclick = () => arm(!C.on);
    R.querySelectorAll('[data-cm]').forEach(b => b.onclick = () => { C.mode = b.dataset.cm; saveC(); renderDesk(); });
    R.querySelector('[data-a=side]').onclick = () => { DK.side = !DK.side; saveDK(); renderDesk(); layoutCols(); placeShot(); placeDesk(); };
    R.querySelector('[data-a=all]').onclick = () => { DK.all = !DK.all; saveDK(); renderDesk(); placeDesk(); };
    k('rows').onclick = e => {
      const b = e.target.closest('[data-cut]'); if (b) return deskCut(b.closest('.r').dataset.id, +b.dataset.cut);
      const f = e.target.closest('[data-fo]'); if (f) { const id = f.dataset.fo; if (id === copyLeader()) return; C.followers[id] = !C.followers[id]; if (!C.followers[id]) delete C.followers[id]; saveC(); renderDesk(); if (SP) renderShot(); kickFast(); return; }
      const r = e.target.closest('.r.a'); if (r && !r.classList.contains('cur')) switchAcct(r.dataset.id);
    };
    const hd = R.querySelector('[data-a=drag]');
    hd.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || DK.side) return; e.preventDefault();
      const r = host.getBoundingClientRect(), ox = e.clientX - r.left, oy = e.clientY - r.top;
      const mv = ev => { DK.dock = false; DK.x = Math.max(0, Math.min(innerWidth - r.width, ev.clientX - ox)); DK.y = Math.max(0, Math.min(innerHeight - 80, ev.clientY - oy)); placeDesk(); };
      const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); saveDK(); };
      addEventListener('pointermove', mv); addEventListener('pointerup', up);
    });
    hd.addEventListener('dblclick', () => { if (DK.side) return; DK.dock = true; saveDK(); placeDesk(); });
    DS = { host, R, k };
    return DS;
  }
  // under the ticket when there is room for it, else floating at the size of its rows
  // side mode: the chart column steps right and the desk takes the room at its left, full height
  const DESKW = 300;
  function chartCol() {
    const fr = document.querySelector('iframe[id^=tradingview_]'), col = IS_TRADE() && fr ? orderCol() : null;
    const ch = col ? [...col.parentElement.children].find(e => e.contains(fr)) : null;
    document.querySelectorAll('[data-gpz-chartcol]').forEach(e => { if (e !== ch || !DK.open) e.removeAttribute('data-gpz-chartcol'); });
    if (!ch || !DK.open) return null;
    if (!document.getElementById('gpz-chartcol-css')) { const st = document.createElement('style'); st.id = 'gpz-chartcol-css'; st.textContent = '[data-gpz-chartcol]{margin-left:' + DESKW + 'px!important}'; document.documentElement.appendChild(st); }
    ch.setAttribute('data-gpz-chartcol', ''); return ch;
  }
  function placeDesk() {
    if (!DS) return; const st = DS.host.style;
    if (!DK.open) { st.display = 'none'; chartCol(); return; }
    st.display = '';
    if (!DK.side) document.querySelectorAll('[data-gpz-chartcol]').forEach(e => e.removeAttribute('data-gpz-chartcol'));
    const q = c => DS.R.querySelector(c), hh = [...DS.R.querySelectorAll('.rh,.cpy')].reduce((a, e) => a + e.offsetHeight, 0), want = q('.hd').offsetHeight + q('.top').offsetHeight + hh + q('.rows').scrollHeight + q('.ft').offsetHeight + 2;
    const t = SP && SP.host.style.display !== 'none' ? SP.host.getBoundingClientRect() : null;
    let x, y, w, h; const ch = DK.side ? chartCol() : null;
    DS.R.querySelector('.d').classList.toggle('side', !!ch);
    if (ch) { const r = ch.getBoundingClientRect(); x = r.left - DESKW; y = r.top; w = DESKW - 12; h = Math.min(r.height, innerHeight - y - 8); }
    else if (DK.dock && t && t.width > 200 && innerHeight - t.bottom - 16 >= 130) { x = t.left; y = t.bottom + 8; w = t.width; h = Math.min(want, innerHeight - y - 8); }
    else { w = 340; h = Math.min(want, innerHeight - 24); x = DK.x != null ? DK.x : t ? t.left - w - 10 : innerWidth - w - 16; y = DK.y != null ? DK.y : t ? t.top : 72; x = Math.max(0, Math.min(innerWidth - w, x)); y = Math.max(0, Math.min(innerHeight - h, y)); }
    st.left = Math.round(x) + 'px'; st.top = Math.round(y) + 'px'; st.width = Math.round(w) + 'px'; st.height = Math.round(h) + 'px';
  }
  function deskToggle(v) {
    DK.open = v == null ? !DK.open : !!v; saveDK(); deskHost();
    if (DK.open) { renderDesk(); kickFast(0); }
    placeDesk(); if (SP) renderShot();
  }
  function deskRows() {
    if (!L.cap) return [];
    const d0 = vestDay(), key = String(d0); if (!DB.dayBase[key]) DB.dayBase = { [key]: {} };
    const out = [];
    L.cap.filter(c => c.status === 2 && L.bal[c.id] != null).forEach(c => {
      const ps = L.pos.filter(p => accOf(p) === c.id); let u = 0;
      ps.forEach(p => { const m = L.mark[p.symbol], q = Math.abs(+p.quantity), dir = /^s/i.test(p.side || '') ? -1 : 1; if (m) u += (m - +p.openPrice) * q * dir; });
      const cash = cashOf(c.id), eq = cash + u;
      let base = +c.daily_reset_equity;
      if (!(c.daily_reset_at >= d0 - 3 * 36e5) || !isFinite(base)) { const b = DB.dayBase[key]; if (b[c.id] == null) { b[c.id] = eq; save(); } base = b[c.id]; }
      const role = C.leader === c.id && (C.on || Object.keys(C.followers).some(f => C.followers[f])) ? 'lead' : C.followers[c.id] ? 'copy' : '';
      out.push({ id: c.id, role, bal: cash, u, today: eq - base, n: ps.length, kind: c.account_type === 3 ? (/instant/i.test(c.plan_product_type || '') ? 'Instant' : 'Funded') : 'Eval' });
    });
    const rk = r => r.role === 'lead' ? 0 : r.role === 'copy' ? 1 : 2;
    return out.sort((a, b) => rk(a) - rk(b) || (b.n > 0) - (a.n > 0) || b.u - a.u);
  }
  W.__gpzDesk = () => deskRows().map(r => ({ id: r.id, role: r.role, u: +r.u.toFixed(2), today: +r.today.toFixed(2), n: r.n }));
  const tone = v => Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'dn';
  function renderDesk() {
    if (!DK.open || !DS) return; const { R, k } = DS;
    const rows = deskRows(), live = rows.filter(r => r.n), shown = DK.all ? rows : rows.filter(r => r.n || r.role);
    const U = live.reduce((a, r) => a + r.u, 0), T = rows.reduce((a, r) => a + r.today, 0), npos = live.reduce((a, r) => a + r.n, 0);
    R.querySelector('.d').classList.toggle('live', live.length > 0); R.querySelector('[data-a=side]').textContent = DK.side ? '⇥' : '⇤';
    const o = k('open'); o.textContent = live.length ? fm(U, { sign: true }) : '$0'; o.className = 'o ' + (live.length ? tone(U) : 'dim');
    const t = k('today'); t.textContent = fm(T, { sign: true }); t.className = tone(T);
    const fx = R.querySelector('[data-a=flat]'); fx.disabled = !npos || !!DK.busy.all; fx.classList.toggle('busy', !!DK.busy.all); k('fx').textContent = npos ? 'flatten · ' + npos : 'flatten';
    const tab = DK.tab === 'pnl' ? 'pnl' : 'acc', d = R.querySelector('.d'); d.classList.toggle('acc', tab === 'acc'); d.classList.toggle('pnl', tab === 'pnl');
    R.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    R.querySelector('[data-a=arm]').classList.toggle('on', !!C.on);
    R.querySelectorAll('[data-cm]').forEach(b => b.classList.toggle('on', b.dataset.cm === C.mode));
    const cur = activeAcct(), lead = copyLeader();
    k('ld').innerHTML = C.elsewhere ? 'on in another tab' : lead ? (C.on ? 'from ' : 'leader ') + '<b>' + acctShort(lead) + '</b>' : '';
    const accHtml = () => rows.map(r => {
      const isL = r.id === lead, on = !!C.followers[r.id], e = on && C.err[r.id];
      return `<div class="r a${r.id === cur ? ' cur' : ''}" data-id="${r.id}"><div class="nm"><b>${acctShort(r.id).replace(/^Account /, '')}</b><em>${r.kind}${e ? '' : ''}</em>${e ? `<i class="er">${e}</i>` : ''}</div>
        <div class="v vb b">${fk(r.bal)}</div>
        <div class="v vt ${tone(r.today)}">${fm(r.today, { sign: true })}</div>
        ${isL ? '<span class="fo lead" title="Leader">LEAD</span>' : `<button class="fo${on ? ' on' : ''}" data-fo="${r.id}" title="${on ? 'Stop copying to it' : 'Copy to it'}"></button>`}</div>`;
    }).join('');
    const html = tab === 'acc' ? accHtml() : shown.map(r => {
      const b = DK.busy[r.id] || DK.busy.all, dis = !r.n || b ? ' disabled' : '';
      const btn = (p, lbl, cls) => `<button class="k${cls || ''}${DK.busy[r.id] === p ? ' busy' : ''}" data-cut="${p}" title="${p >= 100 ? 'Close' : 'Cut ' + p + '%'}"${dis}>${lbl}</button>`;
      return `<div class="r" data-id="${r.id}"><div class="nm"><b>${acctShort(r.id).replace(/^Account /, '')}</b>${r.role ? `<i class="tg ${r.role}">${r.role === 'lead' ? 'LEAD' : 'COPY'}</i>` : `<em>${r.kind}</em>`}</div>
        <div class="v vo ${r.n ? tone(r.u) : 'dim'}">${r.n ? fm(r.u, { sign: true }) : '—'}</div>
        <div class="v vt ${tone(r.today)}">${fm(r.today, { sign: true })}</div>
        <div class="ac">${btn(25, '25')}${btn(50, '50')}${btn(100, '×', ' cl')}</div></div>`;
    }).join('');
    if (k('rows').innerHTML !== html) k('rows').innerHTML = html || '<div class="none">' + (tab === 'acc' ? 'reading your accounts' : 'nothing open') + '</div>';
    const fresh = DK.msg && Date.now() - DK.msgAt < 9000, n = Object.keys(C.followers).filter(f => C.followers[f]).length;
    const lg = C.log[0], lgFresh = lg && Date.now() - lg.t < 60000;
    const m = k('m'); m.textContent = fresh ? DK.msg : tab === 'acc' && lgFresh ? lg.msg : C.on ? 'copying ' + n : live.length + ' of ' + rows.length + ' in trade'; m.className = 'm ' + (fresh ? DK.tone : tab === 'acc' && lgFresh && lg.bad ? 'bad' : '');
    k('all').textContent = tab === 'acc' ? '' : DK.all ? 'less' : rows.length > shown.length ? 'all ' + rows.length : '';
    placeDesk();
  }
  async function cutOne(id, p, pct) {
    const sym = p.symbol, lev = trimNum(p.leverage || maxLev(sym, id) || 1);
    BUSY[id + '|' + sym] = Date.now() + 5000; // the copier keeps its hands off this market while the cut lands
    if (pct >= 100) { await sendExit(id, '/v3/positions/close', { symbol: sym, positionId: p.positionId, orderType: 'market', leverage: lev }); delete C.owned[p.positionId]; return; }
    const qs = fmtQ(Math.abs(+p.quantity) * pct / 100, sym); if (!(+qs > 0)) throw new Error('too small to cut ' + shortSym(sym));
    const sh = C.share[p.positionId]; if (sh) C.share[p.positionId] = sh * (1 - pct / 100);
    try { await sendExit(id, '/v3/positions/reduce', { symbol: sym, positionId: p.positionId, orderType: 'market', leverage: lev, quantity: qs, timeInForce: 'IOC', reduceOnly: true }); }
    catch (e) { if (sh) C.share[p.positionId] = sh; throw e; }
  }
  const deskSay = (m, bad) => { DK.msg = m; DK.tone = bad ? 'bad' : 'ok'; DK.msgAt = Date.now(); };
  // one click: every position on that account, closed or cut by the same share
  async function deskCut(id, pct) {
    if (DK.busy[id] || DK.busy.all) return;
    const ps = L.pos.filter(p => accOf(p) === id); if (!ps.length) return;
    DK.busy[id] = pct; renderDesk();
    const res = await Promise.allSettled(ps.map(p => cutOne(id, p, pct)));
    saveC(); delete DK.busy[id];
    const bad = res.filter(r => r.status === 'rejected'), nm = acctShort(id);
    deskSay(bad.length ? bad[0].reason.message : (pct >= 100 ? 'Closed ' : 'Cut ' + pct + '% · ') + nm, bad.length);
    clog('desk ' + (pct >= 100 ? 'closed ' : 'cut ' + pct + '% on ') + nm, !!bad.length);
    renderDesk(); kickFast(150);
  }
  // one click: every position on every account, closed at market
  async function deskFlatten() {
    if (DK.busy.all) return; const ps = L.pos.slice(); if (!ps.length) return;
    DK.busy.all = 1; renderDesk();
    const res = await Promise.allSettled(ps.map(p => cutOne(accOf(p), p, 100)));
    saveC(); delete DK.busy.all;
    const bad = res.filter(r => r.status === 'rejected');
    deskSay(bad.length ? bad.length + ' failed · ' + bad[0].reason.message : 'Flat · ' + ps.length + ' closed', bad.length);
    clog('desk flattened ' + (ps.length - bad.length) + '/' + ps.length, !!bad.length);
    renderDesk(); kickFast(150);
  }

  // hot keys: Alt+B long, Alt+S short, Alt+X close. One press is one order: a held key does
  // nothing more. Off while typing in any box and while the Pulse panel is open; they work with the chart focused.
  function hotkey(e) {
    if (!e.altKey || e.ctrlKey || e.metaKey || !SHOT.visible || OPEN || !/^Key[BSX]$/.test(e.code)) return;
    const t = (e.composedPath && e.composedPath()[0]) || e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    if (e.shiftKey) return;
    e.preventDefault(); if (e.repeat) return;
    const ap = SHOT.adding && curPos();
    if (ap && e.code !== 'KeyX') { if ((e.code === 'KeyB') === /^l/i.test(ap.side)) addMore(); else shotMsg('this trade is ' + (/^l/i.test(ap.side) ? 'long' : 'short'), 'bad'); return; }
    if (e.code === 'KeyB') fire('long'); else if (e.code === 'KeyS') fire('short'); else closeMine();
  }
  document.addEventListener('keydown', hotkey, true);
  function hookFrame(f) { // the chart is its own page: keys pressed there never reach Vest's page, so they are heard there too
    try { const d = f.contentDocument; if (!d || d.__gpzKeys) return; d.__gpzKeys = 1; d.addEventListener('keydown', hotkey, true);
      d.addEventListener('pointerdown', () => { CHDOWN = true; }, true); ['pointerup', 'pointercancel'].forEach(t => d.addEventListener(t, () => { CHDOWN = false; }, true)); } catch (e) {}
  }
  if (DK.open) setTimeout(() => deskToggle(true), 1200);
  let lastPath = location.pathname;
  setInterval(() => { if (location.pathname !== lastPath) { lastPath = location.pathname; clearLines(); kickFast(); } layoutCols(); bookFold(); placeShot(); placeDesk(); document.querySelectorAll('iframe[id^="tradingview_"]').forEach(hookFrame); }, 400);

  // =====================================================================================================
  // Massive skin for all of Vest: its dark theme runs on CSS variables, so one stylesheet recolours the page;
  // the chart is repainted through TradingView's own overrides. Looks only — nothing is sent to Vest.
  // =====================================================================================================
  const MS = { bg: '#0b0b0b', card: '#0f0f0f', card2: '#131313', input: '#111111', s1: '#171717', hover: '#1c1c1c', active: '#232323',
    line: 'rgba(238,234,226,0.08)', line2: 'rgba(238,234,226,0.05)', text: '#eeeae2', muted: '#9e9ea5', dim: '#6f6f75',
    cream: '#e6e3dc', mint: '#9fd7b2', mintHi: '#bfe6cb', rose: '#e8988c', roseHi: '#efb1a7', gold: '#e3c98e', up: '#dedbd3', down: '#4b4b51' };
  function skinCss() {
    const T = MS;
    return `html.gpz-skin.dark, html.gpz-skin .dark {
      --background: ${T.bg}; --foreground: ${T.text}; --foreground-secondary: ${T.muted}; --contrast: #ffffff;
      --card: ${T.card}; --card-foreground: ${T.text}; --card-elevated: ${T.card2};
      --popover: ${T.card}; --popover-foreground: ${T.text};
      --primary: ${T.cream}; --primary-foreground: ${T.bg}; --primary-light: rgba(230,227,220,0.08);
      --secondary: ${T.s1}; --secondary-foreground: ${T.text}; --accent: ${T.s1}; --accent-foreground: ${T.text};
      --muted: ${T.s1}; --muted-foreground: ${T.muted};
      --surface: ${T.s1}; --surface-foreground: ${T.text}; --surface-muted: ${T.dim}; --surface-hover: ${T.hover}; --surface-active: ${T.active}; --surface-elevated: ${T.card}; --surface-overlay: ${T.text};
      --input: ${T.input}; --ring: rgba(238,234,226,0.35); --border: ${T.line}; --border-muted: ${T.line2};
      --long: ${T.mintHi}; --long-foreground: ${T.bg}; --long-muted: rgba(159,215,178,0.13);
      --short: ${T.roseHi}; --short-foreground: ${T.bg}; --short-muted: rgba(232,152,140,0.13);
      --destructive: ${T.rose}; --destructive-foreground: ${T.bg};
      --warning: ${T.gold}; --info: #b4bfd2; --highlight: ${T.cream}; --yellow: ${T.gold}; --platinum-foreground: #cfcfd4;
      --chart-1: ${T.text}; --chart-2: ${T.mint}; --chart-3: ${T.gold}; --chart-4: ${T.muted}; --chart-5: ${T.rose};
      --instant-card-base: ${T.bg}; --instant-card-mid: ${T.card}; --instant-card-highlight: ${T.s1}; --instant-card-glow: rgba(230,227,220,0.08);
      --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif; --font-mono: "Inter", ui-monospace, monospace;
      --radius: .625rem; --radius-sm: .5rem; --radius-md: .625rem; --radius-lg: .875rem; --radius-xl: 1.125rem; --radius-2xl: 1.375rem; --radius-3xl: 1.75rem;
    }
    html.gpz-skin.dark body { background: ${T.bg}; font-family: "Inter", ui-sans-serif, system-ui, sans-serif; font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased; letter-spacing: -0.011em; }
    html.gpz-skin.dark ::selection { background: rgba(230,227,220,0.22); }
    html.gpz-skin.dark ::-webkit-scrollbar { width: 8px; height: 8px; } html.gpz-skin.dark ::-webkit-scrollbar-thumb { background: rgba(238,234,226,0.1); border-radius: 99px; } html.gpz-skin.dark ::-webkit-scrollbar-track { background: transparent; }
    html.gpz-skin.dark .bg-long.text-white, html.gpz-skin.dark .bg-short.text-white { color: ${T.bg}; }`;
  }
  // Vest draws its own chart lines (orders, stops, targets, positions, fail price) in fixed greens and reds with
  // white text. In the skin each part gets its own tone so everything stays readable: lines and edges a muted
  // mid-tone, fills a dark tint, text a soft light tint. Greys and whites pass through.
  const TONES = { g: { line: '#5f9e78', fill: '#14231b', text: '#bfe6cb' }, r: { line: '#c46f63', fill: '#2a1715', text: '#efb1a7' } };
  function hueOf(c) {
    if (typeof c !== 'string') return null; let r, g, b, a = '';
    const m = c.trim().match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (m) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); a = m[2] || ''; }
    else { const k = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)/i); if (!k) return null; r = +k[1]; g = +k[2]; b = +k[3]; if (k[4] != null) a = Math.round(Math.min(1, +k[4]) * 255).toString(16).padStart(2, '0'); }
    if (Math.max(r, g, b) - Math.min(r, g, b) < 60) return null;
    return { t: g > r && g >= b ? 'g' : r > g && r > b ? 'r' : null, a };
  }
  function skinColor(c, role) { const h = hueOf(c); if (!h || !h.t) return c; return TONES[h.t][role] + (role === 'fill' ? '' : h.a); }
  const ROLE = m => /Background/.test(m) ? 'fill' : /Text/.test(m) ? 'text' : 'line';
  const LINE_SETTERS = ['setLineColor', 'setBodyBorderColor', 'setBodyTextColor', 'setBodyBackgroundColor', 'setQuantityBorderColor', 'setQuantityBackgroundColor', 'setQuantityTextColor', 'setCancelButtonBorderColor', 'setCancelButtonBackgroundColor', 'setCancelButtonIconColor', 'setReverseButtonBorderColor', 'setReverseButtonBackgroundColor', 'setReverseButtonIconColor', 'setCloseButtonBorderColor', 'setCloseButtonBackgroundColor', 'setCloseButtonIconColor'];
  const LINE_FONT = '600 11px Inter, system-ui, sans-serif';
  const VL = new Set(); // Vest's own lines on the chart, so the point distance can ride inside their labels
  function wrapLine(l) {
    if (!l || l.__gpz) return l; l.__gpz = 1; VL.add(l);
    LINE_SETTERS.forEach(m => { const o = l[m]; if (typeof o === 'function') l[m] = function (c) { return o.call(this, DB.skin !== false && !this.__gpzOwn ? skinColor(c, ROLE(m)) : c); }; });
    ['setBodyFont', 'setQuantityFont'].forEach(m => { const o = l[m]; if (typeof o === 'function') { l[m] = function (f) { return o.call(this, DB.skin !== false && !this.__gpzOwn ? LINE_FONT : f); }; } });
    const oText = l.setText, oRemove = l.remove;
    if (typeof oText === 'function') { l.__gpzSetText = oText; l.setText = function (t) { this.__gpzBase = t; return oText.call(this, String(t) + (this.__gpzSuf || '')); }; }
    if (typeof oRemove === 'function') l.remove = function () { VL.delete(this); return oRemove.apply(this, arguments); };
    if (DB.skin !== false) setTimeout(() => { if (!l.__gpzOwn) { try { l.setBodyFont && l.setBodyFont(LINE_FONT); l.setQuantityFont && l.setQuantityFont(LINE_FONT); } catch (e) {} } }, 0);
    return l;
  }
  function wrapChart(ch) {
    try { const proto = ch && Object.getPrototypeOf(ch); if (!proto || proto === Object.prototype || typeof proto.createOrderLine !== 'function') return; if (!proto.__gpzWrapped) { Object.defineProperty(proto, '__gpzWrapped', { value: 1 }); ['createOrderLine', 'createPositionLine'].forEach(m => { const o = proto[m]; if (typeof o === 'function') proto[m] = function () { return wrapLine(o.apply(this, arguments)); }; }); } } catch (e) {}
  }
  function skinOverrides() {
    const o = { 'paneProperties.backgroundType': 'solid', 'paneProperties.background': MS.bg, 'paneProperties.backgroundGradientStartColor': MS.bg, 'paneProperties.backgroundGradientEndColor': MS.bg,
      'paneProperties.vertGridProperties.color': '#141414', 'paneProperties.horzGridProperties.color': '#141414', 'scalesProperties.lineColor': '#1f1f1f', 'scalesProperties.textColor': MS.muted,
      'paneProperties.crossHairProperties.color': '#6f6f75', 'mainSeriesProperties.lineStyle.color': MS.cream, 'mainSeriesProperties.areaStyle.linecolor': MS.cream, 'mainSeriesProperties.areaStyle.color1': 'rgba(230,227,220,0.22)', 'mainSeriesProperties.areaStyle.color2': 'rgba(230,227,220,0)' };
    for (const k of ['candleStyle', 'hollowCandleStyle', 'haStyle']) Object.assign(o, { [`mainSeriesProperties.${k}.upColor`]: MS.up, [`mainSeriesProperties.${k}.downColor`]: MS.down, [`mainSeriesProperties.${k}.borderUpColor`]: MS.up, [`mainSeriesProperties.${k}.borderDownColor`]: MS.down, [`mainSeriesProperties.${k}.wickUpColor`]: MS.up, [`mainSeriesProperties.${k}.wickDownColor`]: MS.down });
    o['mainSeriesProperties.barStyle.upColor'] = MS.up; o['mainSeriesProperties.barStyle.downColor'] = MS.down;
    return o;
  }
  const VEST_CHART = { 'paneProperties.background': '#0F0F0F', 'paneProperties.backgroundGradientStartColor': '#0F0F0F', 'paneProperties.backgroundGradientEndColor': '#0F0F0F', 'paneProperties.vertGridProperties.color': '#292929', 'paneProperties.horzGridProperties.color': '#292929', 'scalesProperties.lineColor': '#292929', 'scalesProperties.textColor': '#F2F2F2', 'mainSeriesProperties.candleStyle.upColor': '#00D98E', 'mainSeriesProperties.candleStyle.downColor': '#E03737', 'mainSeriesProperties.candleStyle.borderUpColor': '#00D98E', 'mainSeriesProperties.candleStyle.borderDownColor': '#E03737', 'mainSeriesProperties.candleStyle.wickUpColor': '#00D98E', 'mainSeriesProperties.candleStyle.wickDownColor': '#E03737' };
  function paintChart(f, on) {
    try {
      const w = f.contentWindow, doc = f.contentDocument, api = w.tradingViewApi, ch = api && api.activeChart();
      if (!ch || typeof w.applyOverrides !== 'function') return false;
      wrapChart(ch); // Vest's own lines come out in the skin's tones from here on
      let st = doc.getElementById('gpz-skin');
      if (on) {
        if (!st) { st = doc.createElement('style'); st.id = 'gpz-skin'; (doc.head || doc.documentElement).appendChild(st); }
        st.textContent = `:root, body { --tv-color-platform-background: ${MS.bg} !important; --tv-color-pane-background: ${MS.bg} !important; --tv-color-popup-background: ${MS.card} !important; --tv-color-popup-element-background-active: ${MS.active} !important; --themed-color-drawer-backdrop: ${MS.bg} !important; --themed-color-pane-bg: ${MS.bg} !important; --themed-color-text: ${MS.text} !important; --themed-color-background: ${MS.card} !important; font-family: Inter, system-ui, sans-serif; }`;
        w.applyOverrides(skinOverrides());
      } else { if (st) st.remove(); w.applyOverrides(VEST_CHART); }
      try { for (const s of ch.getAllStudies() || []) if (s && s.name === 'Volume') ch.getStudyById(s.id).applyOverrides(on ? { 'volume.color.0': '#2a2a2e', 'volume.color.1': '#4a4a50' } : { 'volume.color.0': '#E03737', 'volume.color.1': '#00D98E' }); } catch (e) {}
      return true;
    } catch (e) { return false; }
  }
  let skinKey = '', skinTimers = [];
  // Vest builds a new chart frame on every load and market switch and draws its lines as soon as it's ready:
  // each new frame is caught the moment it appears and its line makers wrapped before Vest uses them
  function watchFrame(f) {
    if (!f || f.__gpzWatch) return; f.__gpzWatch = 1; const t0 = Date.now();
    const tick = () => { let ch = null; try { const a = f.contentWindow && f.contentWindow.tradingViewApi; ch = a && a.activeChart(); } catch (e) {} if (ch) { wrapChart(ch); skinKey = ''; applySkin(); return; } if (Date.now() - t0 < 60000 && f.isConnected) setTimeout(tick, 25); };
    tick();
  }
  new MutationObserver(ms => { for (const m of ms) for (const n of m.addedNodes) { if (n.nodeType !== 1) continue; if (n.tagName === 'IFRAME' && /^tradingview_/.test(n.id || '')) watchFrame(n); else if (n.querySelectorAll) n.querySelectorAll('iframe[id^="tradingview_"]').forEach(watchFrame); } }).observe(document, { childList: true, subtree: true });
  setTimeout(() => document.querySelectorAll('iframe[id^="tradingview_"]').forEach(watchFrame), 0);
  function applySkin() {
    const on = DB.skin !== false, html = document.documentElement;
    let st = document.getElementById('gpz-skin');
    if (on) { if (!st) { st = document.createElement('style'); st.id = 'gpz-skin'; (document.head || html).appendChild(st); } const css = skinCss(); if (st.textContent !== css) st.textContent = css; fonts(); }
    html.classList.toggle('gpz-skin', on);
    const f = document.querySelector('iframe[id^="tradingview_"]'); if (!f) return;
    let sym = ''; try { sym = f.contentWindow.tradingViewApi.activeChart().symbol(); } catch (e) { return; }
    const key = [f.id, sym, on, html.classList.contains('dark')].join('|'); if (key === skinKey) return;
    if (!html.classList.contains('dark') && on) return;
    if (!paintChart(f, on)) return; // not ready yet: tried again on the next pass
    skinKey = key; skinTimers.forEach(clearTimeout); // Vest re-applies its own colours as the chart settles: paint again after it
    skinTimers = [setTimeout(() => paintChart(f, DB.skin !== false), 1500), setTimeout(() => paintChart(f, DB.skin !== false), 4000)];
  }
  // TradingView's "A" (auto-scale the price axis) locks the chart. Vest turns it back on with every load and every
  // market switch; while GP. Shot is on it is switched off again, on every price scale of every pane.
  function noAutoScale() {
    if (!SH.on) return;
    document.querySelectorAll('iframe[id^="tradingview_"]').forEach(f => {
      try {
        const api = f.contentWindow && f.contentWindow.tradingViewApi, ch = api && api.activeChart();
        if (!ch || !ch.getPanes) return;
        ch.getPanes().forEach(pn => {
          const scales = [].concat(pn.getMainSourcePriceScale ? [pn.getMainSourcePriceScale()] : [], pn.getRightPriceScales ? pn.getRightPriceScales() : [], pn.getLeftPriceScales ? pn.getLeftPriceScales() : []);
          scales.forEach(ps => { if (ps && ps.isAutoScale && ps.setAutoScale && ps.isAutoScale()) ps.setAutoScale(false); });
        });
      } catch (e) {}
    });
  }
  setInterval(noAutoScale, 700);
  function toggleSkin() { DB.skin = DB.skin === false; save(true); skinKey = ''; applySkin(); if (P) render(); }
  setInterval(applySkin, 1000);

  // ---------- start ----------
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && OPEN) closePanel(); });
  const boot = () => { booted = true; fonts(); applySkin(); placePill(); render(); setInterval(placePill, 1000); setInterval(() => { if (DB.zone || OPEN) render(); if (DB.zone && SHOT.visible) zoneBits(); }, 1000); loop(); fastLoop(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
