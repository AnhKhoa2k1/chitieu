'use strict';
/* Chi Tiêu – app cá nhân đồng bộ với Google Sheet "Quản lý chi tiêu hàng tháng".
 * Mọi con số được tính lại trên máy theo đúng công thức của sheet (xem phần TÍNH TOÁN). */

const VERSION = '1.0.1';
const LS = { cfg: 'bct.cfg', data: 'bct.data', queue: 'bct.queue' };
const store = {
  get(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* bỏ qua */ } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* bỏ qua */ } },
};

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const TODAY_OVERRIDE = params.get('today');

let cfg = DEMO ? { url: 'demo', token: 'demo' } : store.get(LS.cfg, { url: '', token: '' });
let data = DEMO ? null : store.get(LS.data, null);
let queue = DEMO ? [] : store.get(LS.queue, []);
const ui = { tab: 'home', periodIdx: null, histType: 'all', histQuery: '', histLimit: 120 };
const sync = { state: 'idle', error: '', lastFetch: 0 };

const TYPES = ['Chi', 'Thu', 'Tiết kiệm', 'Rút tiết kiệm', 'Trả nợ'];
const TYPE_LABEL = { 'Chi': 'Chi', 'Thu': 'Thu', 'Tiết kiệm': 'Tiết kiệm', 'Rút tiết kiệm': 'Rút', 'Trả nợ': 'Trả nợ' };
const PALETTE = ['#1f8f5f', '#2f6fdb', '#e8890c', '#8a4fd6', '#e0453a', '#c99a1e', '#16a2b8', '#d6458f', '#6b7a8f', '#7cb342'];

/* ================================================================ TIỆN ÍCH */

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 0 });
const money = (n) => (n < 0 ? '−' : '') + nf.format(Math.round(Math.abs(n))) + ' ₫';
const moneyPlain = (n) => nf.format(Math.round(n));
function short(n) {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  if (a >= 1e6) return s + (a / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'tr';
  if (a >= 1e3) return s + (a / 1e3).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'k';
  return s + nf.format(a);
}
const pct = (x) => (x * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + '%';

function isoLocal(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
const today = () => TODAY_OVERRIDE || isoLocal(new Date());
const toDate = (iso) => { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const diffDays = (a, b) => Math.round((toDate(a) - toDate(b)) / 86400000);
const dm = (iso) => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : '';
const dmy = (iso) => iso ? dm(iso) + '/' + iso.slice(0, 4) : '';
const WD = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
function dayLabel(iso) {
  const t = today();
  if (iso === t) return 'Hôm nay';
  if (diffDays(t, iso) === 1) return 'Hôm qua';
  return (toDate(iso).getDay() === 0 ? 'Chủ nhật' : 'Thứ ' + (toDate(iso).getDay() + 1)) + ', ' + dmy(iso);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sumBy = (list, pred, val = (t) => t.amount) => list.reduce((s, t) => (pred(t) ? s + val(t) : s), 0);

function shortName(name) { return String(name).replace(/\s*\(.*\)\s*$/, ''); }
function catIcon(name) {
  const n = String(name).toLowerCase();
  const map = [
    ['đăng ký', '📱'], ['ăn uống', '🍜'], ['nhà', '🏠'], ['xăng', '🛵'], ['đi lại', '🛵'], ['mua sắm', '🛍️'], ['giải trí', '🎮'],
    ['sức khỏe', '💊'], ['học', '📚'], ['hiếu', '🎁'], ['quà', '🎁'], ['lương', '💼'], ['job', '💻'], ['cặp đôi', '💞'],
    ['quỹ', '🐷'], ['vàng', '🪙'], ['spaylater', '🧾'], ['thẻ', '💳'], ['thu khác', '💰'], ['chi khác', '📦'],
  ];
  for (const [k, e] of map) if (n.includes(k)) return e;
  return '•';
}
function catType(name) { const c = data && data.categories.find((x) => x.name === name); return c ? c.type : ''; }

function toast(msg, ms = 2200) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), ms);
}

/* ================================================================ TÍNH TOÁN
 * Bám sát công thức trong sheet:
 *  - Ảnh hưởng số dư (Thu chi!F): Chờ nhận → 0; Chi trả sau (có Nguồn tiền) → 0; Thu, Rút → +; còn lại → −
 *  - Hạn mức hôm nay = max(0, (Số dư ban đầu + ảnh hưởng trước hôm nay − Đang giữ lại) / số ngày còn lại)
 *  - Đang giữ lại = phần ngân sách còn lại của khoản cố định + chi trả sau trước hôm nay − trả nợ trước hôm nay
 *  - Đã dùng hôm nay = chi hôm nay − chi khoản cố định hôm nay + bỏ quỹ đầu tiên (Quỹ cặp đôi) hôm nay */

function allTx() {
  const pend = queue.filter((q) => q.action === 'add' && !q.error).map((q) => Object.assign({}, q.tx, { pending: true, qid: q.id }));
  return (data ? data.transactions : []).concat(pend);
}
function effect(t) {
  if (t.status === 'Chờ nhận') return 0;
  if (t.type === 'Chi' && t.source) return 0;
  if (t.type === 'Thu' || t.type === 'Rút tiết kiệm') return t.amount;
  return -t.amount;
}
function currentPeriodIndex() {
  const t = today(), P = data.periods;
  let idx = P.findIndex((p) => p.start <= t && t <= p.end);
  if (idx < 0) { for (let i = P.length - 1; i >= 0; i--) if (P[i].start <= t) { idx = i; break; } }
  return Math.max(0, idx);
}
function periodDays(p) { return diffDays(p.end, p.start) + 1; }

function fundStats(p) {
  const T = allTx(), days = periodDays(p);
  const ok = (t) => t.status !== 'Chờ nhận';
  const list = data.funds.map((f) => {
    const target = f.basis === 'Ngày' ? f.target * days : f.target;
    const dep = sumBy(T, (t) => t.type === 'Tiết kiệm' && t.category === f.name && t.date >= p.start && t.date <= p.end && ok(t));
    const wd = sumBy(T, (t) => t.type === 'Rút tiết kiệm' && t.category === f.name && t.date >= p.start && t.date <= p.end && ok(t));
    const bal = f.start
      + sumBy(T, (t) => t.type === 'Tiết kiệm' && t.category === f.name && t.date <= p.end && ok(t))
      - sumBy(T, (t) => t.type === 'Rút tiết kiệm' && t.category === f.name && t.date <= p.end && ok(t));
    return Object.assign({}, f, { periodTarget: target, dep, wd, missing: Math.max(0, target - dep), bal });
  });
  return {
    list,
    target: list.reduce((s, f) => s + f.periodTarget, 0),
    missing: list.reduce((s, f) => s + f.missing, 0),
    bal: list.reduce((s, f) => s + f.bal, 0),
  };
}

function goldStats() {
  const g = data.gold, qty = g.purchases.reduce((s, x) => s + x.qty, 0), paid = g.purchases.reduce((s, x) => s + x.paid, 0);
  const value = g.price ? qty * g.price : 0;
  const pl = g.price ? value - paid : 0;
  return { qty, paid, value, pl, plPct: g.price && paid ? pl / paid : 0, price: g.price, priceDate: g.priceDate, purchases: g.purchases };
}

function periodSummary(p) {
  const T = allTx(), S = data.startBalance || 0;
  const inP = (t) => t.date >= p.start && t.date <= p.end && t.status !== 'Chờ nhận';
  const opening = S + sumBy(T, (t) => t.date < p.start, effect);
  const closing = S + sumBy(T, (t) => t.date <= p.end, effect);
  const thu = sumBy(T, (t) => t.type === 'Thu' && inP(t));
  const chi = sumBy(T, (t) => t.type === 'Chi' && inP(t));
  const tk = sumBy(T, (t) => t.type === 'Tiết kiệm' && inP(t));
  const rut = sumBy(T, (t) => t.type === 'Rút tiết kiệm' && inP(t));
  const chiCats = data.categories.filter((c) => c.type === 'Chi');
  const known = new Set(chiCats.map((c) => c.name));
  const cats = chiCats.map((c) => {
    const actual = sumBy(T, (t) => t.type === 'Chi' && t.category === c.name && inP(t));
    return Object.assign({}, c, { actual, remain: c.budget ? c.budget - actual : null, ratio: c.budget ? actual / c.budget : null });
  });
  const unknownChi = sumBy(T, (t) => t.type === 'Chi' && inP(t) && !known.has(t.category));
  const jobs = data.categories.filter((c) => c.type === 'Thu' && /^job/i.test(c.name)).map((c) => ({
    name: c.name,
    received: sumBy(T, (t) => t.type === 'Thu' && t.category === c.name && inP(t)),
    pending: sumBy(T, (t) => t.type === 'Thu' && t.category === c.name && t.status === 'Chờ nhận'),
  }));
  const debts = data.categories.filter((c) => c.type === 'Nợ').map((c) => ({
    name: c.name,
    spent: sumBy(T, (t) => t.type === 'Chi' && t.source === c.name && t.date >= p.start && t.date <= p.end),
    owed: sumBy(T, (t) => t.type === 'Chi' && t.source === c.name && t.date <= p.end) - sumBy(T, (t) => t.type === 'Trả nợ' && t.category === c.name && t.date <= p.end),
  }));
  const funds = fundStats(p);
  return {
    p, opening, closing, thu, chi, tk, rut, net: tk - rut, rate: thu ? (tk - rut) / thu : 0,
    cats, unknownChi, jobs, debts, funds,
    budgetTotal: cats.reduce((s, c) => s + (c.budget || 0), 0),
    chiInBudgetCats: cats.reduce((s, c) => s + c.actual, 0),
  };
}

function todayMetrics(p) {
  const T = allTx(), S = data.startBalance || 0, t0 = today();
  const daysLeft = Math.max(0, diffDays(p.end, t0) + 1);
  const fixed = data.categories.filter((c) => c.fixed);
  const fixedNames = new Set(fixed.map((c) => c.name));
  const fixedReserve = fixed.reduce((s, c) => s + Math.max(0, c.budget - sumBy(T, (t) => t.type === 'Chi' && t.category === c.name && t.date >= p.start && t.date < t0)), 0);
  const deferred = sumBy(T, (t) => t.type === 'Chi' && t.source && t.date < t0) - sumBy(T, (t) => t.type === 'Trả nợ' && t.date < t0);
  const reserved = fixedReserve + deferred;
  const balBefore = S + sumBy(T, (t) => t.date < t0, effect);
  const limit = Math.max(0, (balBefore - reserved) / Math.max(1, daysLeft));
  const firstFund = data.funds[0] ? data.funds[0].name : null;
  const used = sumBy(T, (t) => t.type === 'Chi' && t.date === t0)
    - sumBy(T, (t) => t.type === 'Chi' && t.date === t0 && fixedNames.has(t.category))
    + (firstFund ? sumBy(T, (t) => t.type === 'Tiết kiệm' && t.category === firstFund && t.date === t0) : 0);
  return { daysLeft, reserved, fixedReserve, deferred, balBefore, limit, used, left: limit - used, fixedNames, firstFund };
}
/** Khoản này có tính vào "Đã dùng hôm nay" không (để báo trước khi lưu). */
function countsToday(tx, m) {
  if (tx.date !== today()) return false;
  if (tx.type === 'Chi') return !m.fixedNames.has(tx.category);
  return tx.type === 'Tiết kiệm' && tx.category === m.firstFund;
}
function mismatch(t) {
  const ct = catType(t.category);
  if (!ct) return false;
  if (t.type === 'Chi') return ct !== 'Chi';
  if (t.type === 'Thu') return ct !== 'Thu';
  if (t.type === 'Tiết kiệm' || t.type === 'Rút tiết kiệm') return ct !== 'Tiết kiệm';
  if (t.type === 'Trả nợ') return ct !== 'Nợ';
  return false;
}

/* ================================================================ ĐỒNG BỘ */

async function api(action, payload) {
  if (DEMO) return demoApi(action, payload || {});
  const body = JSON.stringify(Object.assign({ token: cfg.token, action }, payload || {}));
  let res;
  try {
    res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, redirect: 'follow' });
  } catch (e) {
    const err = new Error('Không có mạng hoặc không kết nối được Google.');
    err.network = true;
    throw err;
  }
  let j;
  try { j = await res.json(); } catch (e) { throw new Error('Google trả về dữ liệu lạ. Kiểm tra lại link Apps Script (phải là link /exec).'); }
  if (!j.ok) throw new Error(j.error || 'Có lỗi xảy ra.');
  return j;
}

