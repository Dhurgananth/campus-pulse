/* ==========================================================================
   CAMPUS PULSE — dashboard + survey form
   Vanilla JS + Chart.js. Data comes from the CSV-backed server; the page
   updates live through Server-Sent Events.
   ========================================================================== */
(() => {
'use strict';

/* ---------- tiny helpers ------------------------------------------------- */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad2 = n => String(n).padStart(2, '0');
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const FB = '"Manrope", system-ui, sans-serif';
const FM = '"JetBrains Mono", ui-monospace, monospace';
const rem = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  kids.flat().forEach(c => el.append(c && c.nodeType ? c : document.createTextNode(c ?? '')));
  return el;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'k' + Math.random().toString(36).slice(2) + Date.now().toString(36));   // randomUUID needs https; LAN http falls back

/* ---------- state -------------------------------------------------------- */
const S = {
  schema: null, F: {}, rows: [], filters: {}, demo: true, counts: { live: 0, demo: 0 },
  version: null, panels: [], live: false, updatedAt: null,
};

const LAYOUT = [                                 // one chart family per question
  { key: 'state', type: 'map', span: 2 },          // choropleth map of India
  { key: 'social_hours', type: 'hist' },           // histogram + cumulative curve
  { key: 'social_platform', type: 'bubble' },      // bubble pack
  { key: 'sleep', type: 'violin' },                // violin + box plot
  { key: 'ai_platform', type: 'radar' },           // radar
  { key: 'activity', type: 'rose' },               // Nightingale rose
  { key: 'food', type: 'waffle' },                 // waffle
  { key: 'entertainment', type: 'lollipop' },      // lollipop
  { key: 'transport', type: 'pareto' },            // Pareto
  { key: 'career', type: 'treemap' },              // treemap
  { key: 'heat', type: 'heat' },                   // correlation heatmap
];

/* ---------- data helpers ------------------------------------------------- */
function filteredRows(excl = []) {
  const ent = Object.entries(S.filters).filter(([k]) => !excl.includes(k));
  return ent.length ? S.rows.filter(r => ent.every(([k, v]) => r[k] === v)) : S.rows;
}
function countBy(rows, f) {
  const m = new Map(f.options.map(o => [o.value, 0]));
  for (const r of rows) m.set(r[f.key], (m.get(r[f.key]) || 0) + 1);
  return m;
}
function ordered(f, m) {
  const ent = f.options.map((o, i) => ({ value: o.value, short: o.short, n: m.get(o.value) || 0, tail: !!o.tail, i, mid: o.mid }));
  return f.kind === 'ordinal' ? ent : ent.sort((a, b) => (a.tail - b.tail) || (b.n - a.n) || (a.i - b.i));
}
const idxOf = (f, v) => f.options.findIndex(o => o.value === v);
const pctN = (n, t) => (t ? (n / t) * 100 : 0);
const share = (rows, pred) => (rows.length ? (rows.filter(pred).length / rows.length) * 100 : 0);
function meanMid(rows, f) {
  const mid = Object.fromEntries(f.options.map(o => [o.value, o.mid]));
  return rows.length ? rows.reduce((s, r) => s + mid[r[f.key]], 0) / rows.length : null;
}
function median(rows, f) {
  if (!rows.length) return null;
  const m = countBy(rows, f); let cum = 0;
  for (const o of f.options) { cum += m.get(o.value) || 0; if (cum >= rows.length / 2) return o; }
  return null;
}
function topOf(rows, f) {
  const m = countBy(rows, f); let best = null;
  for (const o of f.options) { const n = m.get(o.value) || 0; if (!best || n > best.n) best = { ...o, n }; }
  return best && best.n ? { ...best, p: pctN(best.n, rows.length) } : null;
}

/* Spearman rank correlation for two ordinal questions (normal approx. p-value) */
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]); const r = new Array(a.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1;
  }
  return r;
}
function pearson(x, y) {
  const n = x.length, mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxy += dx * dy; sxx += dx * dx; syy += dy * dy; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}
function erf(x) {
  const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
function spearman(rows, fa, fb) {
  if (rows.length < 12) return null;
  const rho = pearson(ranks(rows.map(r => idxOf(fa, r[fa.key]))), ranks(rows.map(r => idxOf(fb, r[fb.key]))));
  if (!isFinite(rho)) return null;
  const z = rho * Math.sqrt(rows.length - 1);
  const p = 2 * (1 - 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2)));
  const a = Math.abs(rho);
  return { rho, p, label: a < .1 ? 'negligible' : a < .3 ? 'weak' : a < .5 ? 'moderate' : 'strong' };
}
const fmtRho = r => (r < 0 ? '−' : '+') + Math.abs(r).toFixed(2);
const fmtP = p => (p < 0.001 ? 'p < 0.001' : 'p = ' + p.toFixed(3));

/* colour ramp for map / heat */
function ramp(t) {
  const stops = [[0, [34, 18, 22]], [.3, [96, 14, 26]], [.65, [192, 18, 31]], [1, [255, 59, 71]]];
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i], k = (t - t0) / (t1 - t0 || 1);
      return `rgb(${c0.map((v, j) => Math.round(v + (c1[j] - v) * k)).join(',')})`;
    }
  }
  return 'rgb(255,59,71)';
}

/* ---------- filters ------------------------------------------------------ */
function toggleFilter(key, value) {
  if (S.filters[key] === value) delete S.filters[key]; else S.filters[key] = value;
  render();
}
function setFilters(obj) {
  const all = Object.entries(obj).every(([k, v]) => S.filters[k] === v);
  for (const [k, v] of Object.entries(obj)) { if (all) delete S.filters[k]; else S.filters[k] = v; }
  render();
}
function clearFilters() { S.filters = {}; render(); }

function renderFilters() {
  const box = $('#filters'), ctx = $('#ctx'), keys = Object.keys(S.filters);
  box.hidden = !keys.length; ctx.hidden = !!keys.length;
  if (!keys.length) { box.replaceChildren(); return; }
  const chips = keys.map(k => {
    const f = S.F[k], o = f.options.find(x => x.value === S.filters[k]);
    return h('span', { class: 'fchip' }, h('b', {}, 'Q' + pad2(f.n)), o.short + (f.key === 'state' ? '' : ''),
      h('button', { type: 'button', 'aria-label': `Remove filter ${f.title}: ${o.value}`, onclick: () => toggleFilter(k, S.filters[k]) }, '✕'));
  });
  box.replaceChildren(...chips, h('button', { class: 'fclear', type: 'button', onclick: clearFilters }, 'Clear all'));
}

/* ---------- tooltip + toasts -------------------------------------------- */
const tip = $('#tip');
function showTip(html, ev) {
  tip.innerHTML = html; tip.hidden = false;
  const pad = 14, r = tip.getBoundingClientRect();
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + r.width > innerWidth - 6) x = ev.clientX - r.width - pad;
  if (y + r.height > innerHeight - 6) y = ev.clientY - r.height - pad;
  tip.style.left = Math.max(6, x) + 'px'; tip.style.top = Math.max(6, y) + 'px';
}
const hideTip = () => { tip.hidden = true; };

function toast({ msg, ok = false, action = null, ttl = 6000 }) {
  const box = $('#toasts');
  while (box.children.length >= 3) box.firstChild.remove();
  const t = h('div', { class: 'toast' + (ok ? ' ok' : ''), role: 'status' }, h('span', { class: 'ic' }, ok ? '✓' : '!'), h('span', {}, msg));
  const close = () => { if (!t.isConnected) return; t.classList.add('out'); setTimeout(() => t.remove(), 260); };
  if (action) t.append(h('button', { type: 'button', onclick: () => { action.fn(); close(); } }, action.label));
  t.append(h('i', { class: 'life', style: `animation-duration:${ttl}ms` }));
  box.append(t); setTimeout(close, ttl);
  return close;
}

/* ---------- shared chart bits -------------------------------------------- */
const px = k => rem() * k;                                  // rem-relative pixel size
const CAT = ['#FF2D3A', '#B3121F', '#FF7A82', '#8A1220', '#FFB3B8', '#D6303C', '#5A0C16', '#FF5A64', '#9A1021'];
const GREY = '#6B6B78';
const catColor = (e, i) => (e.tail ? GREY : CAT[i % CAT.length]);
const DIM = 'rgba(255,45,58,.14)';
const lum = hex => { const n = parseInt(hex.slice(1), 16); return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255; };
const inkOn = hex => (lum(hex) > 0.55 ? '#1A0A0C' : '#FFFFFF');
const wrapName = s => { const m = s.length > 8 && s.match(/^(.+?[- ])(.+)$/); return m ? [m[1].trim(), m[2]] : [s]; };

function chartDefaults() {
  Chart.defaults.color = '#C9C9D2';
  Chart.defaults.font.family = FB;
  if (REDUCED) Chart.defaults.animation = false;
  else { Chart.defaults.animation.duration = 750; Chart.defaults.animation.easing = 'easeOutQuart'; }
}

