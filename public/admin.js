// Usage page. Reads the read-only API in lib/admin.js and draws it.
//
// The server's CSP allows no inline script and no inline style, so everything
// here is built with DOM calls, SVG attributes and classes from admin.css.
// All text from the server (names, user agents) goes in through textContent.

// ---------- pure helpers (also exercised by test/admin.test.js) ----------

const pad2 = (n) => String(n).padStart(2, '0');

// 'YYYY-MM-DD' in the browser's timezone.
function dateKey(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function parseDateKey(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ''));
  if (!m) return null;
  const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return dateKey(date) === key ? date : null; // rejects 2026-02-31
}

// Local midnight to the next local midnight. Built from calendar fields, so a
// day with a clock change is 23 or 25 hours long, as it really was.
function dayRange(key) {
  const start = parseDateKey(key);
  if (!start) return null;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1);
  return { from: start.getTime(), to: end.getTime() };
}

function shiftDay(key, days) {
  const d = parseDateKey(key);
  return dateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + days));
}

function fmtDuration(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const fmtMinutes = (ms) => ((ms || 0) / 60000).toFixed(1);

function fmtTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// The hour of the day (local) with the most talk time, or null on a silent day.
function busiestHour(transmissions) {
  const perHour = new Array(24).fill(0);
  for (const t of transmissions) perHour[new Date(t.started_at).getHours()] += t.held_ms || 0;
  let best = -1;
  for (let h = 0; h < 24; h++) if (perHour[h] > 0 && (best < 0 || perHour[h] > perHour[best])) best = h;
  return best < 0 ? null : { hour: best, talk_ms: perHour[best] };
}

// One entry per local day from `firstKey`, `count` days long.
function dailyTotals(transmissions, firstKey, count) {
  const days = [];
  const byKey = new Map();
  for (let i = 0; i < count; i++) {
    const day = { key: shiftDay(firstKey, i), talk_ms: 0, transmissions: 0 };
    days.push(day);
    byKey.set(day.key, day);
  }
  for (const t of transmissions) {
    const day = byKey.get(dateKey(new Date(t.started_at)));
    if (!day) continue;
    day.talk_ms += t.held_ms || 0;
    day.transmissions += 1;
  }
  return days;
}

// A round number at or above `value`, for the top of the chart's scale.
function niceMax(value) {
  if (!(value > 0)) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) if (step * pow >= value) return step * pow;
  return 10 * pow;
}

const END_REASONS = {
  'ptt-stop': 'Released',
  disconnect: 'Connection lost',
  timeout: 'Time limit',
  preempted: 'Interrupted',
  'server-restart': 'Server restart',
};
const LEAVE_REASONS = {
  closed: 'Closed',
  'dead-connection': 'Dropped',
  'server-restart': 'Server restart',
  flood: 'Flood',
  'relay-flood': 'Flood',
  'socket-error': 'Socket error',
};

// ---------- page ----------

const $ = (id) => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const TOKEN_KEY = 'walkie-admin-token';
const DAILY_DAYS = 30;

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.text !== undefined) node.textContent = String(props.text);
  for (const [k, v] of Object.entries(props.attrs || {})) node.setAttribute(k, String(v));
  for (const child of children) node.append(child);
  return node;
}

