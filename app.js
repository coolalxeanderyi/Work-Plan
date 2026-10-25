import { firebaseConfig } from './firebase-config.js';

// ============================================================
// 資料結構
//   state.jobs[id]   = { id, name, emoji, color, wage, breakMin, updatedAt, deleted? }
//   state.shifts[id] = { id, jobId, date, start, end, breakMin, wage, note, updatedAt, deleted? }
//   state.settings.goal = { id: 'goal', amount, updatedAt }   每月存錢目標
// 刪除只標記 deleted（墓碑），多台裝置同步時才不會把刪掉的資料救回來。
// ============================================================

const STORAGE_KEY = 'workplan.v1';
const KINDS = ['jobs', 'shifts', 'settings'];
const COLORS = ['#7fd4e8', '#ff8fab', '#ffb36b', '#ffd85e', '#8fd9a8', '#b69cff', '#ff9e9e', '#a3b8ff'];
const EMOJIS = ['☕', '🍰', '🍔', '🍜', '🧋', '📚', '✏️', '🛒', '👕', '💻', '🎨', '🎤', '🐶', '🌸', '🚲', '📦', '🏥', '⭐'];
const THEME_KEY = 'workplan.theme.v2';
const THEME_COLORS = { aqua: '#3fb4d0', strawberry: '#f2638f', mint: '#2fae7a', lavender: '#8f6cf0' };

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let state = loadLocal();
let view = 'calendar';
let cursor = startOfMonth(new Date());
let openDay = null;

