import { firebaseConfig } from './firebase-config.js';

// ============================================================
// 資料結構
//   state.jobs[id]   = { id, name, emoji, color, wage, updatedAt, deleted? }
//   state.shifts[id] = { id, jobId, date, start, end, breakMin, wage, note, updatedAt, deleted? }
//   state.classes[id] = { id, name, weekday, start, end, room, color, updatedAt, deleted? }   每週固定的課
//   state.settings.goal = { id: 'goal', amount, updatedAt }   每月存錢目標
//   state.settings.semester = { id: 'semester', start, end, updatedAt }   學期日期，課只在這段期間出現
// 刪除只標記 deleted（墓碑），多台裝置同步或匯入舊備份時，才不會把刪掉的資料救回來。
// ============================================================

const STORAGE_KEY = 'workplan.v1';
const KINDS = ['jobs', 'shifts', 'classes', 'settings'];
const COLORS = ['#7fd4e8', '#ff8fab', '#ffb36b', '#ffd85e', '#8fd9a8', '#b69cff', '#ff9e9e', '#a3b8ff'];
const EMOJIS = ['☕', '🍰', '🍔', '🍜', '🧋', '📚', '✏️', '🛒', '👕', '💻', '🎨', '🎤', '🐶', '🌸', '🚲', '📦', '🏥', '⭐'];
const THEME_KEY = 'workplan.theme.v2';
const THEME_COLORS = { aqua: '#3fb4d0', strawberry: '#f2638f', mint: '#2fae7a', lavender: '#8f6cf0' };

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

let state = loadLocal();
let view = 'calendar';
let cursor = startOfMonth(new Date());
let weekCursor = mondayOf(new Date());
let openDay = null;