/* one place that turns the filtered rows into everything a chart needs */
function modelOf(p) {
  const f = p.f, rows = filteredRows([f.key]), m = countBy(rows, f), ent = ordered(f, m), total = rows.length;
  ent.forEach(e => { e.pct = pctN(e.n, total); });
  p.model = { rows, total, ent, sel: S.filters[f.key], by: Object.fromEntries(ent.map(e => [e.value, e])) };
  return p.model;
}
const resp = n => `${n} ${n === 1 ? 'response' : 'responses'}`;
function defaultTip(p, v) {
  const e = p.model && p.model.by[v]; if (!e) return null;
  return `<b>${esc(p.f.title)}</b>${esc(e.value)}<br>${resp(e.n)} · ${e.pct.toFixed(1)}%`;
}
const ABBR = { 'Non-Vegetarian': 'Non-Veg', 'Data Science & AI': 'DS & AI', 'Business & Mgmt': 'Business', 'IT & Software': 'IT & Soft', 'Government Services': 'Govt', 'Research & Academia': 'Research', 'Social Media': 'Social' };
const abbr = n => ABBR[n] || (n.length > 11 ? n.slice(0, 10) + '…' : n);
const topStat = p => { const t = topOf(p.model.rows, p.f); p.stat.innerHTML = t ? `TOP <b>${esc(abbr(t.short))}</b> ${Math.round(t.p)}%` : ''; };
const setEmpty = p => { p.empty.style.display = p.model.total ? 'none' : 'grid'; };

/* click / hover / keyboard for every element that carries data-v */
function wireVis(p, key) {
  const get = e => e.target.closest && e.target.closest('[data-v]');
  p.body.addEventListener('click', e => { const t = get(e); if (t) toggleFilter(key, t.dataset.v); });
  p.body.addEventListener('mousemove', e => {
    const t = get(e); if (!t || t.closest('.legend')) { hideTip(); return; }
    const html = p.tipFn ? p.tipFn(t.dataset.v) : defaultTip(p, t.dataset.v);
    if (html) showTip(html, e); else hideTip();
  });
  p.body.addEventListener('mouseleave', hideTip);
  p.body.addEventListener('keydown', e => {
    const t = get(e); if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleFilter(key, t.dataset.v); }
  });
}
function paintLegend(p, ent, colors) {
  const sel = p.model.sel;
  p.legend.replaceChildren(...ent.map((e, i) => h('button', { class: 'lg' + (sel === e.value ? ' sel' : sel ? ' dim' : ''), type: 'button', title: e.value, 'data-v': e.value },
    h('i', { style: `background:${colors[i]}` }), h('span', {}, e.short), h('em', {}, Math.round(e.pct) + '%'))));
}
/* custom SVG charts redraw at their real pixel size */
function mountVis(p, paint) {
  p.paint = paint;
  p.repaint = () => { if (p.model && p.vis.clientWidth) paint(p, p.vis.clientWidth, p.vis.clientHeight); };
  new ResizeObserver(() => p.repaint()).observe(p.vis);
}

/* ---------- Chart.js: shared look + plugins ------------------------------ */
const refLine = {
  id: 'refLine',
  beforeDatasetsDraw(chart) {
    const r = chart.$ref; if (!r || !chart.chartArea) return;
    const { left, right } = chart.chartArea, y = chart.scales.y.getPixelForValue(r.v), ctx = chart.ctx;
    ctx.save(); ctx.setLineDash([5, 5]); ctx.strokeStyle = 'rgba(255,255,255,.34)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = `600 ${px(.8)}px ${FM}`; ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillText(r.text, right - 2, y - 3); ctx.restore();
  },
};
const barPct = {
  id: 'barPct',
  afterDatasetsDraw(chart) {
    if (!chart.$labelBars) return;
    const bars = chart.getDatasetMeta(0).data, ctx = chart.ctx, sel = chart.$sel;
    ctx.save(); ctx.textAlign = 'center'; ctx.font = `700 ${px(.92)}px ${FM}`;
    bars.forEach((bar, i) => {
      const v = chart.data.datasets[0].data[i]; if (!(v > 0)) return;
      const inside = i === 0 && (bar.base - bar.y) >= px(1.9), dim = sel && chart.$full[i] !== sel;
      ctx.fillStyle = `rgba(255,255,255,${dim ? .4 : 1})`;
      ctx.textBaseline = inside ? 'top' : 'alphabetic';
      ctx.fillText(Math.round(v) + '%', bar.x, inside ? bar.y + px(.3) : bar.y - px(i === 0 ? .75 : .45));
    });
    ctx.restore();
  },
};
function barColor(ctx, f) {
  const ch = ctx.chart, area = ch.chartArea, i = ctx.dataIndex, sel = S.filters[f.key], val = ch.$full && ch.$full[i];
  if (sel && val !== sel) return 'rgba(255,45,58,.17)';
  if (!area) return '#B3121F';
  const g = ch.ctx.createLinearGradient(0, area.bottom, 0, area.top);
  if (i === ch.$top || sel === val) { g.addColorStop(0, '#9A1021'); g.addColorStop(.8, '#FF3B47'); g.addColorStop(1, '#FF5A64'); }
  else { g.addColorStop(0, '#4A0B14'); g.addColorStop(.8, '#B3121F'); g.addColorStop(1, '#C4202D'); }
  return g;
}
function tooltipCfg() {
  return {
    backgroundColor: 'rgba(12,12,16,.97)', borderColor: 'rgba(255,45,58,.65)', borderWidth: 1, padding: 12, cornerRadius: 8, displayColors: false,
    titleColor: '#FF6B73', bodyColor: '#F6F6F8',
    titleFont: () => ({ family: FM, size: px(.86), weight: '600' }),
    bodyFont: () => ({ family: FB, size: px(1.0), weight: '600' }),
    callbacks: {
      title: it => String(it[0].chart.$title ? it[0].chart.$title(it[0].dataIndex) : it[0].label).toUpperCase(),
      label: it => it.chart.$tip(it),
    },
  };
}
const pickFilter = (key) => (e, els, ch) => {
  const el = els.find(x => x.datasetIndex === 0) || els[0];
  if (el && ch.$full && ch.$full[el.index]) toggleFilter(key, ch.$full[el.index]);
};
const hoverPointer = (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; };

/* histogram + cumulative curve (ogive) / Pareto: bars and cumulative share on ONE % axis */
function makeCombo(canvas, f, o) {
  const tickFont = () => ({ family: FB, size: px(.92), weight: '600' });
  return new Chart(canvas, {
    data: {
      labels: [],
      datasets: [
        { type: 'bar', label: '% of responses', data: [], order: 2, barPercentage: o.bar, categoryPercentage: o.cat, borderRadius: () => px(.25), borderSkipped: false, backgroundColor: c => barColor(c, f) },
        { type: 'line', label: 'Cumulative %', data: [], order: 1, borderColor: '#FFD2D5', borderWidth: 2.4, pointRadius: 4, pointHoverRadius: 6, pointBackgroundColor: '#0E0E13', pointBorderColor: '#FFD2D5', pointBorderWidth: 2, tension: o.tension, clip: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, resizeDelay: 40,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: { top: 2, right: 8 } },
      plugins: {
        legend: { display: true, position: 'top', align: 'end', labels: { color: '#C9C9D2', usePointStyle: true, boxWidth: 8, boxHeight: 8, padding: 10, font: () => ({ family: FB, size: px(.82), weight: '600' }) } },
        tooltip: tooltipCfg(),
      },
      scales: {
        y: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,.07)' }, border: { display: false }, ticks: { stepSize: 25, padding: 4, color: '#8E8E9A', callback: v => v + '%', font: () => ({ family: FM, size: px(.78), weight: '500' }) } },
        x: { grid: { display: false }, border: { color: 'rgba(255,255,255,.14)' }, ticks: { color: '#C9C9D2', autoSkip: false, maxRotation: 0, minRotation: 0, padding: 5, font: tickFont } },
      },
      onClick: pickFilter(f.key), onHover: hoverPointer,
    },
    plugins: [refLine, barPct],
  });
}
function makeRadar(canvas, f) {
  return new Chart(canvas, {
    type: 'radar',
    data: { labels: [], datasets: [{ data: [], fill: true, backgroundColor: 'rgba(255,45,58,.26)', borderColor: '#FF3B47', borderWidth: 2.4, pointRadius: 5, pointHoverRadius: 8, pointBorderColor: '#0E0E13', pointBorderWidth: 1.5, pointBackgroundColor: [] }] },
    options: {
      responsive: true, maintainAspectRatio: false, resizeDelay: 40, layout: { padding: 2 },
      interaction: { mode: 'nearest', intersect: false },
      plugins: { legend: { display: false }, tooltip: tooltipCfg() },
      scales: { r: { beginAtZero: true, ticks: { display: false, backdropColor: 'transparent' }, grid: { color: 'rgba(255,255,255,.11)' }, angleLines: { color: 'rgba(255,255,255,.11)' },
        pointLabels: { color: '#D8D8DF', padding: 4, font: () => ({ family: FB, size: px(.9), weight: '600' }) } } },
      onClick: pickFilter(f.key), onHover: hoverPointer,
    },
  });
}
function makeRose(canvas, f) {
  return new Chart(canvas, {
    type: 'polarArea',
    data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderColor: '#0E0E13', borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, resizeDelay: 40, layout: { padding: 4 },
      plugins: { legend: { display: false }, tooltip: tooltipCfg() },
      scales: { r: { beginAtZero: true, ticks: { display: false }, grid: { color: 'rgba(255,255,255,.09)' }, angleLines: { display: false } } },
      onClick: pickFilter(f.key), onHover: hoverPointer,
    },
  });
}
const entTip = it => { const e = it.chart.$ent[it.dataIndex]; return `${resp(e.n)} · ${e.pct.toFixed(1)}%`; };

