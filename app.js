/* Tamil Data Collector dashboard.
   Reads pre-generated JSON written by scripts/build_dashboard_data.py.
   No frameworks, no network calls off this site, nothing loaded eagerly
   except four small summary files. */

'use strict';

const S = {              // everything the page has loaded so far
  summary: null, history: null, samples: null, manifest: null,
  shards: new Map(),     // "source/0003" -> array of records
  results: [], cursor: null, scanned: 0, page: 0, searching: false,
};

const PAGE_SIZE = 20;
const SHARD_BUDGET = 25;     // shards fetched per search pass
const RESULT_CAP = 400;      // matches collected per search pass

const STATUS = {
  ok:        { icon: '✓', label: 'Working' },
  partial:   { icon: '!', label: 'Partly done' },
  stale:     { icon: '·', label: 'Did not run' },
  idle:      { icon: '·', label: 'No records' },
  fail:      { icon: '✕', label: 'Failed' },
  never_run: { icon: '–', label: 'Never run' },
};

/* ---------------------------------------------------------------- helpers */

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const num = n => (n === null || n === undefined) ? '—' : n.toLocaleString('en-US');
const esc = s => String(s === null || s === undefined ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function bytes(b) {
  if (!b && b !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function duration(seconds) {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60), s = Math.round(seconds % 60);
  return s ? `${m}m ${s}s` : `${m}m`;
}

function ago(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 90) return 'just now';
  if (diff < 5400) return `${Math.round(diff / 60)} minutes ago`;
  if (diff < 172800) return `${Math.round(diff / 3600)} hours ago`;
  return `${Math.round(diff / 86400)} days ago`;
}

const shortDate = iso => !iso ? '' : new Date(iso).toLocaleDateString('en-GB',
  { day: 'numeric', month: 'short' });

async function getJSON(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${url} → HTTP ${response.status}`);
  return response.json();
}

function statusChip(status) {
  const meta = STATUS[status] || { icon: '?', label: status };
  return el('span', { class: `chip ${status}`, title: meta.label },
    [el('span', { class: 'dot' }), `${meta.icon} ${meta.label}`]);
}

function kpi(label, value, detail) {
  return el('div', { class: 'kpi' }, [
    el('div', { class: 'k', text: label }),
    el('div', { class: 'v', text: value }),
    el('div', { class: 'd', text: detail || '' }),
  ]);
}

/* ----------------------------------------------------------------- charts */

const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, value);
  return node;
}

function chartFrame(host, height) {
  host.innerHTML = '';
  const width = Math.max(host.clientWidth || 640, 320);
  const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`,
                            role: 'img' });
  const tip = el('div', { class: 'tip' });
  host.appendChild(root);
  host.appendChild(tip);
  return { root, tip, width, height };
}