// ---------- 工具 ----------
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function toMin(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
// 依底色亮度決定用深色或白色字
function textOn(hex) {
  const n = parseInt(String(hex).slice(1, 7), 16);
  if (Number.isNaN(n)) return '#3d2c3e';
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#3d2c3e' : '#ffffff';
}
const emojiOf = j => j.emoji || '⭐';
function money(n) { return '$' + Math.round(n).toLocaleString('zh-TW'); }
function hours(min) { return (min / 60).toFixed(min % 60 ? 1 : 0); }
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function dateLabel(s) { const d = parseYmd(s); return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`; }

// 工作分鐘數；結束早於開始視為跨夜
function shiftMinutes(s) {
  let m = toMin(s.end) - toMin(s.start);
  if (m <= 0) m += 24 * 60;
  return Math.max(0, m - (Number(s.breakMin) || 0));
}
function shiftPay(s) { return shiftMinutes(s) / 60 * (Number(s.wage) || 0); }

// 撞班判斷：把班換成「從 1970 年起算的分鐘數」區間，跨夜班也能正確比較
function dayNum(date) { const [y, m, d] = date.split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; }
function shiftSpan(s) {
  const start = dayNum(s.date) * 1440 + toMin(s.start);
  let len = toMin(s.end) - toMin(s.start);
  if (len <= 0) len += 1440;
  return [start, start + len];
}
function clashesOf(s, ignoreId = s.id) {
  const [a0, a1] = shiftSpan(s);
  const d = parseYmd(s.date);
  const nearby = [addDays(d, -1), d, addDays(d, 1)].flatMap(x => shiftsOn(ymd(x)));
  return nearby.filter(o => {
    if (o.id === ignoreId) return false;
    const [b0, b1] = shiftSpan(o);
    return a0 < b1 && b0 < a1;
  });
}
const goalAmount = () => Number(state.settings.goal?.amount) || 0;
const monthKey = date => date.slice(0, 7);
function monthPay(key) {
  return Object.values(state.shifts)
    .filter(s => !s.deleted && s.date.startsWith(key + '-'))
    .reduce((a, s) => a + shiftPay(s), 0);
}
// 新增班次後，若某個月剛好跨過存錢目標就慶祝
function celebrateGoal(before) {
  const goal = goalAmount();
  if (!goal) return;
  for (const [key, pay] of Object.entries(before)) {
    if (pay < goal && monthPay(key) >= goal) {
      confetti();
      toast(`🎉 達成 ${Number(key.slice(5))} 月存錢目標！`);
      return;
    }
  }
}

const jobs = () => Object.values(state.jobs).filter(j => !j.deleted).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
const jobOf = id => (state.jobs[id]?.name ? state.jobs[id] : { name: '（已刪除的工作）', color: '#c9c2c6', emoji: '👻' });
const shiftsOn = date => Object.values(state.shifts)
  .filter(s => !s.deleted && s.date === date)
  .sort((a, b) => a.start.localeCompare(b.start));
function shiftsInMonth(month) {
  const prefix = `${month.getFullYear()}-${pad(month.getMonth() + 1)}-`;
  return Object.values(state.shifts)
    .filter(s => !s.deleted && s.date.startsWith(prefix))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// ---------- 儲存 ----------
function loadLocal() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && data.jobs && data.shifts) return { settings: {}, ...data };
  } catch { /* 沒有資料或格式錯誤時重新開始 */ }
  return { jobs: {}, shifts: {}, settings: {} };
}
function saveLocal() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch { toast('無法儲存到本機 😢'); }
}
function upsert(kind, item) {
  item.updatedAt = Date.now();
  state[kind][item.id] = item;
  commit();
}
function remove(kind, id) {
  const item = state[kind][id];
  if (!item) return;
  // 工作保留名稱和顏色，過去的班才看得出是哪份工作
  state[kind][id] = kind === 'jobs'
    ? { ...item, deleted: true, updatedAt: Date.now() }
    : { id, deleted: true, updatedAt: Date.now() };
  commit();
}
function commit() {
  saveLocal();
  render();
  sync.push();
}

// 以 updatedAt 較新的為準，逐筆合併
function mergeInto(target, incoming) {
  let changed = false;
  for (const kind of KINDS) {
    target[kind] ||= {};
    for (const [id, item] of Object.entries(incoming[kind] || {})) {
      const cur = target[kind][id];
      if (!cur || (item.updatedAt || 0) > (cur.updatedAt || 0)) {
        target[kind][id] = item;
        changed = true;
      }
    }
  }
  return changed;
}
// target 裡是否有 other 沒有（或比較新）的資料
function hasNewerThan(target, other) {
  for (const kind of KINDS) {
    for (const [id, item] of Object.entries(target[kind] || {})) {
      const o = other[kind]?.[id];
      if (!o || (item.updatedAt || 0) > (o.updatedAt || 0)) return true;
    }
  }
  return false;
}

// ---------- 畫面 ----------
function render() {
  $('#monthTitle').textContent = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#fab').hidden = view === 'settings';
  if (view === 'calendar') renderCalendar();
  if (view === 'list') renderList();
  if (view === 'stats') renderStats();
  if (view === 'settings') renderSettings();
  if (openDay && $('#dayDialog').open) renderDay();
}

function monthTotals(list) {
  const min = list.reduce((a, s) => a + shiftMinutes(s), 0);
  const pay = list.reduce((a, s) => a + shiftPay(s), 0);
  return { min, pay, count: list.length };
}

function renderGreeting() {
  const h = new Date().getHours();
  const [face, hello] = h < 5 ? ['🌙', '夜深了，早點休息喔']
    : h < 11 ? ['🌞', '早安！']
    : h < 14 ? ['🍙', '午安～記得吃飯']
    : h < 18 ? ['🌼', '下午好！']
    : ['🌛', '晚上好～'];
  const today = shiftsOn(ymd(new Date()));
  let sub;
  if (!jobs().length) sub = '先按右下角的 ＋ 新增一份工作吧 ✨';
  else if (!today.length) sub = '今天沒有班，好好休息 🛌';
  else {
    const first = today[0];
    sub = `今天有 ${today.length} 個班，${first.start} 開始 ${jobOf(first.jobId).name}，加油 💪`;
  }
  $('#greeting').innerHTML = `<span class="face">${face}</span>
    <div><div class="hello">${esc(hello)}</div><div class="sub">${esc(sub)}</div></div>`;
}

function renderCalendar() {
  renderGreeting();
  const t = monthTotals(shiftsInMonth(cursor));
  $('#calSummary').innerHTML = `
    <span class="pill">🗓️ <b>${t.count}</b> 班</span>
    <span class="pill">⏰ <b>${hours(t.min)}</b>h</span>
    <span class="pill">💰 <b>${money(t.pay)}</b></span>
    ${goalAmount() ? `<span class="pill">🐷 <b>${Math.floor(t.pay / goalAmount() * 100)}%</b></span>` : ''}`;

  const first = addDays(cursor, -cursor.getDay());
  const lastOfMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
  const cells = Math.ceil((cursor.getDay() + lastOfMonth.getDate()) / 7) * 7;
  const today = ymd(new Date());
  let html = '';
  for (let i = 0; i < cells; i++) {
    const d = addDays(first, i);
    const key = ymd(d);
    const list = shiftsOn(key);
    const cls = ['day'];
    if (d.getMonth() !== cursor.getMonth()) cls.push('other');
    if (key === today) cls.push('today');
    if (d.getDay() === 0 || d.getDay() === 6) cls.push('weekend');
    const chips = list.slice(0, 3).map(s => {
      const j = jobOf(s.jobId);
      return `<div class="chip" style="background:${esc(j.color)};color:${textOn(j.color)}">${esc(emojiOf(j))}<span class="t"> ${esc(s.start)}</span><span class="n"> ${esc(j.name)}</span></div>`;
    }).join('');
    const more = list.length > 3 ? `<div class="more">+${list.length - 3}</div>` : '';
    const clash = list.some(s => clashesOf(s).length) ? '<span class="clash" title="撞班">⚠️</span>' : '';
    html += `<button class="${cls.join(' ')}" data-date="${key}"><span class="num">${d.getDate()}</span>${clash}${chips}${more}</button>`;
  }
  $('#calendar').innerHTML = html;
}

function shiftItemHtml(s) {
  const j = jobOf(s.jobId);
  const note = s.note ? ` · ${esc(s.note)}` : '';
  return `<button class="shift-item" data-shift="${s.id}">
    <span class="bubble" style="background:${esc(j.color)}55">${esc(emojiOf(j))}</span>
    <span class="info">
      <div class="title">${esc(j.name)}${clashesOf(s).length ? ' <span class="clash-tag">⚠️ 撞班</span>' : ''}</div>
      <div class="sub">${esc(s.start)}–${esc(s.end)} · ${hours(shiftMinutes(s))} 小時${note}</div>
    </span>
    <span class="pay">${money(shiftPay(s))}</span>
  </button>`;
}

function renderList() {
  const list = shiftsInMonth(cursor);
  if (!list.length) {
    $('#shiftList').innerHTML = `<div class="empty"><span class="big">🐣</span>這個月還沒有班<br>按右下角的 ＋ 新增吧</div>`;
    return;
  }
  const today = ymd(new Date());
  const groups = {};
  for (const s of list) (groups[s.date] ||= []).push(s);
  $('#shiftList').innerHTML = Object.entries(groups).map(([date, items]) => `
    <div class="date-group">
      <h4 class="${date === today ? 'is-today' : ''}">${dateLabel(date)}${date === today ? ' · 今天' : ''}</h4>
      ${items.map(shiftItemHtml).join('')}
    </div>`).join('');
}

function renderStats() {
  const list = shiftsInMonth(cursor);
  const t = monthTotals(list);
  const year = cursor.getFullYear();
  const yearList = Object.values(state.shifts).filter(s => !s.deleted && s.date.startsWith(`${year}-`));
  const y = monthTotals(yearList);

  const byJob = {};
  for (const s of list) {
    const b = (byJob[s.jobId] ||= { min: 0, pay: 0, count: 0 });
    b.min += shiftMinutes(s); b.pay += shiftPay(s); b.count++;
  }
  const rows = Object.entries(byJob).sort((a, b) => b[1].pay - a[1].pay);
  const maxPay = Math.max(1, ...rows.map(r => r[1].pay));

  const goal = goalAmount();
  const pct = goal ? Math.min(100, t.pay / goal * 100) : 0;
  const goalHtml = goal ? `
      <div class="goal-top">
        <span class="goal-pig ${pct >= 100 ? 'done' : ''}">🐷</span>
        <div>
          <div class="goal-num">${money(t.pay)} <span>/ ${money(goal)}</span></div>
          <div class="muted" style="margin:0">${pct >= 100 ? '達成目標了，太棒了 🎉' : `還差 ${money(goal - t.pay)}，加油 💪`}</div>
        </div>
      </div>
      <div class="meter big"><div style="width:${pct.toFixed(1)}%;background:var(--primary)"></div></div>
      <button class="btn small" id="goalBtn" style="margin-top:12px">修改目標</button>`
    : `<p class="muted">設定每個月想賺多少，看著小豬存錢筒慢慢裝滿 ✨</p>
      <button class="btn primary small" id="goalBtn">設定目標</button>`;

  $('#stats').innerHTML = `
    <div class="card goal">
      <h2>🎯 ${cursor.getMonth() + 1} 月存錢目標</h2>
      ${goalHtml}
    </div>
    <div class="kpis">
      <div class="kpi"><div class="emoji">💰</div><div class="label">本月薪資</div><div class="value">${money(t.pay)}</div></div>
      <div class="kpi"><div class="emoji">⏰</div><div class="label">本月工時</div><div class="value">${hours(t.min)}h</div></div>
      <div class="kpi"><div class="emoji">🗓️</div><div class="label">本月班數</div><div class="value">${t.count}</div></div>
    </div>
    <div class="card">
      <h2>📊 各工作明細</h2>
      ${rows.length ? rows.map(([id, b]) => {
        const j = jobOf(id);
        return `<div class="breakdown-row">
          <div class="top"><span>${esc(emojiOf(j))} ${esc(j.name)}</span>
          <span>${money(b.pay)} · ${hours(b.min)}h · ${b.count} 班</span></div>
          <div class="meter"><div style="width:${(b.pay / maxPay * 100).toFixed(1)}%;background:${esc(j.color)}"></div></div>
        </div>`;
      }).join('') : '<p class="muted">這個月還沒有收入，加油 🌱</p>'}
    </div>
    <div class="card">
      <h2>🐷 ${year} 年存錢筒</h2>
      <p class="muted" style="margin:0">薪資 <b>${money(y.pay)}</b> · 工時 <b>${hours(y.min)}</b> 小時 · <b>${y.count}</b> 班</p>
    </div>`;
}

function renderSettings() {
  const list = jobs();
  $('#jobList').innerHTML = list.length ? list.map(j => `
    <li data-job="${j.id}">
      <span class="bubble" style="background:${esc(j.color)}55">${esc(emojiOf(j))}</span>
      <span class="name">${esc(j.name)}</span>
      <span class="meta">時薪 ${money(j.wage)}</span>
    </li>`).join('') : '<li class="muted">還沒有工作，先新增一個吧 🌷</li>';
  const theme = document.documentElement.dataset.theme;
  $$('#themes button').forEach(b => b.classList.toggle('selected', b.dataset.theme === theme));
  sync.renderPanel();
}

// ---------- 某一天 ----------
function showDay(date) {
  openDay = date;
  renderDay();
  $('#dayDialog').showModal();
}
function renderDay() {
  $('#dayTitle').textContent = dateLabel(openDay);
  const list = shiftsOn(openDay);
  $('#dayShifts').innerHTML = list.length ? list.map(shiftItemHtml).join('') : '<p class="muted">這天沒有班，可以放空 ☁️</p>';
}

// ---------- 班次表單 ----------
let editingShift = null;
function openShiftForm(shift, date) {
  if (!jobs().length) {
    toast('先新增一份工作喔 🌷');
    view = 'settings'; render();
    openJobForm(null);
    return;
  }
  editingShift = shift;
  const f = $('#shiftForm');
  f.jobId.innerHTML = jobs().map(j => `<option value="${j.id}">${esc(j.name)}</option>`).join('');
  if (shift) {
    if (!state.jobs[shift.jobId] || state.jobs[shift.jobId].deleted) {
      f.jobId.insertAdjacentHTML('afterbegin', `<option value="${esc(shift.jobId)}">${esc(jobOf(shift.jobId).name)}</option>`);
    }
    f.jobId.value = shift.jobId;
    f.date.value = shift.date;
    f.start.value = shift.start;
    f.end.value = shift.end;
    f.breakMin.value = shift.breakMin;
    f.wage.value = shift.wage;
    f.note.value = shift.note || '';
  } else {
    const lastJob = localStorage.getItem('workplan.lastJob');
    f.jobId.value = state.jobs[lastJob] && !state.jobs[lastJob].deleted ? lastJob : jobs()[0].id;
    f.date.value = date || ymd(new Date());
    f.note.value = '';
    applyJobDefaults();
  }
  f.repeat.value = '0';
  $('#repeatRow').hidden = !!shift;
  $('#shiftDelete').hidden = !shift;
  $('#shiftFormTitle').textContent = shift ? '編輯班次' : '新增班次';
  updatePreview();
  $('#shiftDialog').showModal();
}
// 每次上班時間不固定，所以帶入「這份工作最近一次排的班」的時間，第一次就留白
function applyJobDefaults() {
  const f = $('#shiftForm');
  const j = state.jobs[f.jobId.value];
  if (!j) return;
  const last = Object.values(state.shifts)
    .filter(s => !s.deleted && s.jobId === j.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  f.start.value = last?.start || '';
  f.end.value = last?.end || '';
  f.breakMin.value = j.breakMin ?? 0;
  f.wage.value = j.wage;
}
function readShiftForm() {
  const f = $('#shiftForm');
  return {
    jobId: f.jobId.value, date: f.date.value, start: f.start.value, end: f.end.value,
    breakMin: Number(f.breakMin.value) || 0, wage: Number(f.wage.value) || 0, note: f.note.value.trim(),
  };
}
function updatePreview() {
  const s = readShiftForm();
  const warn = $('#shiftWarn');
  warn.hidden = true;
  if (!s.start || !s.end) { $('#shiftPreview').textContent = ''; return; }
  const overnight = toMin(s.end) <= toMin(s.start) ? '（跨夜）' : '';
  $('#shiftPreview').textContent = `共 ${hours(shiftMinutes(s))} 小時${overnight}，預估 ${money(shiftPay(s))}`;
  if (!s.date) return;
  const clashes = clashesOf({ ...s, id: editingShift?.id });
  if (clashes.length) {
    warn.hidden = false;
    warn.textContent = '⚠️ 撞班了：' + clashes.map(o =>
      `${o.date === s.date ? '' : dateLabel(o.date) + ' '}${jobOf(o.jobId).name} ${o.start}–${o.end}`).join('、');
  }
}
function saveShift(e) {
  e.preventDefault();
  const data = readShiftForm();
  if (!data.date || !data.start || !data.end) return;
  const repeat = editingShift ? 0 : Number($('#shiftForm').repeat.value) || 0;
  const dates = Array.from({ length: repeat + 1 }, (_, i) => ymd(addDays(parseYmd(data.date), i * 7)));
  const clashCount = dates.filter(date => clashesOf({ ...data, date, id: editingShift?.id }).length).length;
  if (clashCount && !confirm(`⚠️ 有 ${clashCount} 個班跟其他班撞到了，還是要儲存嗎？`)) return;

  localStorage.setItem('workplan.lastJob', data.jobId);
  const before = Object.fromEntries(dates.map(d => [monthKey(d), monthPay(monthKey(d))]));
  if (editingShift) {
    upsert('shifts', { ...editingShift, ...data });
    toast('更新好了 ✨');
  } else {
    const now = Date.now();
    for (const date of dates) {
      const id = newId();
      state.shifts[id] = { id, ...data, date, updatedAt: now };
    }
    commit();
    toast(repeat ? `新增了 ${repeat + 1} 個班 🎉` : '排好班了 🎉');
  }
  $('#shiftDialog').close();
  celebrateGoal(before);
}

// ---------- 工作表單 ----------
let editingJob = null;
let pickedColor = COLORS[0];
let pickedEmoji = EMOJIS[0];
function openJobForm(job) {
  editingJob = job;
  const f = $('#jobForm');
  f.name.value = job?.name || '';
  f.wage.value = job?.wage ?? 190;
  f.breakMin.value = job?.breakMin ?? 0;
  const used = new Set(jobs().map(j => j.color));
  pickedColor = job?.color || COLORS.find(c => !used.has(c)) || COLORS[0];
  const usedEmoji = new Set(jobs().map(j => j.emoji));
  pickedEmoji = job?.emoji || EMOJIS.find(e => !usedEmoji.has(e)) || EMOJIS[0];
  renderSwatches();
  $('#jobDelete').hidden = !job;
  $('#jobFormTitle').textContent = job ? '編輯工作' : '新增工作';
  $('#jobDialog').showModal();
}
function renderSwatches() {
  $('#swatches').innerHTML = COLORS.map(c =>
    `<button type="button" data-color="${c}" class="${c === pickedColor ? 'selected' : ''}" style="background:${c}" aria-label="顏色 ${c}"></button>`).join('');
  $('#emojis').innerHTML = EMOJIS.map(e =>
    `<button type="button" data-emoji="${e}" class="${e === pickedEmoji ? 'selected' : ''}">${e}</button>`).join('');
}
function saveJob(e) {
  e.preventDefault();
  const f = $('#jobForm');
  const name = f.name.value.trim();
  if (!name) return;
  upsert('jobs', {
    ...(editingJob || { id: newId() }),
    name, emoji: pickedEmoji, color: pickedColor, wage: Number(f.wage.value) || 0,
    breakMin: Number(f.breakMin.value) || 0,
  });
  $('#jobDialog').close();
  toast(editingJob ? '更新好了 ✨' : `${pickedEmoji} 新增工作成功`);
}

// ---------- 備份 ----------
function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `兼職排班備份-${ymd(new Date())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data.jobs || !data.shifts) throw new Error('format');
    mergeInto(state, data);
    commit();
    toast('匯入完成 📦');
  } catch {
    toast('檔案格式不對耶 🤔');
  }
}