/* ---------- updaters: Chart.js based ------------------------------------- */
function updateHist(p) {
  const f = p.f, M = modelOf(p), ch = p.chart, ent = M.ent;
  let cum = 0; const cumPct = ent.map(e => { cum += e.n; return M.total ? (cum / M.total) * 100 : 0; });
  const max = Math.max(0, ...ent.map(e => e.n));
  ch.$ent = ent; ch.$full = ent.map(e => e.value); ch.$sel = M.sel; ch.$top = max ? ent.findIndex(e => e.n === max) : -1;
  ch.$title = i => ent[i].value;
  ch.$tip = it => (it.datasetIndex === 0 ? entTip(it) : `Cumulative ${cumPct[it.dataIndex].toFixed(1)}%`);
  ch.$ref = { v: 50, text: '50% of people' };
  ch.data.labels = ent.map(e => [e.short, Math.round(e.pct) + '%']);
  ch.data.datasets[0].data = ent.map(e => e.pct);
  ch.data.datasets[1].data = cumPct;
  ch.update(); setEmpty(p);
  const md = median(M.rows, f); p.stat.innerHTML = md ? `MEDIAN <b>${esc(md.short)}</b>` : '';
}
function updatePareto(p) {
  const M = modelOf(p), ch = p.chart, sorted = [...M.ent].sort((a, b) => b.n - a.n || a.i - b.i);
  const keep = sorted.slice(0, 5), rest = sorted.slice(5), restN = rest.reduce((s, e) => s + e.n, 0);
  const bars = keep.map(e => ({ value: e.value, label: wrapName(e.short), n: e.n, pct: e.pct }));
  if (rest.length && restN > 0) bars.push({ value: null, label: ['Rest'], n: restN, pct: pctN(restN, M.total), names: rest.filter(e => e.n).map(e => e.short) });
  let cum = 0; const cumPct = bars.map(b => { cum += b.n; return M.total ? (cum / M.total) * 100 : 0; });
  const max = Math.max(0, ...bars.map(b => b.n));
  ch.$labelBars = true; ch.$sel = M.sel; ch.$full = bars.map(b => b.value); ch.$top = max ? bars.findIndex(b => b.n === max) : -1;
  ch.$title = i => bars[i].value || ('Rest: ' + (bars[i].names || []).join(', '));
  ch.$tip = it => (it.datasetIndex === 0 ? `${resp(bars[it.dataIndex].n)} · ${bars[it.dataIndex].pct.toFixed(1)}%` : `Cumulative ${cumPct[it.dataIndex].toFixed(1)}%`);
  ch.$ref = { v: 80, text: '80%' };
  ch.data.labels = bars.map(b => b.label);
  ch.data.datasets[0].data = bars.map(b => b.pct);
  ch.data.datasets[1].data = cumPct;
  ch.update(); setEmpty(p);
  const k = Math.min(3, bars.length), c3 = k ? cumPct[k - 1] : 0;
  p.stat.innerHTML = M.total && bars.length ? `TOP ${k} = <b>${Math.round(c3)}%</b>` : '';
}
function updateRadar(p) {
  const f = p.f, M = modelOf(p), ch = p.chart, ent = f.options.map(o => M.by[o.value]), sel = M.sel;
  ch.$ent = ent; ch.$full = ent.map(e => e.value);
  ch.$title = i => ent[i].value; ch.$tip = entTip;
  ch.data.labels = ent.map(e => e.short);
  ch.data.datasets[0].data = ent.map(e => e.pct);
  ch.data.datasets[0].pointBackgroundColor = ent.map(e => (sel ? (sel === e.value ? '#fff' : '#3a1218') : '#FF3B47'));
  ch.options.scales.r.suggestedMax = Math.max(10, ...ent.map(e => e.pct)) * 1.12;
  ch.update(); setEmpty(p);
  paintLegend(p, M.ent, M.ent.map((e, i) => catColor(e, i)));
  topStat(p);
}
function updateRose(p) {
  const M = modelOf(p), ch = p.chart, ent = M.ent, sel = M.sel, cols = ent.map((e, i) => catColor(e, i));
  ch.$ent = ent; ch.$full = ent.map(e => e.value);
  ch.$title = i => ent[i].value; ch.$tip = entTip;
  ch.data.labels = ent.map(e => e.short);
  ch.data.datasets[0].data = ent.map(e => Math.sqrt(e.n));            // radius ∝ √count, so AREA ∝ count
  ch.data.datasets[0].backgroundColor = ent.map((e, i) => (sel && sel !== e.value ? DIM : cols[i]));
  ch.update(); setEmpty(p);
  paintLegend(p, ent, cols); topStat(p);
}

/* ---------- updaters + painters: custom SVG ------------------------------ */
const txt = (x, y, s, o = {}) => `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${(o.size || px(.95)).toFixed(1)}" fill="${o.fill || '#C9C9D2'}" font-weight="${o.w || 600}" text-anchor="${o.a || 'start'}" dominant-baseline="${o.b || 'middle'}"${o.mono ? ` font-family='${FM}'` : ''}${o.op != null ? ` opacity="${o.op}"` : ''}>${esc(s)}</text>`;