function svg(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
let selectedDay = dateKey(new Date());
let loading = false;
let lastRange = null;

function showMessage(text) {
  $('message').textContent = text || '';
  $('message').classList.toggle('hidden', !text);
}

// Resolves with the response, or null after showing why there is none.
async function api(path) {
  let res;
  const sent = token; // two requests run side by side: judge each by what it carried
  try {
    res = await fetch(path, { headers: sent ? { Authorization: `Bearer ${sent}` } : {}, cache: 'no-store' });
  } catch {
    showMessage('The server cannot be reached.');
    return null;
  }
  if (res.status === 401) {
    if (sent && token === sent) {
      token = null;
      try { sessionStorage.removeItem(TOKEN_KEY); } catch {}
    }
    $('token-form').classList.remove('hidden');
    $('content').classList.add('hidden');
    if (sent) showMessage('That token was not accepted.');
    return null;
  }
  $('token-form').classList.add('hidden');
  if (res.status === 503) {
    showMessage('The usage database is off on this server (STATS=off, or it could not be opened).');
    $('content').classList.add('hidden');
    return null;
  }
  if (res.status === 403) {
    showMessage('The admin page is disabled: ADMIN_TOKEN on the server is too short or a placeholder.');
    $('content').classList.add('hidden');
    return null;
  }
  if (!res.ok) {
    showMessage(`The server answered with an error (${res.status}).`);
    return null;
  }
  return res;
}

function table(target, columns, rows, emptyText) {
  clear(target);
  const head = el('tr');
  for (const c of columns) head.append(el('th', { text: c.title, class: c.num ? 'num' : '', attrs: { scope: 'col' } }));
  target.append(el('thead', {}, [head]));
  const body = el('tbody');
  if (!rows.length) {
    body.append(el('tr', {}, [el('td', { text: emptyText, class: 'empty', attrs: { colspan: columns.length } })]));
  }
  for (const row of rows) {
    const tr = el('tr');
    for (const c of columns) {
      const value = c.value(row);
      const td = el('td', { class: [c.num ? 'num' : '', c.wrap ? 'wrap' : ''].join(' ').trim() });
      if (value instanceof Node) td.append(value);
      else td.textContent = value === null || value === undefined ? '' : String(value);
      tr.append(td);
    }
    body.append(tr);
  }
  target.append(body);
}

const tag = (text, warn) => el('span', { text, class: warn ? 'tag warn' : 'tag' });

function renderTiles(data) {
  const t = data.totals;
  const busy = busiestHour(data.transmissions);
  const tiles = [
    ['Minutes talked', fmtMinutes(t.talk_ms), fmtDuration(t.talk_ms)],
    ['Transmissions', t.transmissions, `${data.conversations.length} conversation${data.conversations.length === 1 ? '' : 's'}`],
    ['Longest', t.longest ? fmtDuration(t.longest.held_ms) : 'None', t.longest ? `${t.longest.name || '?'} at ${fmtTime(t.longest.started_at)}` : ''],
    ['Busiest hour', busy ? `${pad2(busy.hour)}:00` : 'None', busy ? `${fmtDuration(busy.talk_ms)} of talk` : ''],
    ['Connections', t.sessions, `${t.drops} dropped`],
    ['Radio unheard', t.unheard_gateway, t.unheard_gateway ? fmtDuration(t.unheard_gateway_ms) : 'every call had a listener'],
  ];
  const target = $('tiles');
  clear(target);
  for (const [title, value, sub] of tiles) {
    const dd = el('dd', { text: value });
    if (sub) dd.append(el('span', { text: sub, class: 'sub' }));
    target.append(el('div', { class: 'tile' }, [el('dt', { text: title }), dd]));
  }
}

// A bar that can be pointed at, focused and (optionally) activated: an
// invisible, larger hit area in front of the visible mark.
function hitArea(attrs, label, readout, onActivate) {
  const hit = svg('rect', { ...attrs, class: 'hit', tabindex: 0, role: onActivate ? 'button' : 'img', 'aria-label': label });
  hit.append(svg('title', {}, label));
  const say = () => { readout.textContent = label; };
  hit.addEventListener('pointerenter', say);
  hit.addEventListener('focus', say);
  if (onActivate) {
    hit.addEventListener('click', onActivate);
    hit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    });
  }
  return hit;
}

function renderDaily(days) {
  const chart = $('daily-chart');
  clear(chart);
  const W = 720, H = 190, left = 34, right = 8, top = 10, bottom = 26;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const max = niceMax(Math.max(...days.map((d) => d.talk_ms / 60000)));
  for (const frac of [0, 0.5, 1]) {
    const y = top + plotH * (1 - frac);
    chart.append(svg('line', { x1: left, x2: W - right, y1: y, y2: y, class: frac ? 'grid' : 'axis' }));
    chart.append(svg('text', { x: left - 6, y: y + 4, 'text-anchor': 'end' }, +(max * frac).toFixed(1)));
  }
  const slot = plotW / days.length;
  const barW = Math.max(2, slot - 4);
  const readout = $('daily-readout');
  days.forEach((day, i) => {
    const minutes = day.talk_ms / 60000;
    const x = left + i * slot + (slot - barW) / 2;
    const h = minutes > 0 ? Math.max(2, (minutes / max) * plotH) : 2;
    const date = parseDateKey(day.key);
    const label = `${date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}: ${fmtMinutes(day.talk_ms)} min in ${day.transmissions} transmission${day.transmissions === 1 ? '' : 's'}`;
    chart.append(hitArea({ x: left + i * slot, y: top, width: slot, height: plotH + bottom }, label, readout, () => selectDay(day.key)));
    const classes = ['bar', minutes > 0 ? '' : 'empty', day.key === selectedDay ? 'selected' : ''].join(' ').trim();
    chart.append(svg('rect', { x, y: top + plotH - h, width: barW, height: h, rx: Math.min(3, barW / 2), class: classes }));
    if (i % 5 === 0 || i === days.length - 1) {
      chart.append(svg('text', { x: x + barW / 2, y: H - 8, 'text-anchor': 'middle' }, `${date.getDate()}/${date.getMonth() + 1}`));
    }
  });
}