function setData(d) {
  data = d;
  sync.lastFetch = Date.now();
  if (!DEMO) store.set(LS.data, d);
}
function saveQueue() { if (!DEMO) store.set(LS.queue, queue); }
function setSync(state, error) { sync.state = state; sync.error = error || ''; renderSyncChip(); }

let flushing = null;
async function flushQueue() {
  if (flushing) return flushing;
  flushing = (async () => {
    for (const item of queue.slice()) {
      if (item.error) continue;
      setSync('busy');
      try {
        const j = await api('add', { id: item.id, tx: item.tx });
        queue = queue.filter((q) => q.id !== item.id);
        saveQueue();
        setData(j.data);
      } catch (e) {
        if (e.network) { setSync('offline', e.message); render(); return false; }
        item.error = e.message;
        saveQueue();
        toast('Không lưu được 1 khoản: ' + e.message, 4000);
      }
    }
    setSync(queue.some((q) => q.error) ? 'error' : 'idle', queue.some((q) => q.error) ? 'Có khoản chưa lưu được' : '');
    render();
    return true;
  })();
  try { return await flushing; } finally { flushing = null; }
}

async function refresh(silent) {
  if (!cfg.url) return;
  if (queue.some((q) => !q.error)) { const ok = await flushQueue(); if (!ok) return; }
  setSync('busy');
  if (!data) render();
  try {
    const j = await api('data');
    setData(j.data);
    setSync(queue.some((q) => q.error) ? 'error' : 'idle');
    render();
    if (!silent) toast('Đã cập nhật từ Google Sheet');
  } catch (e) {
    setSync(e.network ? 'offline' : 'error', e.message);
    if (!silent || !data) toast(e.message, 3500);
    render();
  }
}

/** Sửa / xóa cần dữ liệu mới nhất (vì số dòng có thể đổi). */
async function writeNow(action, payload, okMsg) {
  if (queue.some((q) => !q.error)) {
    const ok = await flushQueue();
    if (!ok) { toast('Đang không có mạng. Thử lại khi có mạng nhé.'); return false; }
  }
  setSync('busy');
  try {
    const j = await api(action, Object.assign({ id: uid() }, payload));
    setData(j.data);
    setSync('idle');
    render();
    if (okMsg) toast(okMsg);
    return true;
  } catch (e) {
    setSync(e.network ? 'offline' : 'error', e.message);
    toast(e.message, 4000);
    return false;
  }
}

function addTx(tx) {
  queue.push({ id: uid(), action: 'add', tx });
  saveQueue();
  render();
  flushQueue();
}