/* bubble pack ---------------------------------------------------------------*/
function packCircles(rs, aspect) {
  const out = [];
  rs.forEach((r, i) => {
    if (!i) { out.push({ x: 0, y: 0, r }); return; }
    let best = null, bs = Infinity;
    for (const a of out) for (let k = 0; k < 48; k++) {
      const ang = (k * Math.PI * 2) / 48, x = a.x + (a.r + r + .02) * Math.cos(ang), y = a.y + (a.r + r + .02) * Math.sin(ang);
      if (out.some(o => Math.hypot(o.x - x, o.y - y) < o.r + r + .01)) continue;
      const sc = Math.hypot(x / aspect, y); if (sc < bs) { bs = sc; best = { x, y, r }; }
    }
    out.push(best || { x: 0, y: 0, r });
  });
  return out;
}
function updateBubble(p) {
  const M = modelOf(p); p.pkEnt = M.ent.filter(e => e.n > 0).sort((a, b) => b.n - a.n);
  p.repaint(); setEmpty(p);
  paintLegend(p, M.ent, M.ent.map((e, i) => catColor(e, i))); topStat(p);
}
function paintBubble(p, W, H) {
  const M = p.model, ent = p.pkEnt || [], sel = M.sel;
  if (!ent.length) { p.vis.innerHTML = ''; return; }
  const pk = packCircles(ent.map(e => Math.sqrt(e.n)), W / H);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  pk.forEach(c => { x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r); y0 = Math.min(y0, c.y - c.r); y1 = Math.max(y1, c.y + c.r); });
  const pad = px(.4), s = Math.min((W - 2 * pad) / (x1 - x0), (H - 2 * pad) / (y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2 - x0 * s, oy = (H - (y1 - y0) * s) / 2 - y0 * s;
  const order = M.ent.map(e => e.value);
  let g = '';
  ent.forEach((e, i) => {
    const c = pk[i], r = c.r * s, cx = c.x * s + ox, cy = c.y * s + oy, col = catColor(e, order.indexOf(e.value)), dim = sel && sel !== e.value;
    const fit = Math.min(px(1.05), (r * 1.75) / (e.short.length * .6)), show = r > px(1.15) && fit >= px(.66);
    g += `<g class="bub${sel === e.value ? ' on' : ''}" data-v="${esc(e.value)}" tabindex="0" role="button" aria-label="${esc(e.value)}: ${e.n}" opacity="${dim ? .25 : 1}">
      <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${col}" fill-opacity=".92" stroke="rgba(255,255,255,.28)" stroke-width="1.5"/>
      ${show ? txt(cx, cy - fit * .1, e.short, { size: fit, a: 'middle', fill: inkOn(col), w: 800 }) + txt(cx, cy + fit * .95, Math.round(e.pct) + '%', { size: fit * .85, a: 'middle', fill: inkOn(col), mono: 1, w: 600, op: .85 }) : ''}</g>`;
  });
  p.vis.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Bubble chart: ${esc(p.f.title)}">${g}</svg>`;
}

/* treemap -------------------------------------------------------------------*/
function squarify(items, X, Y, W, H) {
  const total = items.reduce((s, i) => s + i.v, 0); if (!total) return [];
  const nodes = items.map(i => ({ ...i, a: (i.v / total) * W * H })), out = []; let rect = { x: X, y: Y, w: W, h: H }, row = [];
  const worst = (r, side) => { const s = r.reduce((t, n) => t + n.a, 0), mx = Math.max(...r.map(n => n.a)), mn = Math.min(...r.map(n => n.a)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
  const lay = r => {
    const s = r.reduce((t, n) => t + n.a, 0);
    if (rect.w >= rect.h) { const cw = s / rect.h; let yy = rect.y; r.forEach(n => { const hh = n.a / cw; out.push({ ...n, x: rect.x, y: yy, w: cw, h: hh }); yy += hh; }); rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h }; }
    else { const rh = s / rect.w; let xx = rect.x; r.forEach(n => { const ww = n.a / rh; out.push({ ...n, x: xx, y: rect.y, w: ww, h: rh }); xx += ww; }); rect = { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh }; }
  };
  for (const n of nodes) {
    const side = Math.min(rect.w, rect.h), nr = [...row, n];
    if (!row.length || worst(nr, side) <= worst(row, side)) row = nr; else { lay(row); row = [n]; }
  }
  if (row.length) lay(row);
  return out;
}
function fitLines(name, w, h, maxS, minS) {                  // wrap a label onto 1-3 lines, largest font that fits
  const words = name.split(' '); let best = null;
  const splits = (ws, k) => {
    if (k === 1) return [[ws.join(' ')]];
    const out = []; for (let i = 1; i <= ws.length - k + 1; i++) for (const rest of splits(ws.slice(i), k - 1)) out.push([ws.slice(0, i).join(' '), ...rest]);
    return out;
  };
  for (let k = 1; k <= Math.min(3, words.length); k++) for (const lines of splits(words, k)) {
    const mx = Math.max(...lines.map(l => l.length)), size = Math.min(maxS, w / (mx * .6), h / (k * 1.2));
    if (size >= minS && (!best || size > best.size + .01)) best = { lines, size };
  }
  return best;
}
function updateTreemap(p) { modelOf(p); p.repaint(); setEmpty(p); topStat(p); }
function paintTreemap(p, W, H) {
  const M = p.model, sel = M.sel, ent = M.ent.filter(e => e.n > 0).sort((a, b) => b.n - a.n);
  if (!ent.length) { p.vis.innerHTML = ''; return; }
  const max = ent[0].n, gap = 3, tiles = squarify(ent.map(e => ({ v: e.n, e })), 0, 0, W, H);
  let g = '';
  tiles.forEach(t => {
    const e = t.e, x = t.x + gap / 2, y = t.y + gap / 2, w = Math.max(0, t.w - gap), hh = Math.max(0, t.h - gap), dim = sel && sel !== e.value;
    const fill = e.tail ? '#3A3A44' : ramp(.3 + .7 * (e.n / max)), pad = px(.5);
    const aw = w - 2 * pad, ah = hh - 2 * pad;
    let fit = fitLines(e.short, aw, ah - px(1.5), px(1.15), px(.78)), showPct = !!fit;
    if (!fit) fit = fitLines(e.short, aw, ah, px(1.15), px(.78));
    const nl = fit ? fit.lines.length : 0;
    g += `<svg x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${hh.toFixed(1)}" class="tm${sel === e.value ? ' on' : ''}" data-v="${esc(e.value)}" tabindex="0" role="button" aria-label="${esc(e.value)}: ${e.n}" opacity="${dim ? .28 : 1}">
      <rect width="${w.toFixed(1)}" height="${hh.toFixed(1)}" rx="${px(.4).toFixed(1)}" fill="${fill}" stroke="rgba(255,255,255,.16)"/>
      ${fit ? fit.lines.map((ln, li) => txt(pad, pad + fit.size * (li * 1.2 + .6), ln, { size: fit.size, w: 800, fill: '#fff' })).join('') : ''}
      ${fit && showPct ? txt(pad, pad + fit.size * (nl * 1.2 + .7), `${Math.round(e.pct)}%`, { size: Math.max(px(.8), fit.size * .95), w: 700, fill: 'rgba(255,255,255,.82)', mono: 1 }) : ''}</svg>`;
  });
  p.vis.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Treemap: ${esc(p.f.title)}">${g}</svg>`;
}

/* lollipop -------------------------------------------------------------------*/
function updateLolli(p) { modelOf(p); p.repaint(); setEmpty(p); topStat(p); }
function paintLolli(p, W, H) {
  const M = p.model, ent = M.ent, n = ent.length, sel = M.sel, rowH = H / n, max = Math.max(1, ...ent.map(e => e.n));
  const fz = Math.min(px(1.02), rowH * .62), labW = Math.min(W * .38, Math.max(...ent.map(e => e.short.length)) * fz * .6 + px(.4));
  const x0 = labW + px(.7), x1 = W - px(5.4), dr = Math.max(4, Math.min(px(.62), rowH * .3)), topN = Math.max(...ent.map(e => e.n));
  let g = '';
  ent.forEach((e, i) => {
    const cy = rowH * i + rowH / 2, xv = x0 + (x1 - x0) * (e.n / max), dim = sel && sel !== e.value, top = e.n === topN && e.n > 0;
    g += `<g class="lol${sel === e.value ? ' on' : ''}" data-v="${esc(e.value)}" tabindex="0" role="button" aria-label="${esc(e.value)}: ${e.n}" opacity="${dim ? .3 : 1}">
      <rect x="0" y="${(rowH * i).toFixed(1)}" width="${W}" height="${rowH.toFixed(1)}" fill="transparent"/>
      <line x1="${x0.toFixed(1)}" x2="${x1.toFixed(1)}" y1="${cy.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="rgba(255,255,255,.07)" stroke-width="2" stroke-linecap="round"/>
      <line x1="${x0.toFixed(1)}" x2="${xv.toFixed(1)}" y1="${cy.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${top ? '#FF3B47' : '#B3121F'}" stroke-width="${Math.max(2, dr * .5).toFixed(1)}" stroke-linecap="round"/>
      <circle cx="${xv.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(top ? dr * 1.18 : dr).toFixed(1)}" fill="${top ? '#FF5A64' : '#D6303C'}" stroke="#0E0E13" stroke-width="2"${top ? ' filter="url(#glow)"' : ''}/>
      ${txt(labW, cy, e.short, { size: fz, a: 'end', fill: top ? '#fff' : '#C9C9D2', w: top ? 800 : 600 })}
      ${txt(xv + dr + px(.45), cy, String(e.n), { size: fz * .95, w: 800, fill: '#fff', mono: 1 })}
      ${txt(xv + dr + px(.45) + String(e.n).length * fz * .62 + px(.4), cy, Math.round(e.pct) + '%', { size: fz * .8, fill: '#8E8E9A', mono: 1, w: 500 })}</g>`;
  });
  p.vis.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Lollipop chart: ${esc(p.f.title)}"><defs><filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${g}</svg>`;
}

/* waffle ---------------------------------------------------------------------*/
function updateWaffle(p) {
  const M = modelOf(p), ent = M.ent;
  const cells = []; let used = 0;
  if (M.total) {
    const base = ent.map(e => ({ e, k: Math.floor(e.pct), r: e.pct - Math.floor(e.pct) }));
    used = base.reduce((s, b) => s + b.k, 0);
    [...base].sort((a, b) => b.r - a.r).slice(0, 100 - used).forEach(b => { b.k++; });
    base.forEach(b => { for (let i = 0; i < b.k; i++) cells.push(b.e); });
  }
  p.cells = cells; p.repaint(); setEmpty(p);
  paintLegend(p, ent, ent.map((e, i) => catColor(e, i)));
  const t = topOf(M.rows, p.f); p.stat.innerHTML = t ? `TOP <b>${esc(abbr(t.short))}</b> ${Math.round(t.p)}%` : '';
}
function paintWaffle(p, W, H) {
  const M = p.model, sel = M.sel, order = M.ent.map(e => e.value), gap = Math.max(2, px(.2));
  const s = Math.min((W - 9 * gap) / 10, (H - 9 * gap) / 10); if (s < 3) { p.vis.innerHTML = ''; return; }
  const gw = 10 * s + 9 * gap, ox = (W - gw) / 2, oy = (H - gw) / 2; let g = '';
  for (let i = 0; i < 100; i++) {
    const e = p.cells[i], col = Math.floor(i / 10), row = i % 10, x = ox + col * (s + gap), y = oy + (9 - row) * (s + gap);
    if (!e) { g += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" rx="${(s * .18).toFixed(1)}" fill="#1B1B22"/>`; continue; }
    const fill = sel && sel !== e.value ? DIM : catColor(e, order.indexOf(e.value));
    g += `<rect class="wf${sel === e.value ? ' on' : ''}" data-v="${esc(e.value)}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" rx="${(s * .18).toFixed(1)}" fill="${fill}"/>`;
  }
  p.vis.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Waffle chart: ${esc(p.f.title)}. Each square is one percent.">${g}</svg>`;
}

/* violin + box plot (sleep) ---------------------------------------------------
   Answers are ranges, so the continuous shape is ESTIMATED: each range is treated
   as uniform, then smoothed with a Gaussian kernel. Counts underneath are exact. */
const SLEEP_RANGES = [[4, 5], [5, 6], [6, 7], [7, 8], [8, 9]];
const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
function updateViolin(p) {
  const M = modelOf(p); p.repaint(); setEmpty(p);
  const md = median(M.rows, p.f); p.stat.innerHTML = md ? `MEDIAN <b>${esc(md.short)}</b>` : '';
}
function paintViolin(p, W, H) {
  const M = p.model, ent = M.ent, tot = M.total, sel = M.sel;
  const padL = px(.9), padR = px(.9), top = px(.5), axisH = px(3.1), bot = H - axisH, cy = (top + bot) / 2, half = ((bot - top) / 2) * .9;
  const X0 = 3.6, X1 = 9.4, xp = v => padL + ((v - X0) / (X1 - X0)) * (W - padL - padR);
  let g = `<rect x="${xp(7)}" y="${top}" width="${xp(X1) - xp(7)}" height="${bot - top}" fill="rgba(255,255,255,.035)"/>` + txt(xp(X1) - 4, top + px(.55), '7h+ recommended', { size: px(.78), a: 'end', fill: 'rgba(255,255,255,.45)', mono: 1, w: 500 });
  SLEEP_RANGES.forEach(([a, b], i) => {
    const e = ent[i], on = sel === e.value, dim = sel && !on;
    g += `<g class="vz${on ? ' on' : ''}" data-v="${esc(e.value)}" tabindex="0" role="button" aria-label="${esc(e.value)}: ${e.n}" opacity="${dim ? .4 : 1}">
      <rect x="${xp(a).toFixed(1)}" y="${top}" width="${(xp(b) - xp(a)).toFixed(1)}" height="${H - top}" class="zone" fill="${on ? 'rgba(255,45,58,.16)' : 'transparent'}"/>
      ${txt((xp(a) + xp(b)) / 2, bot + px(.95), e.short, { size: px(.92), a: 'middle', w: 700, fill: '#D8D8DF' })}
      ${txt((xp(a) + xp(b)) / 2, bot + px(2.15), String(e.n), { size: px(.95), a: 'middle', w: 800, fill: '#fff', mono: 1 })}</g>`;
  });
  for (let v = 5; v <= 8; v++) g += `<line x1="${xp(v)}" x2="${xp(v)}" y1="${top}" y2="${bot}" stroke="rgba(255,255,255,.1)" stroke-dasharray="3 5"/>`;
  g += `<line x1="${padL}" x2="${W - padR}" y1="${bot}" y2="${bot}" stroke="rgba(255,255,255,.18)"/>`;
  if (tot) {
    const sg = .32, pts = []; let dmax = 0;
    for (let v = X0; v <= X1 + 1e-9; v += .05) {
      let d = 0; SLEEP_RANGES.forEach(([a, b], i) => { if (ent[i].n) d += (ent[i].n / (tot * (b - a))) * (Phi((v - a) / sg) - Phi((v - b) / sg)); });
      pts.push([v, d]); dmax = Math.max(dmax, d);
    }
    const up = pts.map(([v, d]) => `${xp(v).toFixed(1)},${(cy - (d / dmax) * half).toFixed(1)}`), dn = pts.slice().reverse().map(([v, d]) => `${xp(v).toFixed(1)},${(cy + (d / dmax) * half).toFixed(1)}`);
    g += `<polygon points="${up.concat(dn).join(' ')}" fill="rgba(255,45,58,.38)" stroke="#FF3B47" stroke-width="2" stroke-linejoin="round" pointer-events="none"/>`;
    const q = pr => { let cum = 0; const t = pr * tot; for (let i = 0; i < 5; i++) { const n = ent[i].n; if (n && cum + n >= t) return SLEEP_RANGES[i][0] + ((t - cum) / n) * (SLEEP_RANGES[i][1] - SLEEP_RANGES[i][0]); cum += n; } return 9; };
    const q05 = q(.05), q25 = q(.25), q50 = q(.5), q75 = q(.75), q95 = q(.95), bh = px(1.15), mean = meanMid(M.rows, p.f);
    g += `<g pointer-events="none"><line x1="${xp(q05)}" x2="${xp(q95)}" y1="${cy}" y2="${cy}" stroke="#fff" stroke-width="2"/>
      <rect x="${xp(q25)}" y="${cy - bh / 2}" width="${Math.max(2, xp(q75) - xp(q25))}" height="${bh}" rx="${px(.2)}" fill="#0E0E13" stroke="#fff" stroke-width="2"/>
      <line x1="${xp(q50)}" x2="${xp(q50)}" y1="${cy - bh / 2}" y2="${cy + bh / 2}" stroke="#FF5A64" stroke-width="3.2"/>
      <path d="M${xp(mean)} ${cy - px(.38)}l${px(.38)} ${px(.38)}l-${px(.38)} ${px(.38)}l-${px(.38)} -${px(.38)}z" fill="#fff"/></g>`;
  }
  p.vis.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Violin and box plot of sleep hours (estimated from ranges)">${g}</svg>`;
}

/* ---------- dashboard construction -------------------------------------- */
const HEAD = { social_platform: 'Social platform', ai_platform: 'AI platform', food: 'Food habits', career: 'Career path' };
function buildDashboard() {
  chartDefaults();
  const grid = $('#grid');
  const ARIA = { hist: 'Histogram with cumulative curve', pareto: 'Pareto chart', radar: 'Radar chart', rose: 'Rose chart' };
  LAYOUT.forEach((spec, i) => {
    const f = S.F[spec.key], T = spec.type, isHeat = T === 'heat';
    const tag = isHeat ? 'Q2×Q4' : 'Q' + pad2(f.n);
    const title = isHeat ? 'Social media × Sleep' : (HEAD[spec.key] || f.title);
    const tooltip = isHeat ? 'Does more social media time go with less sleep?' : f.question;
    const clr = h('button', { class: 'clr', type: 'button', hidden: true, 'aria-label': 'Clear this filter', title: 'Clear filter' }, '✕');
    const stat = h('span', { class: 'stat' });
    const body = h('div', { class: 'pb' });
    const el = h('section', { class: 'panel' + (spec.span ? ' span' + spec.span : ''), style: `--i:${i}`, 'data-key': spec.key },
      h('header', { class: 'ph' }, h('span', { class: 'qtag' }, tag), h('h2', { title: tooltip }, title), stat, clr), body);
    grid.append(el);
    const p = { spec, f, el, body, stat, clr };
    clr.addEventListener('click', () => { delete S.filters[spec.key]; render(); });
    const empty = () => h('div', { class: 'empty' }, 'No responses yet');
    const wide = (inner, lw) => { p.legend = h('div', { class: 'legend' }); return h('div', { class: 'donut wide' + (lw ? ' lw' : '') }, h('div', { class: 'dc' }, inner), p.legend); };
    if (T === 'hist' || T === 'pareto') {
      const cv = h('canvas', { role: 'img', 'aria-label': `${ARIA[T]}: ${f.title}` });
      body.append(cv, empty());
      p.chart = makeCombo(cv, f, T === 'hist' ? { bar: 1, cat: .94, tension: .35 } : { bar: .7, cat: 1, tension: 0 });
    } else if (T === 'radar' || T === 'rose') {
      const cv = h('canvas', { role: 'img', 'aria-label': `${ARIA[T]}: ${f.title}` });
      body.append(wide(cv), empty());
      p.chart = T === 'radar' ? makeRadar(cv, f) : makeRose(cv, f);
    } else if (T === 'bubble' || T === 'waffle') {
      p.vis = h('div', { class: 'vis' });
      body.append(wide(p.vis, true), empty());
      mountVis(p, T === 'bubble' ? paintBubble : paintWaffle);
    } else if (T === 'violin' || T === 'lollipop' || T === 'treemap') {
      p.vis = h('div', { class: 'vis' });
      body.append(p.vis, empty());
      mountVis(p, { violin: paintViolin, lollipop: paintLolli, treemap: paintTreemap }[T]);
    } else if (T === 'map') buildMap(p);
    else if (T === 'heat') buildHeat(p);
    if (T !== 'map' && T !== 'heat') { p.empty = $('.empty', body); wireVis(p, spec.key); }
    S.panels.push(p);
  });

  /* KPIs */
  const k = $('#kpis');
  KPIS.forEach((d, i) => {
    const el = h('div', { class: 'kpi' + (d.hero ? ' hero' : ''), style: `--i:${i}`, 'data-k': d.id },
      h('div', { class: 'k' }, d.label),
      h('div', { class: 'v' }, h('span', { class: 'num' }, '0'), h('span', { class: 'u' }, d.unit || '')),
      h('div', { class: 's' }));
    k.append(el); d.el = el;
  });
  initPager();
}

/* phones: one chart at a time (swipe or tap arrows) so the screen never scrolls */
function initPager() {
  const dots = $('#pgDots'), n = S.panels.length;
  S.panels.forEach((_, i) => dots.append(h('i', { 'data-i': i })));
  const go = i => {
    S.cur = (i + n) % n;
    S.panels.forEach((p, j) => p.el.classList.toggle('cur', j === S.cur));
    $$('i', dots).forEach((d, j) => d.classList.toggle('on', j === S.cur));
    const p = S.panels[S.cur];
    $('#pgTxt').textContent = `${S.cur + 1} / ${n} · ${p.spec.type === 'heat' ? 'Social media × Sleep' : p.f.title}`;
    requestAnimationFrame(() => { if (p.chart) p.chart.resize(); if (p.repaint) p.repaint(); });
  };
  $('#pgPrev').addEventListener('click', () => go(S.cur - 1));
  $('#pgNext').addEventListener('click', () => go(S.cur + 1));
  let x0 = null;
  const g = $('#grid');
  g.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; }, { passive: true });
  g.addEventListener('touchend', e => {
    if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null;
    if (Math.abs(dx) > 55) go(S.cur + (dx < 0 ? 1 : -1));
  }, { passive: true });
  matchMedia('(max-width:640px)').addEventListener('change', () => go(S.cur));
  go(0);
}

/* ----- India choropleth map ----- */
const SMALL_UT = ['DL', 'CH', 'GA', 'PY', 'DD', 'LD', 'AN', 'SK'];          // too small to hover on the map: also shown as chips
function buildMap(p) {
  const f = p.f, M = S.map, byCode = Object.fromEntries(f.options.map(o => [o.code, o]));
  p.body.innerHTML = `<div class="mapwrap"><div class="mapcol">
      <div class="mapstage">
        <div class="mapbox" style="aspect-ratio:${M.w}/${M.h}"><svg class="msvg" viewBox="0 0 ${M.w} ${M.h}" role="group" aria-label="Map of India: respondents by state and union territory"></svg><div class="mlab"></div></div>
        <div class="mchips"><h3>Small UTs</h3><div class="chips"></div><div class="scale"><span>0</span><i></i><span class="smax">1</span></div></div>
      </div></div>
    <div class="toplist"><h3>Top origins</h3><div class="tl"></div></div></div>`;
  p.svg = $('.msvg', p.body); p.mlab = $('.mlab', p.body); p.chips = $('.chips', p.body); p.tl = $('.tl', p.body); p.smax = $('.smax', p.body);
  let s = '';
  for (const [code, d] of Object.entries(M.paths)) {
    const o = byCode[code];
    s += `<path class="st" data-v="${esc(o.value)}" data-c="${code}" d="${d}" tabindex="0" role="button" aria-label="${esc(o.value)}"/>`;
  }
  for (const code of SMALL_UT) { const o = byCode[code], [cx, cy] = M.c[code]; s += `<circle class="dot" data-v="${esc(o.value)}" data-c="${code}" cx="${cx}" cy="${cy}" r="9"/>`; }
  p.svg.innerHTML = s;
  p.chips.replaceChildren(...SMALL_UT.map(c => h('button', { class: 'chip2', type: 'button', 'data-v': byCode[c].value, 'data-c': c, title: byCode[c].value }, h('b', {}, c), h('small', {}, ''))));
  p.tipFn = v => {
    const n = (p.mapCounts && p.mapCounts.get(v)) || 0, t = p.mapTotal || 0, o = f.options.find(x => x.value === v);
    return `<b>${esc(o.group)}</b>${esc(v)}<br>${resp(n)} · ${t ? (n / t * 100).toFixed(1) : 0}%`;
  };
  const size = () => {                                    // keep the small-UT dots a constant ~4px on screen
    const w = $('.mapbox', p.body).clientWidth; if (!w) return;
    const r = Math.max(3.4, px(.3)) / (w / M.w);
    $$('.dot', p.svg).forEach(c => c.setAttribute('r', r.toFixed(1)));
  };
  new ResizeObserver(size).observe($('.mapbox', p.body));
  wireVis(p, 'state');
  p.byCode = byCode;
}
function updateMap(p) {
  const f = p.f, M = S.map, rows = filteredRows(['state']), m = countBy(rows, f), max = Math.max(0, ...m.values()), sel = S.filters.state;
  p.mapTotal = rows.length; p.mapCounts = m;
  const paint = (el, n) => {
    const v = el.dataset.v;
    el.classList.toggle('sel', sel === v); el.classList.toggle('dim', !!sel && sel !== v);
    el.classList.toggle('has', n > 0);
    el.style.fill = n ? ramp(0.2 + 0.8 * (n / max)) : '';
    el.setAttribute('aria-label', `${v}: ${n} ${n === 1 ? 'response' : 'responses'}. Press to filter.`);
    el.setAttribute('aria-pressed', sel === v ? 'true' : 'false');
  };
  $$('.st, .dot', p.svg).forEach(el => paint(el, m.get(el.dataset.v) || 0));
  $$('.chip2', p.chips).forEach(el => {
    const n = m.get(el.dataset.v) || 0; paint(el, n);
    el.style.background = n ? ramp(0.2 + 0.8 * (n / max)) : ''; el.style.fill = '';
    el.lastChild.textContent = n || '';
  });
  /* count labels on the states big enough to carry them */
  p.mlab.replaceChildren(...Object.entries(M.c).filter(([c]) => { const n = m.get(p.byCode[c].value) || 0; return n && M.area[c] >= 9000 && !SMALL_UT.includes(c); })
    .map(([c, [cx, cy]]) => { const v = p.byCode[c].value;
      return h('span', { class: 'ml' + (sel && sel !== v ? ' dim' : ''), style: `left:${(cx / M.w) * 100}%;top:${(cy / M.h) * 100}%` }, m.get(v)); }));
  p.smax.textContent = max;
  const reach = [...m.values()].filter(n => n > 0).length;
  p.stat.innerHTML = `<b>${reach}</b>/36 states & UTs`;
  const top = [...m].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || 0).slice(0, 5), topMax = top.length ? top[0][1] : 1;
  const short = Object.fromEntries(f.options.map(o => [o.value, o.short]));
  p.tl.replaceChildren(...top.map(([v, n], i) => h('button', { class: 'trow' + (sel === v ? ' sel' : ''), type: 'button', onclick: () => toggleFilter('state', v) },
    h('span', { class: 'rk' }, i + 1),
    h('span', { class: 'nm' }, h('span', {}, short[v]), h('span', { class: 'bar' }, h('i', { style: `width:${(n / topMax) * 100}%` }))),
    h('span', { class: 'ct' }, h('b', {}, n), ' · ' + Math.round(pctN(n, rows.length)) + '%'))));
  if (!top.length) p.tl.replaceChildren(h('p', { class: 'empty', style: 'position:static;padding:1rem 0' }, 'No responses yet'));
}