function showTip(host, tip, x, y, html) {
  tip.innerHTML = html;
  tip.style.opacity = '1';
  const left = Math.min(Math.max(x - tip.offsetWidth / 2, 2),
                        host.clientWidth - tip.offsetWidth - 2);
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(y - tip.offsetHeight - 12, 0)}px`;
}

function niceTicks(max) {
  if (max <= 0) return [0, 1];
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const norm = max / step;
  const nice = norm <= 1.5 ? 1.5 : norm <= 2 ? 2 : norm <= 3 ? 3 : norm <= 5 ? 5 : 10;
  const top = nice * step;
  return [0, top / 4, top / 2, (3 * top) / 4, top];
}

/* Single-series trend. One measure per chart - never two scales on one plot. */
function lineChart(host, points, opts) {
  opts = opts || {};
  if (!points.length) { host.innerHTML = '<p class="empty">Nothing recorded yet.</p>'; return; }
  const height = opts.height || 210;
  const { root, tip, width } = chartFrame(host, height);
  const pad = { l: 56, r: 14, t: 12, b: 26 };
  const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
  const ticks = niceTicks(Math.max(...points.map(p => p.v)));
  const top = ticks[ticks.length - 1];
  const x = i => pad.l + (points.length === 1 ? plotW / 2 : (i * plotW) / (points.length - 1));
  const y = v => pad.t + plotH - (v / top) * plotH;
  const fmt = opts.format || num;

  for (const tick of ticks) {
    root.appendChild(svg('line', { x1: pad.l, x2: width - pad.r, y1: y(tick), y2: y(tick),
      stroke: 'var(--grid)', 'stroke-width': 1 }));
    const label = svg('text', { x: pad.l - 8, y: y(tick) + 4, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 11 });
    label.textContent = fmt(tick);
    root.appendChild(label);
  }

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.v)}`).join(' ');
  root.appendChild(svg('path', {
    d: `${line} L${x(points.length - 1)},${pad.t + plotH} L${x(0)},${pad.t + plotH} Z`,
    fill: 'var(--series-1)', opacity: 0.12 }));
  root.appendChild(svg('path', { d: line, fill: 'none', stroke: 'var(--series-1)',
    'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

  if (points.length <= 24) {
    for (let i = 0; i < points.length; i++) {
      root.appendChild(svg('circle', { cx: x(i), cy: y(points[i].v), r: 4,
        fill: 'var(--series-1)', stroke: 'var(--surface-2)', 'stroke-width': 2 }));
    }
  }

  for (const i of [0, points.length - 1]) {
    if (points.length < 2 && i === 1) continue;
    const label = svg('text', { x: x(i), y: height - 8, fill: 'var(--muted)', 'font-size': 11,
      'text-anchor': i === 0 ? 'start' : 'end' });
    label.textContent = points[i].label;
    root.appendChild(label);
  }

  const cross = svg('line', { y1: pad.t, y2: pad.t + plotH, stroke: 'var(--muted)',
    'stroke-width': 1, 'stroke-dasharray': '3 3', opacity: 0 });
  root.appendChild(cross);
  const hit = svg('rect', { x: pad.l, y: pad.t, width: plotW, height: plotH, fill: 'transparent' });
  root.appendChild(hit);
  hit.addEventListener('mousemove', event => {
    const rect = root.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const i = Math.max(0, Math.min(points.length - 1,
      Math.round(((px - pad.l) / plotW) * (points.length - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i));
    cross.setAttribute('opacity', 1);
    showTip(host, tip, x(i), y(points[i].v),
      `<b>${fmt(points[i].v)}</b><br>${esc(points[i].full || points[i].label)}`);
  });
  hit.addEventListener('mouseleave', () => { cross.setAttribute('opacity', 0); tip.style.opacity = '0'; });
}

/* Vertical bars, one per run. Colour carries status, and the legend names it. */
function barChart(host, items, opts) {
  opts = opts || {};
  if (!items.length) { host.innerHTML = '<p class="empty">Nothing recorded yet.</p>'; return; }
  const height = opts.height || 200;
  const { root, tip, width } = chartFrame(host, height);
  const pad = { l: 56, r: 10, t: 12, b: 26 };
  const plotW = width - pad.l - pad.r, plotH = height - pad.t - pad.b;
  const ticks = niceTicks(Math.max(...items.map(d => d.v)));
  const top = ticks[ticks.length - 1];
  const y = v => pad.t + plotH - (v / top) * plotH;
  const slot = plotW / items.length;
  const barW = Math.max(4, Math.min(38, slot - 4));   // 2px surface gap each side
  const fmt = opts.format || num;

  for (const tick of ticks) {
    root.appendChild(svg('line', { x1: pad.l, x2: width - pad.r, y1: y(tick), y2: y(tick),
      stroke: 'var(--grid)', 'stroke-width': 1 }));
    const label = svg('text', { x: pad.l - 8, y: y(tick) + 4, 'text-anchor': 'end',
      fill: 'var(--muted)', 'font-size': 11 });
    label.textContent = fmt(tick);
    root.appendChild(label);
  }

  items.forEach((item, i) => {
    const cx = pad.l + slot * i + slot / 2;
    const barH = Math.max(2, plotH - (y(item.v) - pad.t));
    const bar = svg('rect', { x: cx - barW / 2, y: y(item.v), width: barW, height: barH,
      rx: 4, fill: item.color || 'var(--series-1)' });
    root.appendChild(bar);
    bar.addEventListener('mouseenter', () => showTip(host, tip, cx, y(item.v),
      `<b>${fmt(item.v)}</b><br>${esc(item.label)}`));
    bar.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });

  [0, items.length - 1].forEach((i, k) => {
    if (items.length < 2 && k === 1) return;
    const label = svg('text', { x: pad.l + slot * i + slot / 2, y: height - 8,
      fill: 'var(--muted)', 'font-size': 11, 'text-anchor': k === 0 ? 'start' : 'end' });
    label.textContent = items[i].short;
    root.appendChild(label);
  });
}

/* Horizontal bars for named categories - one hue, length is the message. */
function barChartH(host, items, opts) {
  opts = opts || {};
  if (!items.length) { host.innerHTML = '<p class="empty">Nothing collected yet.</p>'; return; }
  const rowH = 26, pad = { l: 190, r: 66, t: 4, b: 4 };
  const height = items.length * rowH + pad.t + pad.b;
  const { root, tip, width } = chartFrame(host, height);
  const plotW = Math.max(60, width - pad.l - pad.r);
  const max = Math.max(...items.map(d => d.v)) || 1;
  const fmt = opts.format || num;
  const scale = v => (v / max) * plotW;

  items.forEach((item, i) => {
    const y = pad.t + i * rowH;
    const name = svg('text', { x: pad.l - 10, y: y + rowH / 2 + 4, 'text-anchor': 'end',
      fill: 'var(--text-2)', 'font-size': 12.5 });
    name.textContent = item.label.length > 30 ? `${item.label.slice(0, 29)}…` : item.label;
    root.appendChild(name);
    const w = Math.max(2, scale(item.v));
    const bar = svg('rect', { x: pad.l, y: y + 5, width: w, height: rowH - 12, rx: 4,
      fill: item.color || 'var(--series-1)' });
    root.appendChild(bar);
    const value = svg('text', { x: pad.l + w + 8, y: y + rowH / 2 + 4, fill: 'var(--text-2)',
      'font-size': 12 });
    value.textContent = fmt(item.v);
    root.appendChild(value);
    bar.addEventListener('mouseenter', () => showTip(host, tip, pad.l + w / 2, y + 6,
      `<b>${fmt(item.v)}</b><br>${esc(item.sub || item.label)}`));
    bar.addEventListener('mouseleave', () => { tip.style.opacity = '0'; });
  });
}

/* ------------------------------------------------------------ 1. health */

function renderHeader() {
  const s = S.summary;
  $('#updated').textContent =
    `Last crawl ${ago(s.latest_run)} · ${num(s.totals.records)} records from ` +
    `${s.totals.sources} sources · page built ${ago(s.generated_at)}`;
  $('#footer').textContent =
    `Built by scripts/build_dashboard_data.py from ${num(s.totals.files)} data files ` +
    `across ${s.totals.runs} crawl runs. Source repository: ${s.repo || 'tamil-data-collector'}. ` +
    `This page is static — it is regenerated after every crawl.`;
}

function renderBanner() {
  const counts = S.summary.status_counts || {};
  const bad = (counts.fail || 0) + (counts.idle || 0);
  const warn = (counts.partial || 0) + (counts.stale || 0);
  const banner = $('#banner');
  banner.className = `banner ${bad ? 'critical' : warn ? 'warning' : 'good'}`;
  $('.icon', banner).textContent = bad ? '✕' : warn ? '!' : '✓';
  if (bad) {
    $('#banner-title').textContent = `${bad} source${bad > 1 ? 's' : ''} need attention`;
    $('#banner-text').textContent = 'They ran but produced nothing usable. The table below says what each one did.';
  } else if (warn) {
    $('#banner-title').textContent = `${counts.ok || 0} sources working, ${warn} partly done`;
    $('#banner-text').textContent = 'Nothing is broken. A partly-done source ran out of its time budget or logged a warning, and picks up where it left off next run.';
  } else {
    $('#banner-title').textContent = `All ${counts.ok || 0} sources are working`;
    $('#banner-text').textContent = 'Every spider ran and collected records in the most recent crawl.';
  }
}

function renderHealthKpis() {
  const s = S.summary;
  const runs = s.runs || [];
  const last = runs[runs.length - 1];
  const counts = s.status_counts || {};
  const host = $('#health-kpis');
  host.innerHTML = '';
  host.append(
    kpi('Sources working', `${counts.ok || 0}/${(counts.ok || 0) + (counts.partial || 0) +
      (counts.fail || 0) + (counts.idle || 0) + (counts.stale || 0)}`, 'in the latest crawl'),
    kpi('Records collected', num(s.totals.records), `across ${s.totals.sources} sources`),
    kpi('Last crawl took', duration(last && last.duration_s), last ? `run #${last.number}` : ''),
    kpi('Records flagged', num(s.totals.flagged),
      `${((s.totals.flagged / Math.max(s.totals.records, 1)) * 100).toFixed(1)}% — see Spot-checks`),
  );
}

function spiderDetail(row) {
  const parts = [];
  parts.push(el('div', {}, [
    el('h4', { text: 'What happened' }),
    el('p', { style: 'margin:0', text: row.explanation }),
    row.finish_reason ? el('p', { class: 'meta', style: 'margin:6px 0 0;color:var(--muted);font-size:12.5px',
      text: `Scrapy finish reason: ${row.finish_reason}` }) : null,
    row.coverage ? el('p', { style: 'margin:6px 0 0;font-size:13px',
      text: `${row.coverage.label}: ${num(row.coverage.done)} of ${num(row.coverage.total)} (${row.coverage.pct}%)` }) : null,
  ]));

  const facts = [
    ['Records this run', num(row.records)],
    ['Change vs previous', row.delta === null ? '—' : (row.delta > 0 ? `+${num(row.delta)}` : num(row.delta))],
    ['File size', bytes(row.bytes)],
    ['Requests made', row.requests ? num(row.requests) : '—'],
    ['Retries', row.retries ? num(row.retries) : '—'],
    ['Warnings', row.warnings ? num(row.warnings) : '—'],
    ['Typical text length', row.median_text_len ? `${num(row.median_text_len)} characters` : '—'],
    ['Tamil script share', row.tamil_ratio === undefined ? '—' : `${Math.round(row.tamil_ratio * 100)}%`],
    ['Last collected', row.last_run ? new Date(row.last_run).toLocaleString('en-GB') : '—'],
  ];
  parts.push(el('div', {}, [
    el('h4', { text: 'Numbers' }),
    el('table', {}, [el('tbody', {}, facts.map(([k, v]) =>
      el('tr', {}, [el('td', { text: k }), el('td', { class: 'num', text: v })])))]),
  ]));

  if (row.throttle && row.throttle.length) {
    parts.push(el('div', {}, [
      el('h4', { text: 'Crawl speed per site (AutoThrottle)' }),
      el('table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { text: 'Site' }), el('th', { class: 'num', text: 'Avg delay' }),
          el('th', { class: 'num', text: 'Max' }), el('th', { class: 'num', text: 'Site latency' })])]),
        el('tbody', {}, row.throttle.map(t => el('tr', {}, [
          el('td', { text: t.domain }),
          el('td', { class: 'num', text: `${num(t.avg_delay_ms)} ms` }),
          el('td', { class: 'num', text: `${num(t.max_delay_ms)} ms` }),
          el('td', { class: 'num', text: `${num(t.avg_latency_ms)} ms` }),
        ]))),
      ]),
    ]));
  }

  if (row.error_excerpts && row.error_excerpts.length) {
    parts.push(el('div', { style: 'grid-column:1/-1' }, [
      el('h4', { text: `Errors logged (${num(row.errors)})` }),
      el('pre', { class: 'log', text: row.error_excerpts.join('\n') }),
    ]));
  }

  const codes = Object.entries(row.status_counts || {});
  if (codes.length) {
    parts.push(el('div', {}, [
      el('h4', { text: 'HTTP responses' }),
      el('p', { style: 'margin:0;font-size:13px',
        text: codes.map(([code, count]) => `${code}: ${num(count)}`).join(' · ') }),
    ]));
  }
  return el('div', { class: 'detail detail-grid' }, parts);
}