/* ---------- Chế độ dùng thử (dữ liệu mẫu, không gửi đi đâu) ---------- */
let demoDB = null;
async function demoApi(action, p) {
  if (!demoDB) {
    const r = await fetch('../dev/demo-data.json', { cache: 'no-store' });
    demoDB = await r.json();
  }
  await new Promise((r) => setTimeout(r, 250));
  const T = demoDB.transactions;
  const matches = (t, e) => t && e && t.date === e.date && t.type === e.type && t.category === e.category && t.amount === Number(e.amount);
  if (action === 'add') {
    const row = T.reduce((m, t) => Math.max(m, t.row), 1) + 1;
    T.push(Object.assign({ row }, p.tx));
  } else if (action === 'update') {
    const t = T.find((x) => x.row === p.row);
    if (!matches(t, p.expect)) throw new Error('Dòng này đã thay đổi.');
    Object.assign(t, p.tx);
  } else if (action === 'delete') {
    const i = T.findIndex((x) => x.row === p.row);
    if (i < 0 || !matches(T[i], p.expect)) throw new Error('Dòng này đã thay đổi.');
    T.splice(i, 1);
    T.forEach((x) => { if (x.row > p.row) x.row -= 1; });
  } else if (action === 'goldPrice') {
    demoDB.gold.price = Number(p.price); demoDB.gold.priceDate = p.date;
  } else if (action === 'addGold') {
    const g = p.gold, row = demoDB.gold.purchases.reduce((m, x) => Math.max(m, x.row), 10) + 1;
    demoDB.gold.purchases.push({ row, date: g.date, kind: g.kind, qty: Number(g.qty), paid: Number(g.paid) });
    if (g.ledger) T.push({ row: T.reduce((m, t) => Math.max(m, t.row), 1) + 1, date: g.date, type: 'Tiết kiệm', category: 'Mua vàng', amount: Number(g.paid), note: g.qty + ' chỉ ' + g.kind, status: '', source: '' });
  }
  return { ok: true, data: JSON.parse(JSON.stringify(demoDB)) };
}

/* ================================================================ GIAO DIỆN CHUNG */

function setTop(eyebrow, title) { $('#topEyebrow').textContent = eyebrow || ''; $('#topTitle').textContent = title; }

function renderSyncChip() {
  const el = $('#syncChip');
  const pending = queue.filter((q) => !q.error).length;
  const failed = queue.filter((q) => q.error).length;
  let cls = '', text = 'Đã đồng bộ';
  if (DEMO) text = 'Dữ liệu mẫu';
  if (sync.state === 'busy') { cls = 'busy'; text = 'Đang đồng bộ'; }
  else if (failed) { cls = 'err'; text = failed + ' khoản lỗi'; }
  else if (pending) { cls = 'warn'; text = pending + ' chờ gửi'; }
  else if (sync.state === 'offline') { cls = 'warn'; text = 'Ngoại tuyến'; }
  else if (sync.state === 'error') { cls = 'err'; text = 'Lỗi đồng bộ'; }
  el.className = 'sync-chip ' + cls;
  el.innerHTML = '<span class="dot"></span>' + esc(text);
  el.hidden = !cfg.url;
}

function txRow(t) {
  const sign = t.type === 'Thu' || t.type === 'Rút tiết kiệm' ? '+' : '−';
  const cls = t.type === 'Thu' || t.type === 'Rút tiết kiệm' ? 'in' : t.type === 'Tiết kiệm' ? 'save' : 'out';
  const meta = [];
  if (t.type !== 'Chi') meta.push(TYPE_LABEL[t.type]);
  if (t.note) meta.push(t.note);
  const tags = [];
  if (t.pending) tags.push('<span class="tag pending">Chờ gửi</span>');
  if (t.error) tags.push('<span class="tag warn">Lỗi</span>');
  if (t.source) tags.push('<span class="tag blue">' + esc(t.source) + '</span>');
  if (t.status === 'Chờ nhận') tags.push('<span class="tag pending">Chờ nhận</span>');
  if (mismatch(t)) tags.push('<span class="tag warn">Kiểm tra loại</span>');
  const key = t.qid ? 'q:' + t.qid : 'r:' + t.row;
  return '<button class="row" data-tx="' + esc(key) + '">' +
    '<div class="ico">' + catIcon(t.category) + '</div>' +
    '<div class="main"><div class="t1">' + esc(shortName(t.category)) + tags.join('') + '</div>' +
    (meta.length ? '<div class="t2">' + esc(meta.join(' · ')) + '</div>' : '') + '</div>' +
    '<div class="amt num ' + (t.status === 'Chờ nhận' ? 'muted' : cls) + '">' + sign + moneyPlain(t.amount) + '</div></button>';
}
function sortTx(list) { return list.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.pending ? 1e9 : b.row) - (a.pending ? 1e9 : a.row))); }
function findTx(key) {
  if (key.startsWith('q:')) { const q = queue.find((x) => x.id === key.slice(2)); return q ? Object.assign({}, q.tx, { pending: !q.error, error: q.error, qid: q.id }) : null; }
  return data.transactions.find((t) => t.row === Number(key.slice(2))) || null;
}
function bindTxRows(root) {
  root.querySelectorAll('[data-tx]').forEach((el) => el.addEventListener('click', () => { const t = findTx(el.dataset.tx); if (t) openTxSheet({ edit: t }); }));
}

function render() {
  renderSyncChip();
  const view = $('#view');
  const ready = !!data;
  $('#fab').hidden = !ready;
  $('#tabbar').hidden = !ready;
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === ui.tab));
  if (!cfg.url) { setTop('', 'Chi Tiêu'); view.innerHTML = welcomeHTML(); $('#connectBtn').onclick = openSettings; return; }
  if (!ready) {
    setTop('', 'Chi Tiêu');
    view.innerHTML = '<div class="card empty">' + (sync.state === 'busy' ? 'Đang tải dữ liệu từ Google Sheet…' : esc(sync.error || 'Chưa có dữ liệu.') + '<div class="btn-row"><button class="btn primary" id="retryBtn">Thử lại</button></div>') + '</div>';
    const rb = $('#retryBtn'); if (rb) rb.onclick = () => refresh();
    return;
  }
  if (ui.periodIdx == null || ui.periodIdx >= data.periods.length) ui.periodIdx = currentPeriodIndex();
  ({ home: renderHome, period: renderPeriod, assets: renderAssets, history: renderHistory })[ui.tab](view);
}

function welcomeHTML() {
  return '<div class="welcome"><img class="logo" src="icons/icon-192.png" alt=""><h2>Chi Tiêu</h2>' +
    '<p>Ghi thu chi nhanh trên iPhone, tự đồng bộ với Google Sheet của bạn.</p>' +
    '<button class="btn primary" id="connectBtn" style="width:100%">Kết nối Google Sheet</button>' +
    '<p class="form-note" style="margin-top:14px">Bạn cần link Apps Script (kết thúc bằng <code>/exec</code>) và mã bí mật đã đặt trong script. Xem file HUONG_DAN.md.</p></div>';
}

/* ================================================================ HÔM NAY */