function renderTimeline(data) {
  const chart = $('timeline');
  clear(chart);
  const readout = $('timeline-readout');
  const { from, to } = data;
  const end = Math.min(to, data.now);

  // One row per device, in order of first appearance.
  const rows = new Map();
  for (const s of data.sessions) {
    if (!s.joined_at) continue;
    const key = s.device_id || `name:${s.name}`;
    if (!rows.has(key)) rows.set(key, { name: s.name, sessions: [], talks: [] });
    const row = rows.get(key);
    row.name = s.name || row.name;
    row.sessions.push(s);
  }
  for (const t of data.transmissions) {
    const row = rows.get(t.device_id || `name:${t.name}`);
    if (row) row.talks.push(t);
  }

  const W = 720, labelW = 132, right = 10, top = 20, rowH = 24, bottom = 6;
  const plotW = W - labelW - right;
  const list = [...rows.values()];
  const H = top + Math.max(1, list.length) * rowH + bottom;
  chart.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const xOf = (ms) => labelW + ((Math.min(Math.max(ms, from), to) - from) / (to - from)) * plotW;

  for (let hour = 0; hour <= 24; hour += 3) {
    const x = labelW + (hour / 24) * plotW;
    chart.append(svg('line', { x1: x, x2: x, y1: top - 4, y2: H - bottom, class: 'grid' }));
    chart.append(svg('text', { x, y: 11, 'text-anchor': hour === 24 ? 'end' : hour === 0 ? 'start' : 'middle' }, `${pad2(hour)}:00`));
  }
  if (!list.length) {
    chart.append(svg('text', { x: labelW, y: top + 16 }, 'Nobody connected on this day.'));
    return;
  }
  list.forEach((row, i) => {
    const y = top + i * rowH;
    const name = String(row.name || '?');
    chart.append(svg('text', { x: 4, y: y + 16, class: 'row-label' }, name.length > 17 ? `${name.slice(0, 16)}…` : name));
    for (const s of row.sessions) {
      const stillOn = s.left_at === null;
      const x1 = xOf(s.connected_at);
      const x2 = xOf(stillOn ? end : s.left_at);
      const width = Math.max(2, x2 - x1);
      const dropped = s.leave_reason === 'dead-connection';
      const how = stillOn ? 'still connected' : `ended ${fmtTime(s.left_at)} (${LEAVE_REASONS[s.leave_reason] || s.leave_reason || 'closed'})`;
      const label = `${name}: connected ${fmtTime(s.connected_at)}, ${how}, ${fmtDuration((stillOn ? data.now : s.left_at) - s.connected_at)}`;
      chart.append(hitArea({ x: x1 - 2, y: y + 2, width: width + 4, height: rowH - 4 }, label, readout));
      chart.append(svg('rect', { x: x1, y: y + 7, width, height: 10, rx: 3, class: dropped ? 'session drop' : 'session' }));
      // A drop is marked by shape as well as colour: a tall cap where it ended.
      if (dropped) chart.append(svg('rect', { x: x1 + width - 1, y: y + 3, width: 3, height: 18, rx: 1, class: 'drop-cap' }));
    }
    for (const t of row.talks) {
      const x1 = xOf(t.started_at);
      const width = Math.max(1.5, xOf(t.started_at + (t.held_ms || 0)) - x1);
      chart.append(svg('rect', { x: x1, y: y + 10, width, height: 4, class: 'talk' }));
    }
  });
  if (data.now > from && data.now < to) {
    const x = xOf(data.now);
    chart.append(svg('line', { x1: x, x2: x, y1: top - 4, y2: H - bottom, class: 'now' }));
  }
}