function renderSpiderTable() {
  const order = { fail: 0, idle: 1, partial: 2, stale: 3, ok: 4, never_run: 5 };
  const rows = S.summary.spiders.slice().sort((a, b) =>
    (order[a.status] - order[b.status]) || (b.records - a.records));
  const body = $('#spider-table tbody');
  body.innerHTML = '';
  const neverRun = rows.filter(r => r.status === 'never_run');
  for (const row of rows.filter(r => r.status !== 'never_run')) {
    const delta = row.delta === null || row.delta === undefined ? '—'
      : row.delta === 0 ? '0' : (row.delta > 0 ? `+${num(row.delta)}` : num(row.delta));
    const tr = el('tr', { class: 'row' }, [
      el('td', {}, [el('strong', { text: row.label }),
        el('div', { class: 'meta', text: row.name })]),
      el('td', {}, [statusChip(row.status)]),
      el('td', { class: 'num', text: num(row.records) }),
      el('td', { class: 'num', text: delta }),
      el('td', { class: 'num', text: duration(row.duration_s) }),
      el('td', { class: 'num', text: row.errors ? num(row.errors) : '—' }),
      el('td', { class: 'meta', text: row.host || '—' }),
    ]);
    const detail = el('tr', { class: 'detail hidden' },
      [el('td', { colspan: 7 }, [spiderDetail(row)])]);
    tr.addEventListener('click', () => detail.classList.toggle('hidden'));
    body.append(tr, detail);
  }

  if (neverRun.length) {
    const hidden = neverRun.map(row => el('tr', { class: 'hidden' }, [
      el('td', {}, [el('strong', { text: row.label }), el('div', { class: 'meta', text: row.name })]),
      el('td', {}, [statusChip(row.status)]),
      el('td', { class: 'num', text: '0' }), el('td', { class: 'num', text: '—' }),
      el('td', { class: 'num', text: '—' }), el('td', { class: 'num', text: '—' }),
      el('td', { class: 'meta', text: '—' }),
    ]));
    const closed = `${neverRun.length} more spider${neverRun.length > 1 ? 's are' : ' is'} set up but ` +
      `${neverRun.length > 1 ? 'have' : 'has'} never collected anything — show`;
    const toggle = el('tr', {}, [el('td', { colspan: 7, class: 'meta' },
      [el('button', { class: 'ghost', type: 'button', text: closed,
        onclick: event => {
          const show = hidden[0].classList.contains('hidden');
          hidden.forEach(tr => tr.classList.toggle('hidden', !show));
          event.target.textContent = show ? 'Hide them again' : closed;
        } })])]);
    body.append(toggle, ...hidden);
  }
}