function renderHome(view) {
  const p = data.periods[currentPeriodIndex()];
  const m = todayMetrics(p), s = periodSummary(p), t0 = today();
  setTop('Kỳ ' + dm(p.start) + ' → ' + dm(p.end) + ' · còn ' + m.daysLeft + ' ngày', 'Hôm nay');

  const over = m.left < 0;
  const ratio = m.limit > 0 ? Math.min(1, m.used / m.limit) : (m.used > 0 ? 1 : 0);
  const meterCls = over ? 'over' : ratio > 0.8 ? 'near' : '';
  const T = allTx();
  const todayTx = sortTx(T.filter((t) => t.date === t0)).concat(queue.filter((q) => q.error && q.tx.date === t0).map((q) => Object.assign({}, q.tx, { error: q.error, qid: q.id })));

  // Nút nhanh: quỹ gửi theo ngày chưa gửi hôm nay + danh mục chi hay dùng
  const quick = [];
  data.funds.filter((f) => f.basis === 'Ngày' && f.target > 0).forEach((f) => {
    const done = sumBy(T, (t) => t.type === 'Tiết kiệm' && t.category === f.name && t.date === t0) >= f.target;
    quick.push('<button data-quick-fund="' + esc(f.name) + '" class="' + (done ? 'done' : '') + '">' + catIcon(f.name) + ' ' + (done ? 'Đã bỏ ' : 'Bỏ ') + esc(shortName(f.name).toLowerCase()) + ' · ' + short(f.target) + '</button>');
  });
  frequentCats('Chi', 4).forEach((c) => quick.push('<button data-quick-cat="' + esc(c) + '">' + catIcon(c) + ' ' + esc(shortName(c)) + '</button>'));

  const spentRatio = s.budgetTotal ? s.chiInBudgetCats / s.budgetTotal : 0;
  view.innerHTML =
    '<section class="card hero">' +
      '<div class="label">Còn được dùng hôm nay</div>' +
      '<div class="big num ' + (over ? 'neg' : '') + '">' + money(m.left) + '</div>' +
      '<span class="badge ' + (over ? 'bad' : 'ok') + '">' + (over ? 'Vượt mức' : 'Còn dư') + '</span>' +
      '<div class="meter ' + meterCls + '"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i></div>' +
      '<div class="hero-row"><span>Hạn mức <b class="num">' + money(m.limit) + '</b></span><span>Đã dùng <b class="num">' + money(m.used) + '</b></span></div>' +
    '</section>' +
    (quick.length ? '<div class="quick">' + quick.join('') + '</div>' : '') +
    '<div class="grid2">' +
      stat('Số dư tiêu được', money(s.closing), 'không tính quỹ và vàng') +
      stat('Đang giữ lại', money(m.reserved), 'cố định + nợ trả sau') +
      stat('Chi trong kỳ', money(s.chi), s.budgetTotal ? pct(spentRatio) + ' ngân sách' : '') +
      stat('Để dành trong kỳ', money(s.tk), s.funds.missing > 0 ? 'thiếu ' + short(s.funds.missing) + ' so với mục tiêu' : 'đạt mục tiêu 🎉') +
    '</div>' +
    '<div class="section-label"><span>Đã ghi hôm nay</span><span class="num">' + todayTx.length + ' khoản</span></div>' +
    (todayTx.length ? '<div class="list">' + todayTx.map(txRow).join('') + '</div>' : '<div class="card empty">Chưa ghi khoản nào hôm nay.<br>Bấm <b>＋</b> để ghi.</div>');

  bindTxRows(view);
  view.querySelectorAll('[data-quick-cat]').forEach((b) => b.addEventListener('click', () => openTxSheet({ type: 'Chi', category: b.dataset.quickCat })));
  view.querySelectorAll('[data-quick-fund]').forEach((b) => b.addEventListener('click', () => {
    const f = data.funds.find((x) => x.name === b.dataset.quickFund);
    if (b.classList.contains('done')) { openTxSheet({ type: 'Tiết kiệm', category: f.name }); return; }
    addTx({ date: t0, type: 'Tiết kiệm', category: f.name, amount: f.target, note: '', status: '', source: '' });
    toast('Đã bỏ ' + money(f.target) + ' vào ' + shortName(f.name).toLowerCase());
  }));
}
function stat(k, v, s) { return '<div class="card stat"><div class="k">' + esc(k) + '</div><div class="v num">' + v + '</div>' + (s ? '<div class="s">' + esc(s) + '</div>' : '') + '</div>'; }
function frequentCats(type, n) {
  const since = isoLocal(new Date(toDate(today()).getTime() - 60 * 86400000));
  const count = {};
  allTx().forEach((t) => { if (t.type === type && t.date >= since && catType(t.category) === type) count[t.category] = (count[t.category] || 0) + 1; });
  return Object.keys(count).sort((a, b) => count[b] - count[a]).slice(0, n);
}

/* ================================================================ KỲ LƯƠNG */