/* ----- heatmap ----- */
function buildHeat(p) {
  const a = S.F.social_hours, b = S.F.sleep;
  p.body.innerHTML = `<div class="heat"><div class="axis-l"><span>Social media ↓</span><span>Sleep →</span></div><div class="hgrid"></div><div class="hnote"></div></div>`;
  p.hgrid = $('.hgrid', p.body); p.hnote = $('.hnote', p.body); p.cells = [];
  p.hgrid.append(h('div', { class: 'hh' }));
  b.options.forEach(o => p.hgrid.append(h('div', { class: 'hh' }, o.short)));
  a.options.forEach(ra => {
    p.hgrid.append(h('div', { class: 'hh row' }, ra.short));
    b.options.forEach(cb => {
      const c = h('button', { class: 'hc', type: 'button', 'data-a': ra.value, 'data-b': cb.value });
      c.addEventListener('click', () => setFilters({ social_hours: ra.value, sleep: cb.value }));
      c.addEventListener('mousemove', ev => {
        const n = +c.dataset.n || 0, t = p.heatTotal || 0;
        showTip(`<b>Social ${esc(ra.value)} × Sleep ${esc(cb.value)}</b>${n} ${n === 1 ? 'response' : 'responses'} · ${t ? (n / t * 100).toFixed(1) : 0}% of all`, ev);
      });
      c.addEventListener('mouseleave', hideTip);
      p.hgrid.append(c); p.cells.push(c);
    });
  });
}
function updateHeat(p) {
  const a = S.F.social_hours, b = S.F.sleep, rows = filteredRows(['social_hours', 'sleep']);
  const cnt = {}; rows.forEach(r => { const k = r.social_hours + '|' + r.sleep; cnt[k] = (cnt[k] || 0) + 1; });
  const max = Math.max(1, ...Object.values(cnt)); p.heatTotal = rows.length;
  p.cells.forEach(c => {
    const n = cnt[c.dataset.a + '|' + c.dataset.b] || 0; c.dataset.n = n;
    const on = S.filters.social_hours === c.dataset.a && S.filters.sleep === c.dataset.b;
    c.className = 'hc' + (n ? '' : ' zero') + (on ? ' sel' : '');
    c.style.background = n ? ramp(0.16 + 0.84 * (n / max)) : '';
    c.textContent = n || '·';
    c.setAttribute('aria-label', `Social media ${c.dataset.a}, sleep ${c.dataset.b}: ${n} responses`);
  });
  const sp = spearman(rows, a, b);
  p.stat.innerHTML = sp ? `ρ <b>${fmtRho(sp.rho)}</b>` : 'ρ —';
  p.hnote.innerHTML = sp
    ? `<span>ρ <b>${fmtRho(sp.rho)}</b> · ${sp.label} ${sp.rho < 0 ? 'inverse' : 'positive'} · ${fmtP(sp.p)}</span><span>n=<b>${rows.length}</b></span>`
    : `<span>Needs 12+ responses for a correlation</span><span>n = <b>${rows.length}</b></span>`;
}