function renderTables(data) {
  const unheard = data.transmissions.filter((t) => t.role === 'gateway' && t.listeners_audible === 0);
  $('unheard-summary').textContent = unheard.length
    ? `${unheard.length} call${unheard.length === 1 ? '' : 's'}, ${fmtDuration(data.totals.unheard_gateway_ms)} in all. Nobody had the app on screen (or playing in the background) when these started.`
    : '';
  table($('unheard-table'), [
    { title: 'Start', value: (t) => fmtTime(t.started_at) },
    { title: 'From', value: (t) => t.name },
    { title: 'Length', num: true, value: (t) => fmtDuration(t.held_ms) },
    { title: 'Connected but not listening', num: true, value: (t) => t.listeners },
  ], unheard, 'None. Every radio call had someone listening.');

  $('conversations-summary').textContent = `Transmissions less than ${data.conversation_gap_s} s apart count as one conversation.`;
  table($('conversations-table'), [
    { title: 'Start', value: (c) => fmtTime(c.started_at) },
    { title: 'Length', num: true, value: (c) => fmtDuration(c.length_ms) },
    { title: 'Turns', num: true, value: (c) => c.turns },
    { title: 'Talk time', num: true, value: (c) => fmtDuration(c.talk_ms) },
    { title: 'Who', wrap: true, value: (c) => c.participants.map((p) => `${p.name || '?'} (${p.turns}, ${fmtDuration(p.talk_ms)})`).join(', ') },
  ], data.conversations, 'Nobody talked on this day.');

  table($('devices-table'), [
    { title: 'Name', value: (d) => d.name || '?' },
    { title: 'Kind', value: (d) => d.kind || d.role || '' },
    { title: 'Minutes talked', num: true, value: (d) => fmtMinutes(d.talk_ms) },
    { title: 'Times', num: true, value: (d) => d.transmissions },
    { title: 'Connected', num: true, value: (d) => fmtDuration(d.connected_ms) },
    { title: 'Connections', num: true, value: (d) => d.sessions },
    { title: 'Dropped', num: true, value: (d) => (d.drops ? tag(String(d.drops), true) : '0') },
  ], data.devices, 'No devices on this day.');

  table($('talk-table'), [
    { title: 'Start', value: (t) => fmtTime(t.started_at) },
    { title: 'Who', value: (t) => `${t.priority ? '⭐ ' : ''}${t.name || '?'}` },
    { title: 'Length', num: true, value: (t) => fmtDuration(t.held_ms) },
    { title: 'Ended', value: (t) => (t.live ? tag('talking now') : END_REASONS[t.end_reason] || t.end_reason || '') },
    { title: 'Could hear it', num: true, value: (t) => (t.listeners_audible === 0 ? tag('nobody', true) : `${t.listeners_audible} of ${t.listeners}`) },
  ], data.transmissions, 'Nobody talked on this day.');
}

async function load() {
  if (loading) return;
  const day = dayRange(selectedDay);
  if (!day) return;
  loading = true;
  $('refresh').disabled = true;
  try {
    $('day').value = selectedDay;
    const todayKey = dateKey(new Date());
    $('next-day').disabled = selectedDay >= todayKey;

    // The chart always shows the 30 days ending today.
    const firstKey = shiftDay(todayKey, -(DAILY_DAYS - 1));
    const chartFrom = dayRange(firstKey).from;
    const chartTo = dayRange(todayKey).to;
    const [dayRes, chartRes] = await Promise.all([
      api(`api/admin/range?from=${day.from}&to=${day.to}`),
      api(`api/admin/range?from=${chartFrom}&to=${chartTo}`),
    ]);
    if (!dayRes || !chartRes) return;
    const data = await dayRes.json();
    const month = await chartRes.json();
    lastRange = day;

    showMessage(data.truncated || month.truncated ? 'There is more data than this page loads at once; totals are incomplete. Use the CSV export.' : '');
    $('content').classList.remove('hidden');
    $('day-label').textContent = parseDateKey(selectedDay).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    renderTiles(data);
    renderDaily(dailyTotals(month.transmissions, firstKey, DAILY_DAYS));
    renderTimeline(data);
    renderTables(data);
    $('updated').textContent = `Updated ${fmtTime(data.now)}`;
  } finally {
    loading = false;
    $('refresh').disabled = false;
  }
}

function selectDay(key) {
  if (!parseDateKey(key)) return;
  const todayKey = dateKey(new Date());
  selectedDay = key > todayKey ? todayKey : key;
  load();
}

// A link cannot carry the token, so the file is fetched and handed over as a blob.
async function exportCsv(tableName) {
  if (!lastRange) return;
  const res = await api(`api/admin/export.csv?table=${tableName}&from=${lastRange.from}&to=${lastRange.to}`);
  if (!res) return;
  const url = URL.createObjectURL(await res.blob());
  const link = el('a', { attrs: { href: url, download: `walkie-${tableName}-${selectedDay}.csv` } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

$('prev-day').addEventListener('click', () => selectDay(shiftDay(selectedDay, -1)));
$('next-day').addEventListener('click', () => selectDay(shiftDay(selectedDay, 1)));
$('today').addEventListener('click', () => selectDay(dateKey(new Date())));
$('refresh').addEventListener('click', load);
$('day').addEventListener('change', () => selectDay($('day').value));
$('export-transmissions').addEventListener('click', () => exportCsv('transmissions'));
$('export-sessions').addEventListener('click', () => exportCsv('sessions'));
$('token-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = String($('token-input').value || '').trim();
  if (!value) return;
  token = value;
  // sessionStorage: gone when the tab closes, never in the URL.
  try { sessionStorage.setItem(TOKEN_KEY, token); } catch {}
  $('token-input').value = '';
  load();
});

load();