function renderPeriod(view) {
  const P = data.periods, idx = ui.periodIdx, p = P[idx], s = periodSummary(p);
  const isCur = idx === currentPeriodIndex();
  setTop(isCur ? 'Kỳ đang chạy' : 'Kỳ ' + dmy(p.start), 'Kỳ lương');

  const cats = s.cats.filter((c) => c.actual > 0 || c.budget > 0).sort((a, b) => (b.budget > 0) - (a.budget > 0) || b.actual - a.actual);
  const donutItems = s.cats.filter((c) => c.actual > 0).sort((a, b) => b.actual - a.actual).map((c) => ({ name: c.name, v: c.actual }));
  if (s.unknownChi > 0) donutItems.push({ name: 'Khác (sai danh mục)', v: s.unknownChi });

  const yearRows = P.filter((x) => x.start.slice(0, 4) === p.start.slice(0, 4)).map((x) => {
    const y = periodSummary(x);
    return { p: x, thu: y.thu, chi: y.chi, tk: y.tk, rut: y.rut };
  });
  const yr = yearRows.reduce((a, r) => ({ thu: a.thu + r.thu, chi: a.chi + r.chi, tk: a.tk + r.tk, rut: a.rut + r.rut }), { thu: 0, chi: 0, tk: 0, rut: 0 });
  const withData = yearRows.filter((r) => r.thu || r.chi || r.tk);

  const anyDebt = s.debts.some((d) => d.spent || d.owed);
  view.innerHTML =
    '<div class="period-switch"><button id="prevP" ' + (idx <= 0 ? 'disabled' : '') + '>‹</button>' +
      '<div class="lbl num">' + dmy(p.start) + ' → ' + dmy(p.end) + '<small>' + (isCur ? 'Kỳ hiện tại' : p.note || periodDays(p) + ' ngày') + '</small></div>' +
      '<button id="nextP" ' + (idx >= P.length - 1 ? 'disabled' : '') + '>›</button></div>' +

    '<section class="card"><h3 class="card-title">Tóm tắt kỳ</h3>' +
      kv('Số dư đầu kỳ', money(s.opening)) + kv('Tổng thu', '+' + money(s.thu)) + kv('Tổng chi (kể cả trả sau)', '−' + money(s.chi)) +
      kv('Gửi vào quỹ / mua vàng', '−' + money(s.tk)) + kv('Rút từ quỹ ra xài', '+' + money(s.rut)) +
      kv('Số dư cuối kỳ', money(s.closing), 'total') +
    '</section>' +

    '<section class="card"><h3 class="card-title">Tiết kiệm</h3>' +
      kv('Tiết kiệm ròng (gửi − rút)', money(s.net)) + kv('Tỷ lệ so với thu', s.thu ? pct(s.rate) : '—') +
      kv('Mục tiêu gửi quỹ kỳ này', money(s.funds.target)) +
      kv('Còn thiếu', s.funds.missing ? '<span style="color:var(--orange)">' + money(s.funds.missing) + '</span>' : '<span style="color:var(--accent)">Đủ rồi</span>') +
    '</section>' +

    '<section class="card"><h3 class="card-title"><span>Chi theo danh mục</span><span class="num" style="text-transform:none">' + money(s.chi) + '</span></h3>' +
      (donutItems.length ? donut(donutItems) : '<div class="empty">Chưa có khoản chi nào trong kỳ.</div>') +
    '</section>' +

    '<section class="card"><h3 class="card-title"><span>Ngân sách</span><span class="num" style="text-transform:none">' + short(s.chiInBudgetCats) + ' / ' + short(s.budgetTotal) + '</span></h3>' +
      cats.map(budgetRow).join('') + (cats.length ? '' : '<div class="empty">Chưa đặt ngân sách. Đặt ở tab Danh mục trong sheet.</div>') +
    '</section>' +

    (s.jobs.length ? '<section class="card"><h3 class="card-title">Job ngoài</h3>' +
      s.jobs.map((j) => kv(shortName(j.name) + ' <span style="color:var(--text-3)">' + esc((j.name.match(/\((.*)\)/) || [])[1] || '') + '</span>', money(j.received) + (j.pending ? '<div style="font-size:12px;color:var(--orange)">chờ nhận ' + money(j.pending) + '</div>' : ''), '', true)).join('') +
    '</section>' : '') +

    '<section class="card"><h3 class="card-title">Trả sau</h3>' +
      (anyDebt ? s.debts.map((d) => kv(esc(d.name), money(d.spent) + '<div style="font-size:12px;color:' + (d.owed > 0 ? 'var(--red)' : 'var(--text-3)') + '">còn nợ ' + money(d.owed) + '</div>', '', true)).join('') : '<div class="empty" style="padding:10px">Không có khoản trả sau 👍</div>') +
    '</section>' +

    '<section class="card"><h3 class="card-title">Theo kỳ năm ' + p.start.slice(0, 4) + '</h3>' +
      (withData.length ? bars(withData) : '<div class="empty">Chưa có dữ liệu.</div>') +
      '<div style="margin-top:10px">' + kv('Cả năm: thu', money(yr.thu)) + kv('Cả năm: chi', money(yr.chi)) + kv('Cả năm: để dành', money(yr.tk - yr.rut)) + '</div>' +
    '</section>';

  $('#prevP').onclick = () => { ui.periodIdx = Math.max(0, idx - 1); render(); };
  $('#nextP').onclick = () => { ui.periodIdx = Math.min(P.length - 1, idx + 1); render(); };
}
function kv(k, v, cls, rawK) { return '<div class="kv ' + (cls || '') + '"><span class="k">' + (rawK ? k : esc(k)) + '</span><span class="v num">' + v + '</span></div>'; }
function budgetRow(c) {
  const has = c.budget > 0;
  const r = has ? c.actual / c.budget : 0;
  const cls = !has ? '' : r > 1 ? 'over' : r > 0.85 ? 'near' : '';
  return '<div class="budget"><div class="top"><div class="ico">' + catIcon(c.name) + '</div><div class="name">' + esc(shortName(c.name)) + (c.fixed ? ' <span class="tag pending">Cố định</span>' : '') + '</div><div class="val num">' + money(c.actual) + '</div></div>' +
    (has ? '<div class="meter ' + cls + '"><i style="width:' + Math.min(100, r * 100).toFixed(1) + '%"></i></div>' +
      '<div class="sub num"><span>' + pct(r) + ' của ' + short(c.budget) + '</span><span style="color:' + (c.remain < 0 ? 'var(--red)' : 'inherit') + '">' + (c.remain < 0 ? 'vượt ' + short(-c.remain) : 'còn ' + short(c.remain)) + '</span></div>'
      : '<div class="sub"><span>Không đặt ngân sách</span></div>') + '</div>';
}
function donut(items) {
  const total = items.reduce((s, x) => s + x.v, 0), r = 42, C = 2 * Math.PI * r;
  let off = 0;
  const segs = items.map((x, i) => {
    const len = (x.v / total) * C;
    const seg = '<circle r="' + r + '" cx="60" cy="60" fill="none" stroke="' + PALETTE[i % PALETTE.length] + '" stroke-width="18" stroke-dasharray="' + Math.max(0, len - 1.2).toFixed(2) + ' ' + C.toFixed(2) + '" stroke-dashoffset="' + (-off).toFixed(2) + '"/>';
    off += len;
    return seg;
  }).join('');
  const top = items.slice(0, 7);
  return '<div class="donut-wrap"><svg width="124" height="124" viewBox="0 0 120 120"><g transform="rotate(-90 60 60)">' + segs + '</g>' +
    '<text x="60" y="57" text-anchor="middle" font-size="10" fill="var(--text-2)">Tổng chi</text><text x="60" y="72" text-anchor="middle" font-size="14" font-weight="700" fill="var(--text)">' + short(total) + '</text></svg>' +
    '<div class="legend">' + top.map((x, i) => '<div><i style="background:' + PALETTE[i % PALETTE.length] + '"></i><span>' + esc(shortName(x.name)) + '</span><b class="num">' + Math.round((x.v / total) * 100) + '%</b></div>').join('') + '</div></div>';
}
function bars(rows) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.thu, r.chi, r.tk)));
  const h = (v) => ((v / max) * 100).toFixed(1) + '%';
  return '<div class="bars">' + rows.map((r) => '<div class="grp"><div class="cols">' +
    '<i style="height:' + h(r.thu) + ';background:var(--accent)" title="Thu"></i><i style="height:' + h(r.chi) + ';background:var(--red)"></i><i style="height:' + h(r.tk) + ';background:var(--blue)"></i>' +
    '</div><div class="x">' + dm(r.p.start) + '</div></div>').join('') + '</div>' +
    '<div class="chart-legend"><span><i style="background:var(--accent)"></i>Thu</span><span><i style="background:var(--red)"></i>Chi</span><span><i style="background:var(--blue)"></i>Tiết kiệm</span></div>';
}

/* ================================================================ TÀI SẢN */

function renderAssets(view) {
  const p = data.periods[currentPeriodIndex()], f = fundStats(p), g = goldStats();
  setTop('Quỹ tiết kiệm + vàng', 'Tài sản');
  const total = f.bal + g.value;
  view.innerHTML =
    '<section class="card hero"><div class="label">Tổng tài sản tích lũy</div><div class="big num">' + money(total) + '</div>' +
      '<div class="hero-row" style="margin-top:8px"><span>Quỹ <b class="num">' + money(f.bal) + '</b></span><span>Vàng <b class="num">' + money(g.value) + '</b></span></div></section>' +
    '<div class="section-label"><span>Quỹ tiết kiệm · kỳ ' + dm(p.start) + ' → ' + dm(p.end) + '</span></div>' +
    f.list.map((x) => {
      const r = x.periodTarget ? Math.min(1, x.dep / x.periodTarget) : 0;
      return '<section class="card"><div class="fund-top"><div class="ico">' + catIcon(x.name) + '</div><div class="name">' + esc(x.name) + '</div>' +
        '<span class="badge muted">' + (x.basis === 'Ngày' ? short(x.target) + '/ngày' : short(x.target) + '/kỳ') + '</span></div>' +
        '<div class="fund-bal num">' + money(x.bal) + '</div><div style="font-size:13px;color:var(--text-2)">Số dư quỹ cuối kỳ</div>' +
        '<div class="meter ' + (r >= 1 ? '' : 'near') + '"><i style="width:' + (r * 100).toFixed(1) + '%"></i></div>' +
        '<div class="hero-row"><span>Đã gửi <b class="num">' + money(x.dep) + '</b> / ' + short(x.periodTarget) + '</span><span>' + (x.missing ? 'thiếu <b class="num">' + short(x.missing) + '</b>' : '<b style="color:var(--accent)">Đủ</b>') + '</span></div>' +
        (x.wd ? '<div class="hero-row" style="margin-top:4px"><span>Đã rút kỳ này</span><b class="num">' + money(x.wd) + '</b></div>' : '') +
        '<div class="btn-row"><button class="btn primary" data-dep="' + esc(x.name) + '">Bỏ quỹ</button><button class="btn" data-wd="' + esc(x.name) + '">Rút ra xài</button></div></section>';
    }).join('') +
    '<div class="section-label"><span>Vàng</span></div>' +
    '<section class="card"><div class="fund-top"><div class="ico" style="background:var(--gold-soft)">🪙</div><div class="name">' + g.qty.toLocaleString('vi-VN') + ' chỉ</div>' +
      '<span class="pl num ' + (g.pl >= 0 ? 'up' : 'down') + '">' + (g.pl >= 0 ? '+' : '') + pct(g.plPct) + '</span></div>' +
      '<div class="fund-bal num">' + money(g.value) + '</div><div style="font-size:13px;color:var(--text-2)">Giá trị hiện tại theo giá tiệm mua lại</div>' +
      '<div style="margin-top:10px">' + kv('Tổng tiền đã mua', money(g.paid)) + kv('Lãi / lỗ', '<span class="pl ' + (g.pl >= 0 ? 'up' : 'down') + '">' + (g.pl >= 0 ? '+' : '') + money(g.pl) + '</span>') +
      kv('Giá mua lại 1 chỉ', money(g.price) + '<div style="font-size:12px;color:var(--text-3)">cập nhật ' + dmy(g.priceDate) + '</div>') + '</div>' +
      '<div class="btn-row"><button class="btn primary" id="goldPriceBtn">Cập nhật giá</button><button class="btn" id="goldBuyBtn">Ghi lần mua</button></div></section>' +
    (g.purchases.length ? '<div class="list">' + g.purchases.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((x) =>
      '<div class="row"><div class="ico">🪙</div><div class="main"><div class="t1">' + x.qty.toLocaleString('vi-VN') + ' chỉ · ' + esc(x.kind) + '</div><div class="t2">' + dmy(x.date) + ' · ' + short(x.qty ? x.paid / x.qty : 0) + '/chỉ</div></div><div class="amt num">' + moneyPlain(x.paid) + '</div></div>').join('') + '</div>' : '');

  view.querySelectorAll('[data-dep]').forEach((b) => b.addEventListener('click', () => openTxSheet({ type: 'Tiết kiệm', category: b.dataset.dep })));
  view.querySelectorAll('[data-wd]').forEach((b) => b.addEventListener('click', () => openTxSheet({ type: 'Rút tiết kiệm', category: b.dataset.wd })));
  $('#goldPriceBtn').onclick = openGoldPrice;
  $('#goldBuyBtn').onclick = openGoldBuy;
}