/* ---------- KPIs --------------------------------------------------------- */
const KPIS = [
  { id: 'n', label: 'Responses', hero: true, dec: 0,
    get: r => r.length, sub: () => `<b>${S.counts.live}</b> live · <b>${S.demo ? S.counts.demo : 0}</b> demo` },
  { id: 'reach', label: 'States & UTs', unit: '/ 36', dec: 0,
    get: r => new Set(r.map(x => x.state)).size,
    sub: r => { const t = topOf(r, S.F.state); return t ? `Most: <b>${esc(t.short)}</b>` : 'Waiting for data'; } },
  { id: 'social', label: 'Avg social media', unit: 'h / day', dec: 1,
    get: r => meanMid(r, S.F.social_hours),
    sub: r => r.length ? `<b>${Math.round(share(r, x => idxOf(S.F.social_hours, x.social_hours) >= 3))}%</b> spend 4h or more` : 'Waiting for data' },
  { id: 'sleep', label: 'Avg sleep', unit: 'h / night', dec: 1,
    get: r => meanMid(r, S.F.sleep),
    sub: r => r.length ? `<b>${Math.round(share(r, x => idxOf(S.F.sleep, x.sleep) <= 2))}%</b> sleep under 7h` : 'Waiting for data' },
  { id: 'ai', label: 'AI adoption', unit: '%', dec: 0,
    get: r => (r.length ? share(r, x => x.ai_platform !== "Don't Use AI") : null),
    sub: r => { const t = topOf(r.filter(x => x.ai_platform !== "Don't Use AI"), S.F.ai_platform); return t ? `Top tool: <b>${esc(t.short)}</b>` : 'Waiting for data'; } },
  { id: 'active', label: 'Active lifestyle', unit: '%', dec: 0,
    get: r => (r.length ? share(r, x => x.activity !== 'No Regular Physical Activity') : null),
    sub: r => { const t = topOf(r.filter(x => x.activity !== 'No Regular Physical Activity'), S.F.activity); return t ? `Most popular: <b>${esc(t.short)}</b>` : 'Waiting for data'; } },
];
function setNum(el, val, dec) {
  const to = val == null ? null : +val;
  if (to == null) { el.textContent = '–'; el.dataset.v = ''; return; }
  const from = parseFloat(el.dataset.v) || 0; el.dataset.v = to;
  const fmt = v => v.toFixed(dec);
  cancelAnimationFrame(el._raf);
  if (REDUCED || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 650;
  const step = now => { const t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3); el.textContent = fmt(from + (to - from) * e); if (t < 1) el._raf = requestAnimationFrame(step); };
  el._raf = requestAnimationFrame(step);
}
function renderKPIs() {
  const rows = filteredRows();
  KPIS.forEach(d => { setNum($('.num', d.el), d.get(rows), d.dec); $('.s', d.el).innerHTML = d.sub(rows); });
}

