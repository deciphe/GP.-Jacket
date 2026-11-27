// ==UserScript==
// @name         GP. Jacket for MyFundedPerps
// @namespace    https://github.com/deciphe/GP.-Jacket
// @version      0.1.0
// @description  A risk-locked one-click order ticket and a desk of every account, on top of MyFundedPerps. Trades through MFP's own developer API with your key, kept in Tampermonkey on this computer.
// @author       GP.
// @match        https://myfundedperpetuals.com/*
// @match        https://www.myfundedperpetuals.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      developers.myfundedperpetuals.com
// @connect      sandbox.myfundedperpetuals.com
// @homepageURL  https://github.com/deciphe/GP.-Jacket
// @updateURL    https://raw.githubusercontent.com/deciphe/GP.-Jacket/main/gp-jacket-mfp.user.js
// @downloadURL  https://raw.githubusercontent.com/deciphe/GP.-Jacket/main/gp-jacket-mfp.user.js
// ==/UserScript==

(function () {
  'use strict';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  if (W.top !== W.self) return;
  if (W.__gpJacketMfp) return; W.__gpJacketMfp = 1; // one copy per page: two would send every order twice

  // ---------- saved in Tampermonkey on this computer ----------
  const DB = Object.assign({ key: '', risk: 1, rr: 1, size: 35, side: 'long', ot: 'market', loads: [], hide: false, desk: { open: true, x: 14, y: 150 }, acct: '' }, GM_getValue('jacketMfp', null) || {});
  let saveT = 0; const save = () => { clearTimeout(saveT); saveT = setTimeout(() => GM_setValue('jacketMfp', DB), 300); };

  // ---------- MFP's developer API: your key, every order with its own Idempotency-Key ----------
  const isTest = () => /^fp_test_/.test(DB.key);
  const HOST = () => isTest() ? 'https://sandbox.myfundedperpetuals.com' : 'https://developers.myfundedperpetuals.com';
  const uuid = () => (W.crypto && W.crypto.randomUUID) ? W.crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  // MFP allows 60 reads a minute per key (30 on sandbox). Jacket stays under it and never spends the budget twice on one thing.
  const GETS = []; let coolUntil = 0;
  const getRoom = urgent => { const now = Date.now(); while (GETS.length && now - GETS[0] > 60000) GETS.shift(); const cap = isTest() ? 24 : 48; return now >= coolUntil && GETS.length < (urgent ? cap + 6 : cap); };
  function call(method, path, body, urgent, idem) {
    return new Promise((ok, no) => {
      if (!DB.key) return no({ status: 0, code: 'nokey', message: 'Add your API key' });
      if (method === 'GET') { if (!getRoom(urgent)) return no({ status: 0, code: 'budget', message: 'Waiting on the read limit' }); GETS.push(Date.now()); }
      const headers = { Authorization: 'Bearer ' + DB.key, Accept: 'application/json' };
      if (method !== 'GET') { headers['Content-Type'] = 'application/json'; headers['Idempotency-Key'] = idem || uuid(); }
      GM_xmlhttpRequest({ method, url: HOST() + path, headers, data: body == null ? undefined : JSON.stringify(body), timeout: 15000,
        onload: r => { let j = null; try { j = r.responseText ? JSON.parse(r.responseText) : null; } catch (e) {}
          if (r.status >= 200 && r.status < 300) return ok({ status: r.status, body: j, retry: retryOf(r) });
          if (r.status === 429) coolUntil = Date.now() + (retryOf(r) || 20) * 1000;
          const er = (j && j.error) || {}; no({ status: r.status, code: er.code || 'http_' + r.status, message: er.message || ('HTTP ' + r.status), rule: er.rule_id, details: er.details }); },
        onerror: () => no({ status: 0, code: 'network', message: 'Network error' }), ontimeout: () => no({ status: 0, code: 'timeout', message: 'Timed out' }) });
    });
  }
  const retryOf = r => { const m = /retry-after:\s*(\d+)/i.exec(r.responseHeaders || ''); return m ? +m[1] : 0; };
  const errText = e => { const d = e && e.details; const more = Array.isArray(d) && d[0] ? ' · ' + d[0].field + ' ' + d[0].issue : ''; return String((e && e.message) || e || 'Failed').replace(/\.$/, '') + more; };

  // ---------- what Jacket knows ----------
  const S = { accounts: [], risk: {}, pos: {}, orders: {}, markets: [], copy: [], at: {}, fee: {}, err: '', roomMax: {} };
  const acctById = id => S.accounts.find(a => a.id === id);
  const liveAccts = () => S.accounts.filter(a => a.status === 'active');
  const SITE_KEY = 'fp:active-challenge-account';
  const siteAcct = () => { try { return localStorage.getItem(SITE_KEY) || ''; } catch (e) { return ''; } };
  let siteSeen = null;
  function acct() { // the account Jacket trades: the one picked on the desk, else the one MFP has open
    const live = liveAccts(); if (!live.length) return null;
    return live.find(a => a.id === DB.acct) || live.find(a => a.id === siteAcct()) || live[0];
  }
  function setAcct(id) {
    DB.acct = id; save();
    // keep MFP's own page on the same account, only when its ids are the ids the API gave us
    try { const cur = siteAcct(); if (cur && acctById(cur) && acctById(id) && cur !== id) { localStorage.setItem(SITE_KEY, id); siteSeen = id; W.dispatchEvent(new StorageEvent('storage', { key: SITE_KEY, oldValue: cur, newValue: id, storageArea: localStorage, url: location.href })); } } catch (e) {}
    due.pos = 0; due.risk = 0; due.orders = 0; renderAll();
  }
  const tail = a => { const n = String(a.account_number || a.name || a.id); const m = n.match(/(\d{4})\D*$/); return m ? m[1] : n.slice(-4); };
  const label = a => String(a.display_name || a.name || '').replace(/\s+/g, ' ').trim();

  // ---------- the market on the chart ----------
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const slug = () => { const m = /^\/(?:[a-z]{2}(?:-[A-Z]{2})?\/)?trade\/([^/?#]+)/.exec(location.pathname); return m ? norm(decodeURIComponent(m[1])) : ''; };
  const IS_TRADE = () => !!slug();
  function chartApi() { try { const f = document.querySelector('iframe[id^="tradingview_"]'); const a = f && f.contentWindow && f.contentWindow.tradingViewApi; return a ? a.activeChart() : null; } catch (e) { return null; } }
  let venueC = { at: 0, v: '' };
  function venue() { // the venue MFP's header shows for this market
    const now = Date.now(); if (now - venueC.at < 1500) return venueC.v;
    let v = ''; try { for (const e of document.querySelectorAll('span,div,p,label')) { if (e.childElementCount === 0 && e.textContent.trim() === 'Venue') { const box = e.parentElement; v = norm(box.textContent.replace('Venue', '')); break; } } } catch (e) {}
    venueC = { at: now, v }; return v;
  }
  const SUF = ['', 'USD', 'USDT', 'USDC', 'PERP', 'USDPERP', 'USDTPERP'];
  const fits = (m, b) => [m.symbol, m.coin].some(x => { const n = norm(x); return SUF.some(s => n === b + s); });
  function market() {
    const b = slug(); if (!b || !S.markets.length) return null;
    const c = S.markets.filter(m => fits(m, b)); if (!c.length) return null;
    const a = acct(), held = a && (S.pos[a.id] || []).find(p => c.some(m => m.market_id === p.market_id));
    if (held) return c.find(m => m.market_id === held.market_id);
    const v = venue(); return (v && c.find(m => norm(m.provider) === v)) || c.find(m => m.default_venue) || c[0];
  }
  function price() { const m = /^\s*([\d,]+(?:\.\d+)?)\s*\|/.exec(document.title); const v = m ? +m[1].replace(/,/g, '') : NaN; return v > 0 ? v : null; }
  const decOf = step => { const s = String(step); if (/e-/.test(s)) return +s.split('e-')[1]; const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
  const floorStep = (v, step) => { const d = decOf(step); return +(Math.floor(v / step + 1e-9) * step).toFixed(d); };
  const roundTick = (v, tick) => { const d = decOf(tick); return +(Math.round(v / tick) * tick).toFixed(d); };
  const fmtPx = (v, m) => (+v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: m ? decOf(m.tick_size) : 2 });
  const money = (v, sign) => { const a = Math.abs(v); return (v < 0 ? '−' : sign && v > 0 ? '+' : '') + '$' + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const kMoney = v => { const a = Math.abs(v); return '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : Math.round(a).toLocaleString('en-US')); };
  const pts = v => { const a = Math.abs(v); return a >= 100 ? a.toFixed(1) : a >= 1 ? a.toFixed(2) : a.toPrecision(3); };
  const base = m => { const n = norm(m.symbol || m.coin); for (const x of ['USDTPERP', 'USDPERP', 'USDT', 'USDC', 'USD', 'PERP']) if (n.length > x.length && n.endsWith(x)) return n.slice(0, -x.length); return n; };
  function levMode(m, pos) { // an open position keeps its own leverage and margin; otherwise whatever MFP's ticket is set to
    if (pos) return { lev: +pos.leverage, mode: pos.margin_mode };
    let lev = 0, mode = '';
    try { const host = panelHost(); if (host) for (const b of host.querySelectorAll('button')) { const t = b.textContent.trim(); if (/^(Isolated|Cross)$/i.test(t)) mode = t.toLowerCase(); else if (/^\d+(\.\d+)?\s*[×x]$/.test(t)) lev = parseFloat(t); } } catch (e) {}
    const mx = +m.max_leverage || 1; return { lev: Math.max(1, Math.min(lev || mx, mx)), mode: mode || 'cross' };
  }
  const feeBps = m => (S.fee[m.market_id] != null ? S.fee[m.market_id] : 4.5); // taker, each way; read from MFP's quote once per market

  // ---------- the plan: risk-locked size, fee-aware stop and target ----------
  let LIM = null; // the limit entry price while LIMIT is on
  const myPos = () => { const a = acct(), m = market(); return a && m ? (S.pos[a.id] || []).find(p => p.market_id === m.market_id) || null : null; };
  function plan() {
    const a = acct(), m = market(), px = price(); if (!a) return { ok: false, why: S.err || 'Loading accounts' }; if (!m) return { ok: false, why: IS_TRADE() ? 'Market not found' : 'Open a market' }; if (!px) return { ok: false, why: 'Waiting for price' };
    const r = S.risk[a.id], lm = levMode(m, null), avail = r ? +r.available_balance : +a.balance, fb = feeBps(m) / 1e4;
    const entry = DB.ot === 'limit' && LIM > 0 ? LIM : px, riskUsd = +a.balance * DB.risk / 100;
    const maxSize = avail * lm.lev / entry, size = floorStep(maxSize * DB.size / 100, m.size_step), fee = size * entry * fb * 2;
    const dist = size > 0 ? (riskUsd - fee) / size : 0, tdist = size > 0 ? (riskUsd * DB.rr + fee) / size : 0;
    const P = { a, m, px, entry, lev: lm.lev, mode: lm.mode, riskUsd, gain: riskUsd * DB.rr, size, maxSize, fee, dist, tdist, notional: size * entry,
      slL: roundTick(entry - dist, m.tick_size), tpL: roundTick(entry + tdist, m.tick_size), slS: roundTick(entry + dist, m.tick_size), tpS: roundTick(entry - tdist, m.tick_size) };
    P.why = size < m.min_size ? 'Size under the minimum' : P.notional < m.min_notional ? 'Under ' + kMoney(m.min_notional) + ' minimum' : dist <= 0 ? 'Fees eat the whole risk: lower size' : dist >= entry ? 'Stop below zero: raise size' : m.trading_enabled === false ? 'Market closed' : m.reduce_only ? 'Reduce only' : '';
    P.ok = !P.why; return P;
  }
  function sizeFromStop(stopPx) { const p = plan(); if (!p.m || !p.px) return; const d = Math.abs(stopPx - p.entry), fb = feeBps(p.m) / 1e4; if (!(d > 0)) return; const size = p.riskUsd / (d + 2 * p.entry * fb); DB.size = Math.max(1, Math.min(100, +(size / p.maxSize * 100).toFixed(2))); save(); renderAll(); }
  function rrFromTarget(tpPx) { const p = plan(); if (!p.ok) return; const g = Math.abs(tpPx - p.entry) * p.size - p.fee; DB.rr = Math.max(0.25, Math.min(10, +(g / p.riskUsd).toFixed(2))); save(); renderAll(); }

  // ---------- firing ----------
  let MSG = { t: '', tone: '', at: 0 }, BUSY = '';
  const say = (t, tone) => { MSG = { t, tone: tone || '', at: Date.now() }; renderShot(); };
  async function act(tag, fn) { if (BUSY) return; BUSY = tag; renderShot(); try { await fn(); } catch (e) { say(errText(e), 'bad'); } finally { BUSY = ''; due.pos = 0; due.orders = 0; due.risk = 0; renderAll(); } }
  const exitsOf = pos => { const os = (S.orders[pos.account_id] || []).filter(o => o.market_id === pos.market_id && o.reduce_only && /resting|pending/.test(o.status)); const isTp = o => o.bracket_role === 'take_profit' || /^take/.test(o.type), px = o => +(o.trigger_price != null ? o.trigger_price : o.limit_price);
    return { all: os, tp: os.filter(isTp), sl: os.filter(o => !isTp(o)), px, snap: os.map(o => ({ order_id: o.id, execution_type: /limit/.test(o.type) ? 'limit' : 'market', price: px(o), size: +o.size })) }; };
  function fire(side) {
    const p = plan(); if (!p.ok) return say(p.why, 'bad');
    const long = side === 'long', lim = DB.ot === 'limit';
    if (lim && !(LIM > 0)) return say('Drag the entry line, then arm', 'bad');
    const body = { client_order_id: 'gp-' + uuid().replace(/-/g, '').slice(0, 20), type: lim ? 'limit' : 'market', account_id: p.a.id, market_id: p.m.market_id, side: long ? 'buy' : 'sell', size: p.size, leverage: p.lev, margin_mode: p.mode,
      take_profit_price: long ? p.tpL : p.tpS, stop_loss_price: long ? p.slL : p.slS };
    if (lim) { body.limit_price = roundTick(p.entry, p.m.tick_size); body.marketable_limit_acknowledged = true; } else body.expected_price = p.px;
    return act(side, async () => {
      const r = await call('POST', '/v1/orders', body); const o = (r.body && r.body.data) || {};
      if (o.status === 'rejected') return say('Rejected: ' + String(o.reject_reason || o.reject_rule_id || '').replace(/_/g, ' '), 'bad');
      say((lim ? 'Armed ' : '') + (long ? 'Long ' : 'Short ') + p.size + ' ' + base(p.m) + (o.fill_price ? ' @ ' + fmtPx(o.fill_price, p.m) : ''), 'ok'); if (lim) { LIM = null; }
    });
  }
  const closePos = (pos, pct) => act('cut', async () => { const m = S.markets.find(x => x.market_id === pos.market_id); const body = { type: 'market', client_order_id: 'gp-' + uuid().replace(/-/g, '').slice(0, 20) }; const px = price(); if (px && market() && market().market_id === pos.market_id) body.expected_price = px;
    if (pct < 100) { const sz = floorStep(+pos.size * pct / 100, m ? m.size_step : 1e-6); if (!(sz > 0)) return say('Too small to trim', 'bad'); body.size = sz; }
    await call('POST', '/v1/positions/' + encodeURIComponent(pos.id) + '/close', body); say(pct < 100 ? 'Trimmed ' + pct + '%' : 'Closed', 'ok'); });
  const addPos = (pos, pct) => act('add', async () => { const m = S.markets.find(x => x.market_id === pos.market_id), a = acctById(pos.account_id), r = S.risk[a.id], px = price(); if (!m || !px) return say('Waiting for price', 'bad');
    const room = (r ? +r.available_balance : +a.balance) * +pos.leverage / px, sz = floorStep(Math.min(+pos.size * pct / 100, room), m.size_step); if (!(sz >= m.min_size)) return say('No margin left to add', 'bad');
    const ex = exitsOf(pos), body = { client_order_id: 'gp-' + uuid().replace(/-/g, '').slice(0, 20), type: 'market', account_id: a.id, market_id: m.market_id, side: pos.side === 'long' ? 'buy' : 'sell', size: sz, leverage: +pos.leverage, margin_mode: pos.margin_mode, expected_price: px };
    if (ex.tp[0]) body.take_profit_price = ex.px(ex.tp[0]); if (ex.sl[0]) body.stop_loss_price = ex.px(ex.sl[0]); if (ex.tp[0] || ex.sl[0]) body.replace_overlapping_exits = true;
    const res = await call('POST', '/v1/orders', body); const o = (res.body && res.body.data) || {}; if (o.status === 'rejected') return say('Rejected: ' + String(o.reject_reason || '').replace(/_/g, ' '), 'bad'); say('Added ' + sz + ' ' + base(m), 'ok'); });
  const breakEven = pos => act('be', async () => { const m = S.markets.find(x => x.market_id === pos.market_id), fb = feeBps(m) / 1e4, long = pos.side === 'long', px = price();
    const be = roundTick(+pos.entry_price * (long ? 1 + 2 * fb : 1 - 2 * fb), m.tick_size); if (px && (long ? px <= be : px >= be)) return say('Price is not past break-even yet', 'bad');
    const fresh = await call('GET', '/v1/orders?account_id=' + encodeURIComponent(pos.account_id) + '&status=working', null, true); S.orders[pos.account_id] = (fresh.body && fresh.body.data) || [];
    const ex = exitsOf(pos), ops = ex.sl.length ? ex.sl.map(o => ({ kind: 'modify', order_id: o.id, price: be })) : [{ kind: 'place', group: 'sl', execution_type: 'market', price: be, size: +pos.size }];
    await call('PUT', '/v1/positions/' + encodeURIComponent(pos.id) + '/exit-orders', { expected_position_size: +pos.size, expected_orders: ex.snap, operations: ops }); say('Stop at break-even ' + fmtPx(be, m), 'ok'); });
  async function untilDone(path) { // MFP works through these a few at a time: the same request, same key, until it reports completed
    const key = uuid(); for (let i = 0; i < 60; i++) { let r; try { r = await call('POST', path, {}, false, key); } catch (e) { if (e.status === 409 || e.status === 429 || e.status === 503) { await sleep(1200); continue; } throw e; }
      const op = (r.body && r.body.data) || {}; if (r.status !== 202 && op.status !== 'running') return op; await sleep(Math.max(300, Math.min(5000, (r.retry || 1) * 1000))); } }
  const flatAll = () => act('flat', async () => { const ids = liveAccts().map(a => a.id); say('Flattening ' + ids.length + ' accounts');
    const res = await Promise.allSettled(ids.map(async id => { await untilDone('/v1/accounts/' + encodeURIComponent(id) + '/cancel-all-orders'); await untilDone('/v1/accounts/' + encodeURIComponent(id) + '/close-all-positions'); }));
    const bad = res.filter(x => x.status === 'rejected'); ids.forEach(id => { S.at['pos:' + id] = 0; }); say(bad.length ? bad.length + ' of ' + ids.length + ' failed: ' + errText(bad[0].reason) : 'Flat on ' + ids.length + ' accounts', bad.length ? 'bad' : 'ok'); });

  // ---------- keeping up: a few reads on a clock, well inside MFP's limit ----------
  const due = { markets: 0, accounts: 0, risk: 0, pos: 0, others: 0, orders: 0, copy: 0, fee: 0 }; let rr = 0, ticking = false;
  const data = r => (r.body && r.body.data) || [];
  async function tick() {
    if (ticking || !DB.key || document.hidden) return; ticking = true;
    const now = Date.now(), slow = isTest() ? 2 : 1, a = acct();
    try {
      if (now >= due.markets) { due.markets = now + 18e5; S.markets = data(await call('GET', '/v1/markets?venues=all')); }
      if (now >= due.accounts) { due.accounts = now + 30000 * slow; S.accounts = data(await call('GET', '/v1/accounts')); S.accounts.forEach(x => { if (x.risk) S.risk[x.id] = x.risk; }); S.err = ''; }
      if (a && now >= due.pos) { due.pos = now + 4000 * slow; S.pos[a.id] = data(await call('GET', '/v1/positions?account_id=' + encodeURIComponent(a.id))); S.at['pos:' + a.id] = now; }
      const inTrade = a && ((S.pos[a.id] || []).length > 0);
      if (a && now >= due.orders) { due.orders = now + (inTrade ? 6000 : 20000) * slow; S.orders[a.id] = data(await call('GET', '/v1/orders?account_id=' + encodeURIComponent(a.id) + '&status=working')); }
      if (a && now >= due.risk) { due.risk = now + 15000 * slow; const r = await call('GET', '/v1/accounts/' + encodeURIComponent(a.id)); const x = r.body && r.body.data; if (x) { if (x.risk) S.risk[x.id] = x.risk; const i = S.accounts.findIndex(y => y.id === x.id); if (i >= 0) S.accounts[i] = Object.assign({}, S.accounts[i], x); } }
      if (now >= due.others) { due.others = now + 6000 * slow; const rest = liveAccts().filter(x => !a || x.id !== a.id); if (rest.length) { const x = rest[rr++ % rest.length]; // the other accounts, one per beat: loss room and open PnL, and the positions only when it holds one
          const r = await call('GET', '/v1/accounts/' + encodeURIComponent(x.id)), d = r.body && r.body.data, k = d && d.risk; if (k) { S.risk[x.id] = k; const i = S.accounts.findIndex(y => y.id === x.id); if (i >= 0) S.accounts[i] = Object.assign({}, S.accounts[i], d);
            if (+k.margin_used > 0) { S.pos[x.id] = data(await call('GET', '/v1/positions?account_id=' + encodeURIComponent(x.id))); S.at['pos:' + x.id] = now; } else S.pos[x.id] = []; } } }
      if (now >= due.copy) { due.copy = now + 120000; try { S.copy = data(await call('GET', '/v1/copy-trading')); } catch (e) {} }
      const m = market(); if (m && S.fee[m.market_id] == null && now >= due.fee) { due.fee = now + 30000; try { const q = await call('GET', '/v1/markets/' + encodeURIComponent(m.market_id) + '/quote?side=buy&size=' + m.min_size); const f = q.body && q.body.data && q.body.data.fee_bps; if (f > 0) S.fee[m.market_id] = +f; } catch (e) {} }
    } catch (e) { if (e.code !== 'budget') { S.err = e.status === 401 ? 'Key rejected' : e.status === 403 ? 'Key cannot do that' : errText(e); if (e.status === 401) { DB.key = ''; save(); } } }
    ticking = false; renderAll();
  }
  function followSite() { const s = siteAcct(); if (siteSeen === null) { siteSeen = s; return; } if (s !== siteSeen) { siteSeen = s; if (acctById(s) && DB.acct !== s) { DB.acct = s; save(); due.pos = 0; due.risk = 0; due.orders = 0; } } }

  // ---------- look ----------
  const CSS = `
  :host{all:initial;--bg:#0c0c0d;--card:#141415;--ink:#f6f4ef;--ink2:#c9c7c2;--mute:#8b8b92;--faint:#5c5c62;--mint:#9fd7b2;--mint2:#bfe6cb;--rose:#e8988c;--rose2:#efb1a7;--cr:#e6e3dc;--line:rgba(238,234,226,.07);font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink)}
  *{box-sizing:border-box;margin:0;padding:0}button{font:inherit;color:inherit;background:none;border:0;cursor:pointer}
  .s,.d{background:var(--bg);color:var(--ink);font-size:12px;line-height:1.2}
  .s{height:100%;display:flex;flex-direction:column;padding:14px 14px 12px;gap:12px;overflow:auto}
  .hd{display:flex;align-items:center;gap:8px}.hd b{font:800 14px/1 Inter,system-ui,sans-serif;letter-spacing:-.03em}.hd b i{color:var(--faint);font-style:normal}.sp{flex:1}
  .chip{height:24px;padding:0 10px;border-radius:7px;background:rgba(238,234,226,.07);font:700 10.5px/24px Inter,system-ui,sans-serif;letter-spacing:.06em;color:var(--ink2)}.chip:hover{background:rgba(238,234,226,.13);color:var(--ink)}.chip.on{background:var(--cr);color:#0b0b0b}
  .mk{display:flex;align-items:baseline;gap:8px}.mk b{font:800 19px/1 Inter,system-ui,sans-serif;letter-spacing:-.04em}.mk span{font:600 10.5px/1 Inter,system-ui,sans-serif;color:var(--mute);letter-spacing:.02em}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:10px}.two>div:last-child{text-align:right}
  .cap{font:700 9.5px/1 Inter,system-ui,sans-serif;letter-spacing:.16em;color:var(--mute);text-transform:uppercase}
  .big{font:800 27px/1 Inter,system-ui,sans-serif;letter-spacing:-.05em;margin-top:7px;font-variant-numeric:tabular-nums}.big.dn{color:var(--rose)}.big.up{color:var(--mint)}
  .sub{margin-top:5px;font:600 10.5px/1 Inter,system-ui,sans-serif;color:var(--mute);font-variant-numeric:tabular-nums}
  .sl{display:grid;grid-template-columns:62px 1fr 52px;align-items:center;gap:10px;height:26px}.sl label{font:700 9.5px/1 Inter,system-ui,sans-serif;letter-spacing:.16em;color:var(--mute)}.sl output{text-align:right;font:800 13px/1 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums}
  input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:18px;background:none;cursor:pointer}input[type=range]::-webkit-slider-runnable-track{height:4px;border-radius:9px;background:linear-gradient(90deg,var(--cr) var(--f,0%),rgba(238,234,226,.1) var(--f,0%))}input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:var(--ink);box-shadow:0 0 0 4px var(--bg)}
  input[type=range]::-moz-range-track{height:4px;border-radius:9px;background:rgba(238,234,226,.1)}input[type=range]::-moz-range-progress{height:4px;border-radius:9px;background:var(--cr)}input[type=range]::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:var(--ink)}
  .kv{display:flex;justify-content:space-between;gap:8px;font:600 10.5px/1 Inter,system-ui,sans-serif;color:var(--mute);font-variant-numeric:tabular-nums}.kv b{color:var(--ink2);font-weight:700}
  .lo{display:flex;flex-wrap:wrap;gap:6px}.lo .chip{max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.lo .chip.x{color:var(--rose2)}
  .ls{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ls button{height:54px;border-radius:12px;font:800 15px/1 Inter,system-ui,sans-serif;letter-spacing:-.02em;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px}
  .ls small{font:600 9.5px/1 Inter,system-ui,sans-serif;letter-spacing:.04em;opacity:.75}.ls .l{background:rgba(159,215,178,.16);color:var(--mint2)}.ls .l:hover{background:var(--mint);color:#0b0b0b}.ls .sh{background:rgba(232,152,140,.16);color:var(--rose2)}.ls .sh:hover{background:var(--rose);color:#0b0b0b}
  .ls button[disabled]{opacity:.35;cursor:default;pointer-events:none}
  .tabs{display:flex;justify-content:center;align-items:center;gap:14px;font:700 10px/1 Inter,system-ui,sans-serif;letter-spacing:.14em;color:var(--faint)}.tabs button{padding:4px 0;color:var(--faint)}.tabs button.on{color:var(--ink);box-shadow:inset 0 -1.5px 0 var(--ink)}.tabs i{width:3px;height:3px;border-radius:50%;background:var(--faint)}
  .msg{min-height:14px;text-align:center;font:600 11px/1.25 Inter,system-ui,sans-serif;color:var(--mute)}.msg.bad{color:var(--rose2)}.msg.ok{color:var(--mint2)}
  .pos{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:1px solid var(--line)}
  .row4{display:grid;grid-template-columns:repeat(4,1fr);gap:6px}.row3{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}
  .k{height:34px;border-radius:9px;background:rgba(238,234,226,.07);font:800 11.5px/1 Inter,system-ui,sans-serif;letter-spacing:.02em;color:var(--ink2)}.k:hover{background:rgba(238,234,226,.14);color:var(--ink)}.k.x{background:rgba(232,152,140,.16);color:var(--rose2)}.k.x:hover{background:var(--rose);color:#0b0b0b}.k.a{background:rgba(159,215,178,.14);color:var(--mint2)}.k.a:hover{background:var(--mint);color:#0b0b0b}
  .key{display:flex;flex-direction:column;gap:12px}.key input{height:38px;border-radius:9px;border:0;outline:0;background:rgba(238,234,226,.07);color:var(--ink);padding:0 12px;font:600 12px Inter,system-ui,sans-serif;width:100%}.key p{font:500 11px/1.45 Inter,system-ui,sans-serif;color:var(--mute)}.key a{color:var(--ink2)}
  .go{height:40px;border-radius:10px;background:var(--cr);color:#0b0b0b;font:800 12.5px/1 Inter,system-ui,sans-serif}
  .d{width:248px;max-height:72vh;border-radius:14px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,.55)}
  .dh{display:flex;align-items:center;gap:8px;padding:11px 12px 9px;cursor:grab;user-select:none}.dh b{font:800 12.5px/1 Inter,system-ui,sans-serif;letter-spacing:-.02em}.dh .n{font:600 10px/1 Inter,system-ui,sans-serif;color:var(--mute)}
  .fx{height:24px;padding:0 10px;border-radius:7px;background:rgba(232,152,140,.16);color:var(--rose2);font:800 10.5px/24px Inter,system-ui,sans-serif;letter-spacing:.08em;white-space:nowrap}.fx:hover{background:var(--rose);color:#0b0b0b}
  .rows{overflow:auto;padding-bottom:6px}.gh{padding:8px 12px 3px;font:700 9.5px/1 Inter,system-ui,sans-serif;letter-spacing:.16em;color:var(--faint);text-transform:uppercase;display:flex;justify-content:space-between}
  .z{display:flex;align-items:center;gap:8px;height:25px;padding:0 10px 0 12px;cursor:pointer}.z:hover{background:rgba(238,234,226,.045)}.z.cur{background:rgba(238,234,226,.09);box-shadow:inset 2px 0 0 var(--cr)}
  .zn{flex:none;min-width:30px;font:700 12px/1 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#a9a7a1}.z:hover .zn,.z.cur .zn,.z.in .zn{color:var(--ink)}
  .zp{flex:none;width:14px;height:14px;display:grid;place-items:center;border-radius:4px;font:700 9px/1 Inter,system-ui,sans-serif;font-style:normal;background:rgba(159,215,178,.16);color:var(--mint2)}.zp.sh{background:rgba(232,152,140,.16);color:var(--rose2)}
  .zc{flex:none;font:700 8.5px/1 Inter,system-ui,sans-serif;font-style:normal;letter-spacing:.1em;color:var(--mute)}.zc.ld{color:#0b0b0b;background:var(--cr);padding:3px 5px;border-radius:4px}
  .zb{flex:1;min-width:14px;height:4px;border-radius:9px;background:rgba(238,234,226,.08);overflow:hidden}.zb i{display:block;height:100%;border-radius:9px;background:rgba(159,215,178,.6)}.zb.low i{background:var(--rose)}.zb.nil{background:none}
  .zbal{flex:none;font:700 11.5px/1 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums;color:#dedcd5}.zt{flex:none;font:600 10.5px/1 Inter,system-ui,sans-serif;font-variant-numeric:tabular-nums}.zt.up{color:var(--mint)}.zt.dn{color:var(--rose)}
  .df{padding:7px 12px 9px;font:600 10px/1.2 Inter,system-ui,sans-serif;color:var(--mute);border-top:1px solid var(--line)}.df.bad{color:var(--rose2)}
  .pill{height:30px;padding:0 12px;border-radius:9px;background:var(--bg);color:var(--ink);font:800 11.5px/30px Inter,system-ui,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.5)}`;
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function mk(id, css) { let h = document.getElementById(id); if (h) return h.__gp; h = document.createElement('div'); h.id = id; h.style.cssText = css; const R = h.attachShadow({ mode: 'open' }); const st = document.createElement('style'); st.textContent = CSS; R.appendChild(st); const box = document.createElement('div'); R.appendChild(box); document.documentElement.appendChild(h); return (h.__gp = { host: h, R, box, key: '' }); }

  // ---------- the ticket: sits over MFP's own order panel ----------
  function panelHost() { for (const h of document.querySelectorAll('[data-terminal-panel-host]')) if (/Buy\s*\/\s*Long/.test(h.textContent)) return h; const b = [...document.querySelectorAll('button')].find(x => /^Buy\s*\/\s*Long\s+\S/.test(x.textContent.trim())); return b ? b.closest('section') : null; }
  let SP = null, DS = null, PEEK = null;
  function placeShot() {
    if (!SP) return; const ph = IS_TRADE() ? panelHost() : null, show = !!ph && !DB.hide;
    if (show) { const r = ph.getBoundingClientRect(); SP.host.style.cssText = `position:fixed;z-index:40;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${Math.min(r.height, innerHeight - r.top)}px;display:block`; } else SP.host.style.display = 'none';
    if (PEEK) { const on = !!ph && DB.hide; PEEK.host.style.cssText = on ? `position:fixed;z-index:40;right:14px;top:${Math.max(60, ph.getBoundingClientRect().top - 36)}px;display:block` : 'display:none'; }
  }
  const slider = (k, lab, min, max, step, out) => { const v = DB[k], f = ((v - min) / (max - min) * 100).toFixed(1); return `<div class="sl"><label>${lab}</label><input type="range" data-s="${k}" min="${min}" max="${max}" step="${step}" value="${v}" style="--f:${f}%"><output>${out}</output></div>`; };
  function renderShot() {
    if (!SP) return; const R = SP.box;
    if (!DB.key) { if (SP.key !== 'key') { SP.key = 'key'; R.innerHTML = `<div class="s"><div class="hd"><b>GP<i>.</i> Jacket</b><span class="sp"></span><button class="chip" data-a="hide">MFP</button></div><div class="key"><div class="cap">MyFundedPerps API key</div><input type="password" data-k="key" placeholder="fp_live_…" autocomplete="off" spellcheck="false"><button class="go" data-a="savekey">Save key</button><p>Make one in MFP under Settings, API Keys, with Read And Trade. It stays in Tampermonkey on this computer.</p><p><a href="https://myfundedperpetuals.com/settings?section=api-keys" target="_blank" rel="noopener">Open API Keys ↗</a></p><div class="msg bad" data-k="kmsg">${esc(S.err)}</div></div></div>`; } return; }
    const p = plan(), pos = myPos(), m = p.m || market(), a = p.a || acct(), px = p.px || price();
    const msg = Date.now() - MSG.at < 6000 ? MSG : { t: !p.ok && !pos ? p.why : '', tone: 'bad' };
    const head = `<div class="hd"><b>GP<i>.</i></b><span class="sp"></span>${a ? `<span class="chip" title="${esc(label(a))}">#${esc(tail(a))}</span>` : ''}<button class="chip${DB.desk.open ? ' on' : ''}" data-a="desk">Desk</button><button class="chip" data-a="hide">MFP</button></div>
      <div class="mk"><b>${m ? esc(base(m)) : '—'}</b><b>${px && m ? fmtPx(px, m) : ''}</b><span>${m ? esc(m.provider) : ''}${p.lev ? ' · ' + p.lev + '× ' + esc(p.mode) : ''}${isTest() ? ' · SANDBOX' : ''}</span></div>`;
    let body;
    if (pos && m) {
      const long = pos.side === 'long', u = px ? (px - pos.entry_price) * pos.size * (long ? 1 : -1) : null, ex = exitsOf(pos), sl = ex.sl[0] ? ex.px(ex.sl[0]) : null, tp = ex.tp[0] ? ex.px(ex.tp[0]) : null;
      body = `<div class="pos" style="border:0;padding:0"><div class="two"><div><div class="cap">${long ? 'Long' : 'Short'} ${esc(String(pos.size))} ${esc(base(m))}</div><div class="big ${u == null ? '' : u >= 0 ? 'up' : 'dn'}">${u == null ? '—' : money(u, true)}</div><div class="sub">Entry ${fmtPx(pos.entry_price, m)}</div></div>
        <div><div class="cap">Stop · Target</div><div class="sub" style="margin-top:9px;color:var(--rose2)">${sl ? fmtPx(sl, m) + ' · ' + money(-Math.abs(sl - pos.entry_price) * pos.size) : 'No stop'}</div><div class="sub" style="color:var(--mint2)">${tp ? fmtPx(tp, m) + ' · ' + money(Math.abs(tp - pos.entry_price) * pos.size, true) : 'No target'}</div></div></div>
        <div class="cap">Trim</div><div class="row4"><button class="k" data-cut="25">25%</button><button class="k" data-cut="50">50%</button><button class="k" data-cut="75">75%</button><button class="k x" data-cut="100">CLOSE</button></div>
        <div class="cap">Add · Protect</div><div class="row3"><button class="k a" data-add="25">+25%</button><button class="k a" data-add="50">+50%</button><button class="k" data-a="be">BREAK-EVEN</button></div></div>`;
    } else {
      const lim = DB.ot === 'limit', bs = m ? esc(base(m)) : '', dis = !p.ok || BUSY ? ' disabled' : '';
      body = `<div class="two"><div><div class="cap">Stop</div><div class="big dn">${p.riskUsd != null ? money(-p.riskUsd) : '—'}</div><div class="sub">${p.ok ? pts(p.dist) + ' pts' : ''}</div></div><div><div class="cap">Target</div><div class="big up">${p.gain != null ? money(p.gain, true) : '—'}</div><div class="sub">${p.ok ? pts(p.tdist) + ' pts' : ''}</div></div></div>
        <div>${slider('risk', 'RISK', 0.25, 6, 0.05, DB.risk + '%')}${slider('rr', 'REWARD', 0.25, 5, 0.05, DB.rr + 'R')}${slider('size', 'SIZE', 1, 100, 1, DB.size >= 100 ? 'max' : Math.round(DB.size) + '%')}</div>
        <div class="kv"><span>fees <b>${p.fee != null ? money(p.fee) : '—'}</b></span><span><b>${p.size != null ? p.size + ' ' + bs : '—'}</b> · ${p.notional ? kMoney(p.notional) : ''}</span></div>
        <div class="lo">${DB.loads.map((l, i) => `<button class="chip" data-load="${i}" title="${l.risk}% · ${l.rr}R · ${l.size}%">${esc(l.name)}</button>`).join('')}<button class="chip" data-a="saveload" title="Save these sliders">+ Loadout</button>${DB.loads.length ? '<button class="chip x" data-a="dropload" title="Remove the last loadout">−</button>' : ''}</div>
        <div class="ls"><button class="l"${dis} data-fire="long">${lim ? 'Arm long' : 'Long'} ${bs}<small>${p.ok ? 'SL ' + fmtPx(p.slL, m) : ''}</small></button><button class="sh"${dis} data-fire="short">${lim ? 'Arm short' : 'Short'} ${bs}<small>${p.ok ? 'SL ' + fmtPx(p.slS, m) : ''}</small></button></div>
        <div class="tabs"><button data-side="long" class="${DB.side === 'long' ? 'on' : ''}">LONG</button><button data-side="short" class="${DB.side === 'short' ? 'on' : ''}">SHORT</button><i></i><button data-ot="market" class="${!lim ? 'on' : ''}">MARKET</button><button data-ot="limit" class="${lim ? 'on' : ''}">LIMIT</button></div>`;
    }
    const html = `<div class="s">${head}${body}<div class="msg ${msg.tone}">${BUSY ? 'Sending' : esc(msg.t)}</div></div>`;
    if (html !== SP.key && !SP.drag) { SP.key = html; R.innerHTML = html; }
  }
  function shotEvents() {
    const R = SP.box;
    R.addEventListener('input', e => { const k = e.target.dataset && e.target.dataset.s; if (!k) return; SP.drag = true; DB[k] = +e.target.value; save(); const f = ((DB[k] - e.target.min) / (e.target.max - e.target.min) * 100).toFixed(1); e.target.style.setProperty('--f', f + '%'); e.target.nextElementSibling.textContent = k === 'risk' ? DB.risk + '%' : k === 'rr' ? DB.rr + 'R' : DB.size >= 100 ? 'max' : Math.round(DB.size) + '%'; drawChart(); });
    R.addEventListener('change', e => { if (e.target.dataset && e.target.dataset.s) { SP.drag = false; renderAll(); } });
    R.addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; const d = b.dataset;
      if (d.fire) return fire(d.fire); if (d.side) { DB.side = d.side; save(); return renderAll(); } if (d.ot) { DB.ot = d.ot; if (d.ot === 'limit' && !LIM) LIM = price(); if (d.ot === 'market') LIM = null; save(); return renderAll(); }
      const pos = myPos(); if (d.cut && pos) return closePos(pos, +d.cut); if (d.add && pos) return addPos(pos, +d.add); if (d.a === 'be' && pos) return breakEven(pos);
      if (d.load != null) { const l = DB.loads[+d.load]; if (l) { DB.risk = l.risk; DB.rr = l.rr; DB.size = l.size; save(); renderAll(); } return; }
      if (d.a === 'saveload') { DB.loads.push({ name: DB.risk + '% · ' + DB.rr + 'R · ' + Math.round(DB.size) + '%', risk: DB.risk, rr: DB.rr, size: DB.size }); DB.loads = DB.loads.slice(-6); save(); return renderAll(); }
      if (d.a === 'dropload') { DB.loads.pop(); save(); return renderAll(); }
      if (d.a === 'hide') { DB.hide = !DB.hide; save(); clearLines(); return renderAll(); } if (d.a === 'desk') { DB.desk.open = !DB.desk.open; save(); return renderAll(); }
      if (d.a === 'savekey') { const v = (R.querySelector('[data-k=key]').value || '').trim(); if (!/^fp_(live|test)_\S+$/.test(v)) { R.querySelector('[data-k=kmsg]').textContent = 'Keys start with fp_live_'; return; } DB.key = v; S.err = ''; save(); Object.keys(due).forEach(k => { due[k] = 0; }); SP.key = ''; renderAll(); tick(); } });
  }

  // ---------- the desk: every account on one line ----------
  function deskRows() { const cur = acct(), lead = new Set(S.copy.filter(c => c.enabled).map(c => c.source_account_id)), fol = new Set([].concat(...S.copy.filter(c => c.enabled).map(c => (c.targets || []).map(t => t.account_id))));
    return liveAccts().map(a => { const r = S.risk[a.id], ps = S.pos[a.id] || [], rooms = r ? [r.daily_loss_room, r.max_drawdown_room].filter(v => v != null) : [], room = rooms.length ? Math.min(...rooms) : null;
      if (room != null) S.roomMax[a.id] = Math.max(S.roomMax[a.id] || 0, room, r && r.max_drawdown_floor != null ? a.starting_balance - r.max_drawdown_floor : 0);
      return { a, cur: cur && cur.id === a.id, ps, room, max: S.roomMax[a.id] || 0, u: r && r.unrealized_pnl != null ? +r.unrealized_pnl : null, pl: +a.balance - +a.starting_balance, lead: lead.has(a.id), fol: fol.has(a.id) }; })
      .sort((x, y) => (y.ps.length > 0) - (x.ps.length > 0) || (y.lead - x.lead) || (x.a.stage === y.a.stage ? 0 : x.a.stage === 'funded' ? -1 : 1) || String(x.a.account_number).localeCompare(String(y.a.account_number))); }
  function renderDesk() {
    if (!DS) return; const on = DB.key && DB.desk.open && S.accounts.length > 0;
    DS.host.style.display = on ? 'block' : 'none'; if (!on) return;
    DS.host.style.left = Math.max(0, Math.min(innerWidth - 120, DB.desk.x)) + 'px'; DS.host.style.top = Math.max(0, Math.min(innerHeight - 60, DB.desk.y)) + 'px';
    const rows = deskRows(), n = rows.reduce((s, r) => s + r.ps.length, 0);
    const row = r => { const a = r.a, v = r.ps.length && r.u != null ? r.u : r.pl, za = Math.abs(v), zt = za < 0.005 ? '' : (v > 0 ? '+' : '−') + '$' + (za < 100 ? za.toFixed(2) : Math.round(za).toLocaleString('en-US'));
      const tip = [label(a), a.account_number, a.stage, 'balance ' + money(+a.balance), r.room != null ? 'loss room ' + money(Math.max(0, r.room)) : '', r.ps.map(p => p.side.toUpperCase() + ' ' + p.size + ' ' + p.symbol).join(', ')].filter(Boolean).join(' · ');
      const bar = r.room != null && r.max > 0 ? `<div class="zb${r.room / r.max < 0.25 ? ' low' : ''}"><i style="width:${Math.max(0, Math.min(100, r.room / r.max * 100)).toFixed(1)}%"></i></div>` : '<div class="zb nil"></div>';
      return `<div class="z${r.cur ? ' cur' : ''}${r.ps.length ? ' in' : ''}" data-id="${esc(a.id)}" title="${esc(tip)}"><b class="zn">${esc(tail(a))}</b>${r.ps.map(p => `<i class="zp${p.side === 'long' ? '' : ' sh'}">${p.side === 'long' ? 'L' : 'S'}</i>`).join('')}${r.lead ? '<i class="zc ld">LEAD</i>' : r.fol ? '<i class="zc">COPY</i>' : ''}${bar}<span class="zbal">${kMoney(+a.balance)}</span><span class="zt ${v > 0 ? 'up' : v < 0 ? 'dn' : ''}">${zt}</span></div>`; };
    const grp = (t, rs) => rs.length ? `<div class="gh"><span>${t}</span><span>${rs.length}</span></div>` + rs.map(row).join('') : '';
    const html = `<div class="d"><div class="dh"><b>Accounts</b><span class="n">${n ? n + ' in trade' : rows.length}</span><span class="sp"></span><button class="fx" data-a="flat" title="FLATTEN ALL OPEN AND PENDING">${n ? 'FLAT · ' + n : 'FLAT'}</button><button class="chip" data-a="close">✕</button></div><div class="rows">${grp('Funded', rows.filter(r => r.a.stage === 'funded'))}${grp('Evaluation', rows.filter(r => r.a.stage !== 'funded'))}</div>${S.err ? `<div class="df bad">${esc(S.err)}</div>` : ''}</div>`;
    if (html !== DS.key) { const sc = DS.box.querySelector('.rows'), st = sc ? sc.scrollTop : 0; DS.key = html; DS.box.innerHTML = html; const s2 = DS.box.querySelector('.rows'); if (s2) s2.scrollTop = st; }
  }
  function deskEvents() {
    DS.box.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { if (b.dataset.a === 'flat') return flatAll(); if (b.dataset.a === 'close') { DB.desk.open = false; save(); return renderAll(); } } const z = e.target.closest('.z'); if (z) setAcct(z.dataset.id); });
    DS.box.addEventListener('mousedown', e => { if (!e.target.closest('.dh') || e.target.closest('button')) return; const x0 = e.clientX - DB.desk.x, y0 = e.clientY - DB.desk.y; const mv = ev => { DB.desk.x = ev.clientX - x0; DB.desk.y = ev.clientY - y0; renderDesk(); }; const up = () => { removeEventListener('mousemove', mv, true); removeEventListener('mouseup', up, true); save(); }; addEventListener('mousemove', mv, true); addEventListener('mouseup', up, true); e.preventDefault(); });
  }

  // ---------- the plan on the chart: stop, target and a limit entry you can drag ----------
  const CHL = {};
  function clearLines() { for (const k in CHL) { try { CHL[k] && CHL[k].remove(); } catch (e) {} delete CHL[k]; } }
  function chLine(key, px, text, color, onMove) {
    const ch = chartApi(); if (!ch || typeof ch.createOrderLine !== 'function') return; let l = CHL[key];
    const set = (m, ...a) => { try { if (l && typeof l[m] === 'function') l[m](...a); } catch (e) {} };
    try { if (!l) { l = CHL[key] = ch.createOrderLine({ disableUndo: true }); set('setExtendLeft', true); set('setLineLength', 38, 'percentage'); set('setLineWidth', 1); set('setLineStyle', 2); set('setBodyFont', '600 11px Inter, system-ui, sans-serif'); set('setQuantity', '');
        ['setBodyBorderColor', 'setQuantityBorderColor', 'setCancelButtonBorderColor', 'setQuantityBackgroundColor', 'setCancelButtonBackgroundColor', 'setCancelButtonIconColor'].forEach(m => set(m, 'rgba(0,0,0,0)')); set('setBodyBackgroundColor', 'rgba(11,11,11,0.82)'); set('setCancellable', false);
        const line = l; set('onMove', () => { let v = null; try { v = line.getPrice(); } catch (e) {} if (v > 0 && line.__mv) { line.__hold = Date.now() + 1500; line.__mv(v); } }); }
      l.__mv = onMove || null; set('setEditable', !!onMove); if (!(l.__hold > Date.now())) set('setPrice', px); set('setText', text); set('setLineColor', color); set('setBodyTextColor', color);
    } catch (e) { delete CHL[key]; }
  }
  function drawChart() {
    if (!SP || DB.hide || !DB.key || !IS_TRADE()) return clearLines();
    const p = plan(); if (myPos() || !p.ok) return clearLines(); // in a trade MFP's own lines carry the stop and target
    const long = DB.side === 'long', sl = long ? p.slL : p.slS, tp = long ? p.tpL : p.tpS;
    chLine('sl', sl, 'GP. SL  ' + money(-p.riskUsd) + ' · ' + pts(p.dist) + ' pts', '#e8988c', sizeFromStop);
    chLine('tp', tp, 'GP. TP  ' + money(p.gain, true) + ' · ' + pts(p.tdist) + ' pts', '#9fd7b2', rrFromTarget);
    if (DB.ot === 'limit' && LIM > 0) chLine('en', LIM, 'GP. ' + (long ? 'LONG ' : 'SHORT ') + p.size, '#e6e3dc', v => { LIM = roundTick(v, p.m.tick_size); renderAll(); }); else if (CHL.en) { try { CHL.en.remove(); } catch (e) {} delete CHL.en; }
  }

  // ---------- start ----------
  function renderAll() { placeShot(); renderShot(); renderDesk(); drawChart(); if (PEEK) PEEK.box.innerHTML = '<button class="pill" data-a="show">GP. Jacket</button>'; }
  function boot() {
    try { if (!document.getElementById('gpz-font')) { const l = document.createElement('link'); l.id = 'gpz-font'; l.rel = 'stylesheet'; l.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@500;600;700;800&display=swap'; document.head.appendChild(l); } } catch (e) {}
    SP = mk('gpm-shot', 'display:none'); DS = mk('gpm-desk', 'position:fixed;z-index:41;display:none'); PEEK = mk('gpm-peek', 'display:none');
    shotEvents(); deskEvents(); PEEK.box.addEventListener('click', () => { DB.hide = false; save(); renderAll(); });
    setInterval(() => { followSite(); tick(); }, 1000); setInterval(() => { placeShot(); renderShot(); renderDesk(); drawChart(); }, 500);
    addEventListener('resize', placeShot); let href = location.href; setInterval(() => { if (location.href !== href) { href = location.href; LIM = null; clearLines(); due.fee = 0; renderAll(); } }, 400);
    renderAll(); tick();
  }
  W.__gpmHx = { S, DB, plan, market, acct, price }; // read-only handles for checks
  if (document.body) boot(); else addEventListener('DOMContentLoaded', boot);
})();