function renderRunChart() {
  const runs = (S.summary.runs || []).filter(r => r.duration_s !== null);
  const items = runs.map(r => ({
    v: r.duration_s,
    label: `Run #${r.number} · ${new Date(r.created_at).toLocaleString('en-GB')} · ${r.conclusion || r.status}`,
    short: shortDate(r.created_at),
    color: r.conclusion && r.conclusion !== 'success' ? 'var(--critical)' : 'var(--series-1)',
  }));
  barChart($('#chart-duration'), items, { format: duration, height: 200 });
  const failed = items.some(i => i.color === 'var(--critical)');
  $('#duration-legend').innerHTML =
    `<span><i class="swatch" style="background:var(--series-1)"></i> completed run</span>` +
    (failed ? `<span><i class="swatch" style="background:var(--critical)"></i> ✕ failed run</span>` : '');
}

function renderThrottle() {
  const domains = [];
  for (const row of S.summary.spiders) {
    for (const t of row.throttle || []) domains.push(Object.assign({ spider: row.label }, t));
  }
  const host = $('#throttle');
  host.innerHTML = '';
  if (!domains.length) {
    let why;
    const haveLogs = S.summary.logs_available !== undefined
      ? S.summary.logs_available
      : S.summary.spiders.some(r => r.duration_s);
    if (!haveLogs) {
      why = 'No crawl logs were available when this page was built, so there is no ' +
            'per-site detail yet. It appears after the next crawl.';
    } else if (!S.summary.autothrottle_enabled) {
      why = 'AutoThrottle is currently switched off in tamil_harvest/settings.py, so the ' +
            'crawler uses one fixed delay for every site rather than adapting per site. ' +
            'Turn AUTOTHROTTLE_ENABLED on and this panel fills in by itself — the workflow ' +
            'already asks Scrapy to record the detail.';
    } else {
      why = 'AutoThrottle is on but logged no per-request detail this run.';
    }
    host.appendChild(el('p', { class: 'empty', text: why }));
    return;
  }
  domains.sort((a, b) => b.avg_delay_ms - a.avg_delay_ms);
  barChartH(host, domains.slice(0, 14).map(d => ({
    label: d.domain, v: d.avg_delay_ms, sub: `${d.domain} — ${d.spider}, ${num(d.samples)} requests, site replied in ${num(d.avg_latency_ms)} ms`,
  })), { format: v => `${num(Math.round(v))} ms` });
}