/* ---------- insights + footer ------------------------------------------- */
function buildInsights(rows) {
  if (rows.length < 5) return ['Not enough responses yet — add a few more to unlock insights.'];
  const F = S.F, n = rows.length, out = [];
  const t = k => topOf(rows, F[k]);
  const plat = t('social_platform'); if (plat) out.push(`<b>${esc(plat.value)}</b> is the most-used social platform — <b>${Math.round(plat.p)}%</b> of responses`);
  const low = Math.round(share(rows, r => idxOf(F.sleep, r.sleep) <= 2));
  out.push(`<b>${low}%</b> sleep under 7 hours — 7 or more is the usual adult recommendation`);
  const heavy = rows.filter(r => idxOf(F.social_hours, r.social_hours) >= 3), rest = rows.filter(r => idxOf(F.social_hours, r.social_hours) < 3);
  if (heavy.length >= 5 && rest.length >= 5) {
    const a = Math.round(share(heavy, r => idxOf(F.sleep, r.sleep) <= 1)), b = Math.round(share(rest, r => idxOf(F.sleep, r.sleep) <= 1));
    out.push(`Under 6h of sleep: <b>${a}%</b> of heavy social users (4h+) vs <b>${b}%</b> of everyone else`);
  }
  const sp = spearman(rows, F.social_hours, F.sleep);
  if (sp) out.push(sp.p < 0.05
    ? `Social media time and sleep are linked — Spearman ρ <b>${fmtRho(sp.rho)}</b> (${sp.label}, ${fmtP(sp.p)})`
    : `No statistically clear link between social media time and sleep yet (ρ <b>${fmtRho(sp.rho)}</b>, ${fmtP(sp.p)})`);
  const aiUsers = Math.round(share(rows, r => r.ai_platform !== "Don't Use AI")), ai = t('ai_platform');
  if (ai) out.push(`<b>${aiUsers}%</b> use an AI platform — <b>${esc(ai.value)}</b> leads with ${Math.round(ai.p)}%`);
  const none = Math.round(share(rows, r => r.activity === 'No Regular Physical Activity'));
  out.push(`<b>${none}%</b> report no regular physical activity`);
  const st = t('state'); if (st) out.push(`<b>${esc(st.value)}</b> sends the most respondents (${Math.round(st.p)}%) · <b>${new Set(rows.map(r => r.state)).size}</b> of 36 states & UTs represented`);
  const ca = t('career'); if (ca) out.push(`<b>${esc(ca.value)}</b> is the top career pull — ${Math.round(ca.p)}% of responses`);
  const tr = t('transport'); if (tr) out.push(`<b>${esc(tr.value)}</b> is the most common way to get around (${Math.round(tr.p)}%)`);
  const en = t('entertainment'); if (en) out.push(`<b>${esc(en.value)}</b> is the favourite form of entertainment (${Math.round(en.p)}%)`);
  const nv = Math.round(share(rows, r => r.food === 'Non-Vegetarian')), vg = Math.round(share(rows, r => r.food === 'Vegetarian'));
  out.push(`Food habits: <b>${nv}%</b> non-vegetarian · <b>${vg}%</b> vegetarian`);
  return out;
}
let insightList = [], insightIdx = 0, insightTimer = null;
function renderInsights() {
  insightList = buildInsights(filteredRows());
  insightIdx = insightIdx % insightList.length;
  const el = $('#insight');
  if (!insightTimer) { el.innerHTML = insightList[insightIdx]; insightTimer = setInterval(rotateInsight, 7000); }
  else if (!el.dataset.keep) el.innerHTML = insightList[insightIdx];
}
function rotateInsight() {
  const el = $('#insight'); if (document.hidden || insightList.length < 2) return;
  el.classList.add('out');
  setTimeout(() => { insightIdx = (insightIdx + 1) % insightList.length; el.innerHTML = insightList[insightIdx]; el.classList.remove('out'); }, 450);
}
const fmtClock = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'just now'; if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago'; return Math.floor(s / 3600) + 'h ago';
}
function renderLatest() {
  const live = S.rows.filter(r => r.src === 'live'), pool = live.length ? live : S.rows;
  const el = $('#latest');
  if (!pool.length) { el.replaceChildren(); return; }
  const last = pool.reduce((a, b) => (Date.parse(b.ts) >= Date.parse(a.ts) ? b : a));
  const st = S.F.state.options.find(o => o.value === last.state).short, pl = S.F.social_platform.options.find(o => o.value === last.social_platform).short;
  el.replaceChildren(h('i'), `LATEST${last.src === 'demo' ? ' (demo)' : ''}  ${st} · ${pl} · ${ago(Date.parse(last.ts))}`);
}
function renderFooter() {
  $('#upd').textContent = S.updatedAt ? `n = ${filteredRows().length}/${S.rows.length} · updated ${fmtClock(S.updatedAt)}` : '';
  renderLatest();
}

/* ---------- master render ----------------------------------------------- */
const UPDATE = { map: updateMap, heat: updateHeat, hist: updateHist, bubble: updateBubble, violin: updateViolin, radar: updateRadar, rose: updateRose, waffle: updateWaffle, lollipop: updateLolli, pareto: updatePareto, treemap: updateTreemap };
function render() {
  renderFilters(); renderKPIs();
  for (const p of S.panels) {
    const k = p.spec.key;
    UPDATE[p.spec.type](p);
    const filtered = p.spec.type === 'heat' ? ('social_hours' in S.filters && 'sleep' in S.filters) : k in S.filters;
    p.el.classList.toggle('filtered', filtered); p.clr.hidden = !filtered;
  }
  renderInsights(); renderFooter();
}

function celebrate(fresh) {
  $('#livePill').classList.remove('flash'); void $('#livePill').offsetWidth; $('#livePill').classList.add('flash');
  const k = $('.kpi.hero'); k.classList.remove('ping'); void k.offsetWidth; k.classList.add('ping');
  const mp = S.panels.find(p => p.spec.type === 'map');
  fresh.forEach(r => $$(`[data-v="${CSS.escape(r.state)}"]`, mp.body).forEach(t => { t.classList.remove('new'); void t.getBoundingClientRect(); t.classList.add('new'); }));
}

/* ---------- data loading + live connection ------------------------------ */
let inflight = false, again = false;
async function refresh(first = false) {
  if (inflight) { again = true; return; }
  inflight = true;
  try {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.status);
    const d = await res.json();
    const prev = new Set(S.rows.map(r => r.id));
    S.version = d.version; S.rows = d.rows; S.demo = d.demo_enabled; S.counts = d.counts; S.updatedAt = new Date();
    $('#demoToggle').checked = S.demo;
    render();
    if (!first) { const fresh = d.rows.filter(r => r.src === 'live' && !prev.has(r.id)); if (fresh.length) celebrate(fresh); }
  } catch (e) { setLive(false); }
  finally { inflight = false; if (again) { again = false; refresh(); } }
}
function setLive(on) { S.live = on; const p = $('#livePill'); p.classList.toggle('on', on); p.title = on ? 'Connected — updating live' : 'Reconnecting…'; }
function connect() {
  if (!window.EventSource) { setInterval(refresh, 3000); return; }
  const es = new EventSource('/api/stream');
  es.addEventListener('update', e => { setLive(true); try { if (JSON.parse(e.data).version !== S.version) refresh(); } catch { refresh(); } });
  es.onopen = () => setLive(true);
  es.onerror = () => setLive(false);          // the browser retries automatically
  setInterval(() => { if (!S.live) refresh(); }, 4000);
}