/* ================================================================ LỊCH SỬ */

function renderHistory(view) {
  setTop(data.transactions.length + ' giao dịch trong sheet', 'Lịch sử');
  const q = ui.histQuery.trim().toLowerCase();
  const errs = queue.filter((x) => x.error).map((x) => Object.assign({}, x.tx, { error: x.error, qid: x.id }));
  let list = sortTx(allTx()).concat(errs);
  if (ui.histType !== 'all') list = list.filter((t) => t.type === ui.histType);
  if (q) list = list.filter((t) => (t.category + ' ' + t.note + ' ' + t.source + ' ' + t.amount + ' ' + dmy(t.date)).toLowerCase().includes(q));
  const shown = list.slice(0, ui.histLimit);
  const groups = [];
  shown.forEach((t) => { const g = groups[groups.length - 1]; if (g && g.date === t.date) g.items.push(t); else groups.push({ date: t.date, items: [t] }); });

  view.innerHTML =
    '<div class="search"><input id="histQ" type="search" placeholder="Tìm danh mục, ghi chú, số tiền…" value="' + esc(ui.histQuery) + '"></div>' +
    '<div class="chips">' + ['all'].concat(TYPES).map((tp) => '<button class="chip ' + (ui.histType === tp ? 'on' : '') + '" data-type="' + esc(tp) + '">' + (tp === 'all' ? 'Tất cả' : TYPE_LABEL[tp]) + '</button>').join('') + '</div>' +
    (groups.length ? groups.map((g) => {
      const out = sumBy(g.items, (t) => t.type === 'Chi');
      return '<div class="day-head"><span>' + esc(dayLabel(g.date)) + '</span><span class="num">' + (out ? 'chi ' + money(out) : '') + '</span></div><div class="list">' + g.items.map(txRow).join('') + '</div>';
    }).join('') : '<div class="card empty" style="margin-top:12px">Không có giao dịch phù hợp.</div>') +
    (list.length > shown.length ? '<button class="btn" id="moreBtn" style="width:100%">Xem thêm</button>' : '');

  const input = $('#histQ');
  input.addEventListener('input', () => {
    ui.histQuery = input.value;
    clearTimeout(renderHistory._t);
    renderHistory._t = setTimeout(() => { const pos = input.selectionStart; render(); const el = $('#histQ'); el.focus(); el.setSelectionRange(pos, pos); }, 250);
  });
  view.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => { ui.histType = b.dataset.type; render(); }));
  const more = $('#moreBtn'); if (more) more.onclick = () => { ui.histLimit += 150; render(); };
  bindTxRows(view);
}

/* ================================================================ BOTTOM SHEET */

function openSheet({ title, left = 'Hủy', right = '', rightCls = '', onRight, body, footer }) {
  const root = $('#sheetRoot');
  const back = document.createElement('div'); back.className = 'backdrop';
  const sh = document.createElement('div'); sh.className = 'sheet' + (footer ? ' tall' : ''); sh.setAttribute('role', 'dialog');
  sh.innerHTML = '<div class="sheet-head"><button data-act="left">' + esc(left) + '</button><h2>' + esc(title) + '</h2><button data-act="right" class="' + rightCls + '">' + esc(right) + '</button></div>' +
    '<div class="sheet-body ' + (footer ? 'has-keypad' : '') + '"></div>' + (footer ? '<div class="sheet-foot">' + footer + '</div>' : '');
  $('.sheet-body', sh).innerHTML = body;
  root.append(back, sh);
  document.body.style.overflow = 'hidden';
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    back.classList.add('closing'); sh.classList.add('closing');
    setTimeout(() => { back.remove(); sh.remove(); if (!root.children.length) document.body.style.overflow = ''; }, 220);
  };
  back.addEventListener('click', close);
  $('[data-act="left"]', sh).addEventListener('click', close);
  if (onRight) $('[data-act="right"]', sh).addEventListener('click', onRight);
  // Vuốt xuống ở thanh tiêu đề để đóng
  let y0 = null;
  const head = $('.sheet-head', sh);
  head.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  head.addEventListener('touchmove', (e) => { if (y0 == null) return; const dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = 'translateY(' + dy + 'px)'; }, { passive: true });
  head.addEventListener('touchend', (e) => { const dy = (e.changedTouches[0].clientY - y0) || 0; y0 = null; sh.style.transform = ''; if (dy > 90) close(); });
  return { el: sh, close };
}

function catsForType(type) {
  const want = type === 'Chi' ? 'Chi' : type === 'Thu' ? 'Thu' : type === 'Trả nợ' ? 'Nợ' : 'Tiết kiệm';
  let list = data.categories.filter((c) => c.type === want).map((c) => c.name);
  if (type === 'Rút tiết kiệm') list = list.filter((n) => n !== 'Mua vàng');
  return list;
}