/* -------------------------------------------------------------- 2. data */

function renderData() {
  const s = S.summary, h = S.history || [];
  const host = $('#data-kpis');
  host.innerHTML = '';
  const growth = h.length > 1 ? h[h.length - 1].records - h[0].records : 0;
  host.append(
    kpi('Records in collection', num(s.totals.records), 'latest file from each source'),
    kpi('Tamil + English text', `${num(Math.round(s.totals.text_chars / 1000))}k`, 'characters of text collected'),
    kpi('Everything archived', bytes(s.totals.repo_bytes), `${num(s.totals.files)} files, ${s.totals.runs} runs`),
    kpi('Growth so far', growth >= 0 ? `+${num(growth)}` : num(growth), 'records since the first run tracked'),
  );

  lineChart($('#chart-records'), h.map(p => ({
    v: p.records, label: shortDate(p.ts),
    full: `${new Date(p.ts).toLocaleString('en-GB')} · ${p.spiders_ran} sources ran`,
  })));
  lineChart($('#chart-size'), h.map(p => ({
    v: p.repo_bytes, label: shortDate(p.ts),
    full: new Date(p.ts).toLocaleString('en-GB'),
  })), { format: bytes });

  const sources = s.spiders.filter(r => r.records > 0)
    .map(r => ({ label: r.label, v: r.records, sub: `${r.label} — ${bytes(r.bytes)}, ${r.host || 'no host'}` }));
  barChartH($('#chart-sources'), sources, { format: num });

  const cov = $('#coverage');
  cov.innerHTML = '';
  const withCoverage = s.spiders.filter(r => r.coverage);
  if (!withCoverage.length) {
    cov.appendChild(el('p', { class: 'empty', text: 'No source has a measurable total yet.' }));
  }
  for (const row of withCoverage) {
    const c = row.coverage;
    cov.appendChild(el('div', { class: 'meter' }, [
      el('div', { class: 'top' }, [
        el('strong', { text: `${row.label} — ${c.label}` }),
        el('span', { text: `${num(c.done)} of ${num(c.total)} · ${c.pct}%` }),
      ]),
      el('div', { class: 'track' }, [el('div', { class: 'fill',
        style: `width:${Math.max(0.6, Math.min(100, c.pct))}%` })]),
      el('div', { class: 'note', text: c.note || '' }),
    ]));
  }
}