// ---------- 工具 ----------
function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}
function pad(n) { return String(n).padStart(2, '0'); }
function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function parseYmd(s) { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function mondayOf(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function fromMin(m) { m = ((m % 1440) + 1440) % 1440; return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }
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
// 上班到下班的總長（含休息）；下班時間比上班早就當成隔天下班
function spanMinutes(s) {
  let m = toMin(s.end) - toMin(s.start);
  if (m <= 0) m += 24 * 60;
  return m;
}
function shiftMinutes(s) { return Math.max(0, spanMinutes(s) - (Number(s.breakMin) || 0)); }
// 跨夜班可以，但超過這個長度幾乎一定是把時間選錯了（例如 17:00 上班、16:30 下班）
const MAX_SHIFT_MIN = 16 * 60;
function timeProblem(s) {
  if (!s.start || !s.end) return '';
  if (s.start === s.end) return '上班和下班時間一樣喔，請檢查一下 ⏰';
  if (spanMinutes(s) > MAX_SHIFT_MIN) {
    return `下班時間比上班時間早囉！${s.start} 上班、${s.end} 下班，會變成隔天才下班（${hours(spanMinutes(s))} 小時），請檢查一下 ⏰`;
  }
  return '';
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
// 跟這個班時間重疊的課（跨夜班也會檢查隔天早上的課）
function classClashesOf(s) {
  const [a0, a1] = shiftSpan(s);
  const d = parseYmd(s.date);
  const out = [];
  for (const x of [d, addDays(d, 1)]) {
    const date = ymd(x);
    const base = dayNum(date) * 1440;
    for (const c of classesOn(date)) {
      if (a0 < base + toMin(c.end) && base + toMin(c.start) < a1) out.push({ ...c, date });
    }
  }
  return out;
}
const hasClash = s => clashesOf(s).length > 0 || classClashesOf(s).length > 0;
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
function inSemester(date) {
  const sem = state.settings.semester;
  return !(sem?.start && date < sem.start) && !(sem?.end && date > sem.end);
}
const classesOn = date => {
  if (!inSemester(date)) return [];
  const w = parseYmd(date).getDay();
  return Object.values(state.classes)
    .filter(c => !c.deleted && c.weekday === w)
    .sort((a, b) => a.start.localeCompare(b.start));
};
function shiftsInMonth(month) {
  const prefix = `${month.getFullYear()}-${pad(month.getMonth() + 1)}-`;
  return Object.values(state.shifts)
    .filter(s => !s.deleted && s.date.startsWith(prefix))
    .sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}

// ---------- 儲存 ----------
function emptyState() { return { jobs: {}, shifts: {}, classes: {}, settings: {} }; }
function loadLocal() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (data && data.jobs && data.shifts) return { classes: {}, settings: {}, ...data };
  } catch { /* 沒有資料或格式錯誤時重新開始 */ }
  return emptyState();
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
  cloud.push();
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
const hasData = st => KINDS.some(k => Object.values(st[k] || {}).some(x => !x.deleted));

// ---------- 畫面 ----------
function render() {
  if (view === 'timetable') {
    const end = addDays(weekCursor, 6);
    $('#monthTitle').textContent = `${weekCursor.getMonth() + 1}/${weekCursor.getDate()} – ${end.getMonth() + 1}/${end.getDate()}`;
  } else {
    $('#monthTitle').textContent = `${cursor.getFullYear()} 年 ${cursor.getMonth() + 1} 月`;
  }
  $$('.view').forEach(v => { v.hidden = v.id !== `view-${view}`; });
  $$('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('#fab').hidden = view === 'settings';
  if (view === 'calendar') renderCalendar();
  if (view === 'timetable') renderTimetable();
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
  const todayKey = ymd(new Date());
  const shifts = shiftsOn(todayKey);
  const classes = classesOn(todayKey);
  const items = [
    ...classes.map(c => ({ start: c.start, name: c.name })),
    ...shifts.map(x => ({ start: x.start, name: jobOf(x.jobId).name })),
  ].sort((a, b) => a.start.localeCompare(b.start));
  let sub;
  if (!jobs().length && !Object.keys(state.classes).length) sub = '先按右下角的 ＋ 新增一份工作吧 ✨';
  else if (!items.length) sub = '今天沒課也沒班，好好休息 🛌';
  else {
    const parts = [classes.length && `${classes.length} 堂課`, shifts.length && `${shifts.length} 個班`].filter(Boolean);
    sub = `今天有 ${parts.join('、')}，${items[0].start} 開始 ${items[0].name}，加油 💪`;
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
    const clash = list.some(hasClash) ? '<span class="clash" title="撞班或撞課">⚠️</span>' : '';
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
      <div class="title">${esc(j.name)}${clashesOf(s).length ? ' <span class="clash-tag">⚠️ 撞班</span>' : ''}${classClashesOf(s).length ? ' <span class="clash-tag">⚠️ 撞課</span>' : ''}${timeProblem(s) ? ' <span class="clash-tag">⚠️ 時間怪怪的</span>' : ''}</div>
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
  cloud.renderPanel();
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
  const classes = classesOn(openDay);
  const classHtml = classes.length ? `<div class="day-classes">${classes.map(c => `
    <button class="class-row" data-class="${c.id}">
      <span class="dot" style="background:${esc(c.color)}"></span>📖 <b>${esc(c.name)}</b>
      <span>${esc(c.start)}–${esc(c.end)}${c.room ? ' · ' + esc(c.room) : ''}</span>
    </button>`).join('')}</div>` : '';
  $('#dayShifts').innerHTML = classHtml + (list.length ? list.map(shiftItemHtml).join('') : '<p class="muted">這天沒有班，可以放空 ☁️</p>');
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
  shiftTimes.close();
  $('#repeatRow').hidden = !!shift;
  $('#shiftDelete').hidden = !shift;
  $('#shiftFormTitle').textContent = shift ? '編輯班次' : '新增班次';
  updatePreview();
  $('#shiftDialog').showModal();
}
// 每次上班時間不固定，所以帶入「這份工作最近一次排的班」的時間和休息，第一次就留白
function applyJobDefaults() {
  const f = $('#shiftForm');
  const j = state.jobs[f.jobId.value];
  if (!j) return;
  const last = Object.values(state.shifts)
    .filter(s => !s.deleted && s.jobId === j.id)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  f.start.value = last?.start || '';
  f.end.value = last?.end || '';
  f.breakMin.value = last?.breakMin ?? 0;
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
  shiftTimes.refresh();
  const s = readShiftForm();
  const warn = $('#shiftWarn');
  warn.hidden = true;
  if (!s.start || !s.end) { $('#shiftPreview').textContent = ''; return; }
  const problem = timeProblem(s);
  if (problem) {
    $('#shiftPreview').textContent = '';
    warn.hidden = false;
    warn.textContent = problem;
    return;
  }
  const overnight = toMin(s.end) <= toMin(s.start) ? '（跨夜）' : '';
  $('#shiftPreview').textContent = `共 ${hours(shiftMinutes(s))} 小時${overnight}，預估 ${money(shiftPay(s))}`;
  if (!s.date) return;
  const cur = { ...s, id: editingShift?.id };
  const dayPrefix = date => (date === s.date ? '' : dateLabel(date) + ' ');
  const lines = [];
  const shiftClashes = clashesOf(cur);
  if (shiftClashes.length) {
    lines.push('⚠️ 撞班了：' + shiftClashes.map(o => `${dayPrefix(o.date)}${jobOf(o.jobId).name} ${o.start}–${o.end}`).join('、'));
  }
  const classClashes = classClashesOf(cur);
  if (classClashes.length) {
    lines.push('📖 撞課了：' + classClashes.map(c => `${dayPrefix(c.date)}${c.name} ${c.start}–${c.end}`).join('、'));
  }
  if (lines.length) {
    warn.hidden = false;
    warn.textContent = lines.join('\n');
  }
}
function saveShift(e) {
  e.preventDefault();
  const data = readShiftForm();
  if (!data.date) return;
  const problem = !data.start || !data.end ? '先選好上班和下班時間 ⏰' : timeProblem(data);
  if (problem) {
    $('#shiftWarn').hidden = false;
    $('#shiftWarn').textContent = problem;
    return;
  }
  const repeat = editingShift ? 0 : Number($('#shiftForm').repeat.value) || 0;
  const dates = Array.from({ length: repeat + 1 }, (_, i) => ymd(addDays(parseYmd(data.date), i * 7)));
  const clashCount = dates.filter(date => hasClash({ ...data, date, id: editingShift?.id })).length;
  if (clashCount && !confirm(`⚠️ 有 ${clashCount} 個班跟其他班或上課時間撞到了，還是要儲存嗎？`)) return;

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
  const clashCount = plan.fresh.filter(s => clashesOf(s, null).length || classClashesOf(s).length).length;
  if (clashCount && !confirm(`⚠️ 其中 ${clashCount} 個班會跟原本的班或上課撞到，還是要複製嗎？`)) return;
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
  const clashed = ids.filter(id => hasClash(state.shifts[id])).length;
  toast(`複製了 ${plan.fresh.length} 個班 📋` + (clashed ? `，其中 ${clashed} 個撞到了 ⚠️` : ''));
  celebrateGoal(before);
}

// ---------- 課表 ----------
const HOUR_PX = 48;
function renderTimetable() {
  const sem = state.settings.semester;
  const short = date => { const d = parseYmd(date); return `${d.getMonth() + 1}/${d.getDate()}`; };
  $('#semesterBtn').textContent = sem?.start || sem?.end
    ? `🎓 學期 ${sem.start ? short(sem.start) : '…'} ~ ${sem.end ? short(sem.end) : '…'}`
    : '🎓 設定學期日期';

  const today = ymd(new Date());
  const cols = Array.from({ length: 7 }, (_, i) => {
    const d = addDays(weekCursor, i);
    const date = ymd(d);
    const items = [
      ...classesOn(date).map(c => ({
        kind: 'class', id: c.id, name: c.name, label: c.start, start: toMin(c.start), end: toMin(c.end), color: c.color, emoji: '📖',
      })),
      ...shiftsOn(date).map(s => {
        const j = jobOf(s.jobId);
        const end = toMin(s.end) <= toMin(s.start) ? 1440 : toMin(s.end);
        return { kind: 'shift', id: s.id, name: j.name, label: s.start, start: toMin(s.start), end, color: j.color, emoji: emojiOf(j), clash: hasClash(s) };
      }),
    ];
    // 前一天的跨夜班，後半段畫在這一天
    for (const s of shiftsOn(ymd(addDays(d, -1)))) {
      if (toMin(s.end) <= toMin(s.start) && toMin(s.end) > 0) {
        const j = jobOf(s.jobId);
        items.push({ kind: 'shift', id: s.id, name: j.name, label: '↪', start: 0, end: toMin(s.end), color: j.color, emoji: emojiOf(j), clash: hasClash(s) });
      }
    }
    // 時間重疊的並排顯示
    items.sort((a, b) => a.start - b.start);
    const lanes = [];
    for (const it of items) {
      let lane = lanes.findIndex(end => end <= it.start);
      if (lane === -1) lane = lanes.push(0) - 1;
      lanes[lane] = it.end;
      it.lane = lane;
    }
    items.forEach(it => { it.lanes = lanes.length; });
    return { d, date, items };
  });

  const all = cols.flatMap(c => c.items);
  let h0 = 8, h1 = 22;
  if (all.length) {
    h0 = Math.min(h0, Math.floor(Math.min(...all.map(i => i.start)) / 60));
    h1 = Math.max(h1, Math.ceil(Math.max(...all.map(i => i.end)) / 60));
  }
  const hourLabels = Array.from({ length: h1 - h0 }, (_, i) =>
    `<span style="top:${i * HOUR_PX}px">${h0 + i}</span>`).join('');

  const block = it => {
    const top = (it.start - h0 * 60) / 60 * HOUR_PX;
    const height = Math.max(18, (it.end - it.start) / 60 * HOUR_PX - 2);
    const style = `top:${top}px;height:${height}px;left:${it.lane / it.lanes * 100}%;width:calc(${100 / it.lanes}% - 2px);`
      + (it.kind === 'class'
        ? `background:${esc(it.color)}40;border-left:3px solid ${esc(it.color)}`
        : `background:${esc(it.color)};color:${textOn(it.color)}`);
    const attr = it.kind === 'class' ? `data-class="${it.id}"` : `data-shift="${it.id}"`;
    return `<button class="tt-item ${it.kind}" ${attr} style="${style}">
      <span class="nm">${it.clash ? '⚠️' : esc(it.emoji)}${esc(it.name)}</span><span class="tm">${esc(it.label)}</span>
    </button>`;
  };

  const empty = Object.values(state.classes).some(c => !c.deleted) ? ''
    : '<p class="tt-tip">還沒有課，按「＋ 新增課程」把課表加進來 📖<br>有空的時段直接點一下，就能排班喔</p>';

  $('#timetable').innerHTML = `${empty}
    <div class="tt">
      <div class="tt-head"><span></span>${cols.map(c => `
        <span class="${c.date === today ? 'today' : ''}">${WEEK[c.d.getDay()]}<b>${c.d.getDate()}</b></span>`).join('')}
      </div>
      <div class="tt-body" style="height:${(h1 - h0) * HOUR_PX}px;--hour:${HOUR_PX}px" data-h0="${h0}">
        <div class="tt-hours">${hourLabels}</div>
        ${cols.map(c => `<div class="tt-col${c.date === today ? ' today' : ''}" data-tt-date="${c.date}">${c.items.map(block).join('')}</div>`).join('')}
      </div>
    </div>
    <p class="muted tt-legend"><span class="lg class"></span>上課　<span class="lg shift"></span>打工　點空白處可以直接排班</p>`;
}

// 點課表空白處：用那個時段開新班
function addShiftAt(date, startMin) {
  openShiftForm(null, date);
  if (!$('#shiftDialog').open) return;
  const f = $('#shiftForm');
  const dur = f.start.value && f.end.value ? ((toMin(f.end.value) - toMin(f.start.value) + 1440) % 1440 || 240) : 240;
  f.start.value = fromMin(startMin);
  f.end.value = fromMin(startMin + dur);
  updatePreview();
}

let editingClass = null;
let pickedDays = new Set();
let pickedClassColor = COLORS[0];
function openClassForm(c) {
  editingClass = c;
  const f = $('#classForm');
  f.name.value = c?.name || '';
  f.start.value = c?.start || '';
  f.end.value = c?.end || '';
  f.room.value = c?.room || '';
  classTimes.close();
  classTimes.refresh();
  pickedDays = new Set(c ? [c.weekday] : []);
  const usedColors = new Set(Object.values(state.classes).filter(x => !x.deleted).map(x => x.color));
  pickedClassColor = c?.color || COLORS.find(x => !usedColors.has(x)) || COLORS[0];
  renderClassPickers();
  $('#classWarn').hidden = true;
  $('#classDelete').hidden = !c;
  $('#classFormTitle').textContent = c ? '編輯課程' : '新增課程';
  $('#classDialog').showModal();
}
function renderClassPickers() {
  // 學生習慣週一開始
  $('#weekdayPick').innerHTML = [1, 2, 3, 4, 5, 6, 0].map(w =>
    `<button type="button" data-weekday="${w}" class="${pickedDays.has(w) ? 'selected' : ''}">${WEEK[w]}</button>`).join('');
  $('#classSwatches').innerHTML = COLORS.map(c =>
    `<button type="button" data-color="${c}" class="${c === pickedClassColor ? 'selected' : ''}" style="background:${c}" aria-label="顏色 ${c}"></button>`).join('');
}
function saveClass(e) {
  e.preventDefault();
  const f = $('#classForm');
  const warn = $('#classWarn');
  const name = f.name.value.trim();
  if (!name) return;
  if (!f.start.value || !f.end.value) { warn.hidden = false; warn.textContent = '先選好上下課時間 ⏰'; return; }
  if (!pickedDays.size) { warn.hidden = false; warn.textContent = '請選擇星期幾上課 📅'; return; }
  if (toMin(f.end.value) <= toMin(f.start.value)) { warn.hidden = false; warn.textContent = '下課時間要比上課時間晚喔 ⏰'; return; }
  const base = { name, start: f.start.value, end: f.end.value, room: f.room.value.trim(), color: pickedClassColor };
  const days = [...pickedDays];
  const now = Date.now();
  if (editingClass) {
    state.classes[editingClass.id] = { ...editingClass, ...base, weekday: days.shift(), updatedAt: now };
  }
  for (const weekday of days) {
    const id = newId();
    state.classes[id] = { id, ...base, weekday, updatedAt: now };
  }
  commit();
  $('#classDialog').close();
  toast(editingClass ? '課程更新好了 📖' : `加入 ${pickedDays.size} 堂課 📖`);
}

function openSemester() {
  const sem = state.settings.semester;
  $('#semesterForm').start.value = sem?.start || '';
  $('#semesterForm').end.value = sem?.end || '';
  $('#semesterDialog').showModal();
}
function saveSemester(e) {
  e.preventDefault();
  const f = $('#semesterForm');
  if (f.start.value && f.end.value && f.end.value < f.start.value) { toast('結束日要在開始日之後喔 🤔'); return; }
  state.settings.semester = { id: 'semester', start: f.start.value, end: f.end.value, updatedAt: Date.now() };
  commit();
  $('#semesterDialog').close();
  toast(f.start.value || f.end.value ? '學期日期設定好了 🎓' : '已清除學期日期');
}

// ---------- 分享 ----------
async function shareApp() {
  const url = location.origin + location.pathname;
  if (navigator.share) {
    try { await navigator.share({ title: '兼職排班', text: '我在用這個排打工和課表，超可愛 🫧', url }); } catch { /* 使用者取消 */ }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('網址複製好了，貼給朋友吧 💌');
  } catch {
    prompt('複製這個網址傳給朋友：', url);
  }
}

// ============================================================
// 登入與雲端存檔（Firebase）。firebase-config.js 是 null 時整段不啟用。
// 每個人的資料存在 Firestore 的 users/{uid} 這一份文件；手機裡的資料仍是主要來源，
// 有網路時自動和雲端合併，所以離線也能照常使用。
// ============================================================
const UID_KEY = 'workplan.uid';
const AUTH_ERRORS = {
  'auth/invalid-email': 'Email 格式不對耶',
  'auth/missing-password': '請輸入密碼',
  'auth/weak-password': '密碼至少要 6 個字',
  'auth/email-already-in-use': '這個 Email 已經註冊過了，直接按「登入」就好',
  'auth/invalid-credential': 'Email 或密碼不對',
  'auth/wrong-password': 'Email 或密碼不對',
  'auth/user-not-found': '找不到這個帳號，要不要先註冊？',
  'auth/too-many-requests': '試太多次了，等一下再試',
  'auth/network-request-failed': '網路好像斷了，連上再試',
  'auth/operation-not-allowed': '這種登入方式還沒在 Firebase 開啟',
  'auth/unauthorized-domain': '這個網址還沒加到 Firebase 的授權網域',
};
const authMessage = err => AUTH_ERRORS[err.code] || `登入失敗（${err.code || err.message}）`;

const cloud = {
  enabled: !!firebaseConfig,
  api: null,
  user: null,
  remote: null,
  status: 'idle', // idle | syncing | synced | offline | error
  timer: null,
  pending: null,
  loadError: false,

  async init() {
    $('#accountCard').hidden = !this.enabled;
    if (!this.enabled) return;
    const v = '10.12.2';
    try {
      const [app, auth, fs] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${v}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${v}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore.js`),
      ]);
      const fbApp = app.initializeApp(firebaseConfig);
      const a = auth.getAuth(fbApp);
      a.languageCode = 'zh-TW';
      this.api = { auth, fs, a, db: fs.getFirestore(fbApp), unsub: null };
      auth.getRedirectResult(a).catch(err => toast(authMessage(err)));
      auth.onAuthStateChanged(a, user => this.onUser(user));
    } catch (err) {
      console.error(err);
      this.loadError = true; // 沒網路時載不到登入元件，網站照樣用手機裡的資料
    }
    this.renderPanel();
  },

  onUser(user) {
    if (this.api.unsub) { this.api.unsub(); this.api.unsub = null; }
    this.user = user;
    this.remote = null;
    if (!user) { this.setStatus('idle'); return; }

    const last = localStorage.getItem(UID_KEY);
    if (last && last !== user.uid) {
      // 換了另一個帳號：不要把上一個人的資料混進來
      state = emptyState();
      saveLocal();
      render();
    } else if (!last && hasData(state) && !confirm('這台裝置上已經有資料，要一起存到這個帳號嗎？\n（按「取消」會改用帳號裡原本的資料）')) {
      state = emptyState();
      saveLocal();
      render();
    }
    localStorage.setItem(UID_KEY, user.uid);

    this.setStatus('syncing');
    const { fs, db } = this.api;
    this.api.unsub = fs.onSnapshot(fs.doc(db, 'users', user.uid), snap => {
      const data = snap.exists() ? snap.data() : {};
      this.remote = Object.fromEntries(KINDS.map(k => [k, data[k] || {}]));
      if (mergeInto(state, this.remote)) { saveLocal(); render(); }
      if (hasNewerThan(state, this.remote)) this.push(0);
      else if (!snap.metadata.hasPendingWrites) this.setStatus('synced');
    }, err => {
      console.error(err);
      this.setStatus('error');
    });
  },

  // 本機有改動就上傳整份資料（稍微等一下，連續修改只傳一次）
  push(delay = 800) {
    if (!this.user || !this.remote) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), delay);
  },

  async flush() {
    clearTimeout(this.timer);
    if (!this.user) return;
    const { fs, db } = this.api;
    this.setStatus(navigator.onLine ? 'syncing' : 'offline');
    const data = JSON.parse(JSON.stringify(state)); // 去掉 undefined，Firestore 不接受
    this.pending = fs.setDoc(fs.doc(db, 'users', this.user.uid), { ...data, savedAt: Date.now() });
    try {
      await this.pending;
      this.setStatus('synced');
    } catch (err) {
      console.error(err);
      this.setStatus('error');
    } finally {
      this.pending = null;
    }
  },

  async loginGoogle() {
    const { auth, a } = this.api;
    const provider = new auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(a, provider);
    } catch (err) {
      if (err.code === 'auth/popup-blocked' || err.code === 'auth/operation-not-supported-in-this-environment') {
        await auth.signInWithRedirect(a, provider);
      } else if (err.code !== 'auth/popup-closed-by-user' && err.code !== 'auth/cancelled-popup-request') {
        console.error(err);
        // iPhone 主畫面 App 偶爾開不了 Google 視窗，提示改用 Email
        toast(authMessage(err) + '，可以改用 Email 登入');
      }
    }
  },

  async loginEmail(action) {
    const f = $('#emailForm');
    const email = f.email.value.trim();
    const password = f.password.value;
    const { auth, a } = this.api;
    const msg = $('#emailMsg');
    msg.hidden = true;
    try {
      if (action === 'reset') {
        if (!email) { msg.hidden = false; msg.textContent = '先填 Email，再按「忘記密碼」'; return; }
        await auth.sendPasswordResetEmail(a, email);
        msg.hidden = false;
        msg.textContent = `重設密碼的信寄到 ${email} 了，記得也看一下垃圾信件匣 📮`;
        return;
      }
      if (action === 'signup') await auth.createUserWithEmailAndPassword(a, email, password);
      else await auth.signInWithEmailAndPassword(a, email, password);
    } catch (err) {
      msg.hidden = false;
      msg.textContent = authMessage(err);
    }
  },

  async logout() {
    const wipe = confirm('要順便清掉這台裝置上的資料嗎？\n資料都已經存在雲端，再登入就會回來。\n（不是自己的手機建議按「確定」）');
    if (this.pending || this.timer) await this.flush();
    await this.api.auth.signOut(this.api.a);
    if (wipe) {
      state = emptyState();
      saveLocal();
      localStorage.removeItem(UID_KEY);
      render();
    }
    toast('已登出 👋');
  },

  setStatus(status) {
    this.status = status;
    if (view === 'settings') this.renderPanel();
  },

  renderPanel() {
    const p = $('#accountPanel');
    if (!this.enabled || !p) return;
    if (this.loadError) {
      p.innerHTML = '<p class="muted">連不上登入服務，資料先存在這台裝置。有網路時重新打開就好 📡</p>';
      return;
    }
    if (!this.api) { p.innerHTML = '<p class="muted">載入中…</p>'; return; }
    if (this.user) {
      const label = {
        idle: '', syncing: '☁️ 同步中…', synced: '✅ 已存到雲端', offline: '📡 沒有網路，連上後會自動上傳',
        error: '⚠️ 同步失敗，稍後會再試',
      }[this.status];
      p.innerHTML = `<p class="muted">已登入 <b>${esc(this.user.email || this.user.displayName || '')}</b><br>${label}</p>
        <p class="muted">換手機或在電腦上，用同一個帳號登入就能看到同一份資料。</p>
        <button class="btn" id="logoutBtn">登出</button>`;
      return;
    }
    p.innerHTML = `<p class="muted">登入後資料會存到雲端：換手機、刪掉 App 都不怕不見，手機和電腦也能看到同一份。不登入也可以照常使用。</p>
      <button class="btn primary block" id="googleBtn">用 Google 帳號登入</button>
      <div class="or">或用 Email</div>
      <form id="emailForm" class="email-form" novalidate>
        <input type="email" name="email" placeholder="Email" autocomplete="email" inputmode="email">
        <input type="password" name="password" placeholder="密碼（至少 6 個字）" autocomplete="current-password">
        <p class="warn" id="emailMsg" hidden></p>
        <div class="row">
          <button type="submit" class="btn primary" data-act="login">登入</button>
          <button type="button" class="btn" data-act="signup">註冊新帳號</button>
          <button type="button" class="link-btn" data-act="reset">忘記密碼</button>
        </div>
      </form>`;
  },
};

// ---------- 時間滾輪（像鬧鐘一樣轉，24 小時制） ----------
// 每個 .time-field 裡有一個 hidden input 存 "HH:MM"，表單其他程式照常讀寫它；改完值後呼叫 refresh() 更新顯示
// 滾輪會循環（23 之後接 00）：數字重複排 WHEEL_LOOPS 輪，停下來時悄悄跳回中間那一輪，所以怎麼轉都轉不到底
const WHEEL_ITEM = 40;
const WHEEL_LOOPS = 9;
const WHEEL_MID = Math.floor(WHEEL_LOOPS / 2);
function setupTimeWheels(form) {
  const panel = form.querySelector('.wheel-panel');
  const wheels = [panel.querySelector('[data-unit=h]'), panel.querySelector('[data-unit=m]')];
  const sizes = new Map([[wheels[0], 24], [wheels[1], 60]]);
  for (const [wheel, n] of sizes) {
    wheel.innerHTML = Array.from({ length: n * WHEEL_LOOPS }, (_, i) => `<div class="wheel-item">${pad(i % n)}</div>`).join('');
  }
  const fields = [...form.querySelectorAll('.time-field')];
  const inputOf = field => field.querySelector('input');
  const selected = new Map();
  let target = null;
  let settleTimer;

  const indexOf = wheel => Math.max(0, Math.min(wheel.children.length - 1, Math.round(wheel.scrollTop / WHEEL_ITEM)));
  const valueOf = wheel => indexOf(wheel) % sizes.get(wheel);
  function highlight(wheel) {
    const el = wheel.children[indexOf(wheel)];
    if (selected.get(wheel) === el) return;
    selected.get(wheel)?.classList.remove('sel');
    el.classList.add('sel');
    selected.set(wheel, el);
  }
  function scrollToIndex(wheel, i, smooth) {
    wheel.scrollTo({ top: i * WHEEL_ITEM, behavior: smooth ? 'smooth' : 'auto' });
    highlight(wheel);
  }
  const showValue = (wheel, v) => scrollToIndex(wheel, WHEEL_MID * sizes.get(wheel) + v, false);
  function recenter(wheel) {
    if (Math.floor(indexOf(wheel) / sizes.get(wheel)) !== WHEEL_MID) showValue(wheel, valueOf(wheel));
  }
  function refresh() {
    for (const field of fields) {
      const v = inputOf(field).value;
      field.querySelector('.time-btn').textContent = v || '選擇時間';
      field.classList.toggle('is-empty', !v);
    }
    // 班可以跨夜：下班時間比上班早時，在下班時間前標「隔天」
    if ('overnight' in form.dataset) {
      const start = form.elements.start.value;
      const end = form.elements.end.value;
      form.querySelector('.time-field[data-time=end]').classList.toggle('next-day', !!start && !!end && toMin(end) < toMin(start));
    }
  }
  function changed() {
    refresh();
    form.dispatchEvent(new Event('input', { bubbles: true }));
  }
  // 第一次打開時給個合理的預設：上班 09:00，下班 = 開始後 4 小時（課是 50 分鐘）
  function defaultFor(field) {
    if (field.dataset.time !== 'end') return '09:00';
    const start = form.elements.start.value;
    return start ? fromMin(toMin(start) + (form.id === 'classForm' ? 50 : 240)) : '17:00';
  }
  function open(field) {
    target = field;
    fields.forEach(f => f.classList.toggle('active', f === field));
    panel.hidden = false;
    const input = inputOf(field);
    if (!input.value) { input.value = defaultFor(field); changed(); }
    const [h, m] = input.value.split(':').map(Number);
    showValue(wheels[0], h);
    showValue(wheels[1], m);
    panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  function close() {
    target = null;
    panel.hidden = true;
    fields.forEach(f => f.classList.remove('active'));
  }
  // 滾動停下來後才寫入，滑動中只更新中間那一格的樣式
  function settle() {
    wheels.forEach(recenter);
    if (!target) return;
    const value = `${pad(valueOf(wheels[0]))}:${pad(valueOf(wheels[1]))}`;
    const input = inputOf(target);
    if (input.value !== value) { input.value = value; changed(); }
  }

  for (const wheel of wheels) {
    wheel.addEventListener('scroll', () => {
      highlight(wheel);
      clearTimeout(settleTimer);
      settleTimer = setTimeout(settle, 120);
    }, { passive: true });
    wheel.addEventListener('click', e => {
      const item = e.target.closest('.wheel-item');
      if (item) scrollToIndex(wheel, [...wheel.children].indexOf(item), true);
    });
  }
  for (const field of fields) {
    field.querySelector('.time-btn').addEventListener('click', () => (target === field ? close() : open(field)));
  }
  panel.querySelector('.wheel-done').addEventListener('click', () => { settle(); close(); });
  return { refresh, close };
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

// ---------- 事件 ----------
function step(n) {
  if (view === 'timetable') weekCursor = addDays(weekCursor, 7 * n);
  else cursor = new Date(cursor.getFullYear(), cursor.getMonth() + n, 1);
  render();
}
$('#prevMonth').onclick = () => step(-1);
$('#nextMonth').onclick = () => step(1);
$('#monthTitle').onclick = () => { cursor = startOfMonth(new Date()); weekCursor = mondayOf(new Date()); render(); };
$$('.tabbar button').forEach(b => b.onclick = () => { view = b.dataset.view; render(); window.scrollTo(0, 0); });
$('#fab').onclick = () => {
  if (view === 'timetable') { openClassForm(null); return; }
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
  const cls = e.target.closest('[data-class]');
  if (cls) {
    if ($('#dayDialog').open) $('#dayDialog').close();
    openClassForm(state.classes[cls.dataset.class]);
    return;
  }
  const job = e.target.closest('[data-job]');
  if (job) { openJobForm(state.jobs[job.dataset.job]); return; }
  if (e.target.closest('[data-close]')) e.target.closest('dialog').close();
});
// 點對話框外面的背景就關閉
$$('dialog').forEach(d => d.addEventListener('click', e => { if (e.target === d) d.close(); }));

$('#dayAdd').onclick = () => { $('#dayDialog').close(); openShiftForm(null, openDay); };

const shiftTimes = setupTimeWheels($('#shiftForm'));
const classTimes = setupTimeWheels($('#classForm'));

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

$('#timetable').addEventListener('click', e => {
  const col = e.target.closest('[data-tt-date]');
  if (!col || e.target.closest('.tt-item')) return;
  const h0 = Number(col.parentElement.dataset.h0);
  const y = e.clientY - col.getBoundingClientRect().top;
  addShiftAt(col.dataset.ttDate, (h0 + Math.floor(y / HOUR_PX)) * 60);
});
$('#addClassBtn').onclick = () => openClassForm(null);
$('#semesterBtn').onclick = openSemester;
$('#classForm').addEventListener('submit', saveClass);
$('#classForm').addEventListener('input', () => { $('#classWarn').hidden = true; });
$('#weekdayPick').onclick = e => {
  const w = e.target.dataset.weekday;
  if (w === undefined) return;
  const n = Number(w);
  if (pickedDays.has(n)) pickedDays.delete(n); else pickedDays.add(n);
  $('#classWarn').hidden = true;
  renderClassPickers();
};
$('#classSwatches').onclick = e => {
  const c = e.target.dataset.color;
  if (c) { pickedClassColor = c; renderClassPickers(); }
};
$('#classDelete').onclick = () => {
  if (!editingClass || !confirm(`確定刪除「${editingClass.name}」星期${WEEK[editingClass.weekday]}這堂課？`)) return;
  remove('classes', editingClass.id);
  $('#classDialog').close();
  toast('刪掉了 🗑️');
};
$('#semesterForm').addEventListener('submit', saveSemester);
$('#semesterClear').onclick = () => {
  $('#semesterForm').start.value = '';
  $('#semesterForm').end.value = '';
};
$('#shareBtn').onclick = shareApp;
$('#accountPanel').addEventListener('click', e => {
  if (e.target.id === 'googleBtn') cloud.loginGoogle();
  if (e.target.id === 'logoutBtn') cloud.logout();
  const act = e.target.dataset.act;
  if (act && act !== 'login') cloud.loginEmail(act);
});
$('#accountPanel').addEventListener('submit', e => {
  e.preventDefault();
  cloud.loginEmail('login');
});
window.addEventListener('online', () => cloud.push(0));

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
cloud.init();