function openTxSheet(opts) {
  const edit = opts.edit || null;
  const st = edit
    ? { type: edit.type, amount: String(edit.amount), category: edit.category, date: edit.date, note: edit.note || '', status: edit.status || '', source: edit.source || '' }
    : { type: opts.type || 'Chi', amount: '', category: opts.category || '', date: today(), note: '', status: '', source: '' };
  if (!st.category) st.category = frequentCats(st.type, 1)[0] || catsForType(st.type)[0] || '';
  if (st.type === 'Thu' && !st.status) st.status = 'Đã nhận';
  const debtCats = data.categories.filter((c) => c.type === 'Nợ').map((c) => c.name);
  const metrics = todayMetrics(data.periods[currentPeriodIndex()]);

  const sheet = openSheet({
    title: edit ? 'Sửa giao dịch' : 'Ghi giao dịch',
    right: edit ? 'Xóa' : '',
    onRight: edit ? () => removeTx(edit, sheet) : null,
    footer: '<div class="keypad">' + ['1', '2', '3', '4', '5', '6', '7', '8', '9', '000', '0', '⌫'].map((k) => '<button class="' + (k === '⌫' || k === '000' ? 'fn' : '') + '" data-k="' + k + '">' + k + '</button>').join('') +
      '<button class="save" id="saveBtn">Lưu</button></div>',
    body:
      '<div class="seg" id="txType">' + TYPES.map((t) => '<button data-v="' + esc(t) + '">' + TYPE_LABEL[t] + '</button>').join('') + '</div>' +
      '<div class="amount-display"><div class="v num" id="amt"></div><div class="hint" id="hint"></div></div>' +
      '<div class="cat-grid" id="cats"></div>' +
      '<div class="fields">' +
        '<div class="field"><label>Ngày</label><input type="date" id="fDate"></div>' +
        '<div class="field"><label>Ghi chú</label><input type="text" id="fNote" placeholder="Không bắt buộc" enterkeyhint="done"></div>' +
        '<div class="field" id="rowSource"><label>Nguồn tiền</label><select id="fSource"><option value="">Tiền của mình</option>' + debtCats.map((n) => '<option>' + esc(n) + '</option>').join('') + '</select></div>' +
        '<div class="field" id="rowStatus"><label>Trạng thái</label><div class="seg" id="fStatus"><button data-v="Đã nhận">Đã nhận</button><button data-v="Chờ nhận">Chờ nhận</button></div></div>' +
      '</div>' +
      (edit && edit.error ? '<div class="form-note" style="color:var(--red)">Chưa lưu được: ' + esc(edit.error) + '</div>' : ''),
  });
  const el = sheet.el;

  const draw = () => {
    el.querySelectorAll('#txType button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.type));
    const n = Number(st.amount || 0);
    const amt = $('#amt', el);
    amt.textContent = n ? moneyPlain(n) + ' ₫' : '0 ₫';
    amt.classList.toggle('zero', !n);
    let cats = catsForType(st.type);
    if (st.category && !cats.includes(st.category)) cats = [st.category].concat(cats);
    $('#cats', el).innerHTML = cats.map((c) => '<button class="cat ' + (c === st.category ? 'on' : '') + '" data-c="' + esc(c) + '"><span class="e">' + catIcon(c) + '</span>' + esc(shortName(c)) + '</button>').join('');
    el.querySelectorAll('.cat').forEach((b) => b.addEventListener('click', () => { st.category = b.dataset.c; draw(); }));
    $('#rowSource', el).hidden = st.type !== 'Chi' || !debtCats.length;
    $('#rowStatus', el).hidden = st.type !== 'Thu';
    el.querySelectorAll('#fStatus button').forEach((b) => b.classList.toggle('on', b.dataset.v === st.status));
    $('#fSource', el).value = st.source;
    // Gợi ý: sau khoản này còn được dùng bao nhiêu hôm nay
    const probe = { type: st.type, category: st.category, date: st.date };
    let hint = '';
    if (n && countsToday(probe, metrics)) {
      const before = edit && countsToday(edit, metrics) ? edit.amount : 0;
      const after = metrics.left + before - n;
      hint = after >= 0 ? 'Sau khoản này còn được dùng hôm nay ' + money(after) : 'Khoản này làm vượt hạn mức hôm nay ' + money(-after);
    } else if (st.type === 'Chi' && metrics.fixedNames.has(st.category)) hint = 'Khoản cố định, không trừ vào hạn mức ngày';
    else if (st.type === 'Chi' && st.source) hint = 'Trả sau: số dư giữ nguyên, ghi vào nợ ' + st.source;
    else if (st.type === 'Thu' && st.status === 'Chờ nhận') hint = 'Chờ nhận: chưa cộng vào số dư';
    $('#hint', el).textContent = hint;
    $('#hint', el).style.color = hint.startsWith('Khoản này làm vượt') ? 'var(--red)' : '';
    const ok = n > 0 && st.category && st.date;
    $('#saveBtn', el).disabled = !ok;
    $('#saveBtn', el).textContent = ok ? (edit ? 'Lưu thay đổi' : 'Lưu ' + money(n)) : 'Nhập số tiền';
  };

  $('#fDate', el).value = st.date;
  $('#fNote', el).value = st.note;
  $('#fDate', el).addEventListener('change', (e) => { st.date = e.target.value; draw(); });
  $('#fNote', el).addEventListener('input', (e) => { st.note = e.target.value; });
  $('#fNote', el).addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
  $('#fSource', el).addEventListener('change', (e) => { st.source = e.target.value; draw(); });
  el.querySelectorAll('#fStatus button').forEach((b) => b.addEventListener('click', () => { st.status = b.dataset.v; draw(); }));
  el.querySelectorAll('#txType button').forEach((b) => b.addEventListener('click', () => {
    if (st.type === b.dataset.v) return;
    st.type = b.dataset.v;
    st.category = frequentCats(st.type, 1)[0] || catsForType(st.type)[0] || '';
    st.status = st.type === 'Thu' ? 'Đã nhận' : '';
    if (st.type !== 'Chi') st.source = '';
    draw();
  }));
  el.querySelectorAll('[data-k]').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.k;
    if (k === '⌫') st.amount = st.amount.slice(0, -1);
    else if (st.amount.length < 12 && !(st.amount === '' && (k === '0' || k === '000'))) st.amount = (st.amount + k).slice(0, 12);
    draw();
  }));
  $('#saveBtn', el).addEventListener('click', async () => {
    const tx = { date: st.date, type: st.type, category: st.category, amount: Number(st.amount), note: st.note.trim(), status: st.type === 'Thu' ? st.status : '', source: st.type === 'Chi' ? st.source : '' };
    if (!edit) { sheet.close(); addTx(tx); toast('Đã ghi ' + money(tx.amount) + ' · ' + shortName(tx.category)); return; }
    if (edit.qid) { // khoản chưa gửi lên: sửa ngay trong hàng chờ
      const q = queue.find((x) => x.id === edit.qid);
      if (q) { q.tx = tx; delete q.error; saveQueue(); }
      sheet.close(); render(); flushQueue(); return;
    }
    $('#saveBtn', el).disabled = true; $('#saveBtn', el).textContent = 'Đang lưu…';
    const ok = await writeNow('update', { row: edit.row, expect: expectOf(edit), tx }, 'Đã lưu thay đổi');
    if (ok) sheet.close(); else draw();
  });
  draw();
}
function expectOf(t) { return { date: t.date, type: t.type, category: t.category, amount: t.amount }; }

async function removeTx(t, sheet) {
  if (!confirm('Xóa khoản ' + money(t.amount) + ' · ' + shortName(t.category) + ' (' + dmy(t.date) + ')?' + (t.qid ? '' : '\nDòng này sẽ bị xóa khỏi Google Sheet.'))) return;
  if (t.qid) { queue = queue.filter((q) => q.id !== t.qid); saveQueue(); sheet.close(); render(); toast('Đã xóa'); return; }
  const ok = await writeNow('delete', { row: t.row, expect: expectOf(t) }, 'Đã xóa khỏi Google Sheet');
  if (ok) sheet.close();
}