/* ----------------------------------------------------------- 3. quality */

function recordCard(rec, sourceLabel) {
  const flags = (rec.flags || rec.f || []).map(f =>
    el('span', { class: 'flag', title: (S.summary.flag_labels || {})[f] || f,
      text: `⚠ ${(S.summary.flag_labels || {})[f] || f}` }));
  const url = rec.url || rec.u;
  const title = rec.title || rec.t || '(untitled)';
  return el('div', { class: 'rec' }, [
    el('div', { class: 'rec-head' }, [
      el('h3', {}, [url ? el('a', { href: url, target: '_blank', rel: 'noopener', text: title })
                        : document.createTextNode(title)]),
      el('span', { class: 'chip', text: sourceLabel }),
      rec.w ? el('span', { class: 'chip', text: 'new this run' }) : null,
      el('span', { class: 'meta', text: `${num(rec.text_len !== undefined ? rec.text_len : rec.n)} characters` }),
    ]),
    flags.length ? el('div', {}, flags) : null,
    el('div', { class: 'body', html: rec.__html || esc(rec.text || rec.x || '') || '<em>No text on this record.</em>' }),
    rec.fields ? el('div', { class: 'fields' }, Object.entries(rec.fields).map(([k, v]) =>
      el('div', { text: `${k}: ${v}` }))) : null,
    (rec.c || rec.context) ? el('div', { class: 'fields' },
      [el('div', { text: rec.c || rec.context })]) : null,
    url ? el('div', { class: 'meta', style: 'margin-top:6px' },
      [el('a', { href: url, target: '_blank', rel: 'noopener', text: url })]) : null,
  ]);
}

function renderQuality() {
  const select = $('#q-source');
  if (!select.options.length) {
    const withSamples = S.summary.spiders.filter(r => S.samples[r.name] && S.samples[r.name].length);
    withSamples.sort((a, b) => (b.flagged || 0) - (a.flagged || 0) || b.records - a.records);
    for (const row of withSamples) {
      select.appendChild(el('option', { value: row.name,
        text: `${row.label}${row.flagged ? ` — ${row.flagged_pct}% flagged` : ''}` }));
    }
    select.addEventListener('change', renderSamples);
    $('#q-flagged').addEventListener('change', renderSamples);
  }
  renderSamples();
}

function renderSamples() {
  const name = $('#q-source').value;
  const row = S.summary.spiders.find(r => r.name === name);
  const onlyFlagged = $('#q-flagged').value === 'flagged';
  let list = (S.samples[name] || []);
  if (onlyFlagged) list = list.filter(r => r.flags && r.flags.length);

  const summary = $('#quality-summary');
  summary.innerHTML = '';
  if (row) {
    const flagBits = Object.entries(row.flag_counts || {})
      .sort((a, b) => b[1] - a[1])
      .map(([flag, count]) => `${(S.summary.flag_labels || {})[flag] || flag}: ${num(count)}`);
    summary.appendChild(el('div', { class: 'banner ' + (row.flagged_pct >= 20 ? 'warning' : 'good') }, [
      el('span', { class: 'icon', text: row.flagged_pct >= 20 ? '!' : '✓' }),
      el('div', {}, [
        el('strong', { text: `${num(row.records)} record${row.records === 1 ? '' : 's'} · ` +
          `${row.flagged_pct || 0}% carry a warning` }),
        el('p', { text: flagBits.length ? flagBits.join(' · ')
          : 'Nothing looks wrong in the automatic checks. Read a few records anyway.' }),
      ]),
    ]));
  }

  const host = $('#samples');
  host.innerHTML = '';
  if (!list.length) { host.appendChild(el('p', { class: 'empty', text: 'No sampled records match.' })); return; }
  for (const rec of list) host.appendChild(recordCard(rec, row ? row.label : name));
}