// ---------- 複製一週 ----------
function weekStart(date) { const d = parseYmd(date); return addDays(d, -d.getDay()); }
function weekLabel(date) {
  const s = weekStart(date);
  const e = addDays(s, 6);
  return `${s.getMonth() + 1}/${s.getDate()}（日）～ ${e.getMonth() + 1}/${e.getDate()}（六）`;
}
// 算出要複製哪些班：跳過目標週已經有的相同班
function copyPlan() {
  const f = $('#copyForm');
  if (!f.from.value || !f.to.value) return null;
  const from = weekStart(f.from.value);
  const offset = Math.round((weekStart(f.to.value) - from) / 86400000);
  const source = [];
  for (let i = 0; i < 7; i++) source.push(...shiftsOn(ymd(addDays(from, i))));
  const fresh = [];
  let skipped = 0;
  for (const s of source) {
    const date = ymd(addDays(parseYmd(s.date), offset));
    const dup = shiftsOn(date).some(o => o.jobId === s.jobId && o.start === s.start && o.end === s.end);
    if (dup || offset === 0) skipped++;
    else fresh.push({ jobId: s.jobId, start: s.start, end: s.end, breakMin: s.breakMin, wage: s.wage, note: s.note || '', date });
  }
  return { fresh, skipped, total: source.length };
}
function openCopyWeek() {
  const f = $('#copyForm');
  const today = new Date();
  const sameMonth = today.getFullYear() === cursor.getFullYear() && today.getMonth() === cursor.getMonth();
  const target = ymd(weekStart(ymd(sameMonth ? today : cursor)));
  f.to.value = target;
  f.from.value = ymd(addDays(parseYmd(target), -7));
  updateCopyPreview();
  $('#copyDialog').showModal();
}
function updateCopyPreview() {
  const f = $('#copyForm');
  $('#copyFromLabel').textContent = f.from.value ? weekLabel(f.from.value) : '';
  $('#copyToLabel').textContent = f.to.value ? weekLabel(f.to.value) : '';
  const plan = copyPlan();
  let msg = '';
  if (plan) {
    if (!plan.total) msg = '來源那週沒有班喔 🤔';
    else if (!plan.fresh.length) msg = '那些班都已經排好了，不用再複製 👌';
    else msg = `會複製 ${plan.fresh.length} 個班` + (plan.skipped ? `（${plan.skipped} 個已經有了，會跳過）` : '');
  }
  $('#copyPreview').textContent = msg;
  $('#copySubmit').disabled = !plan?.fresh.length;
}
function doCopyWeek(e) {
  e.preventDefault();
  const plan = copyPlan();
  if (!plan?.fresh.length) return;
  const clashCount = plan.fresh.filter(s => clashesOf(s, null).length).length;
  if (clashCount && !confirm(`⚠️ 其中 ${clashCount} 個班會跟原本的班撞到，還是要複製嗎？`)) return;
  const before = Object.fromEntries(plan.fresh.map(s => [monthKey(s.date), monthPay(monthKey(s.date))]));
  const now = Date.now();
  const ids = plan.fresh.map(s => {
    const id = newId();
    state.shifts[id] = { id, ...s, updatedAt: now };
    return id;
  });
  commit();
  $('#copyDialog').close();
  // 複製過來的班之間也可能互撞（例如來源那週本來就撞班）
  const clashed = ids.filter(id => clashesOf(state.shifts[id]).length).length;
  toast(`複製了 ${plan.fresh.length} 個班 📋` + (clashed ? `，其中 ${clashed} 個撞班 ⚠️` : ''));
  celebrateGoal(before);
}

