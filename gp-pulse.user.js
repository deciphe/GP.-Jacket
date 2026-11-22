// ==UserScript==
// @name         GP. Entry for Vest
// @namespace    https://github.com/deciphe/gp-pulse
// @version      1.9.1
// @description  Spend, payouts and live PnL breathing in Vest's header, Zone sessions with a certificate, a risk-locked one-click order ticket, the trade managed from the ticket and the chart, a Vest-to-Vest copier and a desk to close any account.
// @author       GP.
// @match        https://next.vestmarkets.com/*
// @run-at       document-start
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        unsafeWindow
// @homepageURL  https://github.com/deciphe/gp-pulse
// @updateURL    https://raw.githubusercontent.com/deciphe/gp-pulse/main/gp-pulse.user.js
// @downloadURL  https://raw.githubusercontent.com/deciphe/gp-pulse/main/gp-pulse.user.js
// ==/UserScript==

(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  // one clock for all the upkeep: each job runs on its own beat from a single timer, and the UI jobs
  // slow down 4x while the tab is in the background (copying runs on its own loop and keeps full speed)
  const JOBS = []; let clockT = null;
  function every(ms, fn, keep) { JOBS.push({ ms, fn, keep: !!keep, at: 0 }); if (!clockT) clockT = setInterval(clock, 100); }
  function clock() { const now = Date.now(), hid = document.hidden; for (const j of JOBS) { const ms = hid && !j.keep ? j.ms * 4 : j.ms; if (now - j.at < ms) continue; j.at = now; try { j.fn(); } catch (e) {} } }
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
  // code GIGA at checkout: when you buy an account, GIGA goes on the price quote.
  // Switched in the chart menu; while on, it replaces any code typed at checkout.
  const QUOTE_RE = /\/v3\/payments\//;
  const gigaOn = () => { try { return DB.giga !== false; } catch (e) { return false; } };
  // on means GIGA everywhere Vest reads a code: the code check, the price quote and the hosted checkout, whatever was typed or came with a signup link
  const gigaBody = (b, u) => { if (typeof b !== 'string' || !gigaOn()) return null; const j = JSON.parse(b); if (!j || typeof j !== 'object' || Array.isArray(j)) return null; u = String(u || '');
    if (/\/payments\/promotions\/check/.test(u)) { if (!('code' in j) || j.code === 'GIGA') return null; j.code = 'GIGA'; return JSON.stringify(j); }
    const quote = 'items' in j || 'promotionCodeText' in j || (/\/payments\/hosted-checkout/.test(u) && 'priceId' in j); if (!quote || j.promotionCodeText === 'GIGA') return null; j.promotionCodeText = 'GIGA'; return JSON.stringify(j); };
  const REF_RE = /"(signup|link)_ref_discount"/;
  const gigaResp = t => { if (!gigaOn() || typeof t !== 'string' || !REF_RE.test(t)) return t; try { const j = JSON.parse(t);
      const walk = o => { if (!o || typeof o !== 'object') return; for (const k in o) { const v = o[k]; if ((k === 'signup_ref_discount' || k === 'link_ref_discount') && v && typeof v === 'object' && 'code' in v) { v.code = 'GIGA'; v.valid = true; } else walk(v); } };
      walk(j); return JSON.stringify(j); } catch (e) { return t; } };
  const XRT = Object.getOwnPropertyDescriptor(W.XMLHttpRequest.prototype, 'responseText'), XRS = Object.getOwnPropertyDescriptor(W.XMLHttpRequest.prototype, 'response');
  const gigaCheck = () => {};
  W.XMLHttpRequest.prototype.send = function () { try { if (this.__gpzm !== 'GET' && TRADE_RE.test(this.__gpzu || '')) this.addEventListener('loadend', () => kickFast(250));
    if (this.__gpzm === 'POST' && QUOTE_RE.test(this.__gpzu || '')) { const nb = gigaBody(arguments[0], this.__gpzu); if (nb) arguments[0] = nb; }
    if (this.__gpzm === 'GET' && /\/v\d\/(referrals|affiliate|payments|users?|me)\b/.test(this.__gpzu || '') && gigaOn() && XRT && XRS) { const x = this; let c0, c1; // the referral discount Vest shows at checkout reads GIGA too
      Object.defineProperty(x, 'responseText', { configurable: true, get() { const t = XRT.get.call(x); if (t !== c0) { c0 = t; c1 = gigaResp(t); } return c1; } });
      Object.defineProperty(x, 'response', { configurable: true, get() { const r = XRS.get.call(x); return typeof r === 'string' ? x.responseText : r; } }); } } catch (e) {} return XS.apply(this, arguments); };
  const F0 = W.fetch;
  W.fetch = function (i, o) {
    let trade = false;
    try { const u = (i && i.url) || String(i); if (GATE.test(u)) { offer(new W.Headers((o && o.headers) || (i && i.headers) || {}).get('authorization')); trade = TRADE_RE.test(u) && String((o && o.method) || (i && i.method) || 'GET').toUpperCase() !== 'GET'; } } catch (e) {}
    let giga = false;
    try { const u = (i && i.url) || String(i); if (o && QUOTE_RE.test(u) && String(o.method || '').toUpperCase() === 'POST') { const nb = gigaBody(o.body, u); if (nb) { o = Object.assign({}, o, { body: nb }); arguments[1] = o; giga = true; } } } catch (e) {}
    const r = F0.apply(this, arguments); if (trade) r.then(() => kickFast(250), () => {});
    if (giga) r.then(res => res.clone().text().then(t => gigaCheck(res.status, t)), () => {});
    return r;
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
  // another Vest tab saved: take its copier choices and switches, so an older tab never writes stale ones back over yours
  const SYNC_C = ['on', 'leader', 'pick', 'followers', 'mode', 'owned', 'opened', 'share', 'pre'];
  function fromOtherTab(nv) {
    if (!nv || typeof nv !== 'object') return; clearTimeout(saveT);
    ['pill', 'giga', 'gigaSkip'].forEach(k => { if (k in nv) DB[k] = nv[k]; });
    { const was = JSON.stringify([DB.cth, DB.cthc, DB.cthd, DB.skin]); ['cth', 'cthc', 'cthd', 'cthV', 'skin', 'lst', 'abe', 'atr'].forEach(k => { if (k in nv) DB[k] = nv[k]; else delete DB[k]; }); // chart colours and switches picked in another tab: taken here too, so this tab never saves its old ones back
      if (JSON.stringify([DB.cth, DB.cthc, DB.cthd, DB.skin]) !== was) try { CTH_FRAME = ''; skinKey = ''; applySkin(); } catch (e) {} }
    try { if (nv.copier && C) { SYNC_C.forEach(k => { if (k in nv.copier) C[k] = nv.copier[k]; }); DB.copier = C; } } catch (e) {}
    try { placePill(); } catch (e) {} try { renderDesk(); } catch (e) {} try { if (SP) renderShot(); } catch (e) {}
  }
  try { if (typeof GM_addValueChangeListener === 'function') GM_addValueChangeListener('pulse', (k, o, nv, remote) => { if (remote) fromOtherTab(nv); }); } catch (e) {}

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
  // a payout or withdrawal taken today comes off the balance; it is still profit made, so it goes back into the day's tally
  function paidToday(id, d0) {
    let s = 0; const ms = v => typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || 0;
    for (const k in DB.pay) { const x = DB.pay[k]; if (x.acct !== id || /reject|cancel|fail|declin/i.test(x.st || '')) continue; if (ms(x.c || x.t) >= d0) s += +x.req || +x.amt || 0; }
    return s;
  }
  function liveRows(evals) { // evals: the zone counts evaluation accounts too
    if (!L.cap) return [];
    const d0 = vestDay(), key = String(d0);
    if (!DB.dayBase[key]) DB.dayBase = { [key]: {} };
    const rows = [];
    L.cap.filter(c => (c.account_type === 3 || (evals && c.account_type === 2)) && c.status === 2).forEach(c => {
      if (!(c.id in L.bal)) return;
      let u = 0, open = 0;
      L.pos.forEach(p => { if ((p.accountId || p.account_id) !== c.id) return; open++; const m = L.mark[p.symbol]; if (m) u += (m - +p.openPrice) * Math.abs(+p.quantity) * (/^s/i.test(p.side || '') ? -1 : 1); });
      const eq = cashOf(c.id) + u;
      let base = +c.daily_reset_equity;
      if (!(c.daily_reset_at >= d0 - 3 * 36e5) || !isFinite(base)) { const b = DB.dayBase[key]; if (b[c.id] == null) { b[c.id] = eq; save(); } base = b[c.id]; }
      rows.push({ id: c.id, name: planShort(c.plan_name, +c.initial_capital), size: +c.initial_capital || 0, eq, u, today: eq - base + paidToday(c.id, d0), open });
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
    liveRows(true).forEach(r => { if (z.base[r.id] == null) z.base[r.id] = r.eq; z.last[r.id] = r.eq; z.liveSeen = true; });
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
      try { const j = await api(`/v3/positions?account_id=${acct}&limit=25&offset=0`); const p = (j.positions || []).find(x => x.positionId === id); if (p && p.closeDate) { if (DB.zone) { DB.zone.trades.push({ acct, pnl: +p.pnl || 0, fee: +p.fee || 0, sym: String(p.symbol || '').replace(/-USD-PERP$|-PERP$/, '') }); save(); render(); } return; } } catch (e) {}
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
  .rs{display:inline-flex;align-items:center;gap:7px;height:34px;margin-right:8px;padding:0 13px 0 11px;border-radius:8px;border:1px solid rgba(238,234,226,.12);background:#0b0b0b;color:#c9c7c2;font:700 12.5px Inter,system-ui,sans-serif;letter-spacing:-.01em;-webkit-font-smoothing:antialiased;cursor:pointer;white-space:nowrap}
  .rs:hover{border-color:rgba(238,234,226,.32);color:#eeeae2}.rs svg{flex:none}.rs.ok{border-color:rgba(159,215,178,.6);color:#bfe6cb}
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
    R.innerHTML = `<style>${PCSS}</style><button class="rs" data-a="rs" title="Put the ticket and the desk back in place"><svg width="13" height="13" viewBox="0 0 16 16" fill="none"><path d="M2.5 8a5.5 5.5 0 1 0 1.7-3.98" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M2.2 2.2v3.6h3.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>reset</button><button class="p wait" aria-label="Open GP. Entry"><i class="dot"></i><b>GP.</b><span class="v" data-k="a">—</span><span class="l" data-k="al">spent today</span><i class="s" data-k="sep" hidden></i><span class="v" data-k="b" hidden></span><span class="l" data-k="bl" hidden>live</span></button>`;
    R.querySelector('.p').onclick = e => { e.stopPropagation(); OPEN ? closePanel() : openPanel(); };
    R.querySelector('.rs').onclick = e => { e.stopPropagation(); const b = e.currentTarget; snapAll(); b.classList.add('ok'); setTimeout(() => b.classList.remove('ok'), 1200); };
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
    const P = pill(), s = slot(); P.btn.hidden = DB.pill !== true; // the spend pill is a choice in Settings; reset stays
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
  // only a live sign-in token can mint account tokens: an account's own token never can, and Vest swaps the sign-in token every 15 minutes
  const userTok = () => { const c = AUTH && claims(AUTH); return c && c.userId && !c.accountId && (!c.exp || c.exp * 1000 > Date.now() + 5000) ? AUTH : null; };
  async function freshTok(not, ms) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const u = userTok(); if (u && u !== not) return u; await sleep(120); } return userTok() !== not ? userTok() : null; }
  async function acctToken(id, again) {
    const a = ACCT[id]; if (a && a.exp - Date.now() > 60000) return a.tok;
    const tok = userTok() || await freshTok(null, 4000);
    if (!tok) throw new Error('waiting for Vest sign-in');
    const r = await F0.call(W, API + '/v3/auth/account-token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: tok }, body: JSON.stringify({ accountId: id }) });
    if (r.status === 401 && !again) { if (AUTH === tok) AUTH = null; if (await freshTok(tok, 6000)) return acctToken(id, true); } // Vest just renewed its sign-in: wait for the new one, once
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
        { const act = activeAcct(); if (act && L.balAt > (L.capAt || 0) && L.bal[act] == null && capAcct(act)) L.capAt = 0; } // the active account dropped out: re-read the list now
        L.ok = true; L.at = Date.now(); L.err = '';
        if (C.on && ownCopier()) await copierSync();
      } catch (e) { L.err = String(e.message || e); }
      fastBusy = false;
      try { zoneTick(); } catch (e) {}
      try { autoManage(); } catch (e) {}
    }
    if (need) { try { renderShot(); drawChart(); } catch (e) {} try { renderDesk(); } catch (e) {} }
    fastT = setTimeout(fastLoop, C.on ? 1500 : 1100);
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { kickFast(0); reflowSoon(); } });

  // ---------- the plan: risk-locked size and fee-aware stop / target ----------
  const SH = Object.assign({ on: true, sl: true, tp: true, risk: 2, R: 1, tmode: 'R', usd: 0, size: 100, fees: true, chart: true, side: 'long', dock: true, x: null, y: null, addp: 50 }, DB.shot || {});
  const CTHEMES = [
    { id: 'vest', name: 'Vest', bg: '#121714', up: '#00D98E', upB: '#00D98E', dn: '#E03737', dnB: '#E03737' }, // Vest's own colours, the whole page
    { id: 'massive', name: 'Massive', bg: '#0b0b0b', up: '#dedbd3', upB: '#dedbd3', dn: '#4b4b51', dnB: '#4b4b51' },
    { id: 'paper', name: 'Paper', light: true, scale: '#2b2b2e', bg: '#d8d8d8', grid: 'rgba(55,55,57,0.08)', text: '#4a4a4d', up: '#fdfdfd', upB: '#373739', upW: '#373739', dn: '#373739', dnB: '#373739', dnW: '#373739' },
    { id: 'pastel', name: 'Pastel', light: true, scale: '#2a2d36', bg: '#d1d4dc', grid: 'rgba(27,30,40,0.07)', text: '#4a4d57', up: '#a5d6a7', upB: '#1b5e20', upW: '#1b5e20', dn: '#faa1a4', dnB: '#801922', dnW: '#801922' },
    { id: 'night', name: 'Night', bg: '#000000', grid: 'rgba(255,255,255,0.05)', text: '#8b8b92', up: '#163918', upB: '#81c784', upW: '#81c784', dn: '#481015', dnB: '#f7525f', dnW: '#f7525f' }];
  const hex6 = v => /^#[0-9a-f]{6}$/i.test(v || '') ? v : null;
  const cssCol = v => typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d.,\s%]+\))$/i.test(v.trim()) ? v.trim() : null;
  const rgbOf = v => { v = cssCol(v); if (!v) return null; if (v[0] === '#') { let h = v.slice(1); if (h.length < 6) h = h.split('').map(c => c + c).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); } const m = v.match(/[\d.]+/g); return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null; };
  const toHex = v => { const c = rgbOf(v); return c ? '#' + c.map(x => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('') : null; };
  const myTheme = (c, id, name) => { const bg = cssCol(c.bg) || '#121714', up = cssCol(c.up) || '#00D98E', dn = cssCol(c.dn) || '#E03737', k = rgbOf(bg), lum = (0.299 * k[0] + 0.587 * k[1] + 0.114 * k[2]) / 255;
    return Object.assign({ id, name, mine: true, bg, up, dn, upB: cssCol(c.upB) || up, dnB: cssCol(c.dnB) || dn, upW: cssCol(c.upW) || up, dnW: cssCol(c.dnW) || dn }, lum > 0.55 ? { light: true, scale: '#2b2b2e' } : {}); };
  // the colours the chart shows right now, whatever set them: GP., or the chart's own settings
  const readChart = () => { try { const f = document.querySelector('iframe[id^="tradingview_"]'), ch = f.contentWindow.tradingViewApi.activeChart(), cs = ch.getSeries().chartStyleProperties(ch.chartType()) || {}, bg = ch.chartModel().backgroundColor().value();
    const o = { bg: cssCol(bg), up: cssCol(cs.upColor), dn: cssCol(cs.downColor), upB: cssCol(cs.borderUpColor), dnB: cssCol(cs.borderDownColor), upW: cssCol(cs.wickUpColor), dnW: cssCol(cs.wickDownColor) }; return o.bg && o.up && o.dn ? o : null; } catch (e) { return null; } };
  const allThemes = () => CTHEMES.concat((Array.isArray(DB.cthc) ? DB.cthc : []).map(c => myTheme(c, c.id, c.name)), DB.cthd ? [myTheme(DB.cthd, 'draft', 'Edit')] : []);
  const ctgHtml = () => allThemes().filter(t => t.id !== 'draft').map(t => `<button data-cth="${esc(t.id)}" title="${esc(t.name)}"><span class="sw3"><i style="background:${t.bg}"></i><i style="background:${t.up};box-shadow:inset 0 0 0 1px ${t.upB}"></i><i style="background:${t.dn};box-shadow:inset 0 0 0 1px ${t.dnB}"></i></span><small>${esc(t.name)}</small>${t.mine ? `<em data-cdel="${esc(t.id)}" title="Delete">×</em>` : ''}</button>`).join('');
  SH.keys = Object.assign({ on: false, long: 'Alt+KeyB', short: 'Alt+KeyS', close: 'Alt+KeyX' }, SH.keys || {}); // keyboard shortcuts: off until switched on
  SH.chart = true;
  const saveSH = () => { DB.shot = SH; save(); };
  const esc = v => String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const loadOf = (x = SH) => ({ risk: +x.risk, rmode: x.rmode === 'usd' ? 'usd' : 'pct', rusd: +x.rusd || 0, R: +x.R, tmode: x.tmode || 'R', usd: +x.usd || 0, size: +x.size, fees: !!x.fees });
  const FRESH = 3500; // a price older than this never sizes or sends an order
  W.__gpzVest = m => vestSuffix(m);
  W.__gpzSync = () => syncHistory(false);
  W.__gpzZoneTrade = (acct, pnl) => { if (DB.zone) { DB.zone.trades.push({ acct, pnl }); save(); } };
  W.__gpzLocked = id => lockedAcct(id);
  W.__gpzPlan = () => { const p = plan(); return { why: p.why, id: p.id, closed: !!p.closed, ok: p.ok }; };
  function plan() {
    const sym = curSymbol(), id = activeAcct(), x = sym && SPEC[sym];
    if (!sym || !x) return { ok: false, why: 'reading the market' };
    if (!id) return { ok: false, why: 'pick an account on Vest', sym };
    if (L.cap && L.capAt && L.balAt && !capAcct(id) && L.bal[id] == null) return { ok: false, why: acctShort(id) + ' is closed · pick another', sym, id, closed: true };
    const px = L.mark[sym], bal = balOf(id);
    if (!px || !(bal > 0)) return { ok: false, why: 'reading your account', sym, id };
    const levMax = maxLev(sym, id) || 1, lev = Math.max(1, Math.min(levMax, Math.round((SH.levs && SH.levs[sym]) || levMax))), f = +x.takerFee || 0;
    const mine = L.pos.filter(p => accOf(p) === id);
    const used = mine.reduce((a, p) => a + Math.abs(+p.quantity) * (+p.openPrice) / (+p.leverage || lev), 0);
    const free = L.bal[id] != null ? Math.max(0, L.bal[id]) : Math.max(0, bal - used), maxN = free * lev * 0.985, notional = maxN * (SH.size / 100);
    const d = dec(sym), qty = Math.floor(notional / px * Math.pow(10, d) + 1e-7) / Math.pow(10, d);
    const base = { sym, id, x, px, bal, lev, levMax, f, maxN };
    if (!(qty > 0)) return { ...base, ok: false, why: 'no free margin' };
    // the pass line: an evaluation's target equity, less what the account holds now (open trades included)
    const ca = capAcct(id), tgtEq = ca && ca.account_type === 2 ? +ca.target_equity : 0;
    const openU = mine.reduce((a, p) => { const m = L.mark[p.symbol]; return m ? a + (m - +p.openPrice) * Math.abs(+p.quantity) * (/^s/i.test(p.side || '') ? -1 : 1) : a; }, 0);
    const passNeed = tgtEq > 0 ? Math.max(0, tgtEq - bal - openU) : 0;
    const N = qty * px, fees = 2 * N * f, risk = SH.rmode === 'usd' && SH.rusd > 0 ? SH.rusd : bal * SH.risk / 100;
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
  function zoneStats(acct) {
    const z = DB.zone; if (!z) return null;
    const tr = (z.trades || []).filter(t => t.pnl != null && (acct == null || t.acct === acct)), sum = tr.reduce((a, t) => a + t.pnl, 0);
    return { sum, lost: tr.filter(t => t.pnl < 0).length, won: tr.filter(t => t.pnl > 0).length };
  }
  // the zone lock is per account: the account that hits the loss (or the losing-trade count) is locked until Vest's
  // 8pm New York reset, even after the zone ends. Every other account keeps trading.
  const nextReset = () => vestDay() + 864e5;
  function lockedAcct(id) {
    const Z = DB.zlock || (DB.zlock = {}); for (const k in Z) if (Z[k] <= Date.now()) { delete Z[k]; save(); }
    const z = DB.zone; if (z && id && !Z[id] && (ZL.loss > 0 || ZL.n > 0)) { const s = zoneStats(id); if (s && ((ZL.loss > 0 && s.sum <= -ZL.loss) || (ZL.n > 0 && s.lost >= ZL.n))) { Z[id] = nextReset(); save(true); } }
    return !!Z[id];
  }
  function zoneLocked() { const z = DB.zone; if (z) for (const t of z.trades || []) if (t.acct) lockedAcct(t.acct); return lockedAcct(activeAcct()); }

  // ---------- firing ----------
  const SHOT = { busy: false, msg: '', tone: '', hover: null, visible: false, cool: 0, zopen: false };
  function shotMsg(m, tone) { SHOT.msg = m; SHOT.tone = tone || ''; SHOT.msgAt = Date.now(); renderShot(); }
  const myPos = p => p && p.sym ? L.pos.find(x => accOf(x) === p.id && x.symbol === p.sym) : null;
  async function fire(side) {
    if (SHOT.busy || Date.now() < SHOT.cool) return;
    if (zoneLocked()) return shotMsg('zone locked', 'bad');
    let p = plan(); if (!p.ok) return shotMsg(p.why, 'bad');
    if (myPos(p)) return shotMsg('already in ' + shortSym(p.sym), 'bad');
    SHOT.busy = side; renderShot();
    let sent = false;
    try {
      await ensureLev(p.id, p.sym, p.lev).catch(() => {});
      await Promise.race([readMarks(), sleep(350)]).catch(() => {}); // stop and target come off the newest price
      p = plan(); if (!p.ok) throw new Error(p.why);
      if (myPos(p)) throw new Error('already in ' + shortSym(p.sym));
      const g = p[side];
      const body = { orderType: 'market', leverage: String(p.lev), side, symbol: p.sym, quantity: p.qtyS, timeInForce: 'IOC', takeProfits: SH.tp === false ? [] : [{ executionType: 'market', triggerPrice: fmtP(g.tp, p.sym) }], stopLosses: SH.sl === false ? [] : [{ executionType: 'market', triggerPrice: fmtP(g.sl, p.sym) }] };
      sent = true; await send(p.id, 'POST', '/v3/positions/open', body);
      shotMsg((side === 'long' ? 'Long ' : 'Short ') + p.qtyS + ' ' + shortSym(p.sym) + (SH.sl === false ? ' · no stop' : ' · stop ' + fmtPx(g.sl, p.sym)) + (SH.tp === false ? ' · no target' : ''), 'ok'); flash(side);
    } catch (e) { if (e.status && e.status < 500 && e.status !== 429) sent = false; shotMsg(e.message, 'bad'); }
    SHOT.cool = Date.now() + (sent ? 2500 : 600); // no second shot until the position list has caught up
    SHOT.busy = false; saveSH(); kickFast(150); setTimeout(renderShot, 2600);
  }
  function flash(side) { const s = SP && SP.R.querySelector('.s'); if (!s) return; s.classList.remove('fl-long', 'fl-short'); void s.offsetWidth; s.classList.add('fl-' + side); setTimeout(() => s.classList.remove('fl-' + side), 900); }
  // auto break even at +1R, then the stop trails up in 0.5R steps: off unless switched on in settings
  function autoManage() {
    if ((!DB.abe && !DB.atr) || SHOT.busy || Date.now() < (SHOT.autoAt || 0)) return;
    const pos = curPos(); if (!pos) return; const t = tradeOf(pos); if (!t.sl || t.R == null || !t.m) return;
    if (t.R < 1) return; const lockR = DB.atr ? Math.floor((t.R - 1) / 0.5 + 1e-9) * 0.5 : 0, tk = tickOf(t.sym);
    const be = t.long ? t.op * (1 + t.f) / (1 - t.f) : t.op * (1 - t.f) / (1 + t.f), raw = lockR > 0 ? t.op + t.dir * t.d0 * lockR : be;
    const want = t.long ? Math.ceil(raw / tk - 1e-9) * tk : Math.floor(raw / tk + 1e-9) * tk, cur = +t.sl.triggerPrice;
    if ((want - cur) * t.dir <= tk / 2 || (t.m - want) * t.dir <= tk * 2) return;
    SHOT.autoAt = Date.now() + 4000; setStop(want, lockR > 0 ? 'Trailed +' + trimNum(lockR) + 'R ·' : 'Auto break even ·', 'be');
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
  // add to the open trade: a share of the margin still free on the account, at the trade's own leverage
  function firstSize(pos) { // the size the trade opened with, remembered per position
    const id = pos.positionId, q = Math.abs(+pos.quantity) || 0, I = DB.init || (DB.init = {});
    if (!(I[id] > 0) && q > 0) { I[id] = q; const ks = Object.keys(I); if (ks.length > 60) ks.slice(0, ks.length - 60).forEach(k => delete I[k]); save(); }
    return I[id] || q;
  }
  function addPlan(pct) { // how much one click adds: a share of the first size, no more than the free margin carries
    const pos = curPos(); if (!pos) return null; const id = accOf(pos), sym = pos.symbol, lev = +pos.leverage || maxLev(sym, id) || 1, m = L.mark[sym];
    const free = L.bal[id] != null ? Math.max(0, L.bal[id]) : 0, cap = m ? free * lev * 0.985 / m : 0, want = firstSize(pos) * pct / 100;
    return { pos, id, sym, lev, m, qs: fmtQ(Math.min(want, cap), sym), capped: want > cap };
  }
  function addPct(pct) {
    const a = addPlan(pct); if (!a) return; if (zoneLocked()) return shotMsg('zone locked', 'bad');
    const { pos, id, sym, lev, m, qs } = a;
    if (!m || !(Date.now() - (L.markAt || 0) < FRESH)) return shotMsg('price stale', 'bad');
    if (!(+qs > 0)) return shotMsg(a.capped ? 'no free margin' : 'too small to add', 'bad');
    act('addx', async () => {
      await send(id, 'POST', '/v3/positions/append', { symbol: sym, positionId: pos.positionId, orderType: 'market', quantity: qs, leverage: trimNum(lev), isBuy: /^l/i.test(pos.side), timeInForce: 'IOC' });
      return 'Added ' + qs + ' ' + shortSym(sym);
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
  .ib{flex:none;height:24px;min-width:24px;padding:0 7px;border-radius:8px;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:700 11px/1 Inter,system-ui,sans-serif;cursor:pointer;white-space:nowrap;display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:border-color .25s,color .25s,background .25s;font-variant-numeric:tabular-nums}
  .ib:hover{color:#f1f1f3;border-color:rgba(238,234,226,.34)}
  .ib.gr{width:28px;padding:0;justify-content:center;color:#9e9ea5}.ib.gr svg{display:block}.ib.gr.on svg{color:#0b0b0b}.ib .cs{width:10px;height:10px;border-radius:3px;margin:0;flex:none;box-shadow:inset 0 0 0 1px rgba(238,234,226,.25)}
  .ctm{position:absolute;top:44px;right:18px;z-index:31;display:flex;flex-direction:column;gap:2px;width:190px;padding:5px;border-radius:12px;border:1px solid rgba(238,234,226,.14);background:#101010;box-shadow:0 22px 50px -16px rgba(0,0,0,.9);animation:lin .18s ease-out}.ctm[hidden]{display:none}
  .ctm button{display:flex;align-items:center;gap:10px;height:28px;padding:0 10px;border:0;border-radius:8px;background:none;color:#c9c7c2;font:600 12px Inter,system-ui,sans-serif;cursor:pointer;text-align:left}
  .ctm button:hover{background:rgba(238,234,226,.06);color:#f1f1f3}.ctm button.on{background:rgba(238,234,226,.08);color:#f1f1f3}
  .ctg button{position:relative}.ctg em{position:absolute;top:1px;right:3px;font-style:normal;font-size:11px;line-height:1;color:#6f6f75;display:none;padding:2px}.ctg button:hover em{display:block}.ctg em:hover{color:#e8988c}
  .cted{display:flex;gap:2px;padding:3px 1px 2px}.cted label{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:6px 2px;border-radius:8px;cursor:pointer;position:relative}.cted label:hover{background:rgba(238,234,226,.06)}.cted input{position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;border:0;padding:0}.cted i{width:22px;height:14px;border-radius:4px;box-shadow:inset 0 0 0 1px rgba(238,234,226,.18)}.cted small{font-size:9px;font-weight:700;letter-spacing:.12em;color:#8b8b92}.cted button:disabled{opacity:.35;cursor:default}.cted button{flex:1.2;justify-content:center;height:auto!important;color:#9fd7b2!important}
  .ctg{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:2px;padding:0 1px}.ctg .sw3{gap:1px;padding:2px}.ctg .sw3 i{width:6px;height:12px}.ctg .sw3 i:first-child{width:9px}.ctg button{flex-direction:column;justify-content:center;gap:5px;height:auto!important;padding:7px 2px!important}.ctg small{font-size:9.5px;font-weight:600;color:#8b8b92}.ctg button.on small{color:#f1f1f3}.ctm{width:236px!important}
  .ctt{padding:6px 10px 6px;font-size:13px;font-weight:800;color:#f1f1f3;border-bottom:1px solid rgba(238,234,226,.08);margin-bottom:2px}.ctm{max-height:min(560px,calc(100vh - 140px));overflow-y:auto;scrollbar-width:none}.cth{padding:6px 10px 3px;font-size:9.5px;font-weight:700;letter-spacing:.16em;color:#6f6f75}.ctr{display:flex;gap:2px}.ctr button{flex:1;justify-content:center;padding:0 6px}
  .sw3{display:inline-flex;gap:2px;padding:2px;border-radius:6px;background:rgba(238,234,226,.06)}.sw3 i{width:10px;height:14px;border-radius:2px}.sw3 i:first-child{width:14px}
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
  .mk{display:flex;justify-content:space-between;align-items:baseline;gap:8px}.mk>b{display:inline-flex;align-items:center;gap:7px}
  .fr{width:5px;height:5px;border-radius:50%;background:#55555b;flex:none;transition:background .3s}.fr.ok{background:#9fd7b2;box-shadow:0 0 6px rgba(159,215,178,.6)}.fr.mid{background:#d6d3cc}.fr.bad{background:#e8988c}
  .rm{color:#9e9ea5}.rm.low{color:#efb1a7}
  .s.fl-long{outline:1.5px solid rgba(159,215,178,.95);outline-offset:-1.5px}.s.fl-short{outline:1.5px solid rgba(232,152,140,.95);outline-offset:-1.5px}
  .mk b{font-size:19px;font-weight:600;letter-spacing:-.04em;font-variant-numeric:tabular-nums;white-space:nowrap;transition:color .4s}
  .mk b em{font-style:normal}.mk .old{color:#5f5f66}
  .mk>span{font-size:11px;font-weight:600;color:#8b8b92;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:0 1 auto}.mk>b{flex:0 1 auto;min-width:0}
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
  .c.pass{flex:none;width:54px;height:24px;font-size:10.5px;letter-spacing:.06em;color:#9e9ea5}.c.pass.on{background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b}
  .c.gold{color:#c9c7c2;border-color:rgba(238,234,226,.16)}.c.grn{color:#bfe6cb;border-color:rgba(159,215,178,.3)}[data-a=addx]{flex:1;font-weight:700}.c.gold:hover{border-color:#d6d3cc}
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
  .pl em{display:none;margin-top:5px;font-style:normal;font-size:11px;font-weight:600;color:#8b8b92;font-variant-numeric:tabular-nums;white-space:nowrap}
  .pl em i{font-style:normal;color:#5f5f66}.pl em.note{display:block}
  .pe{display:flex;gap:4px;margin-top:6px}.pl .tp .pe{justify-content:flex-end}.pe .n{width:64px;height:22px;font-size:11px}.pe .c.pass{height:22px;width:46px}
  .bm{position:relative;height:22px;margin:0 5px}
  .bm i{position:absolute;display:block}
  .bm .tr{left:-5px;right:-5px;top:10px;height:2px;border-radius:2px;background:rgba(238,234,226,.09)}
  .bm .zl,.bm .zh,.bm .fl{top:10px;height:2px;border-radius:2px;transition:left .8s cubic-bezier(.16,1,.3,1),width .8s cubic-bezier(.16,1,.3,1),background .4s}
  .bm .zl{background:rgba(232,152,140,.5)}.bm .zh{background:rgba(159,215,178,.5)}
  .bm .fl{top:9px;height:4px}.bm .fl.up{background:#bfe6cb;box-shadow:0 0 14px rgba(159,215,178,.55)}.bm .fl.dn{background:#efb1a7;box-shadow:0 0 14px rgba(232,152,140,.5)}
  .bm .bk{top:5px;width:2px;height:12px;margin-left:-1px;border-radius:2px;transition:left .8s cubic-bezier(.16,1,.3,1)}
  .bm .ks{background:#e8988c}.bm .kt{background:#9fd7b2}.bm .ke{background:#e6e3dc;top:7px;height:8px;opacity:.55}.bm .kg{background:#d6d3cc;top:7px;height:8px}
  .bm .pd{top:5px;width:12px;height:12px;margin-left:-6px;border-radius:50%;background:#e6e3dc;border:3px solid #0b0b0b;box-shadow:0 0 0 1px #e6e3dc,0 0 16px rgba(230,227,220,.45);transition:left .9s cubic-bezier(.16,1,.3,1),background .4s,box-shadow .4s}
  .bm.up .pd{background:#bfe6cb;box-shadow:0 0 0 1px #bfe6cb,0 0 18px rgba(159,215,178,.7)}.bm.dn .pd{background:#efb1a7;box-shadow:0 0 0 1px #efb1a7,0 0 18px rgba(232,152,140,.65)}
  .bm .pd:after{content:"";position:absolute;inset:-7px;border-radius:50%;border:1px solid currentColor;color:rgba(230,227,220,.5);animation:ring 3.5s ease-out infinite}
  @keyframes ring{0%,8%{transform:scale(.4);opacity:0}38%{opacity:.6}100%{transform:scale(1.5);opacity:0}}
  /* fees against the stop: the gold part of the risk goes to Vest, the rest is room for price */
  .bal{display:flex;flex-direction:column;gap:5px}
  .bb{height:3px;border-radius:3px;background:rgba(238,234,226,.14);overflow:hidden}
  .bb i{display:block;height:100%;border-radius:3px;background:rgba(230,227,220,.55);transition:width .7s cubic-bezier(.16,1,.3,1),background .3s}
  .bb i.hot{background:#e8988c}
  .bt{display:flex;justify-content:space-between;gap:8px;font-size:11px;font-weight:600;color:#8b8b92;font-variant-numeric:tabular-nums;white-space:nowrap}
  .sw.sm{width:24px;height:14px;vertical-align:-2px;margin-left:7px}.sw.sm:after{width:8px;height:8px;top:2px;left:2px}.sw.sm.on:after{transform:translateX(10px)}
  .s.nosl .sr[data-sr=risk]>b{color:#4f4f55}.s.nosl .pl .sl b{color:#4f4f55}
  .lvb{border:0;background:none;padding:0 2px;margin:0 -2px;border-radius:5px;color:#f1f1f3;font:inherit;font-weight:700;cursor:pointer;border-bottom:1px dashed rgba(238,234,226,.35)}
  .lvb:hover{background:rgba(238,234,226,.08)}.lvb.set{color:#e6e3dc;border-bottom-color:rgba(238,234,226,.5)}
  .lvp{position:absolute;right:14px;top:84px;z-index:30;width:230px;padding:12px 14px 10px;border-radius:12px;background:#111111;border:1px solid rgba(238,234,226,.14);box-shadow:0 22px 50px -16px rgba(0,0,0,.9);animation:lin .2s ease-out}
  .lvh{display:flex;justify-content:space-between;align-items:baseline;font-size:10.5px;font-weight:600;letter-spacing:.14em;color:#8b8b92}.lvh b{font-size:20px;letter-spacing:-.03em;color:#f1f1f3;font-variant-numeric:tabular-nums}
  .lvp input{-webkit-appearance:none;appearance:none;width:100%;height:18px;margin:8px 0 4px;background:none;cursor:pointer}
  .lvp input::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:linear-gradient(90deg,#e6e3dc 0,#e6e3dc var(--p,100%),rgba(238,234,226,.12) var(--p,100%))}
  .lvp input::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#0b0b0b;box-shadow:0 0 0 2px #e6e3dc}
  .lvp input::-moz-range-track{height:4px;border-radius:99px;background:rgba(238,234,226,.12)}.lvp input::-moz-range-progress{height:4px;border-radius:99px;background:#e6e3dc}
  .lvp input::-moz-range-thumb{width:12px;height:12px;border-radius:50%;background:#0b0b0b;border:2px solid #e6e3dc}
  .kp{position:absolute;right:18px;bottom:96px;z-index:30;width:210px;padding:12px 14px;border-radius:12px;background:#111111;border:1px solid rgba(238,234,226,.14);box-shadow:0 22px 50px -16px rgba(0,0,0,.9);animation:lin .2s ease-out}.kp[hidden]{display:none}
  .kh{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:10.5px;font-weight:600;letter-spacing:.14em;color:#8b8b92}
  .kr{display:flex;justify-content:space-between;align-items:center;height:30px;font-size:12px;font-weight:600;color:#c9c7c2}.kp:not(.on) .kr{opacity:.4}
  .kr button{min-width:76px;height:24px;padding:0 10px;border-radius:7px;border:1px solid rgba(238,234,226,.14);background:none;color:#f1f1f3;font:700 11px Inter,system-ui,sans-serif;letter-spacing:.06em;cursor:pointer}.kr button:hover{border-color:rgba(238,234,226,.34)}.kr button.rec{border-color:#d6d3cc;color:#d6d3cc}
  .sdt .kb.on{color:#e6e3dc}
  .lvf{display:flex;justify-content:space-between;align-items:center;font-size:10.5px;font-weight:600;color:#6f6f75}
  .lvf button{height:22px;padding:0 8px;border-radius:6px;border:1px solid rgba(238,234,226,.14);background:none;color:#9e9ea5;font:600 10.5px Inter,system-ui,sans-serif;cursor:pointer}.lvf button:hover{color:#f1f1f3}
  .bt b{color:#c9c7c2;font-weight:600}.bt b.hot{color:#efb1a7}.bt span:last-child b{color:#f1f1f3}
  .sw{position:relative;width:28px;height:16px;border-radius:99px;border:1px solid rgba(238,234,226,.16);background:rgba(238,234,226,.025);cursor:pointer;flex:none;vertical-align:-3px;margin-left:6px;padding:0;transition:border-color .25s,background .25s}
  .sw:hover{border-color:rgba(238,234,226,.34)}
  .sw:after{content:"";position:absolute;left:3px;top:3px;width:8px;height:8px;border-radius:50%;background:#55555b;transition:transform .25s cubic-bezier(.3,1.4,.5,1),background .25s,box-shadow .25s}
  .sw.on{border-color:rgba(159,215,178,.45);background:rgba(159,215,178,.08)}.sw.on:after{transform:translateX(12px);background:#bfe6cb;box-shadow:0 0 8px rgba(159,215,178,.6)}
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
  .ends b:not(.none){display:none}.ends b{display:block;font-size:13px;font-weight:600;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .ends em{display:block;margin-top:0;font-style:normal;font-size:14px;letter-spacing:-.02em;font-weight:600;font-variant-numeric:tabular-nums;color:#8b8b92}
  .ends .a em{color:#efb1a7}.ends .b em{color:#bfe6cb}.ends .a em.up{color:#bfe6cb}
  .ends b[data-k=e2].none{color:#8b8b92;animation:none;letter-spacing:.06em;font-size:11.5px}
  .ends b.none{color:#efb1a7;letter-spacing:.06em;font-size:11.5px;animation:glow 1.6s ease-in-out infinite}
  @keyframes glow{0%,100%{opacity:.55}50%{opacity:1}}
  .ar{display:grid;grid-template-columns:46px minmax(0,1fr);align-items:center;gap:8px}
  .ar>label{font-size:10.5px;font-weight:700;color:#6f6f75;letter-spacing:.06em}
  .ch{display:flex;gap:5px;min-width:0}.ch .c{flex:1 1 0;min-width:0;padding:0}
  .lgs{display:flex;flex-wrap:wrap;gap:5px}.lgs:empty{display:none}
  .lg{display:inline-flex;align-items:center;height:26px;padding:0 4px 0 11px;border-radius:6px;border:1px solid rgba(238,234,226,.14);color:#d6d3cc;font-size:11.5px;font-weight:700;font-variant-numeric:tabular-nums;animation:lin .35s ease-out}
  .lg button{border:0;background:none;color:#8b8b92;font:700 13px Inter,system-ui,sans-serif;cursor:pointer;padding:0 7px}.lg button:hover{color:#efb1a7}
  .busy:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.35),transparent);animation:sweep 1s linear infinite}
  @keyframes sweep{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
  /* the triggers */
  .sdt{grid-column:1/-1;display:flex;justify-content:center;align-items:center;gap:8px;margin-top:-2px;height:16px}
  .sdt button{border:0;background:none;padding:0 4px;color:#4f4f55;font:600 10px Inter,system-ui,sans-serif;letter-spacing:.12em;text-transform:uppercase;cursor:pointer;transition:color .2s}
  .sdt button:hover{color:#9e9ea5}.sdt button.on{color:#e6e3dc}.sdt i{width:1px;height:9px;background:rgba(238,234,226,.14)}
  .s>.go{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:auto;position:sticky;bottom:0;z-index:3;padding:8px 0 0;background:linear-gradient(180deg,rgba(11,11,11,0),#0b0b0b 10px)}
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
  /* finish: one focus ring, calm hovers, a soft top light on the fire buttons */
  button:focus-visible,input:focus-visible{outline:2px solid rgba(238,234,226,.55);outline-offset:2px}
  .s.notp .sr[data-sr=R]>b,.s.notp .pl .tp b{color:#4f4f55}.s.notp .pl .tp .pe{opacity:.35;pointer-events:none}
  .sw.k-sl,.sw.k-tp,.sw.k-fe{background:#121212;border-color:rgba(238,234,226,.12);box-shadow:inset 0 1px 2px rgba(0,0,0,.5)}
  .sw.k-sl:after,.sw.k-tp:after,.sw.k-fe:after{background:#46464c;box-shadow:0 1px 2px rgba(0,0,0,.6)}
  .sw.k-sl.on{background:linear-gradient(180deg,rgba(232,152,140,.26),rgba(232,152,140,.12));border-color:rgba(239,177,167,.55)}.sw.k-sl.on:after{background:#f6cfc8;box-shadow:0 0 0 1px rgba(232,152,140,.5),0 0 10px rgba(232,152,140,.55)}
  .sw.k-tp.on{background:linear-gradient(180deg,rgba(159,215,178,.26),rgba(159,215,178,.12));border-color:rgba(191,230,203,.55)}.sw.k-tp.on:after{background:#d9f2e1;box-shadow:0 0 0 1px rgba(159,215,178,.5),0 0 10px rgba(159,215,178,.55)}
  .sw.k-fe.on{background:linear-gradient(180deg,rgba(230,227,220,.22),rgba(230,227,220,.1));border-color:rgba(238,234,226,.5)}.sw.k-fe.on:after{background:#f1efea;box-shadow:0 0 0 1px rgba(230,227,220,.45),0 0 10px rgba(230,227,220,.4)}
  .c,.ls,.ldd,.ib,.sw{transition:background .15s,border-color .15s,color .15s,transform .1s}.c:active,.ls:active,.ib:active{transform:scale(.97)}
  .L,.S{box-shadow:inset 0 1px 0 rgba(255,255,255,.14)}.S{box-shadow:inset 0 1px 0 rgba(255,255,255,.06)}
  .L[disabled],.S[disabled]{opacity:.32;cursor:not-allowed;box-shadow:none}
  .L small,.S small,.X small{display:block;font-size:9.5px;font-weight:700;opacity:.5;letter-spacing:.08em;margin-top:1px}
  .lk{grid-column:1/-1;display:flex;align-items:center;gap:12px;height:50px;padding:0 6px 0 16px;border-radius:10px;border:1px solid rgba(232,152,140,.35)}
  .lk i{flex:none;width:9px;height:9px;border-radius:50%;background:#e8988c;animation:br 4s ease-in-out infinite}
  .lk b{font-size:13px;font-weight:600;letter-spacing:.22em;color:#efb1a7}
  .lk span{flex:1;min-width:0;font-size:11.5px;font-weight:600;color:#8b8b92;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lk button{flex:none;height:36px;padding:0 14px;border-radius:8px;border:0;background:#e6e3dc;color:#0b0b0b;font:600 12px Inter,system-ui,sans-serif;cursor:pointer}
  .s>
  .mst{position:relative;height:0;z-index:7}.mst .msg{position:absolute;left:0;right:0;top:6px;padding:7px 11px;border-radius:9px;background:#141414;border:1px solid rgba(238,234,226,.14);box-shadow:0 10px 24px -10px rgba(0,0,0,.8);font-size:11.5px;font-weight:600;color:#c9c7c2;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;transition:opacity .25s,transform .25s}.mst .msg:empty{opacity:0;transform:translateY(-4px);pointer-events:none}.msg.wait{color:#d6d3cc;border-color:rgba(214,211,204,.35)}
  .msg.ok{color:#9fd7b2;border-color:rgba(159,215,178,.35)!important}.msg.bad{color:#efb1a7;border-color:rgba(232,152,140,.4)}
  [hidden]{display:none!important}
  @media (prefers-reduced-motion:reduce){.dot,.moon,.bm .pd:after{animation:none}}`;
  const SL_FMT = { addp: v => (v >= 200 && v % 100 === 0 ? v / 100 + 'x' : trimNum(v) + '%'), risk: v => trimNum(v) + '%', R: v => trimNum(v) + 'R', size: v => (v >= 100 ? 'max' : trimNum(Math.round(v * 10) / 10) + '%') };
  // the reward dial runs on a log scale, so 0.5R and 1R get as much room as 2R to 5R
  const anchors = (A, step) => ({ to: v => { v = Math.max(A[0], Math.min(A[A.length - 1], v)); let i = 0; while (i < A.length - 2 && v > A[i + 1]) i++; return (i + (v - A[i]) / (A[i + 1] - A[i])) * 1000 / (A.length - 1); },
    from: p => { const t = Math.max(0, Math.min(1, p / 1000)) * (A.length - 1), i = Math.min(A.length - 2, Math.floor(t)), v = A[i] + (t - i) * (A[i + 1] - A[i]), k = step(v); return Math.round(v * k) / k; } }); // ticks sit evenly along the dial
  const RLO = 0.25, RHI = 5, LOGD = { addp: anchors([5, 25, 50, 100, 200, 300], v => v < 100 ? 0.2 : 0.1), risk: anchors([0.25, 0.5, 1, 2, 3], v => v < 1 ? 20 : 10), R: { to: v => 1000 * Math.log(Math.max(RLO, Math.min(RHI, v)) / RLO) / Math.log(RHI / RLO), from: p => { const v = RLO * Math.exp(p / 1000 * Math.log(RHI / RLO)); return v < 1 ? Math.round(v * 20) / 20 : Math.round(v * 10) / 10; } } };
  // a slider with the benchmarks as tick marks under it (click one to snap to it)
  function slider(key, label, min, max, step, ticks, extra) {
    const lg = LOGD[key]; if (lg) { min = 0; max = 1000; step = 1; }
    const at = v => ((lg ? lg.to(v) : v) - min) / (max - min) * 100;
    return `<div class="sr" data-sr="${key}"><label>${label}</label>
      <div class="rg"><input type="range" data-r="${key}" min="${min}" max="${max}" step="${step}" aria-label="${label}">
      <div class="tk">${ticks.map(([v, t]) => `<button data-tk="${key}" data-v="${v}" style="left:${at(v)}%">${t}</button>`).join('')}</div></div><b data-sv="${key}" contenteditable="plaintext-only" spellcheck="false" title="Type a value"></b>${extra ? `<div class="ex">${extra}</div>` : ''}</div>`;
  }
  const SLCSS = `
  .sr{display:grid;grid-template-columns:50px 1fr 50px;align-items:start;column-gap:4px}
  .sr>label{font-size:10.5px;font-weight:700;color:#6f6f75;letter-spacing:.06em;line-height:18px}
  .sr>b{font-size:14px;font-weight:600;letter-spacing:-.03em;font-variant-numeric:tabular-nums;color:#f1f1f3;text-align:right;line-height:18px;transition:color .25s;outline:none;white-space:nowrap;justify-self:end;border-radius:5px;cursor:text;padding:0 2px;margin-right:-2px}
  .sr>b:hover{background:rgba(238,234,226,.06)}.sr>b:focus{background:#151515;box-shadow:inset 0 0 0 1px rgba(238,234,226,.3)}
  .sr.off>b{color:#4f4f55}
  .ex{grid-column:1/-1;display:flex;justify-content:flex-end;gap:5px;margin-top:2px}
  .rg{position:relative;padding:0 4px 14px}
  .rg input{-webkit-appearance:none;appearance:none;display:block;width:100%;height:18px;margin:0;background:none;cursor:pointer;outline:none}
  .rg input::-webkit-slider-runnable-track{height:4px;border-radius:99px;background:linear-gradient(90deg,#e6e3dc 0,#e6e3dc var(--p,0%),rgba(238,234,226,.12) var(--p,0%))}
  .rg input::-moz-range-track{height:4px;border-radius:99px;background:linear-gradient(90deg,#e6e3dc 0,#e6e3dc var(--p,0%),rgba(238,234,226,.12) var(--p,0%))}
  .rg input::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;margin-top:-6px;border-radius:50%;background:#e6e3dc;border:3px solid #0b0b0b;box-shadow:0 0 0 1px #e6e3dc,0 0 14px rgba(230,227,220,.28);transition:transform .2s}
  .rg input::-moz-range-thumb{width:10px;height:10px;border-radius:50%;background:#e6e3dc;border:3px solid #0b0b0b;box-shadow:0 0 0 1px #e6e3dc,0 0 14px rgba(230,227,220,.28)}
  .rg input:hover::-webkit-slider-thumb,.rg input:active::-webkit-slider-thumb{transform:scale(1.18)}
  .rg input:focus-visible::-webkit-slider-thumb{box-shadow:0 0 0 2px #e6e3dc}
  .sr.off .rg input::-webkit-slider-runnable-track{background:rgba(238,234,226,.1)}
  .sr.off .rg input::-webkit-slider-thumb{background:#4f4f55;box-shadow:0 0 0 1px #4f4f55}
  .tk{position:absolute;left:12px;right:12px;bottom:0;height:13px}
  .tk button{position:absolute;transform:translateX(-50%);padding:0 3px;border:0;background:none;color:#5c5c62;font:700 9.5px Inter,system-ui,sans-serif;cursor:pointer;letter-spacing:.02em;transition:color .2s}
  .tk button:before{content:"";position:absolute;left:50%;top:-6px;width:1px;height:4px;background:rgba(238,234,226,.18)}
  .tk button:hover{color:#f1f1f3}.tk button.on{color:#e6e3dc}
  .rg .tk button:not(.on){opacity:0;transition:opacity .2s,color .2s}.rg:hover .tk button,.rg:focus-within .tk button{opacity:1}
  .ld{position:relative;display:flex;align-items:center;gap:6px;flex:none;z-index:4}.ld>*{flex:none}
  .ldd{flex:1 1 auto!important;min-width:0;display:flex;align-items:center;gap:8px;height:30px;padding:0 10px 0 12px;border-radius:9px;border:1px solid rgba(238,234,226,.12);background:rgba(238,234,226,.025);color:#c9c7c2;font:700 12px Inter,system-ui,sans-serif;cursor:pointer;transition:border-color .2s,background .2s;white-space:nowrap;overflow:hidden}
  .ldd:hover,.ldd.op{border-color:rgba(238,234,226,.3);background:rgba(238,234,226,.05);color:#f1f1f3}.ldd:disabled{cursor:default;opacity:.55}
  .ldd .dt{width:6px;height:6px;border-radius:50%;background:#55555b;flex:none}.ldd.on .dt{background:#bfe6cb;box-shadow:0 0 8px rgba(159,215,178,.6)}
  .ldd b{font-weight:700;color:#f1f1f3;overflow:hidden;text-overflow:ellipsis}.ldd:not(.on) b{color:#9e9ea5}
  .ldd small{margin-left:auto;font-size:10px;font-weight:600;color:#7a7a80;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis}
  .ldd i{font-style:normal;width:8px;height:8px;flex:none;border-right:1.5px solid #7a7a80;border-bottom:1.5px solid #7a7a80;transform:translateY(1px) rotate(-135deg);transition:transform .2s}.ldd.op i{transform:translateY(-2px) rotate(45deg)}
  .ls{flex:none;height:30px;min-width:30px;padding:0 10px;border-radius:9px;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:700 12px Inter,system-ui,sans-serif;cursor:pointer;transition:all .2s;white-space:nowrap}
  .ls:hover{color:#f1f1f3;border-color:rgba(238,234,226,.3)}.ls.on{background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b}
  .ln{display:flex;gap:6px;flex:1 0 100%!important}.ln[hidden]{display:none}.ld:has(.ln:not([hidden]))>:not(.ln){display:none}
  .ln input{flex:1;min-width:0;height:30px;padding:0 12px;border-radius:9px;border:1px solid rgba(238,234,226,.3);background:#0b0b0b;color:#f1f1f3;font:700 12px Inter,system-ui,sans-serif;outline:none}
  .ll{position:absolute;left:0;right:0;bottom:calc(100% + 6px);display:flex;flex-direction:column;gap:2px;max-height:210px;overflow-y:auto;scrollbar-width:none;padding:5px;border-radius:12px;border:1px solid rgba(238,234,226,.14);background:#101010;box-shadow:0 -18px 40px -8px rgba(0,0,0,.75);animation:lup .16s ease-out;transform-origin:bottom}.ll[hidden]{display:none}.ll::-webkit-scrollbar{display:none}
  @keyframes lup{from{opacity:0;transform:translateY(4px) scale(.98)}to{opacity:1;transform:none}}
  .lc{position:relative;flex:none;display:flex;align-items:center;height:32px;border-radius:8px;transition:background .15s}
  .lc:hover{background:rgba(238,234,226,.06)}.lc.on{background:rgba(159,215,178,.08)}
  .lc button{height:100%;border:0;background:none;color:#c9c7c2;font:700 12px Inter,system-ui,sans-serif;cursor:pointer}
  .lc button:first-child{flex:1;min-width:0;display:flex;align-items:center;gap:8px;padding:0 6px 0 10px;text-align:left}
  .lc button:first-child:before{content:"";width:6px;height:6px;border-radius:50%;flex:none;background:rgba(238,234,226,.14)}.lc.on button:first-child:before{background:#bfe6cb;box-shadow:0 0 8px rgba(159,215,178,.6)}
  .lc.on button{color:#f1f1f3}
  .lc button small{margin-left:auto;font-size:10px;font-weight:600;color:#7a7a80;font-variant-numeric:tabular-nums}.lc.on button small{color:#9fd7b2}
  .lc button.x{width:26px;flex:none;color:#55555b;font-size:14px;opacity:0;transition:opacity .15s,color .15s}
  .lc:hover button.x{opacity:1}.lc button.x:hover{color:#efb1a7}
  @keyframes lin{from{opacity:0;transform:scale(.9)}to{opacity:1;transform:none}}`;
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
    const cuts = (attr, cls, vs) => (vs || [25, 50, 75]).map(v => `<button class="c${cls || ''}" data-${attr}="${v}">${v}%</button>`).join('');
    R.innerHTML = `<style>${SCSS}${SLCSS}</style><div class="s">
      <div class="mw"><canvas class="moon" width="660" height="660"></canvas></div>
      <div class="hd" data-a="drag"><i class="dot"></i><div class="brand">GP.<span>SHOT</span></div><div class="sp"></div>
        <button class="ib" data-a="zone" title="Zone"><i></i><span data-k="zc">zone</span></button><button class="ib gr" data-a="cth" title="Settings" aria-label="Settings"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.6M12 18.9v2.6M4.6 4.6l1.9 1.9M17.5 17.5l1.9 1.9M2.5 12h2.6M18.9 12h2.6M4.6 19.4l1.9-1.9M17.5 6.5l1.9-1.9"/></svg><i class="cs" data-k="cts" hidden></i></button><button class="ib" data-a="copy" title="Copier"><i></i><span data-k="cp">desk</span></button><button class="ib" data-a="vest" title="Vest's ticket">Vest</button></div>
      <div class="ctm" data-k="ctm" hidden><div class="ctt">Settings</div><span class="cth">LOOK</span><div class="ctr"><button data-look="vest">Vest</button><button data-look="gp">GP.</button></div><span class="cth">CHART</span><div class="ctg" data-k="ctg"></div><div class="cted"><label title="Background"><input type="color" data-cc="bg"><i></i><small>BG</small></label><label title="Up candles"><input type="color" data-cc="up"><i></i><small>UP</small></label><label title="Down candles"><input type="color" data-cc="dn"><i></i><small>DOWN</small></label><button data-a="csave" title="Save the chart's colours as it looks now, from GP. or the chart's own settings">save</button></div><span class="cth">LINES</span><div class="ctr"><button data-lst="0">solid</button><button data-lst="2">dashed</button><button data-lst="1">dotted</button></div><span class="cth">CODE GIGA AT CHECKOUT</span><div class="ctr"><button data-giga="1" title="GIGA goes on every account you buy, in place of any other code">on</button><button data-giga="0">off</button></div><span class="cth">TRADE</span><div class="ctr"><button data-am="abe" title="Stop to break even once the trade reaches +1R">auto BE at 1R</button><button data-am="atr" title="After +1R the stop locks profit in 0.5R steps">trail 0.5R</button></div><span class="cth">GP. PILL</span><div class="ctr"><button data-pil="1">on</button><button data-pil="0">off</button></div><span class="cth">TOOLS</span><div class="ctr"><button data-a="keys" title="Keyboard shortcuts">keys</button><button data-a="snap" title="Put the ticket, the desk and the chart back in place">reset layout</button></div></div>
      <div class="mk"><b><em data-k="px">—</em><i class="fr" data-k="fr"></i></b><span data-k="ac">—</span></div>
      <div class="mst"><div class="msg" data-k="msg"></div></div>
      <div class="lvp" data-k="lvp" hidden><div class="lvh"><span>LEVERAGE</span><b data-k="lvv">—</b></div><input type="range" data-k="lvr" min="1" max="50" step="1" aria-label="Leverage"><div class="lvf"><span>1x</span><button data-a="levmax">max <span data-k="lvm"></span></button></div></div>
      <div class="zr" data-k="zr" hidden><div class="zs" data-k="zs"></div>
        <div class="zi" data-k="zi"><label>LOCK</label><input class="n" data-z="loss" inputmode="decimal" placeholder="−$ loss" aria-label="Lock after this loss"><input class="n" data-z="n" inputmode="numeric" placeholder="losers" aria-label="Lock after this many losers"><button class="ls on" data-a="zgo">enter</button></div>
        <button class="ls" data-a="zend" hidden>end</button></div>
      <div class="pv" data-v="plan">
        <div class="adh" data-k="adh" hidden><span data-k="adt">—</span><button data-a="addback">back</button></div>
        <div class="pl"><div class="sl"><small>STOP<button class="sw sm k-sl" data-t="sl" title="Stop loss on or off" aria-label="Stop loss on or off"></button></small><b data-k="slv">—</b><em data-k="slp">—</em><div class="pe"><input class="n" data-n="rusd" inputmode="decimal" placeholder="$ stop" aria-label="Dollar stop"></div></div><div class="tp"><small>TARGET<button class="sw sm k-tp" data-t="tp" title="Target on or off" aria-label="Target on or off"></button></small><b data-k="tpv">—</b><em data-k="tpp">—</em><div class="pe"><button class="c pass" data-a="pass" title="Pass line">PASS</button><input class="n" data-n="usd" inputmode="decimal" placeholder="$ gain" aria-label="Dollar target"></div></div></div>
        <div class="bm" data-k="bm0">${BEAM}</div>
        ${slider('risk', 'RISK', 0.25, 3, 0.05, [[0.25, '.25'], [0.5, '.5%'], [1, '1%'], [2, '2%'], [3, '3%']])}
        ${slider('R', 'REWARD', RLO, RHI, 0.05, [[0.5, '.5R'], [1, '1R'], [2, '2R'], [3, '3R']])}
        ${slider('size', 'SIZE', 5, 100, 1, [[25, '25%'], [50, '50%'], [75, '75%'], [100, 'max']])}
        <div class="bal"><div class="bb"><i data-k="fb" style="width:0"></i></div><div class="bt"><span>fees <b data-k="fe">—</b><button class="sw k-fe" data-t="fees" title="Fees inside the risk" aria-label="Fees inside the risk"></button></span><span data-k="qz"></span></div></div>
        <div class="ld"><button class="ldd" data-a="ldd" data-k="ldd" title="Loadouts"></button><div class="ll" data-k="ll" hidden></div><button class="ls" data-a="lsave" title="Save loadout" data-k="lsv">+</button>
          <div class="ln" data-k="ln" hidden><input data-k="lname" maxlength="18" placeholder="name it" aria-label="Loadout name"><button class="ls on" data-a="lok">save</button><button class="ls" data-a="lno">×</button></div></div>
      </div>
      <div class="tv" data-v="pos" hidden>
        <div class="th"><span data-k="ph">—</span><span data-k="pe">—</span></div>
        <div class="pu"><b data-k="pu">—</b><span data-k="pr"></span></div>
        <div class="bm" data-k="bm1">${BEAM}</div>
        <div class="ends"><div class="a"><b data-k="e1">—</b><em data-k="e1s"></em></div><div class="b"><b data-k="e2">—</b><em data-k="e2s"></em></div></div>
        ${slider('addp', 'ADD', 5, 300, 5, [[25, '25%'], [50, '50%'], [100, '100%'], [200, '2x'], [300, '3x']])}
        <div class="ar"><label></label><div class="ch"><button class="c grn" data-a="addx" data-k="addx" title="Adds this share of the trade's first size, each click">add</button></div></div>
        <div class="ar"><label>CLOSE</label><div class="ch">${cuts('cut', '', [10, 20, 25, 50, 75])}</div></div>
        <div class="ar"><label>LIMIT</label><div class="ch">${cuts('lim', ' gold', [10, 20, 25, 50, 75])}</div></div>
        <div class="ar"><label>STOP</label><div class="ch"><button class="c" data-a="half">½ risk</button><button class="c" data-a="be">break even</button><button class="c rose" data-a="addstop" hidden>add stop</button></div></div>
        <div class="lgs" data-k="lgs"></div>
      </div>
      <div class="go" data-v="go"><button class="L" data-a="long">Long<small data-kk="long"></small></button><button class="S" data-a="short">Short<small data-kk="short"></small></button><div class="sdt" title="Which side the stop, target and lines are set for"><button data-sd="long">long</button><i></i><button data-sd="short">short</button></div></div>
      <div class="go" data-v="go2" hidden><button class="X" data-a="close">Close<small data-kk="close"></small></button></div>
      <div class="go" data-v="go4" hidden><button class="L" data-a="addgo"><span data-k="addq">Add</span><small data-kk="add"></small></button><button class="X" data-a="close2">Close<small data-kk="close"></small></button></div>
      <div class="kp" data-k="kp" hidden><div class="kh"><span>KEYS</span><button class="sw" data-kt="keys" aria-label="Keyboard shortcuts on or off"></button></div>
        <div class="kr"><span>Long</span><button data-kb="long"></button></div><div class="kr"><span>Short</span><button data-kb="short"></button></div><div class="kr"><span>Close</span><button data-kb="close"></button></div></div>
      <div class="go" data-v="go3" hidden><div class="lk"><i></i><b>LOCKED</b><span data-k="lk"></span></div></div>
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
    // a dollar stop: the risk in dollars instead of a share of the balance
    const rusd = R.querySelector('[data-n=rusd]');
    rusd.onchange = () => { const v = parseFloat(String(rusd.value).replace(/[$,\s]/g, '')); if (v > 0) { SH.rusd = Math.round(v * 100) / 100; SH.rmode = 'usd'; } else SH.rmode = 'pct'; saveSH(); redo(); };
    rusd.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') rusd.blur(); };
    R.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { SH[b.dataset.t] = !SH[b.dataset.t]; saveSH(); redo(); });
    const setSl = (key, v) => { v = Math.round(+v * 100) / 100; if (!(v > 0)) return; SH[key] = v; if (key === 'R') SH.tmode = 'R'; if (key === 'risk') SH.rmode = 'pct'; redo(); };
    R.querySelectorAll('[data-r]').forEach(i => { i.oninput = () => setSl(i.dataset.r, LOGD[i.dataset.r] ? LOGD[i.dataset.r].from(+i.value) : i.value); i.onchange = () => saveSH(); });
    R.querySelectorAll('[data-tk]').forEach(b => b.onclick = () => { setSl(b.dataset.tk, b.dataset.v); saveSH(); });
    // leverage: tap the "25x" for a slider from 1x to the market's max; it closes on release
    const lvp = k('lvp'), lvr = k('lvr');
    const lvShow = () => { const p = plan(); if (!p.sym || !p.levMax) return; lvr.max = p.levMax; lvr.value = p.lev; k('lvm').textContent = p.levMax + 'x'; lvPaint(); lvp.hidden = false; };
    const lvPaint = () => { const mx = +lvr.max || 1; k('lvv').textContent = lvr.value + 'x'; lvr.style.setProperty('--p', (mx > 1 ? (lvr.value - 1) / (mx - 1) * 100 : 100) + '%'); };
    const lvSet = v => { const p = plan(); if (!p.sym) return; SH.levs = SH.levs || {}; if (v >= (p.levMax || v)) delete SH.levs[p.sym]; else SH.levs[p.sym] = v; saveSH(); redo(); };
    k('ac').addEventListener('click', e => { if (e.target.closest('[data-a=lev]')) { e.stopPropagation(); lvp.hidden ? lvShow() : (lvp.hidden = true); } });
    lvr.oninput = () => { lvPaint(); lvSet(+lvr.value); };
    lvr.onchange = () => { lvSet(+lvr.value); lvp.hidden = true; };
    on('levmax', () => { lvSet(1e9); lvp.hidden = true; });
    R.querySelector('.s').addEventListener('pointerdown', e => { if (!lvp.hidden && !e.composedPath().includes(lvp) && !e.target.closest('[data-a=lev]')) lvp.hidden = true; });
    const TYPED = { addp: [1, 500], risk: [0.01, 20], R: [0.1, 20], size: [1, 100] };
    R.querySelectorAll('[data-sv]').forEach(b => {
      const key = b.dataset.sv, done = keep => { if (keep) { const t = b.textContent.trim().toLowerCase(), v = key === 'size' && /max/.test(t) ? 100 : parseFloat(t.replace(/[^0-9.]/g, ''));
        if (v > 0) { setSl(key, Math.max(TYPED[key][0], Math.min(TYPED[key][1], v))); saveSH(); } } b.blur(); redo(); };
      b.onfocus = () => { b.textContent = trimNum(+SH[key]); const r = document.createRange(); r.selectNodeContents(b); const sel = R.getSelection ? R.getSelection() : getSelection(); sel.removeAllRanges(); sel.addRange(r); };
      b.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); done(true); } else if (e.key === 'Escape') done(false); };
      b.onblur = () => { if (b.textContent.trim() !== trimNum(+SH[key])) done(true); else redo(); };
    });
    // loadouts: the three dials, the target mode and the fees switch, under a name
    const ln = k('ln'), lname = k('lname');
    const openName = v => { ln.hidden = !v; R.querySelector('[data-a=lsave]').hidden = v; if (v) { lname.value = ''; lname.focus(); } };
    on('lsave', () => openName(true)); on('lno', () => openName(false));
    const ldOpen = v => { k('ll').hidden = !v; k('ldd').classList.toggle('op', !!v); };
    on('ldd', () => ldOpen(k('ll').hidden && (DB.loads || []).length > 0));
    k('ldd').addEventListener('wheel', e => { const L0 = DB.loads || []; if (!L0.length) return; e.preventDefault(); const cur = L0.findIndex(x => x.n === SH.ldn), i = ((cur < 0 ? -1 : cur) + (e.deltaY > 0 ? 1 : -1) + L0.length) % L0.length;
      const b = R.querySelector('.lc[data-i="' + i + '"] button:first-child'); if (b) { b.click(); ldOpen(false); } }, { passive: false });
    R.addEventListener('pointerdown', e => { if (!k('ll').hidden && !e.composedPath().some(n => n === k('ll') || n === k('ldd'))) ldOpen(false); });
    const keep = () => { const n = lname.value.trim().slice(0, 18); if (!n) return lname.focus(); const L0 = (DB.loads || []).filter(x => x.n.toLowerCase() !== n.toLowerCase()); L0.push(Object.assign({ n }, loadOf())); SH.ldn = n; saveSH(); DB.loads = L0.slice(-12); save(); openName(false); renderShot(); };
    on('lok', keep);
    lname.onkeydown = e => { if (e.key === 'Enter') keep(); else if (e.key === 'Escape') openName(false); };
    k('ll').onclick = e => { const c = e.target.closest('.lc'); if (!c) return; const L0 = DB.loads || [], x = L0[+c.dataset.i]; if (!x) return;
      if (e.target.closest('.x')) { L0.splice(+c.dataset.i, 1); DB.loads = L0; save(); if (!L0.length) ldOpen(false); renderShot(); return; }
      ldOpen(false); SH.ldn = x.n;
      Object.assign(SH, { risk: x.risk, rmode: x.rmode === 'usd' ? 'usd' : 'pct', rusd: +x.rusd || 0, R: x.R, tmode: x.tmode, usd: x.usd, size: x.size, fees: x.fees }); saveSH(); redo(); };
    const ctm = k('ctm');
    on('cth', () => { ctm.hidden = !ctm.hidden; renderShot(); });
    R.querySelectorAll('[data-look]').forEach(b => b.onclick = () => { DB.skin = b.dataset.look !== 'vest'; save(true); ctm.hidden = true; skinKey = ''; vestPanels(); applySkin(); renderShot(); drawChart(); });
    R.querySelectorAll('[data-am]').forEach(b => b.onclick = () => { DB[b.dataset.am] = !DB[b.dataset.am]; save(true); renderShot(); });
    R.querySelectorAll('[data-pil]').forEach(b => b.onclick = () => { DB.pill = b.dataset.pil === '1'; save(true); ctm.hidden = true; placePill(); if (!DB.pill && OPEN) closePanel(); renderShot(); });
    R.querySelectorAll('[data-giga]').forEach(b => b.onclick = () => { DB.giga = b.dataset.giga === '1'; DB.gigaSkip = 0; save(true); ctm.hidden = true; renderShot(); });
    R.querySelectorAll('[data-lst]').forEach(b => b.onclick = () => { DB.lst = +b.dataset.lst; save(true); ctm.hidden = true; renderShot(); drawChart(); });
    const paintNow = () => { DB.cthPaint = true; save(true); skinKey = ''; applySkin(); renderShot(); };
    k('ctg').addEventListener('click', e => { const d = e.target.closest('[data-cdel]'); if (d) { e.stopPropagation(); DB.cthc = (DB.cthc || []).filter(c => c.id !== d.dataset.cdel); if (DB.cth === d.dataset.cdel) DB.cth = 'vest'; paintNow(); return; }
      const b = e.target.closest('[data-cth]'); if (!b) return; DB.cth = b.dataset.cth; ctm.hidden = true; paintNow(); });
    R.querySelectorAll('[data-cc]').forEach(inp => inp.oninput = () => { const t = cTheme(), d = readChart() || { bg: t.bg, up: t.up, dn: t.dn, upB: t.upB, dnB: t.dnB, upW: t.upW, dnW: t.dnW }; if (inp.dataset.cc === 'up') d.upB = d.upW = inp.value; if (inp.dataset.cc === 'dn') d.dnB = d.dnW = inp.value; d[inp.dataset.cc] = inp.value; DB.cthd = d; DB.cth = 'draft'; paintNow(); });
    on('csave', () => { const t = cTheme(), live = readChart(), L = Array.isArray(DB.cthc) ? DB.cthc : []; if (L.length >= 10) L.shift(); let n = 1; while (L.some(c => c.name === 'Mine ' + n)) n++;
      const c = Object.assign({ id: 'u' + Date.now().toString(36), name: 'Mine ' + n }, live || { bg: t.bg, up: t.up, dn: t.dn, upB: t.upB, dnB: t.dnB, upW: t.upW, dnW: t.dnW }); L.push(c); DB.cthc = L; DB.cth = c.id; delete DB.cthd; paintNow(); });
    R.addEventListener('pointerdown', e => { if (!ctm.hidden && !e.composedPath().some(n => n === ctm || (n.dataset && n.dataset.a === 'cth'))) { ctm.hidden = true; renderShot(); } });
    const kp = k('kp');
    on('snap', () => { k('ctm').hidden = true; snapAll(); });
    on('keys', () => { k('ctm').hidden = true; kp.hidden = !kp.hidden; KREC = null; renderShot(); });
    const kpOff = e => { if (!kp.hidden && !(e && e.composedPath().some(n => n === kp || (n.dataset && n.dataset.a === 'keys')))) { kp.hidden = true; KREC = null; renderShot(); } };
    SHOT.kpOff = kpOff; document.addEventListener('pointerdown', kpOff, true); R.addEventListener('pointerdown', kpOff);
    R.querySelector('[data-kt=keys]').onclick = () => { SH.keys.on = !SH.keys.on; KREC = null; saveSH(); renderShot(); };
    R.querySelectorAll('[data-kb]').forEach(b => b.onclick = () => { KREC = KREC === b.dataset.kb ? null : b.dataset.kb; renderShot(); });
    on('long', () => fire('long')); on('short', () => fire('short')); on('close', closeMine); on('close2', closeMine);
    on('addback', () => addOn(false)); on('addgo', addMore);
    R.querySelectorAll('[data-sd]').forEach(b => b.onclick = () => { SH.side = b.dataset.sd; saveSH(); redo(); });
    on('vest', () => { SH.on = false; saveSH(); placeShot(); clearLines(); });
    // in the trade
    R.querySelectorAll('[data-cut]').forEach(b => b.onclick = () => cut(+b.dataset.cut));
    on('addx', () => addPct(SH.addp));
    R.querySelectorAll('[data-lim]').forEach(b => b.onclick = () => scaleOut(+b.dataset.lim));
    on('be', breakEven); on('half', halfRisk); on('addstop', addStop);
    k('lgs').onclick = e => { const b = e.target.closest('button'); if (b) dropLeg(b.dataset.id); };
    // zone: entered from the ticket with its lock, ended from it
    R.querySelectorAll('[data-z]').forEach(i => { i.value = ZL[i.dataset.z] > 0 ? ZL[i.dataset.z] : ''; i.onchange = () => { const v = Math.abs(parseFloat(String(i.value).replace(/[^\d.]/g, ''))); ZL[i.dataset.z] = v > 0 ? (i.dataset.z === 'n' ? Math.round(v) : Math.round(v * 100) / 100) : 0; DB.zl = ZL; save(); renderShot(); }; i.onkeydown = e => { if (e.key === 'Enter') i.blur(); }; });
    on('zone', () => { SHOT.zopen = !SHOT.zopen; renderShot(); });
    on('zgo', () => { SHOT.zopen = false; if (!DB.zone) zoneStart(); renderShot(); });
    const end = () => { SHOT.zopen = false; if (DB.zone) zoneEnd(); renderShot(); };
    on('zend', end);
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
  let OCOL = null;
  function orderCol() { // the column that holds Vest's ticket: the child of the row that also holds the chart
    const card = vestTicket(), fr = document.querySelector('iframe[id^=tradingview_]');
    if (!card || !fr) return OCOL && OCOL.isConnected && fr && OCOL.parentElement && OCOL.parentElement.contains(fr) ? OCOL : null;
    let c = card; while (c.parentElement && c.parentElement !== document.body && !c.parentElement.contains(fr)) c = c.parentElement;
    return (OCOL = c.parentElement && c.parentElement.contains(fr) && !c.contains(fr) ? c : null);
  }
  function splitTotal(col) { // chart column + order column: the two that share the room
    const fr = document.querySelector('iframe[id^=tradingview_]'), ch = [...col.parentElement.children].find(e => e.contains(fr));
    // from the row's own width, not the two columns: when Vest adds something wide (the Extended hours badge) the chart column
    // can grow past its share, and measuring it fed back into the width we set — the ticket rocked side to side
    const P = col.parentElement, ps = getComputedStyle(P), kids = [...P.children].filter(e => e.offsetParent !== null || e === col || e === ch);
    let avail = P.getBoundingClientRect().width - (parseFloat(ps.paddingLeft) || 0) - (parseFloat(ps.paddingRight) || 0) - (parseFloat(ps.columnGap) || 0) * Math.max(0, kids.length - 1);
    for (const e of kids) { if (e === col || e === ch) continue; avail -= e.getBoundingClientRect().width; }
    if (ch) avail -= parseFloat(getComputedStyle(ch).marginLeft) || 0;
    const sum = col.getBoundingClientRect().width + (ch ? ch.getBoundingClientRect().width : 0);
    return avail > 200 ? Math.min(sum, avail) : sum;
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
    if (!col && on && Date.now() - (layoutCols.seen || 0) < 1500) return; // Vest re-mounting its ticket for a moment: hold the layout, no jump
    if (col) layoutCols.seen = Date.now();
    document.querySelectorAll('[data-gpz-col]').forEach(e => { if (e !== col) e.removeAttribute('data-gpz-col'); });
    if (!col) { if (SPL) SPL.style.display = 'none'; return; }
    const own = DB.colF == null || !(DB.colF > 0); // no drag yet: Vest's layout as it is
    if (own) col.removeAttribute('data-gpz-col');
    if (!own) { const f = Math.max(0.18, Math.min(0.6, DB.colF)), tot = splitTotal(col), w = Math.max(300, Math.round(tot * f)) + 'px'; // the width lives in our own rule: Vest rewrites <html>'s style
      let st = document.getElementById('gpz-col-css'); if (!st) { st = document.createElement('style'); st.id = 'gpz-col-css'; document.documentElement.appendChild(st); }
      const css = `[data-gpz-col]{flex:0 0 ${w}!important;width:${w}!important;max-width:none!important;min-width:0!important;box-sizing:border-box!important}`, was = parseFloat((st.textContent.match(/flex:0 0 ([\d.]+)px/) || [])[1]) || 0; if (st.textContent !== css && (SPL && SPL.drag || Math.abs(was - parseFloat(w)) >= 8)) st.textContent = css; // small wobbles in Vest's layout never move the ticket
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
  // one of Vest's own windows is up (checkout, settings, a confirm): GP. steps out of its way and comes back docked when it closes
  // Vest's own menus and dropdowns (account picker, market list…) sit above GP. while they are open
  const POPS = '[role=menu],[role=listbox]'; // menus only: tooltips and hover cards (Vest's Extended badge…) never move GP., or the two flicker over each other
  function vestPop() { for (const e of document.querySelectorAll(POPS)) { if (e.closest('[id^=gpz-]') || e.getAttribute('data-state') === 'closed') continue; const r = e.getBoundingClientRect(); if (r.width > 20 && r.height > 20) return true; } return false; }
  let popLow = false;
  function popZ() { const low = vestPop(); if (low === popLow) return; popLow = low; ['gpz-shot', 'gpz-peek', 'gpz-desk'].forEach(id => { const h = document.getElementById(id); if (h) h.style.zIndex = low ? '1' : id === 'gpz-desk' ? '2147483640' : '2147483639'; }); }
  let popObs = null;
  function watchPops() { if (popObs || !document.body) return; popObs = new MutationObserver(popZ); popObs.observe(document.body, { childList: true }); document.addEventListener('pointerdown', () => setTimeout(popZ, 30), true); document.addEventListener('keydown', () => setTimeout(popZ, 30), true); }
  function vestModal() { for (const d of document.querySelectorAll('[role=dialog],[role=alertdialog]')) { if (d.closest('[id^=gpz-]') || d.getAttribute('data-state') === 'closed') continue; const r = d.getBoundingClientRect(); if (r.width > 120 && r.height > 120) return true; } return false; }
  function placeShot() {
    const S = shotHost(), on = SH.on && IS_TRADE() && !!AUTH;
    if (on && vestModal()) { SHOT.visible = false; S.host.style.display = 'none'; S.peek.style.display = 'none'; if (DS) DS.host.style.display = 'none'; return; }
    { const id = activeAcct(); if (on && L.capAt && id && !capAcctOld(id)) { // the Primary account can't trade: Vest's own panel shows, GP. waits for a trading account
      SHOT.visible = false; S.host.style.display = 'none'; S.peek.style.display = 'none'; tkFit(null); return; } }
    const card = IS_TRADE() ? vestTicket() : null; let r = card && card.getBoundingClientRect();
    if (r && r.width > 200 && r.height > 300) SHOT.lastH = r.height;
    else if (IS_TRADE()) { const oc = orderCol(); if (oc) { const q = oc.getBoundingClientRect(); if (q.width > 200) r = { left: q.left, top: q.top, right: q.right, width: q.width, height: Math.min(q.height, SHOT.lastH || 640) }; } } // Vest swapped its ticket out: stay where it was
    SHOT.visible = on;
    if (!on) { tkFit(null); S.host.style.display = 'none'; const pk = S.peek; if (IS_TRADE() && r && r.width > 150) { pk.style.display = ''; pk.style.left = (r.right - 160) + 'px'; pk.style.top = (r.top + 4) + 'px'; } else pk.style.display = 'none'; return; }
    S.peek.style.display = 'none';
    let x, y, w, h;
    const st = S.host.style, docked = SH.dock && r && r.width > 200 && r.height > 300;
    if (docked) { x = r.left; y = r.top; w = r.width; } else { w = 320; x = SH.x != null ? SH.x : innerWidth - w - 16; }
    st.display = ''; st.width = Math.round(w) + 'px';
    // as tall as what's in it, on any screen: no dead space under Long / Short, no scroll
    const room = Math.max(320, innerHeight - (docked ? Math.max(0, y) : 24) - 8), nat = shotNat(S);
    h = Math.min(room, nat || room);
    if (!docked) y = SH.y != null ? SH.y : Math.max(12, innerHeight - h - 16);
    st.left = Math.round(x) + 'px'; st.top = Math.round(y) + 'px'; st.height = Math.round(h) + 'px';
    tkFit(docked && card && card.isConnected ? card : null, h);
  }
  function shotNat(S) { // the ticket's own height with nothing stretched
    const host = S.host, box = S.R.querySelector('.s'), h0 = host.style.height;
    host.style.height = 'auto'; box.style.height = 'auto'; const n = Math.ceil(box.getBoundingClientRect().height);
    box.style.height = ''; host.style.height = h0; return n > 200 ? n : 0;
  }
  const TKP = ['height', 'max-height', 'min-height', 'flex-grow', 'flex-shrink', 'overflow'];
  function tkFit(card, h) { // Vest's ticket under GP. takes GP.'s height, so what sits below it moves up
    document.querySelectorAll('[data-gpz-tk]').forEach(e => { if (e !== card) { e.removeAttribute('data-gpz-tk'); TKP.forEach(k => e.style.removeProperty(k)); } });
    if (!card || !(h > 200)) return;
    const px = Math.round(h) + 'px', st = card.style; // set on the element itself: Vest rewrites <html>'s style, so a variable there gets lost
    if (st.getPropertyValue('height') !== px) { st.setProperty('height', px, 'important'); st.setProperty('max-height', px, 'important'); st.setProperty('min-height', px, 'important'); st.setProperty('flex-grow', '0', 'important'); st.setProperty('flex-shrink', '0', 'important'); st.setProperty('overflow', 'hidden', 'important'); }
    card.setAttribute('data-gpz-tk', '');
  }

  const NM = {}, CAPOLD = {}; // names and kinds stay known after an account closes
  const capAcctOld = id => capAcct(id) || CAPOLD[id] || null;
  const acctShort = id => (L.names && L.names[id]) || (capAcct(id) ? (CAPOLD[id] = capAcct(id), NM[id] = 'Account ' + ((+capAcct(id).attempt_index || 0) + 1)) : NM[id] || '…' + String(id).slice(-4));
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
    if (p.closed && SHOT.closedFor !== p.id) { SHOT.closedFor = p.id; DK.tab = 'acc'; saveDK();
      const was = capAcctOld(p.id), pool = (L.cap || []).filter(c => c.status === 2 && L.bal[c.id] != null && c.id !== p.id);
      const next = pool.filter(c => !was || c.account_type === was.account_type).sort((a, b) => (cashOf(b.id) || 0) - (cashOf(a.id) || 0))[0] || pool[0];
      setTimeout(() => { if (!DK.open) deskToggle(true); else renderDesk(); if (next) { shotMsg(acctShort(p.id) + ' closed · on ' + acctShort(next.id), 'bad'); switchAcct(next.id); } }, 0); }
    renderCopy(p);
    const zb = zoneBits(), locked = zb.locked && !pos;
    const stale = !(Date.now() - (L.markAt || 0) < FRESH);
    k('px').textContent = p.sym && L.mark[p.sym] ? shortSym(p.sym) + '  ' + fmtPx(L.mark[p.sym], p.sym) : '—'; k('px').classList.toggle('old', stale);
    { const ca = p.id && capAcct(p.id), fund = !!ca && ca.account_type === 3 && p.bal > 0; R.querySelectorAll('[data-tk=risk]').forEach(b => { if (b.dataset.l == null) b.dataset.l = b.textContent; b.textContent = fund ? '$' + trimNum(Math.round(p.bal * +b.dataset.v / 100)) : b.dataset.l; }); }
    { const age = (Date.now() - (L.markAt || 0)) / 1000, f = k('fr'); f.className = 'fr ' + (age < 1.6 ? 'ok' : age < 4 ? 'mid' : 'bad'); f.title = 'price ' + (age < 60 ? age.toFixed(1) + 's' : 'over a minute') + ' old'; }
    k('ac').innerHTML = p.id && p.bal ? `${esc(acctShort(p.id).replace(/^Account /, '#'))} · <button class="lvb${p.lev && p.levMax && p.lev < p.levMax ? ' set' : ''}" data-a="lev" title="Leverage">${p.lev || '—'}x</button> · ${p.bal >= 1e3 ? '$' + trimNum(Math.round(p.bal / 10) / 100) + 'K' : fm(p.bal, { short: true }).replace(/\.00$/, '')}` : '';
    if (!pos) SHOT.adding = false; const adding = !!pos && !!SHOT.adding;
    R.querySelector('[data-v=plan]').hidden = !!pos && !adding; R.querySelector('[data-v=pos]').hidden = !pos || adding;
    R.querySelector('[data-v=go]').hidden = !!pos || locked; R.querySelector('[data-v=go2]').hidden = !pos || adding; R.querySelector('[data-v=go3]').hidden = !locked; R.querySelector('[data-v=go4]').hidden = !adding;
    box.classList.toggle('in', !!pos && !adding); box.classList.toggle('nosl', SH.sl === false && !(pos && !adding)); box.classList.toggle('add', adding); box.classList.toggle('notp', SH.tp === false && !(pos && !adding)); k('adh').hidden = !adding;
    if (pos && !adding) {
      const t = tradeOf(pos), sym = pos.symbol, slP = t.sl ? +t.sl.triggerPrice : null, tpP = t.tp ? +t.tp.triggerPrice : null;
      box.classList.toggle('neg', t.u < 0);
      k('ph').innerHTML = `<b class="${t.long ? 'up' : 'dn'}">${t.long ? 'LONG' : 'SHORT'}</b> ${trimNum(pos.quantity)} ${shortSym(sym)}`; k('pe').textContent = 'ENTRY ' + fmtPx(t.op, sym);
      k('pu').textContent = fm(t.u, { sign: true }); k('pu').className = (t.u > 0 ? 'up' : t.u < 0 ? 'dn' : '') + fit(k('pu').textContent);
      k('pr').innerHTML = (t.R != null ? (t.R >= 0 ? '+' : '−') + Math.abs(t.R).toFixed(2) + 'R' : '') + (t.m ? `<small>${(t.s(t.m) >= 0 ? '+' : '−') + pts(t.s(t.m))} pts</small>` : '');
      const sm = t.m ? t.s(t.m) : 0, sS = slP != null ? t.s(slP) : null, sT = tpP != null ? t.s(tpP) : null;
      const a = Math.min(sS != null ? sS : -t.d0, sm, -t.d0 * 0.2), b = Math.max(sT != null ? sT : t.d0 * 2, sm, t.d0 * 0.2);
      setBeam(k('bm1'), { a, b, stop: sS, tgt: sT, price: sm, legs: t.scales.map(l => t.s(+l.triggerPrice)) });
      { const i = R.querySelector('[data-r=addp]'), v = LOGD.addp.to(+SH.addp); if (R.activeElement !== i) i.value = v; i.style.setProperty('--p', v / 10 + '%');
        const sv = R.querySelector('[data-sv=addp]'); if (R.activeElement !== sv) sv.textContent = SL_FMT.addp(+SH.addp);
        R.querySelectorAll('[data-tk=addp]').forEach(b => b.classList.toggle('on', +b.dataset.v === +SH.addp)); }
      { const a = addPlan(SH.addp), b = k('addx'); if (a) { b.textContent = +a.qs > 0 ? '+ ' + a.qs + ' ' + shortSym(a.sym) + (a.capped ? ' · all the margin left' : '') : 'no free margin'; b.disabled = !(+a.qs > 0) || !!SHOT.busy; } }
      k('e1').textContent = slP != null ? fmtPx(slP, sym) : 'NO STOP'; k('e1').className = slP != null ? '' : 'none';
      const slUsd = slP != null ? t.at(slP) : 0; k('e1s').textContent = slP != null ? fm(slUsd, { sign: true }) : ''; k('e1s').className = slUsd > 0 ? 'up' : '';
      k('e2').textContent = tpP != null ? fmtPx(tpP, sym) : 'NO TARGET'; k('e2').className = tpP != null ? '' : 'none'; k('e2s').textContent = tpP != null ? fm(t.at(tpP), { sign: true }) : '';
      R.querySelector('[data-a=addstop]').hidden = slP != null; R.querySelector('[data-a=half]').hidden = R.querySelector('[data-a=be]').hidden = slP == null;
      R.querySelectorAll('[data-v=pos] .c').forEach(c => { const tag = c.dataset.cut ? 'cut' + c.dataset.cut : c.dataset.lim ? 'lim' + c.dataset.lim : c.dataset.a; c.classList.toggle('busy', SHOT.busy === tag); c.disabled = !!SHOT.busy; });
      const lh = t.scales.map(l => `<span class="lg">${legFixed(l) ? Math.round(Math.abs(+l.quantity) / t.q * 100) + '% · ' : ''}${fmtPx(l.triggerPrice, sym)}<button data-id="${esc(l.id)}" title="Remove">×</button></span>`).join('');
      if (k('lgs').dataset.h !== lh) k('lgs').innerHTML = k('lgs').dataset.h = lh;
    } else {
      box.classList.remove('neg');
      R.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', !!SH[b.dataset.t]));
      R.querySelectorAll('[data-r]').forEach(i => { const key = i.dataset.r, v = LOGD[key] ? LOGD[key].to(+SH[key]) : +SH[key], mn = +i.min, mx = +i.max; if (R.activeElement !== i) i.value = v; i.style.setProperty('--p', Math.max(0, Math.min(100, ((v - mn) / (mx - mn)) * 100)) + '%'); });
      R.querySelectorAll('[data-sv]').forEach(b => { if (R.activeElement !== b) b.textContent = SL_FMT[b.dataset.sv](+SH[b.dataset.sv]); });
      R.querySelectorAll('[data-tk]').forEach(b => b.classList.toggle('on', +b.dataset.v === +SH[b.dataset.tk] && (b.dataset.tk !== 'R' || SH.tmode === 'R')));
      R.querySelector('[data-sr=R]').classList.toggle('off', SH.tmode !== 'R'); R.querySelector('[data-sr=risk]').classList.toggle('off', SH.rmode === 'usd' && SH.rusd > 0);
      { const ru = R.querySelector('[data-n=rusd]'); if (R.activeElement !== ru) { ru.value = SH.rmode === 'usd' && SH.rusd > 0 ? '$' + SH.rusd : ''; ru.classList.toggle('on', SH.rmode === 'usd' && SH.rusd > 0); } }
      const pb = R.querySelector('[data-a=pass]'); pb.classList.toggle('on', SH.tmode === 'pass'); pb.disabled = !(p.passNeed > 0); pb.hidden = !(p.passNeed > 0) && SH.tmode !== 'pass';
      const usd = R.querySelector('[data-n=usd]'); if (R.activeElement !== usd) { usd.value = SH.tmode === 'usd' && SH.usd > 0 ? '$' + SH.usd : ''; usd.classList.toggle('on', SH.tmode === 'usd'); }
      { const cur = JSON.stringify(loadOf()), L0 = DB.loads || [], same = x => JSON.stringify(loadOf(x)) === cur, lit = L0.find(x => x.n === SH.ldn && same(x)) || L0.find(same),
          peek = x => `${x.rmode === 'usd' && x.rusd > 0 ? '$' + trimNum(x.rusd) + ' stop' : trimNum(x.risk) + '%'} · ${x.tmode === 'pass' ? 'pass' : x.tmode === 'usd' ? '$' + trimNum(x.usd) : trimNum(x.R) + 'R'} · ${x.size >= 100 ? 'max' : x.size + '%'}`,
          h = L0.map((x, i) => `<div class="lc${x === lit ? ' on' : ''}" data-i="${i}"><button title="${esc(x.n)}${x.fees ? ' · fees in' : ''}">${esc(x.n)}<small>${peek(x)}</small></button><button class="x" title="Delete">×</button></div>`).join('');
        if (k('ll').dataset.h !== h) k('ll').innerHTML = k('ll').dataset.h = h; k('lsv').textContent = L0.length ? '+' : '+ save';
        const dd = k('ldd'), dh = `<span class="dt"></span><b>${lit ? esc(lit.n) : L0.length ? 'loadouts' : 'no loadouts'}</b><small>${lit ? peek(lit) : L0.length ? L0.length + ' saved' : ''}</small>${L0.length ? '<i></i>' : ''}`;
        if (dd.dataset.h !== dh) dd.innerHTML = dd.dataset.h = dh; dd.classList.toggle('on', !!lit); dd.disabled = !L0.length; }
      { const K = SH.keys, kp = k('kp'); kp.classList.toggle('on', !!K.on); R.querySelector('[data-kt=keys]').classList.toggle('on', !!K.on); R.querySelector('[data-a=keys]').classList.toggle('on', !!K.on);
        R.querySelectorAll('[data-kb]').forEach(b => { const n = b.dataset.kb; b.classList.toggle('rec', KREC === n); b.textContent = KREC === n ? 'press keys' : K[n] ? keyName(K[n]) : 'none'; });
        const lg = { long: K.long, short: K.short, close: K.close, add: pos && (/^l/i.test(pos.side) ? K.long : K.short) };
        R.querySelectorAll('[data-kk]').forEach(m => { const v = K.on && lg[m.dataset.kk] ? keyName(lg[m.dataset.kk]) : ''; m.textContent = v; m.hidden = !v; }); }
      { const t = cTheme(); k('cts').style.background = t.id === 'massive' ? '#e6e3dc' : t.id === 'vest' ? '#00D98E' : t.bg; R.querySelector('[data-a=cth]').classList.toggle('on', !k('ctm').hidden);
        { const g = k('ctg'), h = ctgHtml(); if (g.__h !== h) { g.innerHTML = h; g.__h = h; } }
        R.querySelectorAll('[data-cth]').forEach(b => b.classList.toggle('on', b.dataset.cth === t.id));
        const lv = !k('ctm').hidden && readChart(); R.querySelectorAll('[data-cc]').forEach(inp => { const v = toHex((lv || t)[inp.dataset.cc]) || '#000000'; if (inp !== R.activeElement && inp.value !== v.toLowerCase()) inp.value = v.toLowerCase(); inp.nextElementSibling.style.background = v; });
        
        R.querySelectorAll('[data-look]').forEach(b => b.classList.toggle('on', (b.dataset.look === 'vest') === (DB.skin === false)));
        R.querySelectorAll('[data-lst]').forEach(b => b.classList.toggle('on', +b.dataset.lst === lineStyle()));
        R.querySelectorAll('[data-giga]').forEach(b => b.classList.toggle('on', (b.dataset.giga === '1') === (DB.giga !== false)));
        R.querySelectorAll('[data-pil]').forEach(b => b.classList.toggle('on', (b.dataset.pil === '1') === (DB.pill === true)));
        R.querySelectorAll('[data-am]').forEach(b => b.classList.toggle('on', !!DB[b.dataset.am])); }
      const side = SH.side || 'long';
      R.querySelectorAll('[data-sd]').forEach(b => b.classList.toggle('on', b.dataset.sd === side));
      if (p.qty) {
        k('slv').textContent = '−' + fm(SH.fees ? p.risk : p.slG).replace('−', '');
        k('tpv').textContent = '+' + fm(SH.fees ? p.reward : p.tpG);
        k('slv').className = fit(k('slv').textContent); k('tpv').className = fit(k('tpv').textContent);
        k('slp').innerHTML = p.dSL ? pts(p.dSL) + ' pts <i>· ' + fmtPx(p[side].sl, p.sym) + '</i>' : '—';
        if (SH.sl === false) { k('slv').textContent = 'NO STOP'; k('slp').textContent = 'risk is the size'; }
        k('slp').classList.toggle('note', SH.sl === false); k('tpp').classList.toggle('note', SH.tp === false);
        k('tpp').innerHTML = p.dTP ? pts(p.dTP) + ' pts <i>· ' + fmtPx(p[side].tp, p.sym) + '</i>' : '—';
        if (SH.tp === false) { k('tpv').textContent = 'NO TARGET'; k('tpp').textContent = 'open'; k('tpv').className = ''; }
        if (p.dSL) setBeam(k('bm0'), { a: -p.dSL, b: p.dTP, stop: -p.dSL, tgt: p.dTP, price: 0, legs: p.dPass && SH.tmode !== 'pass' && p.dPass < p.dTP ? [p.dPass] : [] });
        const share = p.risk > 0 ? p.fees / p.risk : 0, hot = share >= 0.4;
        k('fb').style.width = Math.min(100, share * 100) + '%'; k('fb').classList.toggle('hot', hot);
        k('fe').textContent = fm(p.fees) + ' · ' + Math.round(share * 100) + '% of risk'; k('fe').classList.toggle('hot', hot);
        k('qz').innerHTML = `<b>${p.qtyS} ${shortSym(p.sym)}</b> · ${fk(p.N)}`;
      } else { k('slv').textContent = '—'; k('tpv').textContent = '—'; k('slp').textContent = ''; k('tpp').textContent = ''; k('fe').textContent = '—'; k('qz').textContent = ''; k('fb').style.width = '0'; }
      const cool = Date.now() < SHOT.cool;
      const L1 = R.querySelector('[data-a=long]'), S1 = R.querySelector('[data-a=short]');
      L1.disabled = S1.disabled = !p.ok || !!SHOT.busy || cool; L1.classList.toggle('busy', SHOT.busy === 'long'); S1.classList.toggle('busy', SHOT.busy === 'short');
      if (locked) { const id = activeAcct(), as = zoneStats(id) || { sum: 0, lost: 0 }; k('lk').textContent = acctShort(id).replace(/^Account /, '#') + ' · ' + fm(as.sum, { sign: true }) + ' · until 8pm reset'; }
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
      k('addq').textContent = aq ? 'Add ' + trimNum(aq) : 'Add';
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
        set('setExtendLeft', true); set('setLineLength', 38, 'percentage'); set('setLineWidth', 1);
        set('setBodyFont', '600 11px Inter, system-ui, sans-serif'); set('setQuantityFont', '700 11px Inter, system-ui, sans-serif');
        set('setBodyBorderColor', 'rgba(0,0,0,0)'); set('setQuantityBorderColor', 'rgba(0,0,0,0)'); set('setCancelButtonBorderColor', 'rgba(0,0,0,0)');
        const line = l, k0 = key;
        set('onMove', () => { let px = null; try { px = line.getPrice(); } catch (e) {} if (px == null || !isFinite(px) || !line.__gpzMove) return; HOLD[k0] = { px, until: Date.now() + 2500 }; line.__gpzMove(px); });
        set('onCancel', () => { if (line.__gpzCancel) line.__gpzCancel(); });
      }
      l.__gpzMove = o.move || null; l.__gpzCancel = o.cancel || null;
      set('setEditable', !!o.move); set('setCancellable', !!o.cancel); set('setCancelButtonIconColor', o.cancel ? color : 'rgba(0,0,0,0)');
      const h = HOLD[key]; if (h && Date.now() > h.until) delete HOLD[key];
      if (!CHDOWN) set('setPrice', HOLD[key] ? HOLD[key].px : price); // never fight a line that is being dragged
      if (style === 2) style = lineStyle();
      const lt = cTheme().light, vm = !lt && DB.skin === false, vc = vm ? vestTone(color) : null;
      const bg = lt ? 'rgba(22,22,24,0.94)' : vm ? '#121714' : 'rgba(11,11,11,0.78)', tx = lt ? lightTone(color, 1) : vm ? vc : color, ln = lt ? lightTone(color, 0) : vm ? vc : color, bd = vm ? vc : 'rgba(0,0,0,0)';
      if (l.__gpzBg !== bg + bd) { l.__gpzBg = bg + bd; set('setBodyBackgroundColor', bg); set('setQuantityBackgroundColor', bg); set('setCancelButtonBackgroundColor', bg); set('setBodyBorderColor', bd); set('setQuantityBorderColor', bd); set('setCancelButtonBorderColor', bd); }
      set('setText', text); set('setQuantity', ''); set('setLineColor', ln); set('setBodyTextColor', tx); set('setQuantityTextColor', tx); set('setLineStyle', style);
    } catch (e) { CHL[key] = null; }
  }
  // on a light chart the lines go dark and the labels stay dark boxes with bright text
  function toneOf(c, dark, a) { const m = String(c).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/) || (/^#([0-9a-f]{6})$/i.test(c) ? [0, ...[1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16))] : null); if (!m) return c;
    const [r, g, b] = [m[1], m[2], m[3]].map(v => Math.round(+v * (1 - dark))); return `rgba(${r},${g},${b},${a})`; }
  const lineStyle = () => [0, 1, 2].includes(DB.lst) ? DB.lst : 2; // TP, SL and floor lines: solid, dotted or dashed
  function lightTone(c, label) { // light charts: deep, saturated lines; labels stay dark boxes with bright text
    const v = vestTone(c), L = { '#ff4d5e': ['#c41d2e', '#ff6b78'], '#00d98e': ['#0f8a4a', '#3ee08f'], '#f5c542': ['#a66f00', '#f5c542'] }[v];
    return L ? L[label] : label ? '#e6e3dc' : '#2b2b2e';
  }
  function vestTone(c) { // Vest look: plain, full-strength colours, easy to see on Vest's chart
    const m = String(c).match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/); if (!m) return c; const [r, g, b] = [+m[1], +m[2], +m[3]];
    if (r > 200 && g > 180 && b < 160) return '#f5c542'; // gold: pass
    if (g > r + 20) return '#00d98e'; if (r > g + 30) return '#ff4d5e'; return 'rgba(242,242,242,0.75)';
  }
  function clearLines(keep) { for (const key in CHL) if (!keep || keep.indexOf(key) < 0) { try { CHL[key] && CHL[key].remove(); } catch (e) {} delete CHL[key]; delete HOLD[key]; } }
  function vestSuffix(m) { // returns how many of Vest's TP / SL labels now carry the distance
    let n = 0;
    const pxOf = l => { try { const v = l.getPrice(); return v != null && isFinite(v) ? +v : null; } catch (e) { return null; } };
    const all = [...VL].filter(l => !l.__gpzOwn).map(l => ({ l, px: pxOf(l) })), near = nearGap(m);
    all.forEach(({ l, px }) => {
      const b = String(l.__gpzBase || ''); const tp = /^\s*TP\b|take profit/i.test(b), sl = /^\s*SL\b|stop loss/i.test(b);
      let suf = '';
      if ((tp || sl) && m != null && px != null) { suf = '   ' + pts(m - px) + ' pts'; n++; }
      if (l.__gpzSuf !== suf) { l.__gpzSuf = suf; try { l.__gpzSetText.call(l, b + suf); } catch (e) {} }
      // a stop at entry (or a target on the pass price) sits on another of Vest's labels: slide it left, clear of it
      const nudge = !!((tp || sl) && px != null && near > 0 && all.some(o => o.l !== l && o.px != null && Math.abs(o.px - px) < near));
      if (l.__gpzNudge !== nudge) { l.__gpzNudge = nudge; if (l.__gpzLen) try { l.__gpzSetLen.apply(l, lenOf(l)); } catch (e) {} }
    });
    return n;
  }
  function nearGap(m) { // about one label's height in price
    try { const r = chartApi().getPanes()[0].getMainSourcePriceScale().getVisiblePriceRange(); if (r && isFinite(r.to - r.from) && r.to !== r.from) return Math.abs(r.to - r.from) * 0.035; } catch (e) {}
    return m ? Math.abs(m) * 0.0006 : 0;
  }
  const lenOf = l => { const [v, u] = l.__gpzLen; return l.__gpzNudge ? [u === 'pixel' ? v + 230 : Math.min(90, v + 16), u] : [v, u]; };
  const ROSE = 'rgba(232,152,140,0.7)', MINT = 'rgba(159,215,178,0.7)', GOLD = 'rgba(214,211,204,0.6)'; // resting limits and the pass line: soft cream, no gold
  // the account's real floor today: Vest's daily_loss_floor already carries the buffer from withdrawn profit,
  // but the max drawdown floor still binds when it is higher; the line sits where equity would touch it
  function floorOf(id) {
    const ca = capAcct(id); if (!ca) return null;
    const dlf = +ca.daily_loss_floor || 0, mdl = +ca.max_drawdown_limit || 0, F = Math.max(dlf, mdl); if (!(F > 0)) return null;
    return { F, which: dlf >= mdl ? 'DLL' : 'MLL', dlf, mdl };
  }
  W.__gpzFloor = id => floorOf(id || activeAcct());
  function dllKeys(p, side) {
    const id = p && p.id, sym = p && p.sym, m = sym && L.mark[sym], fl = id && floorOf(id), cash = id != null ? cashOf(id) : null;
    if (!fl || !m || cash == null) return [];
    let E = cash, Q = 0;
    L.pos.filter(x => accOf(x) === id).forEach(x => { const q = Math.abs(+x.quantity) * (/^s/i.test(x.side || '') ? -1 : 1), mk = L.mark[x.symbol]; if (mk) E += (mk - +x.openPrice) * q; if (x.symbol === sym) Q += q; });
    if (!Q && side && p.qty > 0) Q = side === 'long' ? p.qty : -p.qty;
    const room = E - fl.F; if (!Q || !(room > 0)) return [];
    const px = m - room / Q; if (!(px > 0)) return [];
    chLine('dll', px, fl.which + '  −' + fm(room).replace('−', '') + '  ·  ' + pts(Math.abs(m - px)) + ' pts', 'rgba(239,177,167,0.55)', 2);
    return ['dll'];
  }
  function drawChart() {
    const ch0 = chartApi(); if (ch0) wrapChart(ch0);
    if (!SHOT.visible) { vestSuffix(null); return clearLines(); }
    const p = plan(); if (!p.sym || !ch0) return clearLines();
    const pos = myPos(p), m = L.mark[p.sym];
    if (pos && vestSuffix(m)) return clearLines(dllKeys(p)); // Vest's labels now read "TP +$107.36   199.2 pts"
    if (!pos) vestSuffix(null);
    if (pos) {
      const t = tradeOf(pos), keys = [], usd = v => fm(v, { sign: true });
      if (t.sl) { const px = +t.sl.triggerPrice, id = t.sl.id; chLine('psl', px, 'SL  ' + usd(t.at(px)) + (m ? '  ·  ' + pts(m - px) + ' pts' : ''), ROSE, 2, { move: v => moveLeg('sl', id, v) }); keys.push('psl'); }
      if (t.tp) { const px = +t.tp.triggerPrice, id = t.tp.id; chLine('ptp', px, 'TP  ' + usd(t.at(px)) + (m ? '  ·  ' + pts(px - m) + ' pts' : ''), MINT, 2, { move: v => moveLeg('tp', id, v), cancel: () => dropLeg(id) }); keys.push('ptp'); }
      t.scales.forEach(l => { const px = +l.triggerPrice, id = l.id, key = 'pl' + id, part = legFixed(l) ? Math.round(Math.abs(+l.quantity) / t.q * 100) + '%' : 'TP'; chLine(key, px, part + (m ? '  ·  ' + pts(px - m) + ' pts' : ''), GOLD, 2, { move: v => moveLeg('tp', id, v), cancel: () => dropLeg(id) }); keys.push(key); });
      keys.push(...dllKeys(p));
      return clearLines(keys);
    }
    if (!p.qty || !p.dSL) return clearLines();
    const side = SH.side || 'long', g = p[side];
    if (SH.tp !== false) chLine('tp', g.tp, (SH.tmode === 'pass' ? 'PASS  +' : 'TP  +') + fm(p.reward) + '  ·  ' + pts(p.dTP) + ' pts', MINT, 2, { move: targetFromLine });
    if (SH.sl !== false) chLine('sl', g.sl, 'SL  −' + fm(p.risk).replace('−', '') + '  ·  ' + pts(p.dSL) + ' pts', ROSE, 2, { move: sizeFromStop });
    chLine('en', p.px, (side === 'long' ? 'long ' : 'short ') + p.qtyS + '  ·  ' + p.lev + 'x', 'rgba(230,227,220,0.32)', 1);
    const keep = ['en', ...(SH.tp !== false ? ['tp'] : []), ...(SH.sl !== false ? ['sl'] : []), ...dllKeys(p, side)];
    if (p.passNeed > 0 && SH.tmode !== 'pass' && SH.tp !== false) { chLine('pass', g.pass, 'PASS  +' + fm(p.passNeed) + '  ·  ' + pts(p.dPass) + ' pts', 'rgba(227,201,142,0.6)', 2); keep.push('pass'); }
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
  // followers that can still trade: a blown, passed or closed account drops off the copy list by itself
  function pruneFollowers() {
    if (!L.cap || !L.cap.length) return; let gone = 0;
    for (const f of Object.keys(C.followers)) { const c = L.cap.find(x => x.id === f); if (!C.followers[f] || !c || c.status !== 2) { delete C.followers[f]; gone++; } }
    if (gone) saveC(); return gone;
  }
  const nFollow = () => Object.keys(C.followers).filter(f => C.followers[f] && f !== C.leader).length;
  function clog(msg, bad) { C.log.unshift({ t: Date.now(), msg, bad: !!bad }); C.log = C.log.slice(0, 40); saveC(); }
  function arm(on) {
    if (on) {
      const id = leadPick(); if (!id) return shotMsg('pick a LEAD account in the desk first', 'bad'); if (id !== activeAcct()) switchAcct(id);
      C.leader = id; delete C.followers[id]; C.pre = {}; L.pos.filter(p => accOf(p) === id).forEach(p => { C.pre[p.positionId] = 1; });
      C.on = true; C.err = {}; clog('copying ' + acctLabel(id) + ' → ' + (pruneFollowers(), nFollow()) + ' accounts');
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
  function roomOf(id) { const fl = floorOf(id), c = cashOf(id); if (!fl || c == null) return null; let u = 0; L.pos.filter(p => accOf(p) === id).forEach(p => { const m = L.mark[p.symbol]; if (m) u += (m - +p.openPrice) * Math.abs(+p.quantity) * (/^s/i.test(p.side || '') ? -1 : 1); }); return c + u - fl.F; }
  function sizeFor(f, lq, sym) {
    const lb = balOf(C.leader) || 0, fb = balOf(f) || 0; if (!(lb > 0) || !(fb > 0)) return 0;
    const rl = C.mode === 'room' ? roomOf(C.leader) : null, rf = C.mode === 'room' ? roomOf(f) : null;
    let q = C.mode === 'room' && rl > 0 && rf != null ? lq * Math.max(0, rf) / rl : C.mode === 'bal' ? lq * fb / lb : (fb < lb * 0.995 ? lq * fb / lb * 0.97 : lq); // same size, cut to fit a smaller account
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
      if (lockedAcct(f)) { C.err[f] = 'zone locked until 8pm reset'; return; }
      const want = sizeFor(f, lq, sym); if (!(want > 0)) { C.err[f] = 'too small to hold any ' + shortSym(sym); return; }
      hold(4000); C.opened[okey] = Date.now(); PENDING[key] = { at: Date.now(), lead: lp.positionId }; saveC();
      const lev = Math.min(+lp.leverage || 1e9, maxLev(sym, f) || 1e9);
      await ensureLev(f, sym, lev).catch(() => {});
      const t0 = Date.now(); const r = await send(f, 'POST', '/v3/positions/open', { orderType: 'market', leverage: trimNum(lev), side: lp.side, symbol: sym, quantity: fmtQ(want, sym), timeInForce: 'IOC', takeProfits: legsFor(lp.takeProfits, lq, want, sym), stopLosses: legsFor(lp.stopLosses, lq, want, sym) });
      if (r.positionId) { C.owned[r.positionId] = { f, sym, lead: lp.positionId }; C.share[r.positionId] = want / lq; delete PENDING[key]; }
      C.err[f] = ''; (C.res || (C.res = {}))[f] = { ok: 1, ms: Date.now() - t0, t: Date.now() }; clog((/^l/i.test(lp.side) ? 'Long ' : 'Short ') + fmtQ(want, sym) + ' ' + shortSym(sym) + ' on ' + acctLabel(f)); saveC();
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
  const leadPick = () => C.pick && L.bal[C.pick] != null ? C.pick : activeAcct(); // the desk's LEAD choice, else the account Vest has open
  const copyLeader = () => C.on ? C.leader : leadPick();
  function setLead(id) { // any row can take the lead: it stops following, the old lead just steps back
    if (!id) return; C.pick = id; delete C.followers[id];
    if (C.on && C.leader !== id) { C.leader = id; C.pre = {}; L.pos.filter(p => accOf(p) === id).forEach(p => { C.pre[p.positionId] = 1; }); clog('lead is now ' + acctLabel(id)); }
    saveC(); renderDesk(); if (SP) renderShot(); if (id !== activeAcct()) switchAcct(id); kickFast();
  }
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
    if (!SP) return; const { R, k } = SP, n = (pruneFollowers(), nFollow());
    R.querySelector('[data-a=copy]').classList.toggle('armed', !!C.on); R.querySelector('[data-a=copy]').classList.toggle('on', !!DK.open);
    k('cp').textContent = C.on ? 'copying ' + n : 'desk';
    if (DS && DK.open) renderDesk();
  }
  // ---------- GP. Desk: every account's open and today PnL, closed whole or in part with one click ----------
  // Docks under the ticket (over Vest's Account Health card); drag it out to float, double-click its header to dock it back.
  // A cut on a copy follower moves its share down first, so the copier keeps the smaller size instead of topping it back up.
  // A cut on the leader is copied on every follower.
  if (DB.deskV !== 2) { DB.desk = Object.assign({}, DB.desk, { open: true, side: true }); DB.deskV = 2; } // the desk loads open, at the chart's left
  const DK = Object.assign({ open: true, dock: true, side: true, all: false, tab: 'acc', x: null, y: null, sort: 'auto', big: false }, DB.desk || {});
  DK.busy = {}; DK.msg = ''; DK.tone = ''; DK.msgAt = 0;
  const saveDK = () => { DB.desk = { open: DK.open, dock: DK.dock, side: DK.side, all: DK.all, tab: DK.tab, x: DK.x, y: DK.y, sort: DK.sort, big: DK.big }; save(); };
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
  .fx:hover{background:rgba(232,152,140,.16);color:#f6c3ba}.fx{margin-right:10px}.fx:active{transform:scale(.95)}
  .x{width:24px;height:24px;border-radius:50%;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:700 13px/1 Inter,system-ui,sans-serif;cursor:pointer}.x:hover{color:#f1f1f3;border-color:rgba(238,234,226,.4)}
  .top{display:flex;align-items:baseline;gap:12px;padding:6px 14px 8px;border-bottom:1px solid rgba(238,234,226,.08)}
  .top .o{font-size:26px;font-weight:600;letter-spacing:-.06em;line-height:1;white-space:nowrap}.o.flat{font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:#6f6f75}
  .top .t{margin-left:auto;text-align:right;font-size:13px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
  .top small{font-size:9.5px;font-weight:700;letter-spacing:.16em;color:#5f5f66;margin-right:6px}
  .up{color:#bfe6cb}.dn{color:#efb1a7}.flat{color:#e6e3dc}.dim{color:#4a4a4f}
  .rows{flex:1 1 auto;min-height:0;overflow:auto;scrollbar-width:none}
  .rows::-webkit-scrollbar{display:none}
  .r{display:grid;grid-template-columns:minmax(0,1fr) 56px 56px 122px;align-items:center;gap:6px;height:32px;padding:0 8px 0 14px;border-bottom:1px solid rgba(238,234,226,.05)}
  .r:hover{background:rgba(238,234,226,.03)}
  .x.sd{font-size:12px}.d.side .x.sd{background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b}
  .d.side{border-radius:14px}.d.side .hd{cursor:default}
  .d.side .rh{display:none}
  .d.side .r{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"nm ac" "vo vt";height:auto;row-gap:5px;padding:10px 10px 10px 14px}
  .d.side .nm{grid-area:nm}.d.side .ac{grid-area:ac}.d.side .vo{grid-area:vo;text-align:left}.d.side .vt{grid-area:vt}
  .d.side .vo:before,.d.side .vt:before{font-size:8.5px;font-weight:700;letter-spacing:.16em;color:#5f5f66;margin-right:6px}.d.side .vo:before{content:"OPEN"}.d.side .vt:before{content:"TODAY"}
  .tb{display:flex;gap:2px;padding:2px;border-radius:8px;background:#111111;border:1px solid rgba(238,234,226,.06)}.fx{flex:none}.d.side .tb button{padding:0 7px}.d.side .ld{display:none}.d.side .hd{gap:4px;padding-right:8px}.d.side .fx{margin-right:6px;padding:0 9px}
  .tb button{height:22px;padding:0 9px;border:0;border-radius:6px;background:none;color:#8b8b92;font:600 10.5px Inter,system-ui,sans-serif;letter-spacing:.02em;cursor:pointer}.tb button:hover{color:#f1f1f3}
  .tb button.on{background:#e6e3dc;color:#0b0b0b}
  .d.acc .rh:not(.ra),.d.pnl .rh.ra,.d.pnl .cpy{display:none}
  .cpy{display:flex;align-items:center;gap:8px;padding:8px 12px 8px 14px;border-bottom:1px solid rgba(238,234,226,.06)}
  .cpy>b{font-size:9.5px;font-weight:600;letter-spacing:.2em;color:#8b8b92}
  .sw{position:relative;flex:none;width:30px;height:17px;border-radius:99px;border:1px solid rgba(238,234,226,.2);background:#151515;cursor:pointer;transition:background .2s,border-color .2s}
  .sw:after{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#8b8b92;transition:transform .2s cubic-bezier(.34,1.2,.64,1),background .2s}
  .sw.on{background:#14231b;border-color:rgba(159,215,178,.6)}.sw.on:after{transform:translateX(13px);background:#9fd7b2}
  .cm{display:flex;gap:2px}.cm button{height:20px;padding:0 7px;white-space:nowrap;border-radius:6px;border:1px solid rgba(238,234,226,.1);background:none;color:#8b8b92;font:600 10px Inter,system-ui,sans-serif;cursor:pointer}.cm button.on{color:#f1f1f3;border-color:rgba(238,234,226,.35)}
  .ld{margin-left:auto;font-size:10.5px;color:#6f6f75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}.ld b{color:#c9c7c2;font-weight:600}
  .r.a{grid-template-columns:minmax(0,1fr) 66px 62px auto;cursor:pointer;height:auto;min-height:32px;padding-block:6px}
  .r.a .ex{grid-column:1/-1;display:flex;flex-direction:column;gap:4px;min-width:0}
  .pcs{display:flex;gap:5px;flex-wrap:wrap;align-items:center}.pc{font-size:10px;font-weight:700;letter-spacing:.04em;padding:2px 6px;border-radius:5px;background:rgba(159,215,178,.1);color:#bfe6cb;white-space:nowrap}.pc.sh{background:rgba(232,152,140,.1);color:#efb1a7}.pcs .pu{font-size:11px;font-weight:700}
  .rb{display:flex;align-items:center;gap:7px;font-size:9.5px;font-weight:700;letter-spacing:.08em;color:#55555b}.rb .bar{flex:1;height:3px;border-radius:9px;background:rgba(238,234,226,.07);overflow:hidden}.rb .bar i{display:block;height:100%;border-radius:9px;background:rgba(159,215,178,.55)}
  .rb b{font-weight:600;letter-spacing:0;color:#8b8b92;font-size:10.5px;font-variant-numeric:tabular-nums}.rb.low .bar i{background:#e8988c}.rb.low b{color:#efb1a7}
  .r:not(.a) .ac{opacity:.0;transition:opacity .15s}.r:not(.a):hover .ac,.r:not(.a) .ac:focus-within,.r:not(.a) .ac .busy{opacity:1}.d.busyall .r .ac{opacity:1}
  .dl{display:block;margin-left:6px;flex:none}.dl path{fill:none;stroke-width:1.4;stroke-linejoin:round;stroke-linecap:round}
  .gh{display:flex;justify-content:space-between;align-items:center;padding:9px 10px 5px 14px;font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#6f6f75;cursor:pointer;border-bottom:1px solid rgba(238,234,226,.05)}.gh:hover{color:#c9c7c2}
  .gh i{font-style:normal;margin-left:6px;color:#55555b}.gh b{letter-spacing:0;font-size:11px;font-weight:600}
  .tg.lkd{display:inline-flex;align-items:center;gap:4px;font-style:normal;font-size:8px;font-weight:700;letter-spacing:.12em;padding:2px 6px 2px 5px;border-radius:5px;margin-left:6px;color:#efb1a7;background:rgba(232,152,140,.1);box-shadow:inset 0 0 0 1px rgba(232,152,140,.28)}
  .r.lkd{background:repeating-linear-gradient(135deg,rgba(232,152,140,.035) 0 6px,transparent 6px 12px)}.r.lkd .v,.r.lkd .nm b,.r.lkd .nm em{opacity:.45}.r.lkd .fo{opacity:.35}
  .tg.lead{font-style:normal;font-size:8px;font-weight:700;letter-spacing:.12em;padding:1px 5px;border-radius:4px;background:#e6e3dc;color:#0b0b0b;margin-left:6px}
  .r.a.lead{box-shadow:inset 2px 0 0 #e6e3dc}.fo.nil{border:0;cursor:default}
  .cr{font-style:normal;font-size:9.5px;font-weight:700;margin-left:6px}.cr.ok{color:#9fd7b2}.cr.bad{color:#efb1a7}
  .r.fd{background:linear-gradient(90deg,rgba(159,215,178,.075),rgba(159,215,178,.02) 55%,rgba(159,215,178,0))}.r.fd:hover{background:linear-gradient(90deg,rgba(159,215,178,.11),rgba(159,215,178,.03) 55%,rgba(159,215,178,0))}
  .r.a.cur{background:rgba(238,234,226,.045)}.r.a.cur .nm b:before{content:"";display:inline-block;width:5px;height:5px;border-radius:50%;background:#e6e3dc;margin-right:6px;vertical-align:2px}
  .r.a .v.b{color:#c9c7c2}
  .fo{justify-self:end;width:18px;height:18px;border-radius:5px;border:1px solid rgba(238,234,226,.22);background:none;cursor:pointer;display:grid;place-items:center;padding:0;color:#0b0b0b;font:700 11px/1 Inter,system-ui,sans-serif}
  .fo.on{background:#9fd7b2;border-color:#9fd7b2}.fo.on:after{content:"✓"}.fo:hover{border-color:rgba(238,234,226,.5)}
  .ro{display:flex;align-items:center;gap:5px;justify-self:end}
  .lb{height:18px;padding:0 6px;border-radius:5px;border:1px solid rgba(238,234,226,.16);background:none;color:#6f6f75;font:700 8px/1 Inter,system-ui,sans-serif;letter-spacing:.12em;cursor:pointer;opacity:0;transition:opacity .15s,color .15s,border-color .15s,background .15s}
  .r.a:hover .lb,.lb:focus-visible{opacity:1}.lb:hover{color:#f1f1f3;border-color:rgba(238,234,226,.5)}.lb.on{opacity:1;background:#e6e3dc;border-color:#e6e3dc;color:#0b0b0b;cursor:default}
  .so{display:flex;align-items:center;gap:3px;padding:6px 12px 6px 14px;border-bottom:1px solid rgba(238,234,226,.06);overflow-x:auto;scrollbar-width:none}.so::-webkit-scrollbar{display:none}
  .so>b{font-size:9.5px;font-weight:600;letter-spacing:.2em;color:#8b8b92;margin-right:5px}
  .so button{flex:none;height:20px;padding:0 7px;white-space:nowrap;border-radius:6px;border:1px solid transparent;background:none;color:#6f6f75;font:600 10px Inter,system-ui,sans-serif;cursor:pointer}.so button:hover{color:#c9c7c2}.so button.on{color:#f1f1f3;border-color:rgba(238,234,226,.3)}
  .d.pnl .so{display:none}
  .scrim{display:none}
  :host(.big) .scrim{display:block;position:fixed;inset:0;background:rgba(6,6,6,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}
  .d.big{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(1120px,calc(100vw - 64px));height:min(780px,calc(100vh - 80px));border-radius:18px;box-shadow:0 40px 120px rgba(0,0,0,.6)}
  .d.big .hd{cursor:default}.d.big .sd,.d.big [data-t=pnl]{display:none}.d.big .bg{background:#e6e3dc;color:#0b0b0b;border-color:#e6e3dc}
  .d.big .rh{display:none}
  .d.big .rows{display:grid;grid-template-columns:repeat(auto-fill,minmax(236px,1fr));grid-auto-rows:max-content;gap:8px;padding:10px 12px 14px;align-content:start;overflow-y:auto}
  .d.big .gh{grid-column:1/-1;border:0;padding:10px 4px 2px}
  .d.big .r.a{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"nm ro" "vb vt" "ex ex";row-gap:4px;padding:10px 10px 10px 12px;border-radius:11px;background:rgba(238,234,226,.025);box-shadow:inset 0 0 0 1px rgba(238,234,226,.06)}
  .d.big .r.a .nm{grid-area:nm}.d.big .r.a .ro{grid-area:ro}.d.big .r.a .vb{grid-area:vb;text-align:left}.d.big .r.a .vt{grid-area:vt}.d.big .r.a .ex{grid-area:ex}
  .d.big .r.a.lead{box-shadow:inset 0 0 0 1px rgba(230,227,220,.55)}.d.big .r.a.cur{background:rgba(238,234,226,.06)}.d.big .lb{opacity:1}
  .fo.lead{width:auto;padding:0 5px;border:0;background:#e6e3dc;font-size:8px;letter-spacing:.12em;cursor:default}
  .r .er{display:block;font-style:normal;font-size:9.5px;color:#efb1a7;overflow:hidden;text-overflow:ellipsis}
  .d.side .r.a{grid-template-columns:minmax(0,1fr) auto;grid-template-areas:"nm ro" "vb vt" "ex ex";height:auto;row-gap:4px;padding:9px 10px 9px 14px}.d.side .r.a .ex{grid-area:ex}
  .d.side .r.a .nm{grid-area:nm}.d.side .r.a .ro{grid-area:ro}.d.side .r.a .vb{grid-area:vb;text-align:left}.d.side .r.a .vt{grid-area:vt}
  .d.side .rh.ra{display:none}
  .rh{display:grid;grid-template-columns:minmax(0,1fr) 56px 56px 122px;align-items:center;gap:6px;height:22px;padding:0 8px 0 14px}.rh .v{font-size:9px;font-weight:700;letter-spacing:.16em;color:#5f5f66}
  .nm{display:flex;align-items:center;gap:6px;min-width:0;white-space:nowrap}
  .nm b{font-size:12.5px;font-weight:600;letter-spacing:-.02em}
  .nm em{font-style:normal;font-size:10.5px;font-weight:600;color:#6f6f75;overflow:hidden;text-overflow:ellipsis}
  .tg{flex:none;font-size:8px;font-weight:600;letter-spacing:.14em;padding:2px 5px;border-radius:6px}
  .tg.lead{background:#e6e3dc;color:#0b0b0b}.tg.copy{border:1px solid rgba(159,215,178,.5);color:#9fd7b2}
  .v{text-align:right;font-size:12px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
  .ac{display:flex;gap:3px;justify-content:flex-end}
  .k{position:relative;overflow:hidden;width:22px;height:22px;padding:0;border-radius:7px;border:1px solid rgba(238,234,226,.12);background:none;color:#9e9ea5;font:600 10px Inter,system-ui,sans-serif;cursor:pointer;transition:all .2s}
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
    const host = document.createElement('div'); host.id = 'gpz-desk'; host.style.cssText = 'position:fixed;z-index:2147483640;display:none'; // above GP. if they ever meet
    ['keydown', 'keyup', 'keypress'].forEach(t => host.addEventListener(t, e => e.stopPropagation()));
    const R = host.attachShadow({ mode: 'open' });
    R.innerHTML = `<style>${DCSS}</style><div class="scrim"></div><div class="d">
      <div class="mw"><canvas class="moon" width="440" height="440"></canvas></div>
      <div class="hd" data-a="drag"><i class="dot"></i><div class="tb"><button data-t="acc">Accounts</button><button data-t="pnl">PnL</button></div><div class="sp"></div><button class="fx" data-a="flat"><span data-k="fx">flatten</span></button><button class="x bg" data-a="big" aria-label="Big view" title="Big view">⤢</button><button class="x sd" data-a="side" aria-label="Beside the chart" title="Beside the chart">⇤</button><button class="x" data-a="x" aria-label="Close desk">×</button></div>
      <div class="top"><span class="o" data-k="open">—</span><span class="t"><small>TODAY</small><span data-k="today">—</span></span></div>
      <div class="cpy" data-k="cpy"><b>COPY</b><button class="sw" data-a="arm" aria-label="Copy on or off"></button><div class="cm"><button data-cm="same">same</button><button data-cm="bal">by bal</button><button data-cm="room" title="Each copy sized by its account's room to the floor">by room</button></div><span class="ld" data-k="ld"></span></div>
      <div class="so" data-k="so"><b>SORT</b><button data-so="auto">auto</button><button data-so="target">to target</button><button data-so="pnl">pnl</button><button data-so="new">newest</button><button data-so="old">oldest</button></div>
      <div class="rh"><span></span><span class="v">OPEN</span><span class="v">TODAY</span><span></span></div>
      <div class="rh ra"><span></span><span class="v">BALANCE</span><span class="v">TODAY</span><span class="v">COPY</span></div>
      <div class="rows" data-k="rows"></div>
      <div class="ft"><span class="m" data-k="m"></span><button data-a="all" data-k="all"></button></div>
    </div>`;
    document.documentElement.appendChild(host);
    moon(R.querySelector('.moon').getContext('2d'), 440, 440, 220, 220, 200, 9, 1);
    const k = n => R.querySelector(`[data-k="${n}"]`);
    R.querySelector('[data-a=x]').onclick = () => { if (DK.big) { DK.side = true; DK.dock = true; DK.x = DK.y = null; return deskBig(false); } deskToggle(false); reflowSoon(); }; // from the big view, back to its bar
    R.querySelector('[data-a=flat]').onclick = () => deskFlatten();
    R.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { DK.tab = b.dataset.t; saveDK(); renderDesk(); });
    R.querySelector('[data-a=arm]').onclick = () => arm(!C.on);
    R.querySelectorAll('[data-cm]').forEach(b => b.onclick = () => { C.mode = b.dataset.cm; saveC(); renderDesk(); });
    R.querySelector('[data-a=side]').onclick = () => { DK.side = !DK.side; DK.x = DK.y = null; DK.dock = true; saveDK(); renderDesk(); layoutCols(); placeShot(); placeDesk(); };
    R.querySelector('[data-a=all]').onclick = () => { DK.all = !DK.all; saveDK(); renderDesk(); placeDesk(); };
    R.querySelector('[data-a=big]').onclick = () => deskBig(!DK.big);
    R.querySelectorAll('[data-so]').forEach(b => b.onclick = () => { DK.sort = b.dataset.so; saveDK(); renderDesk(); });
    R.querySelector('.scrim').onclick = () => deskBig(false);
    host.addEventListener('keydown', e => { if (e.key === 'Escape' && DK.big) deskBig(false); });
    k('rows').onclick = e => {
      const b = e.target.closest('[data-cut]'); if (b) return deskCut(b.closest('.r').dataset.id, +b.dataset.cut);
      const gh = e.target.closest('.gh'); if (gh) { const lead = copyLeader(), ids = deskRows().filter(r => r.kind === gh.dataset.g && r.id !== lead).map(r => r.id), all = ids.every(id => C.followers[id]); ids.forEach(id => { if (all) delete C.followers[id]; else C.followers[id] = true; }); saveC(); renderDesk(); if (SP) renderShot(); kickFast(); return; }
      const ld = e.target.closest('[data-ld]'); if (ld) return setLead(ld.dataset.ld);
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
    if (!DK.open || !IS_TRADE() || vestModal()) { st.display = 'none'; chartCol(); return; } // off the trade page it waits, still open
    st.display = '';
    if (!DK.side) document.querySelectorAll('[data-gpz-chartcol]').forEach(e => e.removeAttribute('data-gpz-chartcol'));
    const q = c => DS.R.querySelector(c), hh = [...DS.R.querySelectorAll('.rh,.cpy')].reduce((a, e) => a + e.offsetHeight, 0), want = q('.hd').offsetHeight + q('.top').offsetHeight + hh + q('.rows').scrollHeight + q('.ft').offsetHeight + 2;
    const t = SP && SP.host.style.display !== 'none' ? SP.host.getBoundingClientRect() : null;
    let x, y, w, h; const big = !!DK.big; DS.R.querySelector('.d').classList.toggle('big', big); DS.host.classList.toggle('big', big);
    if (big) { st.left = '0px'; st.top = '0px'; st.width = innerWidth + 'px'; st.height = innerHeight + 'px'; return; }
    const ch = DK.side ? chartCol() : null;
    DS.R.querySelector('.d').classList.toggle('side', !!ch);
    if (ch) { const r = ch.getBoundingClientRect(); x = r.left - DESKW; y = r.top; w = DESKW - 12; h = Math.min(r.height, innerHeight - y - 8, want); } // ends after the last row
    else if (DK.dock && t && t.width > 200 && innerHeight - t.bottom - 16 >= 130) { x = t.left; y = t.bottom + 8; w = t.width; h = Math.min(want, innerHeight - y - 8); }
    else { w = 340; h = Math.min(want, innerHeight - 24); x = DK.x != null ? DK.x : t ? t.left - w - 10 : innerWidth - w - 16; y = DK.y != null ? DK.y : t ? t.top : 72;
      if (DK.x == null && t && x < 8) { x = 8; w = Math.max(240, t.left - 18); } // beside GP., never under it
      x = Math.max(0, Math.min(innerWidth - w, x)); y = Math.max(0, Math.min(innerHeight - h, y)); }
    st.left = Math.round(x) + 'px'; st.top = Math.round(y) + 'px'; st.width = Math.round(w) + 'px'; st.height = Math.round(h) + 'px';
  }
  function deskBig(v) { if (!v) setTimeout(reflowSoon, 0); return deskBig0(v); }
  function deskBig0(v) { DK.big = !!v; if (DK.big) DK.tab = 'acc'; saveDK(); renderDesk(); placeDesk(); if (DK.big) DS.host.focus && DS.host.setAttribute('tabindex', '-1'), DS.host.focus(); }
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
      const fl = floorOf(c.id), room = fl ? eq - fl.F : null, roomMax = fl ? Math.max(room, base - fl.F, 1) : null;
      const tg = +c.target_equity, need = c.account_type === 2 && tg > 0 ? Math.max(0, tg - eq) : null, born = Date.parse(c.created_at || '') || (+c.attempt_index || 0);
      out.push({ id: c.id, role, need, born, bal: cash, eq, u, today: eq - base + paidToday(c.id, d0), n: ps.length, room, roomMax, roomW: fl ? fl.which : '', ps: ps.map(p => ({ long: !/^s/i.test(p.side || ''), q: Math.abs(+p.quantity), sym: p.symbol })),
        kind: c.account_type === 3 ? (/instant/i.test(c.plan_product_type || '') ? 'Instant' : 'Funded') : 'Eval' });
    });
    const rk = r => r.role === 'lead' ? 0 : 1;
    return out.sort((a, b) => rk(a) - rk(b) || (b.n > 0) - (a.n > 0) || b.today - a.today); // lead first, then accounts in a trade, then by today
  }
  W.__gpzDesk = () => deskRows().map(r => ({ id: r.id, role: r.role, u: +r.u.toFixed(2), today: +r.today.toFixed(2), n: r.n }));
  const tone = v => Math.abs(v) < 0.005 ? 'flat' : v > 0 ? 'up' : 'dn';
  function dayLine(rows) { // today's equity per account, a point a minute, kept for the day
    const d0 = String(vestDay()); if (!DB.dl || DB.dl.d !== d0) DB.dl = { d: d0, at: 0, ids: {} };
    if (Date.now() - DB.dl.at < 60000) return; DB.dl.at = Date.now();
    rows.forEach(r => { const a = DB.dl.ids[r.id] || (DB.dl.ids[r.id] = []); a.push(Math.round(r.today * 100) / 100); if (a.length > 900) a.splice(0, a.length - 900); }); save();
  }
  function spark(id, v) {
    const a = ((DB.dl && DB.dl.ids[id]) || []).concat(v); if (a.length < 2) return '';
    const W = 46, H = 14, lo = Math.min(0, ...a), hi = Math.max(0, ...a), sp = hi - lo || 1, X = i => (i / (a.length - 1) * W).toFixed(1), Y = x => (H - 1 - (x - lo) / sp * (H - 2)).toFixed(1);
    return `<svg class="dl" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><path d="M0 ${Y(0)}H${W}" stroke="rgba(238,234,226,.12)" stroke-dasharray="2 2"/><path d="${a.map((x, i) => (i ? 'L' : 'M') + X(i) + ' ' + Y(x)).join('')}" stroke="${v >= 0 ? '#9fd7b2' : '#e8988c'}"/></svg>`;
  }
  const LOCKSVG = '<svg width="9" height="10" viewBox="0 0 9 10" aria-hidden="true"><rect x="0.5" y="4.2" width="8" height="5.3" rx="1.4" fill="currentColor"/><path d="M2.4 4.4V3a2.1 2.1 0 0 1 4.2 0v1.4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  function renderDesk() {
    if (!DK.open || !DS) return; const { R, k } = DS;
    const rows = deskRows(), live = rows.filter(r => r.n), shown = DK.all ? rows : rows.filter(r => r.n || r.role); dayLine(rows);
    const U = live.reduce((a, r) => a + r.u, 0), T = rows.reduce((a, r) => a + r.today, 0), npos = live.reduce((a, r) => a + r.n, 0);
    R.querySelector('.d').classList.toggle('live', live.length > 0); R.querySelector('.d').classList.toggle('busyall', !!DK.busy.all); R.querySelector('[data-a=side]').textContent = DK.side ? '⇥' : '⇤';
    const o = k('open'); o.textContent = live.length ? fm(U, { sign: true }) : 'flat'; o.className = 'o ' + (live.length ? tone(U) : 'dim flat');
    const t = k('today'); t.textContent = fm(T, { sign: true }); t.className = tone(T);
    const fx = R.querySelector('[data-a=flat]'); fx.disabled = !!DK.busy.all; fx.classList.toggle('busy', !!DK.busy.all); k('fx').textContent = npos ? 'flatten all · ' + npos : 'flatten all'; fx.title = 'Cancels every pending order and closes every position, on every account';
    const tab = DK.tab === 'pnl' ? 'pnl' : 'acc', d = R.querySelector('.d'); d.classList.toggle('acc', tab === 'acc'); d.classList.toggle('pnl', tab === 'pnl');
    R.querySelectorAll('[data-t]').forEach(b => b.classList.toggle('on', b.dataset.t === tab));
    R.querySelector('[data-a=arm]').classList.toggle('on', !!C.on);
    R.querySelectorAll('[data-cm]').forEach(b => b.classList.toggle('on', b.dataset.cm === C.mode));
    const cur = activeAcct(), lead = copyLeader();
    k('ld').innerHTML = C.elsewhere ? 'on in another tab' : lead ? (C.on ? 'from ' : 'lead ') + '<b>' + acctShort(lead).replace(/^Account /, '') + '</b>' : '';
    const accRow = r => {
      const isL = r.id === lead, on = !!C.followers[r.id], e = on && C.err[r.id], cr = on && C.res && C.res[r.id], crOk = cr && Date.now() - cr.t < 6e5;
      const mark = e ? `<i class="cr bad" title="${esc(e)}">✕</i>` : crOk && cr.ok ? `<i class="cr ok" title="last copy landed">✓ ${cr.ms}ms</i>` : '';
      const chip = r.ps.map(p => `<span class="pc${p.long ? '' : ' sh'}">${p.long ? 'LONG' : 'SHORT'} ${trimNum(+fmtQ(p.q, p.sym))} ${shortSym(p.sym)}</span>`).join('') + (r.n ? `<span class="pu ${tone(r.u)}">${fm(r.u, { sign: true })}</span>` : '');
      const rb = r.room != null ? `<div class="rb${r.room / r.roomMax < 0.25 ? ' low' : ''}" title="${r.roomW} room: what the account can lose before its floor"><span>${r.roomW}</span><div class="bar"><i style="width:${Math.max(0, Math.min(100, r.room / r.roomMax * 100)).toFixed(1)}%"></i></div><b>${fm(Math.max(0, r.room))}</b></div>` : '';
      const lk = lockedAcct(r.id), lkTag = lk ? `<i class="tg lkd" title="Zone lock: no trading on this account until Vest's 8pm reset">${LOCKSVG}LOCKED</i>` : '';
      return `<div class="r a${r.id === cur ? ' cur' : ''}${r.kind !== 'Eval' ? ' fd' : ''}${isL ? ' lead' : ''}${lk ? ' lkd' : ''}" data-id="${r.id}"><div class="nm"><b>${acctShort(r.id).replace(/^Account /, '')}</b><em>${r.kind}${r.need != null ? ' · ' + (r.need > 0 ? fk(r.need) + ' to go' : 'target hit') : ''}</em>${lkTag}${lk ? '' : mark}</div>
        <div class="v vb b">${fk(r.bal)}</div>
        <div class="v vt ${tone(r.today)}">${fm(r.today, { sign: true })}</div>
        <span class="ro"><button class="lb${isL ? ' on' : ''}" data-ld="${r.id}" title="${isL ? 'Lead account' : 'Make it the lead'}">LEAD</button>${isL ? '<span class="fo nil"></span>' : `<button class="fo${on ? ' on' : ''}" data-fo="${r.id}" title="${on ? 'Stop copying to it' : 'Copy to it'}"></button>`}</span>
        ${chip || rb ? `<div class="ex">${chip ? `<div class="pcs">${chip}</div>` : ''}${rb}</div>` : ''}</div>`;
    };
    const GROUPS = ['Funded', 'Instant', 'Eval'];
    const so = DK.sort || 'auto', srt = (a, b) => so === 'target' ? (a.need != null && b.need != null ? a.need - b.need : b.today - a.today) : so === 'pnl' ? b.today - a.today : so === 'new' ? b.born - a.born : so === 'old' ? a.born - b.born : 0;
    R.querySelectorAll('[data-so]').forEach(b => b.classList.toggle('on', b.dataset.so === so));
    const accHtml = () => GROUPS.map(g => { const rs = rows.filter(r => r.kind === g).sort((a, b) => (a.id === lead) - (b.id === lead) ? (b.id === lead) - (a.id === lead) : srt(a, b)); if (!rs.length) return '';
      const sub = rs.reduce((a, r) => a + r.today, 0), all = rs.filter(r => r.id !== lead).every(r => C.followers[r.id]);
      return `<div class="gh" data-g="${g}" title="${all ? 'Stop copying to all ' : 'Copy to all '}${g}"><span>${g}<i>${rs.length}</i></span><b class="${tone(sub)}">${fm(sub, { sign: true })}</b></div>` + rs.map(accRow).join(''); }).join('');
    const html = tab === 'acc' ? accHtml() : shown.map(r => {
      const b = DK.busy[r.id] || DK.busy.all, dis = !r.n || b ? ' disabled' : '';
      const btn = (p, lbl, cls) => `<button class="k${cls || ''}${DK.busy[r.id] === p ? ' busy' : ''}" data-cut="${p}" title="${p >= 100 ? 'Close' : 'Cut ' + p + '%'}"${dis}>${lbl}</button>`;
      return `<div class="r${r.kind !== 'Eval' ? ' fd' : ''}" data-id="${r.id}"><div class="nm"><b>${acctShort(r.id).replace(/^Account /, '')}</b>${r.role ? `<i class="tg ${r.role}">${r.role === 'lead' ? 'LEAD' : 'COPY'}</i>` : `<em>${r.kind}</em>`}${lockedAcct(r.id) ? `<i class="tg lkd" title="Zone lock until Vest's 8pm reset">${LOCKSVG}LOCKED</i>` : ''}${spark(r.id, r.today)}</div>
        <div class="v vo ${r.n ? tone(r.u) : 'dim'}">${r.n ? fm(r.u, { sign: true }) : '—'}</div>
        <div class="v vt ${tone(r.today)}">${fm(r.today, { sign: true })}</div>
        <div class="ac">${btn(10, '10')}${btn(20, '20')}${btn(25, '25')}${btn(50, '50')}${btn(100, '×', ' cl')}</div></div>`;
    }).join('');
    const rowsEl = k('rows'); if (rowsEl.__h !== html) rowsEl.__h = html, rowsEl.innerHTML = html || '<div class="none">' + (tab === 'acc' ? 'reading your accounts' : 'nothing open') + '</div>';
    const fresh = DK.msg && Date.now() - DK.msgAt < 9000, n = (pruneFollowers(), nFollow());
    const lg = C.log[0], lgFresh = lg && Date.now() - lg.t < 60000;
    const hm = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }), m = k('m'); m.textContent = fresh ? DK.msg + ' · ' + hm(DK.msgAt) : tab === 'acc' && lgFresh ? lg.msg + ' · ' + hm(lg.t) : C.on ? 'copying ' + n : live.length + ' of ' + rows.length + ' in trade'; m.className = 'm ' + (fresh ? DK.tone : tab === 'acc' && lgFresh && lg.bad ? 'bad' : '');
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
    clog((pct >= 100 ? 'Closed ' : 'Cut ' + pct + '% · ') + nm, !!bad.length);
    renderDesk(); kickFast(150);
  }
  // one click: every position on every account, closed at market
  // the failsafe: every pending order on every account cancelled, every position closed, then checked again
  async function cancelAllOrders(ids) {
    let n = 0; const bad = [];
    await Promise.allSettled(ids.map(async id => {
      const j = await send(id, 'GET', '/v3/positions/opened-orders').catch(e => { bad.push(e.message); return null; });
      const os = j && (Array.isArray(j) ? j : j.orders || j.items || []) || [];
      for (const o of os) { const oid = o.order_id || o.orderId || o.id; if (!oid || /filled|cancel|reject/i.test(o.status || '')) continue;
        try { await sendExit(id, '/v3/positions/cancel-order', { orderId: oid }); n++; } catch (e) { bad.push(e.message); } }
    }));
    return { n, bad };
  }
  async function deskFlatten() {
    if (DK.busy.all) return;
    const ids = (L.cap || []).filter(c => c.status === 2 && L.bal[c.id] != null).map(c => c.id); if (!ids.length) return;
    DK.busy.all = 1; renderDesk();
    const o1 = await cancelAllOrders(ids); // pending limits first, so none can fill while the positions close
    const ps = L.pos.slice(), res = await Promise.allSettled(ps.map(p => cutOne(accOf(p), p, 100)));
    await sleep(900); const o2 = await cancelAllOrders(ids); // anything left hanging after the closes
    saveC(); delete DK.busy.all;
    const bad = res.filter(r => r.status === 'rejected').map(r => r.reason.message).concat(o1.bad, o2.bad), n = o1.n + o2.n;
    deskSay(bad.length ? bad.length + ' failed · ' + bad[0] : 'Flattened · ' + ps.length + ' closed · ' + n + ' order' + (n === 1 ? '' : 's') + ' cancelled', bad.length);
    clog(bad.length ? 'Flatten all: ' + bad.length + ' failed' : 'Flattened · ' + ps.length + ' closed · ' + n + ' order' + (n === 1 ? '' : 's') + ' cancelled', !!bad.length);
    renderDesk(); kickFast(150);
  }

  // keyboard shortcuts: off by default; switched on and set in the keys popup. One press is one order: a held key
  // does nothing more. Off while typing in any box and while the Pulse panel is open; they work with the chart focused.
  const comboOf = e => [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', e.code].filter(Boolean).join('+');
  const keyName = c => String(c || '').split('+').map(x => x.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '').replace(/^Meta$/, 'Cmd')).join(' ').toUpperCase();
  let KREC = null;
  function hotkey(e) {
    if (KREC) { if (/^(Alt|Control|Shift|Meta)/.test(e.code || e.key)) return; e.preventDefault(); e.stopPropagation(); const k = KREC; KREC = null;
      if (e.code !== 'Escape') { const c = comboOf(e); ['long', 'short', 'close'].forEach(n => { if (n !== k && SH.keys[n] === c) SH.keys[n] = ''; }); SH.keys[k] = c; saveSH(); }
      renderShot(); return; }
    const K = SH.keys; if (!K.on || !SHOT.visible || OPEN) return;
    const c = comboOf(e), act = ['long', 'short', 'close'].find(n => K[n] && K[n] === c); if (!act) return;
    const t = (e.composedPath && e.composedPath()[0]) || e.target; if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''))) return;
    e.preventDefault(); if (e.repeat) return;
    const ap = SHOT.adding && curPos();
    if (ap && act !== 'close') { if ((act === 'long') === /^l/i.test(ap.side)) addMore(); else shotMsg('this trade is ' + (/^l/i.test(ap.side) ? 'long' : 'short'), 'bad'); return; }
    if (act === 'long') fire('long'); else if (act === 'short') fire('short'); else closeMine();
  }
  document.addEventListener('keydown', hotkey, true);
  function hookFrame(f) { // the chart is its own page: keys pressed there never reach Vest's page, so they are heard there too
    try { const d = f.contentDocument; if (!d || d.__gpzKeys) return; d.__gpzKeys = 1; d.addEventListener('keydown', hotkey, true);
      d.addEventListener('pointerdown', () => { CHDOWN = true; if (SHOT.kpOff) SHOT.kpOff(); }, true); ['pointerup', 'pointercancel'].forEach(t => d.addEventListener(t, () => { CHDOWN = false; }, true)); } catch (e) {}
  }
  if (DK.open) setTimeout(() => deskToggle(true), 1200);
  // a cleaner Vest: no market-category rail beside the chart, no Feedback tab
  (function clean() { const root = document.documentElement; if (!root) return setTimeout(clean, 30); if (document.getElementById('gpz-clean')) return; const st = document.createElement('style'); st.id = 'gpz-clean'; st.textContent = 'aside.h-full:has(> ul.space-y-2),aside.h-full:has(> ul.space-y-2) + div.w-px,div[class^="PostHogSurvey"]{display:none!important}'; root.appendChild(st); })();
  let lastPath = location.pathname;
  function freshLayout() { // forget what was measured on the old page: Vest builds a new one
    OCOL = null; SHOT.lastH = 0; bookDone = ''; skinKey = ''; tkFit(null);
    document.querySelectorAll('[data-gpz-col],[data-gpz-chartcol]').forEach(e => { e.removeAttribute('data-gpz-col'); e.removeAttribute('data-gpz-chartcol'); });
  }
  let reflowT = [];
  function reflow() { if (document.hidden) return; if (OCOL && !OCOL.isConnected) OCOL = null; layoutCols(); placeShot(); placeDesk(); } // re-place only: tearing the dock down on every nudge made it flicker
  function reflowSoon() { reflowT.forEach(clearTimeout); reflowT = [0, 120, 450, 1200].map(ms => setTimeout(reflow, ms)); } // Vest often re-renders just after a tab comes back
  ['pageshow', 'resize'].forEach(ev => addEventListener(ev, reflowSoon));
  ['pushState', 'replaceState'].forEach(m => { const o = history[m]; history[m] = function () { const was = location.pathname, r = o.apply(this, arguments); if (location.pathname !== was) setTimeout(reflowSoon, 0); return r; }; }); // only a real page change, not Vest's frequent URL updates
  addEventListener('popstate', reflowSoon);
  function snapAll() { // the reset: everything back in its place
    SH.dock = true; SH.x = SH.y = null; SH.on = true; saveSH();
    Object.assign(DK, { open: true, side: true, dock: true, big: false, tab: 'acc', x: null, y: null }); saveDK();
    DB.colF = null; save(true); freshLayout(); deskHost(); renderDesk();
    layoutCols(); placeShot(); placeDesk(); setTimeout(() => { layoutCols(); placeShot(); placeDesk(); }, 300);
    shotMsg('snapped back', 'ok');
  }
  every(400, () => { watchPops(); popZ(); if (document.hidden) return; if (location.pathname !== lastPath) { lastPath = location.pathname; clearLines(); kickFast(); freshLayout(); reflowSoon(); } else if (OCOL && !OCOL.isConnected) OCOL = null; layoutCols(); bookFold(); placeShot(); placeDesk(); document.querySelectorAll('iframe[id^="tradingview_"]').forEach(hookFrame); });

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
    const oText = l.setText, oRemove = l.remove, oLen = l.setLineLength;
    if (typeof oLen === 'function') { l.__gpzSetLen = oLen; l.setLineLength = function (v, u) { this.__gpzLen = [v, u]; return oLen.apply(this, this.__gpzOwn ? [v, u] : lenOf(this)); }; }
    if (typeof oText === 'function') { l.__gpzSetText = oText; l.setText = function (t) { this.__gpzBase = t; return oText.call(this, String(t) + (this.__gpzSuf || '')); }; }
    if (typeof oRemove === 'function') l.remove = function () { VL.delete(this); return oRemove.apply(this, arguments); };
    if (DB.skin !== false) setTimeout(() => { if (!l.__gpzOwn) { try { l.setBodyFont && l.setBodyFont(LINE_FONT); l.setQuantityFont && l.setQuantityFont(LINE_FONT); } catch (e) {} } }, 0);
    return l;
  }
  every(250, () => { if (DB.skin !== false) wrapChart(chartApi()); });
  function wrapChart(ch) {
    try { const proto = ch && Object.getPrototypeOf(ch); if (!proto || proto === Object.prototype || typeof proto.createOrderLine !== 'function') return; if (!proto.__gpzWrapped) { Object.defineProperty(proto, '__gpzWrapped', { value: 1 }); ['createOrderLine', 'createPositionLine'].forEach(m => { const o = proto[m]; if (typeof o === 'function') proto[m] = function () { return wrapLine(o.apply(this, arguments)); }; }); } } catch (e) {}
  }
  // chart colours: the canvas and candles, picked from the chart chip
  if (!DB.cthV) { DB.cthV = 1; DB.skin = false; DB.cthPaint = true; save(); } // Vest's own colours are the default
  if (DB.cthV < 2) { DB.cthV = 2; if (DB.skin === false) DB.cth = 'vest'; save(); } // the look and the chart's colours are picked apart now
  let CTH_FRAME = '', CTH_HOLD = 0; // after a load or a pick, your set is held while Vest restores its saved chart layout
  const sameColors = () => { const r = readChart(); if (!r) return true; const c = chartColors(), g = k => toHex(c[k]); return toHex(r.bg) === g('paneProperties.background') && toHex(r.up) === g('mainSeriesProperties.candleStyle.upColor') && toHex(r.dn) === g('mainSeriesProperties.candleStyle.downColor'); };
  function cTheme() { return allThemes().find(t => t.id === DB.cth) || CTHEMES[0]; }
  function chartColors() { return cTheme().id === 'vest' ? Object.assign({}, VEST_CHART) : skinOverrides(); }
  function skinOverrides() {
    const o = { 'paneProperties.backgroundType': 'solid', 'paneProperties.background': MS.bg, 'paneProperties.backgroundGradientStartColor': MS.bg, 'paneProperties.backgroundGradientEndColor': MS.bg,
      'paneProperties.vertGridProperties.color': '#141414', 'paneProperties.horzGridProperties.color': '#141414', 'scalesProperties.lineColor': '#1f1f1f', 'scalesProperties.textColor': MS.muted,
      'paneProperties.crossHairProperties.color': '#6f6f75', 'mainSeriesProperties.lineStyle.color': MS.cream, 'mainSeriesProperties.areaStyle.linecolor': MS.cream, 'mainSeriesProperties.areaStyle.color1': 'rgba(230,227,220,0.22)', 'mainSeriesProperties.areaStyle.color2': 'rgba(230,227,220,0)' };
    for (const k of ['candleStyle', 'hollowCandleStyle', 'haStyle']) Object.assign(o, { [`mainSeriesProperties.${k}.upColor`]: MS.up, [`mainSeriesProperties.${k}.downColor`]: MS.down, [`mainSeriesProperties.${k}.borderUpColor`]: MS.up, [`mainSeriesProperties.${k}.borderDownColor`]: MS.down, [`mainSeriesProperties.${k}.wickUpColor`]: MS.up, [`mainSeriesProperties.${k}.wickDownColor`]: MS.down });
    o['mainSeriesProperties.barStyle.upColor'] = MS.up; o['mainSeriesProperties.barStyle.downColor'] = MS.down;
    return Object.assign(o, themeOverrides());
  }
  function themeOverrides() {
    const t = cTheme(); if (t.id === 'massive' || t.id === 'vest') return {};
    const o = { 'paneProperties.backgroundType': 'solid', 'paneProperties.background': t.bg, 'paneProperties.backgroundGradientStartColor': t.bg, 'paneProperties.backgroundGradientEndColor': t.bg,
 }; // canvas and candles only
    if (t.scale) o['scalesProperties.textColor'] = t.scale; // on a light canvas the price and time numbers go dark to stay readable
    for (const k of ['candleStyle', 'hollowCandleStyle', 'haStyle']) Object.assign(o, { [`mainSeriesProperties.${k}.upColor`]: t.up, [`mainSeriesProperties.${k}.downColor`]: t.dn, [`mainSeriesProperties.${k}.borderUpColor`]: t.upB, [`mainSeriesProperties.${k}.borderDownColor`]: t.dnB, [`mainSeriesProperties.${k}.wickUpColor`]: t.upW, [`mainSeriesProperties.${k}.wickDownColor`]: t.dnW, [`mainSeriesProperties.${k}.drawBorder`]: true });
    o['mainSeriesProperties.barStyle.upColor'] = t.upB; o['mainSeriesProperties.barStyle.downColor'] = t.dnB;
    return o;
  }
  const VEST_CHART = { 'paneProperties.backgroundType': 'solid', 'paneProperties.background': '#121714', 'paneProperties.backgroundGradientStartColor': '#121714', 'paneProperties.backgroundGradientEndColor': '#121714', 'paneProperties.vertGridProperties.color': 'rgba(0,0,0,0)', 'paneProperties.horzGridProperties.color': 'rgba(0,0,0,0)', 'scalesProperties.lineColor': '#292929', 'scalesProperties.textColor': '#F2F2F2', 'mainSeriesProperties.candleStyle.upColor': '#00D98E', 'mainSeriesProperties.candleStyle.downColor': '#E03737', 'mainSeriesProperties.candleStyle.borderUpColor': '#00D98E', 'mainSeriesProperties.candleStyle.borderDownColor': '#E03737', 'mainSeriesProperties.candleStyle.wickUpColor': '#00D98E', 'mainSeriesProperties.candleStyle.wickDownColor': '#E03737' };
  function paintChart(f, on, colors) { // colors: the canvas and candles too, only right after a set is picked
    try {
      const w = f.contentWindow, doc = f.contentDocument, api = w.tradingViewApi, ch = api && api.activeChart();
      if (!ch || typeof w.applyOverrides !== 'function') return false;
      wrapChart(ch); // Vest's own lines come out in the skin's tones from here on
      let st = doc.getElementById('gpz-skin');
      if (on) {
        if (!st) { st = doc.createElement('style'); st.id = 'gpz-skin'; (doc.head || doc.documentElement).appendChild(st); }
        st.textContent = `:root, body { --tv-color-platform-background: ${MS.bg} !important; --tv-color-pane-background: ${MS.bg} !important; --tv-color-popup-background: ${MS.card} !important; --tv-color-popup-element-background-active: ${MS.active} !important; --themed-color-drawer-backdrop: ${MS.bg} !important; --themed-color-pane-bg: ${MS.bg} !important; --themed-color-text: ${MS.text} !important; --themed-color-background: ${MS.card} !important; font-family: Inter, system-ui, sans-serif; }`;
      } else if (st) st.remove();
      if (colors) w.applyOverrides(chartColors());
      { const ts = doc.getElementById('gpz-cth'); if (ts) ts.remove(); } // the canvas colour comes from the overrides alone: Vest's toolbars keep their own dark
      if (colors) try { for (const s of ch.getAllStudies() || []) if (s && s.name === 'Volume') ch.getStudyById(s.id).applyOverrides(cTheme().id !== 'vest' ? { 'volume.color.0': '#2a2a2e', 'volume.color.1': '#4a4a50' } : { 'volume.color.0': '#E03737', 'volume.color.1': '#00D98E' }); } catch (e) {}
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
    if (!html.classList.contains('dark') && on) return;
    if (DB.cthPaint) { // a colour set was just picked: paint the chart once, then it is yours to change in the chart's own settings
      if (!paintChart(f, on, true)) return; // not ready yet: tried again on the next pass
      DB.cthPaint = false; CTH_HOLD = Date.now() + 25000; save(true); skinKey = [f.id, sym, on].join('|'); skinTimers.forEach(clearTimeout); // Vest re-applies its own colours as the chart settles: paint again after it
      skinTimers = [setTimeout(() => paintChart(f, DB.skin !== false, true), 1500), setTimeout(() => paintChart(f, DB.skin !== false, true), 4000)]; return;
    }
    if (f.id !== CTH_FRAME) { // a new chart: your picked set goes back on once, then it is yours to change in the chart's own settings
      if (!paintChart(f, on, true)) return; CTH_FRAME = f.id; CTH_HOLD = Date.now() + 25000; skinKey = [f.id, sym, on].join('|'); skinTimers.forEach(clearTimeout);
      skinTimers = [setTimeout(() => paintChart(f, DB.skin !== false, true), 1500), setTimeout(() => paintChart(f, DB.skin !== false, true), 4000)]; return;
    }
    if (Date.now() < CTH_HOLD && !sameColors()) paintChart(f, on, true); // Vest put its saved colours back: yours go on again
    const key = [f.id, sym, on].join('|'); if (key === skinKey) return;
    if (paintChart(f, on, false)) skinKey = key; // the frame's own dark and Vest's lines only: the candles are left alone
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
  every(700, noAutoScale);
  // Vest mode: GP.'s own panels take Vest's colours too, so the page looks as if nothing were installed
  const VMAP = [[/#0b0b0b/gi, '#121714'], [/rgba\(11,\s*11,\s*11,/g, 'rgba(18,23,20,'], [/#1[01]1[01]1[01]|#151515/gi, '#0f0f0f'],
    [/#e6e3dc|#eeeae2|#dedbd3|#f1f1f3/gi, '#f2f2f2'], [/rgba\((230,\s*227,\s*220|238,\s*234,\s*226),/g, 'rgba(242,242,242,'], [/#c9c7c2/gi, '#d4d4d4'],
    [/#9e9ea5|#8b8b92|#7a7a80|#6f6f75|#6d6d73/gi, '#a3a3a3'], [/#5f5f66|#55555b|#4f4f55/gi, '#737373'],
    [/#9fd7b2|#bfe6cb/gi, '#00d98e'], [/rgba\(159,\s*215,\s*178,/g, 'rgba(0,217,142,'], [/#e8988c|#efb1a7/gi, '#de1c4e'], [/rgba\(232,\s*152,\s*140,/g, 'rgba(222,28,78,']];
  const VEXTRA = `.mw{display:none!important}.s,.d{background:#121714!important;border-color:#292929!important;border-radius:8px!important;box-shadow:none!important}
    .L{background:#00d98e!important;color:#fff!important;box-shadow:none!important}.S{background:#de1c4e!important;border-color:#de1c4e!important;color:#fff!important}
    .L small,.S small{color:rgba(255,255,255,.7)!important}`;
  const vestify = css => VMAP.reduce((c, [re, to]) => c.replace(re, to), css) + VEXTRA;
  function vestPanels() {
    const vm = DB.skin === false;
    document.querySelectorAll('[id^=gpz-]').forEach(h => { const R = h.shadowRoot, st = R && R.querySelector('style'); if (!st) return;
      if (st.__gpzOrig == null) st.__gpzOrig = st.textContent; const want = vm ? vestify(st.__gpzOrig) : st.__gpzOrig; if (st.textContent !== want) st.textContent = want; });
  }
  every(700, vestPanels);
  function toggleSkin() { DB.skin = DB.skin === false; save(true); skinKey = ''; applySkin(); if (P) render(); }
  every(1000, applySkin);
  // code GIGA: a small switch in Vest's footer, right after Online. It sits in the row, so it never covers anything.
  const gigaChip = () => {
    let el = document.getElementById('gpz-giga');
    if (!el || !el.isConnected) {
      const o = [...document.querySelectorAll('a,span,p,button')].find(e => e.childElementCount === 0 && e.textContent.trim() === 'Online' && e.getBoundingClientRect().top > innerHeight * .6);
      if (!o) return;
      if (el) el.remove();
      el = document.createElement('button'); el.id = 'gpz-giga'; el.type = 'button'; el.title = 'Code GIGA at checkout';
      el.style.cssText = 'all:unset;display:inline-flex;align-items:center;gap:6px;margin-left:16px;font:600 11px/1 Manrope,Inter,system-ui,sans-serif;letter-spacing:.08em;cursor:pointer;vertical-align:middle;white-space:nowrap';
      el.innerHTML = '<i style="width:6px;height:6px;border-radius:50%;box-sizing:border-box"></i><span>GIGA</span>';
      el.onclick = e => { e.preventDefault(); e.stopPropagation(); DB.giga = DB.giga === false; DB.gigaSkip = 0; save(true); gigaChip(); try { renderShot(); } catch (x) {} };
      o.insertAdjacentElement('afterend', el);
    }
    const on = DB.giga !== false, d = el.firstChild;
    el.style.color = on ? '#9fd7b2' : '#6f6f76';
    d.style.background = on ? '#9fd7b2' : 'none'; d.style.border = on ? '0' : '1.5px solid #6f6f76';
    el.dataset.on = on ? '1' : '0';
  };
  every(1000, gigaChip);

  // ---------- start ----------
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && OPEN) closePanel(); });
  const boot = () => { booted = true; fonts(); applySkin(); placePill(); render(); every(1000, placePill); every(1000, () => { if (DB.zone || OPEN) render(); if (DB.zone && SHOT.visible) zoneBits(); }); loop(); fastLoop(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