/* ------------------------------------------------------------ 4. browse */

async function loadManifest() {
  if (S.manifest) return;
  S.manifest = await getJSON('browse/manifest.json');
  const select = $('#b-source');
  select.appendChild(el('option', { value: '', text: 'All sources' }));
  for (const source of S.manifest.sources) {
    select.appendChild(el('option', { value: source.name,
      text: `${source.label} (${num(source.records)})` }));
  }
}

async function getShard(source, index) {
  const key = `${source}/${index}`;
  if (S.shards.has(key)) return S.shards.get(key);
  const shard = await getJSON(`browse/${source}/${String(index).padStart(4, '0')}.json`);
  if (S.shards.size > 60) S.shards.clear();      // keep memory bounded
  S.shards.set(key, shard);
  return shard;
}

function currentFilters() {
  return {
    source: $('#b-source').value,
    query: $('#b-query').value.trim().toLowerCase(),
    from: $('#b-from').value,
    to: $('#b-to').value,
    flagged: $('#b-flagged').checked,
  };
}

function matches(rec, filters) {
  if (filters.flagged && !(rec.f && rec.f.length)) return false;
  if (filters.from && (!rec.s || rec.s < filters.from)) return false;
  if (filters.to && (!rec.s || rec.s > filters.to)) return false;
  if (filters.query) {
    const hay = `${rec.t} ${rec.x} ${rec.c} ${rec.u}`.toLowerCase();
    if (!hay.includes(filters.query)) return false;
  }
  return true;
}

async function scan(reset) {
  if (S.searching) return;
  S.searching = true;
  $('#b-go').disabled = true;
  const filters = currentFilters();
  const sources = S.manifest.sources.filter(s => !filters.source || s.name === filters.source);

  if (reset) {
    S.results = []; S.scanned = 0; S.page = 0; S.cursor = { source: 0, shard: 0 };
    writeFiltersToUrl();
  }
  const total = sources.reduce((sum, s) => sum + s.records, 0);
  let fetched = 0;

  try {
    while (S.cursor.source < sources.length && fetched < SHARD_BUDGET && S.results.length < RESULT_CAP) {
      const source = sources[S.cursor.source];
      if (S.cursor.shard >= source.shards) { S.cursor.source++; S.cursor.shard = 0; continue; }
      $('#browse-status').textContent =
        `Reading ${source.label}… ${num(S.results.length)} matches so far`;
      const shard = await getShard(source.name, S.cursor.shard);
      for (const rec of shard) {
        S.scanned++;
        if (matches(rec, filters)) {
          rec.__source = source.label;
          S.results.push(rec);
          if (S.results.length >= RESULT_CAP) break;
        }
      }
      S.cursor.shard++;
      fetched++;
    }
  } catch (err) {
    $('#browse-status').textContent = `Could not load records: ${err.message}`;
    S.searching = false; $('#b-go').disabled = false;
    return;
  }

  const done = S.cursor.source >= sources.length;
  const capped = S.results.length >= RESULT_CAP;
  $('#browse-status').textContent = S.results.length
    ? `${num(S.results.length)}${capped ? '+' : ''} matching records · searched ${num(S.scanned)} of ${num(total)}`
    : `No matches yet · searched ${num(S.scanned)} of ${num(total)} records`;

  const more = $('#browse-more');
  more.innerHTML = '';
  if (!done && !capped) {
    more.appendChild(el('p', { class: 'pager' }, [
      el('button', { class: 'ghost', type: 'button', onclick: () => scan(false),
        text: `Keep searching the remaining ${num(total - S.scanned)} records` }),
    ]));
  } else if (capped) {
    more.appendChild(el('p', { class: 'empty', text:
      `Stopped at ${num(RESULT_CAP)} matches — narrow the keyword or pick one source to see the rest.` }));
  }
  S.searching = false;
  $('#b-go').disabled = false;
  renderResults();
}

function highlight(text, query) {
  const safe = esc(text);
  if (!query) return safe;
  const pattern = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return safe.replace(new RegExp(pattern, 'gi'), m => `<mark>${m}</mark>`);
}