// ---------- 存錢目標 ----------
function openGoal() {
  $('#goalForm').amount.value = goalAmount() || '';
  $('#goalDialog').showModal();
}
function saveGoal(e) {
  e.preventDefault();
  const amount = Math.max(0, Number($('#goalForm').amount.value) || 0);
  state.settings.goal = { id: 'goal', amount, updatedAt: Date.now() };
  commit();
  $('#goalDialog').close();
  toast(amount ? '目標設定好了，加油 🐷' : '已取消存錢目標');
  if (amount && monthPay(monthKey(ymd(cursor))) >= amount) confetti();
}

// ---------- 撒花 ----------
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const pieces = ['🎉', '✨', '💰', '🫧', '💖', '⭐', '🐷'];
  const box = document.createElement('div');
  box.className = 'confetti';
  for (let i = 0; i < 36; i++) {
    const p = document.createElement('span');
    p.textContent = pieces[i % pieces.length];
    p.style.left = Math.random() * 100 + 'vw';
    p.style.animationDelay = Math.random() * 0.6 + 's';
    p.style.animationDuration = 1.8 + Math.random() * 1.4 + 's';
    p.style.fontSize = 16 + Math.random() * 18 + 'px';
    box.append(p);
  }
  document.body.append(box);
  setTimeout(() => box.remove(), 4000);
}