/* ---------- Vàng ---------- */
function openGoldPrice() {
  const g = data.gold;
  const sheet = openSheet({
    title: 'Giá vàng', right: 'Lưu', onRight: async () => {
      const price = Number(String($('#gp', sheet.el).value).replace(/\D/g, ''));
      const date = $('#gd', sheet.el).value;
      if (!(price > 0) || !date) { toast('Nhập giá và ngày'); return; }
      if (await writeNow('goldPrice', { price, date }, 'Đã cập nhật giá vàng')) sheet.close();
    },
    body: '<div class="fields"><div class="field"><label>Giá mua lại 1 chỉ</label><input id="gp" inputmode="numeric" value="' + (g.price ? moneyPlain(g.price) : '') + '"></div>' +
      '<div class="field"><label>Ngày xem giá</label><input type="date" id="gd" value="' + today() + '"></div></div>' +
      '<div class="form-note">Là giá tiệm mua lại (giá bán ra của bạn), dùng để tính giá trị vàng đang có. Giá này ghi vào ô B4 tab Vàng.</div>',
  });
  moneyInput($('#gp', sheet.el));
}
function openGoldBuy() {
  const last = data.gold.purchases[data.gold.purchases.length - 1];
  const hasLedgerCat = data.categories.some((c) => c.name === 'Mua vàng');
  const sheet = openSheet({
    title: 'Ghi lần mua vàng', right: 'Lưu', onRight: async () => {
      const gold = {
        date: $('#bd', sheet.el).value, kind: $('#bk', sheet.el).value.trim(),
        qty: Number(String($('#bq', sheet.el).value).replace(',', '.')), paid: Number(String($('#bp', sheet.el).value).replace(/\D/g, '')),
        ledger: hasLedgerCat && $('#bl', sheet.el).checked,
      };
      if (!gold.date || !(gold.qty > 0) || !(gold.paid > 0)) { toast('Nhập đủ ngày, số chỉ và số tiền'); return; }
      if (await writeNow('addGold', { gold }, 'Đã ghi lần mua vàng')) sheet.close();
    },
    body: '<div class="fields"><div class="field"><label>Ngày mua</label><input type="date" id="bd" value="' + today() + '"></div>' +
      '<div class="field"><label>Loại vàng</label><input id="bk" value="' + esc(last ? last.kind : '') + '"></div>' +
      '<div class="field"><label>Số chỉ</label><input id="bq" inputmode="decimal" placeholder="0,5"></div>' +
      '<div class="field"><label>Số tiền đã trả</label><input id="bp" inputmode="numeric" placeholder="0"></div>' +
      (hasLedgerCat ? '<div class="field"><label style="width:auto;flex:1">Trừ vào số dư tiêu được</label><input type="checkbox" id="bl" checked style="flex:none;width:22px;height:22px;-webkit-appearance:checkbox;appearance:auto"></div>' : '') + '</div>' +
      '<div class="form-note">Thêm 1 dòng ở bảng "Các lần mua" tab Vàng.' + (hasLedgerCat ? ' Nếu bật "Trừ vào số dư", app ghi thêm 1 dòng <b>Tiết kiệm · Mua vàng</b> ở tab Thu chi. Tắt đi nếu tiền mua vàng không lấy từ tiền tiêu.' : '') + '</div>',
  });
  moneyInput($('#bp', sheet.el));
}
function moneyInput(input) {
  input.addEventListener('input', () => { const d = input.value.replace(/\D/g, '').slice(0, 12); input.value = d ? moneyPlain(Number(d)) : ''; });
}

/* ---------- Cài đặt ---------- */
function openSettings() {
  const sheet = openSheet({
    title: 'Cài đặt', left: 'Đóng',
    body:
      '<div class="section-label" style="margin-top:6px">Kết nối Google Sheet</div>' +
      (DEMO ? '<div class="form-note">Đang ở chế độ dùng thử với dữ liệu mẫu. Mọi thay đổi chỉ nằm trong bộ nhớ, tải lại trang là mất.</div>' :
      '<div class="stack"><input class="textfield" id="sUrl" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(cfg.url) + '" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<input class="textfield" id="sTok" type="password" placeholder="Mã bí mật" value="' + esc(cfg.token) + '" autocapitalize="off" autocorrect="off" spellcheck="false">' +
      '<button class="btn primary" id="sSave">Lưu và kiểm tra kết nối</button></div>' +
      '<div class="form-note">Link và mã chỉ lưu trên iPhone này, không nằm trong mã nguồn của app.</div>') +
      (data ? '<div class="section-label">Dữ liệu</div><div class="list">' +
        '<button class="row" id="sRefresh"><div class="ico">🔄</div><div class="main"><div class="t1">Tải lại từ Google Sheet</div><div class="t2">Lần cuối: ' + (data.fetchedAt ? new Date(data.fetchedAt).toLocaleString('vi-VN') : '—') + '</div></div></button>' +
        (data.spreadsheetUrl ? '<a class="row" href="' + esc(data.spreadsheetUrl) + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:none"><div class="ico">📊</div><div class="main"><div class="t1">Mở Google Sheet</div><div class="t2">Sửa danh mục, ngân sách, quỹ, kỳ lương ở đây</div></div></a>' : '') +
        (queue.some((q) => q.error) ? '<button class="row" id="sRetry"><div class="ico">⚠️</div><div class="main"><div class="t1">Gửi lại các khoản bị lỗi</div><div class="t2">' + queue.filter((q) => q.error).length + ' khoản</div></div></button>' : '') +
        '</div>' : '') +
      (DEMO ? '' : '<div class="list"><button class="row" id="sReset"><div class="ico">🗑️</div><div class="main"><div class="t1" style="color:var(--red)">Xóa dữ liệu trên máy này</div><div class="t2">Không ảnh hưởng Google Sheet</div></div></button></div>') +
      '<div class="form-note" style="text-align:center">Chi Tiêu · phiên bản ' + VERSION + '</div>',
  });
  const el = sheet.el;
  const save = $('#sSave', el);
  if (save) save.onclick = async () => {
    const url = $('#sUrl', el).value.trim(), token = $('#sTok', el).value.trim();
    if (!/^https:\/\/script\.google\.com\/.+\/exec$/.test(url)) { toast('Link phải dạng https://script.google.com/…/exec', 3500); return; }
    if (!token) { toast('Nhập mã bí mật'); return; }
    const prev = cfg;
    cfg = { url, token };
    save.disabled = true; save.textContent = 'Đang kiểm tra…';
    try {
      const j = await api('data');
      store.set(LS.cfg, cfg);
      setData(j.data);
      setSync('idle');
      sheet.close(); render();
      toast('Kết nối thành công · ' + j.data.transactions.length + ' giao dịch');
      flushQueue();
    } catch (e) {
      cfg = prev;
      save.disabled = false; save.textContent = 'Lưu và kiểm tra kết nối';
      toast(e.message, 4000);
    }
  };
  const rf = $('#sRefresh', el); if (rf) rf.onclick = () => { sheet.close(); refresh(); };
  const rt = $('#sRetry', el); if (rt) rt.onclick = () => { queue.forEach((q) => delete q.error); saveQueue(); sheet.close(); flushQueue(); };
  const rs = $('#sReset', el); if (rs) rs.onclick = () => {
    const pending = queue.length;
    if (!confirm('Xóa link, mã bí mật và dữ liệu đã lưu trên máy này?' + (pending ? '\nCó ' + pending + ' khoản CHƯA gửi lên sheet sẽ bị mất.' : ''))) return;
    [LS.cfg, LS.data, LS.queue].forEach(store.del);
    cfg = { url: '', token: '' }; data = null; queue = [];
    sheet.close(); render();
  };
}

/* ================================================================ KHỞI ĐỘNG */

document.querySelectorAll('#tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (ui.tab === b.dataset.tab) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  ui.tab = b.dataset.tab;
  if (ui.tab === 'period') ui.periodIdx = null;
  window.scrollTo(0, 0);
  render();
}));
$('#fab').addEventListener('click', () => openTxSheet({}));
$('#settingsBtn').addEventListener('click', openSettings);
$('#syncChip').addEventListener('click', () => refresh());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && cfg.url && Date.now() - sync.lastFetch > 60000) refresh(true);
  if (document.visibilityState === 'visible' && data) render(); // ngày có thể đã sang hôm sau
});
window.addEventListener('online', () => { if (cfg.url) flushQueue().then(() => refresh(true)); });

if ('serviceWorker' in navigator && location.protocol === 'https:' && !DEMO) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

render();
if (cfg.url) refresh(true);