function renderResults() {
  const host = $('#browse-results');
  host.innerHTML = '';
  const filters = currentFilters();
  const pages = Math.ceil(S.results.length / PAGE_SIZE);
  S.page = Math.min(S.page, Math.max(pages - 1, 0));
  const slice = S.results.slice(S.page * PAGE_SIZE, (S.page + 1) * PAGE_SIZE);
  if (!slice.length) {
    host.appendChild(el('p', { class: 'empty', text: 'Nothing to show for these filters.' }));
    $('#browse-pager').classList.add('hidden');
    return;
  }
  for (const rec of slice) {
    const copy = Object.assign({}, rec);
    copy.__html = highlight(rec.x || '', filters.query) ||
      '<em>No text stored for this record — open the link to see the original.</em>';
    copy.fields = null;
    const card = recordCard(copy, rec.__source);
    if (rec.s) card.querySelector('.rec-head').appendChild(
      el('span', { class: 'meta', text: `first collected ${rec.s}` }));
    host.appendChild(card);
  }
  $('#browse-pager').classList.remove('hidden');
  $('#b-page').textContent = `Page ${S.page + 1} of ${pages}`;
  $('#b-prev').disabled = S.page === 0;
  $('#b-next').disabled = S.page >= pages - 1;
}

function readFiltersFromUrl() {
  const params = new URLSearchParams(location.search);
  const set = (id, key) => { if (params.has(key)) $(id).value = params.get(key); };
  set('#b-query', 'q');
  set('#b-from', 'from');
  set('#b-to', 'to');
  const source = params.get('source');
  if (source && $$('#b-source option').some(o => o.value === source)) $('#b-source').value = source;
  $('#b-flagged').checked = params.get('flagged') === '1';
}

function writeFiltersToUrl() {
  const f = currentFilters();
  const params = new URLSearchParams();
  if (f.query) params.set('q', f.query);
  if (f.source) params.set('source', f.source);
  if (f.from) params.set('from', f.from);
  if (f.to) params.set('to', f.to);
  if (f.flagged) params.set('flagged', '1');
  const query = params.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}#browse`);
}

async function initBrowse() {
  if (S.manifest) return;
  $('#browse-status').textContent = 'Loading…';
  await loadManifest();
  readFiltersFromUrl();
  $('#b-go').addEventListener('click', () => scan(true));
  $('#b-query').addEventListener('keydown', e => { if (e.key === 'Enter') scan(true); });
  for (const id of ['#b-source', '#b-from', '#b-to', '#b-flagged']) {
    $(id).addEventListener('change', () => scan(true));
  }
  $('#b-prev').addEventListener('click', () => { S.page--; renderResults(); window.scrollTo({ top: 220 }); });
  $('#b-next').addEventListener('click', () => { S.page++; renderResults(); window.scrollTo({ top: 220 }); });
  await scan(true);
}

/* ---------------------------------------------------------------- boot */

function showTab(name) {
  for (const button of $$('#tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const section of $$('.tab')) section.classList.add('hidden');
  $(`#tab-${name}`).classList.remove('hidden');
  location.hash = name;
  if (name === 'browse') initBrowse();
  if (name === 'data') requestAnimationFrame(renderData);
  if (name === 'health') requestAnimationFrame(() => { renderRunChart(); renderThrottle(); });
}

async function init() {
  try {
    const [summary, history, samples] = await Promise.all([
      getJSON('data/summary.json'), getJSON('data/history.json'), getJSON('data/samples.json'),
    ]);
    S.summary = summary; S.history = history; S.samples = samples;
  } catch (err) {
    $('#loading').classList.add('hidden');
    $('#error').classList.remove('hidden');
    $('#error-detail').textContent = err.message;
    return;
  }
  $('#loading').classList.add('hidden');
  renderHeader();
  renderBanner();
  renderHealthKpis();
  renderSpiderTable();
  renderQuality();
  for (const button of $$('#tabs button')) {
    button.addEventListener('click', () => showTab(button.dataset.tab));
  }
  showTab((location.hash || '#health').slice(1));

  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!$('#tab-health').classList.contains('hidden')) { renderRunChart(); renderThrottle(); }
      if (!$('#tab-data').classList.contains('hidden')) renderData();
    }, 180);
  });
}

$('#theme').addEventListener('click', () => {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark' ||
    (!document.documentElement.getAttribute('data-theme') &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'light' : 'dark');
  try { localStorage.setItem('theme', dark ? 'light' : 'dark'); } catch (e) { /* private mode */ }
  if (!$('#tab-health').classList.contains('hidden')) { renderRunChart(); renderThrottle(); }
  if (!$('#tab-data').classList.contains('hidden')) renderData();
});
try {
  const saved = localStorage.getItem('theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
} catch (e) { /* private mode */ }

init();