// ---------- 提示 ----------
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

// ============================================================
// 雲端同步（Firebase）。firebase-config.js 沒填時，整個網站以本機模式運作。
// 雲端資料存在 Firestore 的 users/{uid} 這一份文件裡。
// ============================================================
const sync = {
  enabled: !!firebaseConfig,
  user: null,
  api: null,
  remote: null,
  timer: null,

  async init() {
    if (!this.enabled) { this.renderPanel(); return; }
    const v = '10.12.2';
    try {
      const [app, auth, fs] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`),
      ]);
      const fbApp = app.initializeApp(firebaseConfig);
      const a = auth.getAuth(fbApp);
      const db = fs.getFirestore(fbApp);
      this.api = { auth, fs, a, db, unsub: null };
      auth.onAuthStateChanged(a, user => this.onUser(user));
    } catch (err) {
      console.error(err);
      this.loadError = true;
      this.renderPanel();
    }
  },

  onUser(user) {
    const { fs, db } = this.api;
    this.user = user;
    this.remote = null;
    if (this.api.unsub) { this.api.unsub(); this.api.unsub = null; }
    if (user) {
      this.setDot('busy');
      const ref = fs.doc(db, 'users', user.uid);
      this.api.unsub = fs.onSnapshot(ref, snap => {
        const remote = snap.exists() ? snap.data() : {};
        this.remote = Object.fromEntries(KINDS.map(k => [k, remote[k] || {}]));
        if (mergeInto(state, this.remote)) { saveLocal(); render(); }
        if (hasNewerThan(state, this.remote)) this.push(0);
        this.setDot('on');
      }, err => {
        console.error(err);
        toast('同步失敗，請檢查 Firestore 規則 😢');
        this.setDot('');
      });
    } else {
      this.setDot('');
    }
    this.renderPanel();
  },

  push(delay = 800) {
    if (!this.user || !this.remote) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const { fs, db } = this.api;
      this.setDot('busy');
      try {
        const data = JSON.parse(JSON.stringify(state)); // 去掉 undefined，Firestore 不接受
        await fs.setDoc(fs.doc(db, 'users', this.user.uid), { ...data, savedAt: Date.now() });
        this.setDot('on');
      } catch (err) {
        console.error(err);
        this.setDot('');
        toast('上傳失敗，連線恢復後會再試 📡');
      }
    }, delay);
  },

  async login() {
    const { auth, a } = this.api;
    const provider = new auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(a, provider);
    } catch (err) {
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
        await auth.signInWithRedirect(a, provider);
      } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
        console.error(err);
        toast('登入失敗：' + err.code);
      }
    }
  },

  async logout() {
    await this.api.auth.signOut(this.api.a);
    toast('已登出，資料還留在這台裝置 👋');
  },

  setDot(cls) {
    const dot = $('#syncDot');
    dot.className = 'sync-dot' + (cls ? ' ' + cls : '');
    dot.title = cls === 'on' ? '已同步' : cls === 'busy' ? '同步中…' : '本機模式';
  },

  renderPanel() {
    const p = $('#syncPanel');
    if (!p) return;
    if (!this.enabled) {
      p.innerHTML = `<p class="muted">目前是<b>本機模式</b>：資料存在這台裝置裡，記得偶爾匯出備份喔。
        想讓手機和電腦看到同一份班表時再設定就好，現在不用管它 😊</p>`;
      return;
    }
    if (this.loadError) {
      p.innerHTML = `<p class="muted">無法載入同步元件，請確認網路連線後重新整理。</p>`;
      return;
    }
    if (!this.api) {
      p.innerHTML = `<p class="muted">載入中…</p>`;
      return;
    }
    if (this.user) {
      p.innerHTML = `<p class="muted">已登入 <b>${esc(this.user.email || this.user.displayName)}</b>，資料會自動同步到所有登入同帳號的裝置。</p>
        <button class="btn" id="logoutBtn">登出</button>`;
    } else {
      p.innerHTML = `<p class="muted">登入 Google 帳號後，手機、電腦都能看到同一份班表。這台裝置現有的資料會自動合併上去。</p>
        <button class="btn primary" id="loginBtn">用 Google 登入</button>`;
    }
  },
};

// ---------- 事件 ----------
$('#prevMonth').onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1); render(); };
$('#nextMonth').onclick = () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1); render(); };
$('#monthTitle').onclick = () => { cursor = startOfMonth(new Date()); render(); };
$$('.tabbar button').forEach(b => b.onclick = () => { view = b.dataset.view; render(); window.scrollTo(0, 0); });
$('#fab').onclick = () => {
  const today = new Date();
  const sameMonth = today.getFullYear() === cursor.getFullYear() && today.getMonth() === cursor.getMonth();
  openShiftForm(null, ymd(sameMonth ? today : cursor));
};

$('#calendar').onclick = e => {
  const cell = e.target.closest('[data-date]');
  if (cell) showDay(cell.dataset.date);
};
document.addEventListener('click', e => {
  const item = e.target.closest('[data-shift]');
  if (item) {
    if ($('#dayDialog').open) $('#dayDialog').close();
    openShiftForm(state.shifts[item.dataset.shift]);
    return;
  }
  const job = e.target.closest('[data-job]');
  if (job) { openJobForm(state.jobs[job.dataset.job]); return; }
  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
  if (e.target.id === 'loginBtn') sync.login();
  if (e.target.id === 'logoutBtn') sync.logout();
});
// 點對話框外面的背景就關閉
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

$('#dayAdd').onclick = () => { $('#dayDialog').close(); openShiftForm(null, openDay); };

const sf = $('#shiftForm');
sf.addEventListener('submit', saveShift);
sf.addEventListener('input', updatePreview);
sf.jobId.addEventListener('change', () => { applyJobDefaults(); updatePreview(); });
$('#shiftDelete').onclick = () => {
  if (!editingShift || !confirm('確定刪除這個班？')) return;
  remove('shifts', editingShift.id);
  $('#shiftDialog').close();
  toast('刪掉了 🗑️');
};

$('#jobForm').addEventListener('submit', saveJob);
$('#swatches').onclick = e => {
  const c = e.target.dataset.color;
  if (c) { pickedColor = c; renderSwatches(); }
};
$('#emojis').onclick = e => {
  const em = e.target.dataset.emoji;
  if (em) { pickedEmoji = em; renderSwatches(); }
};
$('#themes').onclick = e => {
  const b = e.target.closest('[data-theme]');
  if (!b) return;
  setTheme(b.dataset.theme);
  renderSettings();
};
function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]').content = THEME_COLORS[theme] || THEME_COLORS.aqua;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* 無痕模式存不了也沒關係 */ }
}
$('#addJob').onclick = () => openJobForm(null);
$('#jobDelete').onclick = () => {
  if (!editingJob || !confirm(`確定刪除「${editingJob.name}」？已排的班會保留。`)) return;
  remove('jobs', editingJob.id);
  $('#jobDialog').close();
  toast('刪掉了 🗑️');
};

$('#copyWeekBtn').onclick = openCopyWeek;
$('#copyForm').addEventListener('input', updateCopyPreview);
$('#copyForm').addEventListener('submit', doCopyWeek);
$('#goalForm').addEventListener('submit', saveGoal);
$('#stats').addEventListener('click', e => { if (e.target.id === 'goalBtn') openGoal(); });

$('#exportBtn').onclick = exportData;
$('#importInput').onchange = e => { if (e.target.files[0]) importData(e.target.files[0]); e.target.value = ''; };

// 其他分頁改了資料時跟著更新
window.addEventListener('storage', e => {
  if (e.key === STORAGE_KEY) { state = loadLocal(); render(); }
});

// 離線也能開啟
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

setTheme(document.documentElement.dataset.theme || 'aqua');
render();
sync.init();