/* ---------- header controls --------------------------------------------- */
function bindControls() {
  $('#btnAdd').addEventListener('click', () => openForm());
  $('#btnExport').addEventListener('click', () => { location.href = '/api/export.csv?demo=' + (S.demo ? 1 : 0); });
  $('#btnFull').addEventListener('click', toggleFull);
  $('#demoToggle').addEventListener('change', async e => {
    const want = e.target.checked;
    try {
      const r = await fetch('/api/demo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: want }) });
      if (!r.ok) throw 0;
      toast({ msg: want ? 'Demo data ON — 150 sample responses included' : 'Demo data OFF — showing live responses only', ok: true, ttl: 3200 });
      refresh();
    } catch { e.target.checked = !want; toast({ msg: 'Could not change demo data. Is the server running?' }); }
  });

  const menuBtn = $('#btnMenu'), pop = $('#menuPop'), reset = $('#mReset');
  const closeMenu = () => { pop.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); disarm(); };
  let armTimer = null;
  const disarm = () => { clearTimeout(armTimer); reset.classList.remove('armed'); reset.textContent = 'Reset live responses…'; };
  menuBtn.addEventListener('click', e => {
    e.stopPropagation(); const open = pop.hidden; pop.hidden = !open; menuBtn.setAttribute('aria-expanded', String(open));
    if (open) $('a,button', pop).focus(); else disarm();
  });
  document.addEventListener('click', e => { if (!pop.hidden && !pop.contains(e.target)) closeMenu(); });
  pop.addEventListener('keydown', e => {
    const items = $$('[role=menuitem]', pop), i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    if (e.key === 'Escape') { closeMenu(); menuBtn.focus(); }
  });
  reset.addEventListener('click', async () => {
    if (!reset.classList.contains('armed')) {
      reset.classList.add('armed'); reset.textContent = 'Click again — erases live responses (backup kept)';
      armTimer = setTimeout(disarm, 4500); return;
    }
    disarm();
    try {
      const r = await fetch('/api/reset-live', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Failed');
      closeMenu(); toast({ msg: d.backup ? `Live responses cleared. Backup saved: data/backups/${d.backup}` : 'Live responses cleared.', ok: true, ttl: 5000 }); refresh();
    } catch (err) { toast({ msg: err.message || 'Could not reset.' }); }
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#formDlg').open && Object.keys(S.filters).length) { clearFilters(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey || $('#formDlg').open || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); openForm(); }
    else if (k === 'd') { $('#demoToggle').click(); }
    else if (k === 'f') toggleFull();
    else if (k === 'c') clearFilters();
  });
  let rz; addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => S.panels.forEach(p => p.chart && p.chart.update('none')), 120); });
  setInterval(renderLatest, 1000);
}
function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen();
}

/* ---------- survey form -------------------------------------------------- */
const FORM = { key: uid(), busy: false, attempted: false, undoId: null };
const dlg = $('#formDlg'), form = $('#surveyForm');
let formOnly = false;

function buildForm() {
  const wrap = $('#fields');
  S.schema.fields.forEach(f => {
    const id = 'f_' + f.key;
    const sel = h('select', { id, name: f.key, required: true, class: 'unset', 'aria-describedby': 'e_' + f.key });
    sel.append(h('option', { value: '', disabled: true, selected: true, hidden: true }, f.placeholder + '…'));
    if (f.kind === 'geo') {
      for (const g of ['State', 'Union Territory']) {
        const grp = h('optgroup', { label: g === 'State' ? 'States (28)' : 'Union Territories (8)' });
        f.options.filter(o => o.group === g).forEach(o => grp.append(h('option', { value: o.value }, o.value)));
        sel.append(grp);
      }
    } else f.options.forEach(o => sel.append(h('option', { value: o.value }, o.value)));
    sel.addEventListener('change', () => { fieldCheck(f); progress(); });
    sel.addEventListener('blur', () => { if (FORM.attempted) fieldCheck(f); });
    wrap.append(h('div', { class: 'field', 'data-key': f.key },
      h('label', { for: id }, h('span', { class: 'n' }, pad2(f.n)), h('span', {}, f.question, h('span', { class: 'req', 'aria-hidden': 'true' }, '\u00A0*'))),
      h('div', { class: 'sel' }, sel),
      h('p', { class: 'err', id: 'e_' + f.key }, '')));
  });
  form.addEventListener('submit', onSubmit);
  $('#btnCancel').addEventListener('click', () => { formOnly ? (resetForm(), focusFirst()) : closeForm(); });
  dlg.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!e.repeat) form.requestSubmit(); }
  });
  dlg.addEventListener('cancel', e => { if (formOnly) e.preventDefault(); else resetForm(); });   // Esc closes + clears
  dlg.addEventListener('click', e => { if (e.target === dlg && !formOnly) closeForm(); });         // click on backdrop
}
const focusFirst = () => setTimeout(() => $('#f_state').focus(), 30);

function fieldCheck(f, quiet = false) {
  const sel = $('#f_' + f.key), box = sel.closest('.field'), ok = !!sel.value;
  sel.classList.toggle('unset', !ok);
  box.classList.toggle('filled', ok);
  if (!quiet) {
    box.classList.toggle('bad', !ok);
    sel.setAttribute('aria-invalid', ok ? 'false' : 'true');
    $('#e_' + f.key).textContent = ok ? '' : `Question ${f.n} needs an answer — pick one option.`;
  }
  return ok;
}
function progress() {
  const done = S.schema.fields.filter(f => $('#f_' + f.key).value).length, total = S.schema.fields.length;
  $('#progFill').style.width = (done / total) * 100 + '%';
  $('#progTxt').textContent = `${done} / ${total} answered`;
  if (done === total && FORM.attempted) $('#formSummary').hidden = true;
}
function resetForm() {
  form.reset(); FORM.attempted = false; FORM.key = uid();
  $$('.field', form).forEach(b => { b.classList.remove('bad', 'filled'); $('select', b).classList.add('unset'); $('select', b).removeAttribute('aria-invalid'); $('.err', b).textContent = ''; });
  $('#formSummary').hidden = true; progress();
  const b = $('#btnSubmit'); b.classList.remove('busy', 'done'); b.disabled = false; $('.lbl', b).textContent = 'Submit Response';
}
function openForm() {
  if (formOnly || dlg.open) { focusFirst(); return; }
  hideTip(); resetForm(); dlg.showModal(); focusFirst();
}
function closeForm() { if (dlg.open) dlg.close(); resetForm(); }

function showSummary(msg, net = false) {
  const s = $('#formSummary'); s.textContent = msg; s.classList.toggle('net', net); s.hidden = false;
}
async function onSubmit(e) {
  e.preventDefault();
  if (FORM.busy || e.repeat) return;                       // double-click / key-repeat guard
  FORM.attempted = true;
  const bad = S.schema.fields.filter(f => !fieldCheck(f));
  if (bad.length) {
    showSummary(bad.length === 1 ? 'One question still needs an answer.' : `${bad.length} questions still need an answer.`);
    $('#f_' + bad[0].key).focus(); return;
  }
  $('#formSummary').hidden = true;
  FORM.busy = true;
  const btn = $('#btnSubmit'); btn.classList.add('busy'); btn.setAttribute('aria-busy', 'true'); $('.lbl', btn).textContent = 'Submitting…';
  const answers = Object.fromEntries(S.schema.fields.map(f => [f.key, $('#f_' + f.key).value]));
  let ok = false;
  try {
    const r = await fetch('/api/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: FORM.key, answers }) });
    const d = await r.json();
    if (r.status === 422 && d.errors) {
      Object.entries(d.errors).forEach(([k, m]) => { const box = $(`.field[data-key="${k}"]`); if (box) { box.classList.add('bad'); $('.err', box).textContent = m; } });
      showSummary('Some answers were not accepted. Please check the highlighted questions.');
    } else if (!r.ok) throw new Error('Server error');
    else {
      ok = true;
      if (d.duplicate) toast({ msg: 'This response was already recorded — no duplicate added.', ok: true, ttl: 3500 });
      else toast({ msg: `Response ${d.id} recorded`, ok: true, ttl: 8000, action: { label: 'Undo', fn: () => undo(d.id) } });
    }
  } catch (err) {
    showSummary('Could not reach the server. Your answers are still here — check the connection and press Submit again.', true);
  }
  btn.removeAttribute('aria-busy');
  if (ok) {
    btn.classList.remove('busy'); btn.classList.add('done'); $('.lbl', btn).textContent = 'Recorded ✓';
    setTimeout(() => {
      FORM.busy = false; resetForm();
      if ($('#keepOpen').checked || formOnly) focusFirst(); else closeForm();
    }, 650);
  } else { btn.classList.remove('busy'); $('.lbl', btn).textContent = 'Submit Response'; setTimeout(() => { FORM.busy = false; }, 400); }
}
async function undo(id) {
  try {
    const r = await fetch('/api/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
    if (!r.ok) throw 0;
    toast({ msg: `Response ${id} removed`, ok: true, ttl: 2800 }); if (!formOnly) refresh();
  } catch { toast({ msg: 'Could not undo that response.' }); }
}

/* ---------- boot --------------------------------------------------------- */
async function boot() {
  formOnly = location.pathname.replace(/\/+$/, '') === '/form';
  const schema = await (await fetch('/api/schema')).json();
  S.schema = schema; schema.fields.forEach(f => { S.F[f.key] = f; });
  buildForm(); progress();
  if (formOnly) {
    document.documentElement.classList.add('form-only');
    dlg.showModal(); focusFirst(); return;
  }
  try { await Promise.all([document.fonts.load('800 16px "Unbounded"'), document.fonts.load('600 12px "Manrope"'), document.fonts.load('600 12px "JetBrains Mono"')]); } catch {}
  S.map = await (await fetch('/static/india-map.json')).json();
  buildDashboard(); bindControls();
  await refresh(true);
  connect();
}
boot().catch(err => { console.error(err); toast({ msg: 'Could not load Campus Pulse: ' + err.message }); });
})();
