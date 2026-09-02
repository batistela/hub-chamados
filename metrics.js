// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
// Segunda página do Hub — métricas/BI. Lê os mesmos dados que o background.js já salva
// no chrome.storage.local (state, events, dailySnapshots, config) — não faz nenhuma
// checagem própria, só apresenta o que já existe de um jeito mais interativo: um filtro
// único (período + fontes) que vale pra tudo na página, gráficos com crosshair/tooltip e
// legenda clicável, atividade com drill-down por dia, e rankings que filtram a lista de
// "parados" ao clicar.

const GLPI_BASE = 'http://chamadosti.holambra.corp';
const MOVIDESK_BASE = 'https://keyrus-brasil.movidesk.com';
const NS = 'http://www.w3.org/2000/svg';

const el = (id) => document.getElementById(id);

const CLOSED_STATUS_RE = /encerr|fechad|solucion|resolvid|cancel|conclu[ií]d/i;

// ---------- tema claro/escuro ----------
// Mesmo mecanismo do dashboard.js (chave própria "uiTheme" no storage, fora de `config`)
// — duplicado aqui porque cada página da extensão roda seu próprio script isolado.
function setThemeAttr(theme) {
  if (theme === 'dark' || theme === 'light') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
  const btn = el('btnToggleTheme');
  if (btn) {
    btn.textContent = theme === 'dark' ? '☀️' : theme === 'light' ? '🌙' : '🌓';
    btn.title =
      theme === 'dark' ? 'Tema escuro (clique para claro)' :
      theme === 'light' ? 'Tema claro (clique para escuro)' :
      'Tema automático (clique para claro)';
  }
}
async function applyStoredTheme() {
  const { uiTheme } = await chrome.storage.local.get('uiTheme');
  setThemeAttr(uiTheme || null);
}
applyStoredTheme();

el('btnToggleTheme').addEventListener('click', async () => {
  const { uiTheme } = await chrome.storage.local.get('uiTheme');
  const next = uiTheme === 'light' ? 'dark' : uiTheme === 'dark' ? null : 'light';
  if (next) {
    await chrome.storage.local.set({ uiTheme: next });
  } else {
    await chrome.storage.local.remove('uiTheme');
  }
  setThemeAttr(next);
});

// ---------- datas ----------
// parseFlexibleDateTime/daysSinceUpdate duplicados do background.js de propósito — os
// dois precisam interpretar exatamente os mesmos formatos de `lastUpdate`.
function parseFlexibleDateTime(str) {
  if (!str) return null;
  const s = String(str).trim();
  let m = s.match(/^(\d{2})[\/\-](\d{2})[\/\-](\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, d, mo, y, h, mi, se] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(se || 0));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m) {
    const [, y, mo, d, h, mi, se] = m;
    const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0), Number(se || 0));
    return Number.isNaN(dt.getTime()) ? null : dt;
  }
  return null;
}
function daysSinceUpdate(lastUpdateStr) {
  const dt = parseFlexibleDateTime(lastUpdateStr);
  if (!dt) return null;
  const diffMs = Date.now() - dt.getTime();
  if (diffMs < 0) return null;
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}
function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
function fmtShortDate(dateStr) {
  const [, mo, d] = dateStr.split('-');
  return `${d}/${mo}`;
}
function fmtLongDate(dateStr) {
  const [y, mo, d] = dateStr.split('-');
  return `${d}/${mo}/${y}`;
}
function baseSourceName(source) {
  return String(source || '').replace(/\s*\(avulso\)\s*$/i, '').trim();
}

// ---------- estado carregado do storage ----------

let currentState = {};
let currentEvents = [];
let currentSnapshots = {};
let currentConfig = {};

// ---------- filtro global (período + fontes) — uma linha, vale pra tudo abaixo ----------
// Persistido numa chave própria do storage (fora de `config`, mesmo espírito do
// `uiTheme`) — não é configuração operacional do Hub, é só a preferência de visualização
// desta página, mas vale a pena lembrar entre aberturas.

const SOURCE_ORDER = ['glpi', 'evolutize', 'movidesk'];
const SOURCE_META = {
  glpi: { label: 'GLPI', color: 'var(--series-glpi)', stateKey: 'glpi' },
  evolutize: { label: 'Evolutize', color: 'var(--series-evolutize)', stateKey: 'evolutize' },
  movidesk: { label: 'Movidesk', color: 'var(--series-movidesk)', stateKey: 'movidesk' },
};

let filterState = { range: 30, sources: { glpi: true, evolutize: true, movidesk: true } };
let personFilter = null; // { field: 'lastUpdateBy' | 'requester', value: string }
let selectedDay = null;

function enabledSources() {
  return SOURCE_ORDER.filter((k) => filterState.sources[k]);
}

async function loadFilterState() {
  const { metricsFilters } = await chrome.storage.local.get('metricsFilters');
  if (metricsFilters && typeof metricsFilters === 'object') {
    filterState = {
      range: [7, 30, 90, 365].includes(Number(metricsFilters.range)) ? Number(metricsFilters.range) : 30,
      sources: {
        glpi: metricsFilters.sources ? metricsFilters.sources.glpi !== false : true,
        evolutize: metricsFilters.sources ? metricsFilters.sources.evolutize !== false : true,
        movidesk: metricsFilters.sources ? metricsFilters.sources.movidesk !== false : true,
      },
    };
  }
  syncFilterControls();
}

function saveFilterState() {
  chrome.storage.local.set({ metricsFilters: filterState });
}

function syncFilterControls() {
  document.querySelectorAll('#rangePills .pill').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.range) === filterState.range);
  });
  document.querySelectorAll('#sourceChips .chip').forEach((btn) => {
    btn.classList.toggle('active', !!filterState.sources[btn.dataset.source]);
  });
}

document.querySelectorAll('#rangePills .pill').forEach((btn) => {
  btn.addEventListener('click', () => {
    filterState.range = Number(btn.dataset.range);
    syncFilterControls();
    saveFilterState();
    renderAll();
  });
});
document.querySelectorAll('#sourceChips .chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.source;
    filterState.sources[key] = !filterState.sources[key];
    syncFilterControls();
    saveFilterState();
    renderAll();
  });
});

// ---------- utilidades compartilhadas com o background.js (mesma leitura de dados) ----------

function countAbertos(map) {
  let n = 0;
  Object.values(map || {}).forEach((t) => { if (t && !CLOSED_STATUS_RE.test(t.status || '')) n++; });
  return n;
}

function countStaleNow(config, map) {
  const globalDays = Number(config.staleDays) > 0 ? Number(config.staleDays) : null;
  if (!globalDays) return 0;
  let count = 0;
  for (const data of Object.values(map || {})) {
    if (!data || data.error) continue;
    const days = daysSinceUpdate(data.lastUpdate);
    if (days == null) continue;
    if (days >= globalDays) count++;
  }
  return count;
}

function sortedDates(snapshots) {
  return Object.keys(snapshots).sort();
}
function lastNDates(dates, n) {
  return dates.slice(Math.max(0, dates.length - n));
}
function buildSeriesValues(snapshots, dates, sourceKey, metricKey) {
  return dates.map((d) => {
    const snap = snapshots[d];
    if (!snap || !snap[sourceKey]) return null;
    const v = snap[sourceKey][metricKey];
    return typeof v === 'number' ? v : null;
  });
}

// ---------- KPIs (stat tiles) ----------
// Valor = estado ATUAL (vivo); delta/sparkline = comparação com o início do período
// selecionado no filtro — assim os KPIs também respeitam o filtro de período, mesmo não
// tendo granularidade horária pra ter um "valor" próprio por período.

function renderSparkline(svgEl, values, color) {
  svgEl.innerHTML = '';
  const w = 84, h = 26, pad = 3;
  const known = values.map((v, i) => ({ v, i })).filter((p) => p.v != null);
  if (known.length < 2) return;
  let min = Math.min(...known.map((p) => p.v));
  let max = Math.max(...known.map((p) => p.v));
  if (min === max) { min -= 1; max += 1; }
  const xs = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const pts = known.map((p) => `${pad + xs * p.i},${pad + (h - pad * 2) * (1 - (p.v - min) / (max - min))}`);
  const poly = document.createElementNS(NS, 'polyline');
  poly.setAttribute('points', pts.join(' '));
  poly.setAttribute('style', `fill:none;stroke:${color};stroke-width:2`);
  svgEl.appendChild(poly);
  const last = known[known.length - 1];
  const c = document.createElementNS(NS, 'circle');
  c.setAttribute('cx', String(pad + xs * last.i));
  c.setAttribute('cy', String(pad + (h - pad * 2) * (1 - (last.v - min) / (max - min))));
  c.setAttribute('r', '2.5');
  c.setAttribute('fill', color);
  svgEl.appendChild(c);
}

function buildKpiTile(t) {
  const div = document.createElement('div');
  div.className = 'kpi-tile';

  const labelRow = document.createElement('div');
  labelRow.className = 'kpi-label';
  const dot = document.createElement('span');
  dot.className = 'chip-dot';
  dot.style.background = t.color;
  dot.style.opacity = '1';
  labelRow.appendChild(dot);
  labelRow.appendChild(document.createTextNode(t.label));

  const value = document.createElement('div');
  value.className = 'kpi-value';
  value.textContent = String(t.value);

  const metaRow = document.createElement('div');
  metaRow.className = 'kpi-meta';
  const deltaEl = document.createElement('div');
  deltaEl.className = 'kpi-delta';
  const periodLabel = `${t.dates.length || filterState.range} dia${(t.dates.length || filterState.range) === 1 ? '' : 's'}`;
  if (t.delta == null) {
    deltaEl.classList.add('flat');
    deltaEl.textContent = 'sem histórico suficiente ainda';
  } else if (t.delta === 0) {
    deltaEl.classList.add('flat');
    deltaEl.textContent = `estável — últimos ${periodLabel}`;
  } else {
    const up = t.delta > 0;
    const bad = t.badWhenUp ? up : !up;
    deltaEl.classList.add(bad ? 'up-bad' : 'up-good');
    deltaEl.textContent = `${up ? '▲' : '▼'} ${Math.abs(t.delta)} — últimos ${periodLabel}`;
  }

  const spark = document.createElementNS(NS, 'svg');
  spark.setAttribute('class', 'kpi-sparkline');
  spark.setAttribute('viewBox', '0 0 84 26');
  renderSparkline(spark, t.sparkValues, t.color);

  metaRow.appendChild(deltaEl);
  metaRow.appendChild(spark);
  div.appendChild(labelRow);
  div.appendChild(value);
  div.appendChild(metaRow);
  return div;
}

function renderKpis() {
  const dates = lastNDates(sortedDates(currentSnapshots), filterState.range);
  const startSnap = dates.length ? currentSnapshots[dates[0]] : null;
  const sources = enabledSources();
  const tiles = [];

  sources.forEach((key) => {
    const meta = SOURCE_META[key];
    const map = currentState[meta.stateKey] || {};
    const value = countAbertos(map);
    const startVal = startSnap && startSnap[meta.stateKey] ? startSnap[meta.stateKey].abertos : null;
    const delta = startVal != null ? value - startVal : null;
    tiles.push({
      key, label: `${meta.label} — abertos`, color: meta.color, value, delta, badWhenUp: true,
      sparkValues: buildSeriesValues(currentSnapshots, dates, meta.stateKey, 'abertos'), dates,
    });
  });

  let paradosNow = 0;
  sources.forEach((key) => { paradosNow += countStaleNow(currentConfig, currentState[SOURCE_META[key].stateKey]); });
  let paradosStart = null;
  if (startSnap) {
    paradosStart = 0;
    sources.forEach((key) => { const s = startSnap[SOURCE_META[key].stateKey]; if (s) paradosStart += (s.parados || 0); });
  }
  const paradosSpark = dates.map((d) => {
    const snap = currentSnapshots[d];
    if (!snap) return null;
    let sum = 0, has = false;
    sources.forEach((key) => { const s = snap[SOURCE_META[key].stateKey]; if (s) { sum += (s.parados || 0); has = true; } });
    return has ? sum : null;
  });
  tiles.push({
    key: 'parados', label: 'Parados agora (total)', color: 'var(--status-critical)', value: paradosNow,
    delta: paradosStart != null ? paradosNow - paradosStart : null, badWhenUp: true, sparkValues: paradosSpark, dates,
  });

  const row = el('kpiRow');
  row.innerHTML = '';
  if (!tiles.length) {
    row.innerHTML = '<p class="muted small">Nenhuma fonte selecionada no filtro acima.</p>';
    return;
  }
  tiles.forEach((t) => row.appendChild(buildKpiTile(t)));
}

// ---------- chamados parados agora ----------

function ticketLink(source, id, data) {
  if (data && data.url) return data.url;
  if (source === 'GLPI') return `${GLPI_BASE}/front/ticket.form.php?id=${id}`;
  if (source === 'Movidesk') return `${MOVIDESK_BASE}/Ticket/Edit/${id}`;
  return null;
}

function renderParadosFilterChip() {
  const div = el('paradosFilterChip');
  div.innerHTML = '';
  if (!personFilter) return;
  const chip = document.createElement('span');
  chip.className = 'active-filter-chip';
  const label = document.createElement('span');
  label.textContent = `Filtrado por: ${personFilter.value}`;
  const btn = document.createElement('button');
  btn.textContent = '✕';
  btn.title = 'Limpar filtro';
  btn.addEventListener('click', () => {
    personFilter = null;
    renderParados();
    renderEditorsAndRequesters();
  });
  chip.appendChild(label);
  chip.appendChild(btn);
  div.appendChild(chip);
}

function renderParados() {
  renderParadosFilterChip();
  const globalDays = Number(currentConfig.staleDays) > 0 ? Number(currentConfig.staleDays) : null;
  const rows = [];
  const sources = enabledSources();

  const collect = (map, source) => {
    Object.entries(map || {}).forEach(([id, data]) => {
      if (!data || data.error) return;
      if (CLOSED_STATUS_RE.test(data.status || '')) return;
      if (personFilter && data[personFilter.field] !== personFilter.value) return;
      const days = daysSinceUpdate(data.lastUpdate);
      if (days == null) return;
      rows.push({ source, id, title: data.title, status: data.status, days, lastUpdate: data.lastUpdate, url: ticketLink(source, id, data) });
    });
  };
  if (sources.includes('glpi')) collect(currentState.glpi, 'GLPI');
  if (sources.includes('evolutize')) collect(currentState.evolutize, 'Evolutize');
  rows.sort((a, b) => b.days - a.days);

  el('countParados').textContent = rows.length ? `(${rows.length})` : '';
  const ul = el('paradosList');
  ul.innerHTML = '';
  if (!rows.length) {
    ul.innerHTML = '<li class="muted">Nenhum chamado em aberto corresponde ao filtro atual.</li>';
    return;
  }
  rows.slice(0, 150).forEach((r) => {
    const li = document.createElement('li');
    if (globalDays && r.days >= globalDays) li.className = 'parado';
    const idLabel = `[${r.source}] ${r.id}`;
    const idPart = r.url ? `<a href="${r.url}" target="_blank">${idLabel}</a>` : idLabel;
    const body = document.createElement('div');
    body.className = 'event-body';
    body.innerHTML = `<strong>${idPart}</strong> — ${r.title || ''}<div class="event-meta">${r.days} dia${r.days === 1 ? '' : 's'} sem tramitação (última em ${r.lastUpdate}) — status: ${r.status || '—'}</div>`;
    li.appendChild(body);
    ul.appendChild(li);
  });
}

// ---------- núcleo dos gráficos de linha (tendência) ----------
// Compartilhado pelos dois gráficos (abertos/parados) — cada um mantém seu próprio
// estado de "isolar série" (clique na legenda) e "ver como tabela".

function computeChartGeometry(pointCount) {
  const width = 680, height = 220, padL = 34, padR = 10, padT = 12, padB = 22;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const xStep = pointCount > 1 ? innerW / (pointCount - 1) : 0;
  return { width, height, padL, padR, padT, padB, innerW, innerH, xStep, xFor: (i) => padL + xStep * i };
}

function renderLineChartSvg(svgEl, dates, series, wrapEl, tooltipEl) {
  svgEl.innerHTML = '';
  if (tooltipEl) tooltipEl.hidden = true;

  if (!dates.length || !series.length) {
    const g = computeChartGeometry(2);
    svgEl.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
    const text = document.createElementNS(NS, 'text');
    text.setAttribute('x', '10');
    text.setAttribute('y', '110');
    text.setAttribute('class', 'chart-axis-label');
    text.textContent = dates.length
      ? 'Nenhuma fonte selecionada — marque ao menos uma no filtro acima.'
      : 'Ainda não há dados suficientes — volte depois de alguns dias de uso.';
    svgEl.appendChild(text);
    return;
  }

  const g = computeChartGeometry(dates.length);
  svgEl.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);

  let maxVal = 1;
  series.forEach((s) => s.values.forEach((v) => { if (v != null && v > maxVal) maxVal = v; }));
  maxVal = Math.max(1, Math.ceil(maxVal * 1.15));
  const yFor = (v) => g.padT + g.innerH - (v / maxVal) * g.innerH;

  const gridCount = 4;
  for (let i = 0; i <= gridCount; i++) {
    const y = g.padT + (g.innerH / gridCount) * i;
    const line = document.createElementNS(NS, 'line');
    line.setAttribute('x1', String(g.padL));
    line.setAttribute('x2', String(g.width - g.padR));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    line.setAttribute('class', 'chart-grid-line');
    svgEl.appendChild(line);
    const val = Math.round(maxVal - (maxVal / gridCount) * i);
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', '2');
    t.setAttribute('y', String(y + 3));
    t.setAttribute('class', 'chart-axis-label');
    t.textContent = String(val);
    svgEl.appendChild(t);
  }
  const baseline = document.createElementNS(NS, 'line');
  baseline.setAttribute('x1', String(g.padL));
  baseline.setAttribute('x2', String(g.width - g.padR));
  baseline.setAttribute('y1', String(g.padT + g.innerH));
  baseline.setAttribute('y2', String(g.padT + g.innerH));
  baseline.setAttribute('class', 'chart-baseline-line');
  svgEl.appendChild(baseline);

  const labelEvery = Math.max(1, Math.ceil(dates.length / 6));
  dates.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== dates.length - 1) return;
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', String(g.xFor(i)));
    t.setAttribute('y', String(g.height - 4));
    t.setAttribute('class', 'chart-axis-label');
    t.setAttribute('text-anchor', i === dates.length - 1 ? 'end' : 'middle');
    t.textContent = fmtShortDate(d);
    svgEl.appendChild(t);
  });

  series.forEach((s) => {
    const points = [];
    dates.forEach((d, i) => { const v = s.values[i]; if (v == null) return; points.push(`${g.xFor(i)},${yFor(v)}`); });
    if (points.length >= 2) {
      const poly = document.createElementNS(NS, 'polyline');
      poly.setAttribute('points', points.join(' '));
      poly.setAttribute('style', `fill:none;stroke:${s.color};stroke-width:2`);
      svgEl.appendChild(poly);
    }
    dates.forEach((d, i) => {
      const v = s.values[i];
      if (v == null) return;
      const snap = currentSnapshots[d];
      const isLast = i === dates.length - 1;
      const c = document.createElementNS(NS, 'circle');
      c.setAttribute('cx', String(g.xFor(i)));
      c.setAttribute('cy', String(yFor(v)));
      c.setAttribute('r', isLast ? '3.5' : '2');
      c.setAttribute('fill', snap && snap.approximated ? 'var(--card-bg)' : s.color);
      c.setAttribute('stroke', s.color);
      c.setAttribute('stroke-width', '1.5');
      svgEl.appendChild(c);
    });
  });

  if (!wrapEl || !tooltipEl) return;

  // ---- crosshair + tooltip (mouse e teclado) ----
  const crosshair = document.createElementNS(NS, 'line');
  crosshair.setAttribute('class', 'chart-crosshair');
  crosshair.setAttribute('y1', String(g.padT));
  crosshair.setAttribute('y2', String(g.padT + g.innerH));
  crosshair.setAttribute('visibility', 'hidden');
  svgEl.appendChild(crosshair);

  const hit = document.createElementNS(NS, 'rect');
  hit.setAttribute('class', 'chart-hit-layer');
  hit.setAttribute('x', String(g.padL));
  hit.setAttribute('y', '0');
  hit.setAttribute('width', String(g.innerW));
  hit.setAttribute('height', String(g.height));
  hit.setAttribute('tabindex', '0');
  hit.setAttribute('role', 'img');
  hit.setAttribute('aria-label', 'Gráfico de tendência — use as setas do teclado pra navegar pelos dias');
  svgEl.appendChild(hit);

  let kbIndex = dates.length - 1;

  function showAtIndex(idx) {
    idx = Math.max(0, Math.min(dates.length - 1, idx));
    const d = dates[idx];
    const cx = g.xFor(idx);
    crosshair.setAttribute('x1', String(cx));
    crosshair.setAttribute('x2', String(cx));
    crosshair.setAttribute('visibility', 'visible');

    tooltipEl.innerHTML = '';
    const dateEl = document.createElement('div');
    dateEl.className = 'tt-date';
    dateEl.textContent = fmtLongDate(d);
    tooltipEl.appendChild(dateEl);
    series.forEach((s) => {
      const v = s.values[idx];
      const row = document.createElement('div');
      row.className = 'tt-row';
      const key = document.createElement('div');
      key.className = 'tt-key';
      const sw = document.createElement('span');
      sw.className = 'swatch-line';
      sw.style.background = s.color;
      key.appendChild(sw);
      const label = document.createElement('span');
      label.textContent = s.label;
      key.appendChild(label);
      const val = document.createElement('div');
      val.className = 'tt-value';
      val.textContent = v == null ? '—' : String(v);
      row.appendChild(key);
      row.appendChild(val);
      tooltipEl.appendChild(row);
    });
    const snap = currentSnapshots[d];
    if (snap && snap.approximated) {
      const note = document.createElement('div');
      note.className = 'tt-approx';
      note.textContent = 'valor aproximado (dia recuperado a partir do estado atual)';
      tooltipEl.appendChild(note);
    }

    const svgRect = svgEl.getBoundingClientRect();
    const scaleX = svgRect.width / g.width;
    tooltipEl.style.left = `${cx * scaleX}px`;
    tooltipEl.style.top = `${g.padT}px`;
    tooltipEl.hidden = false;
  }

  function hideTooltip() {
    crosshair.setAttribute('visibility', 'hidden');
    tooltipEl.hidden = true;
  }

  hit.addEventListener('pointermove', (ev) => {
    const svgRect = svgEl.getBoundingClientRect();
    const scaleX = svgRect.width / g.width;
    const xInViewBox = (ev.clientX - svgRect.left) / scaleX;
    const idx = g.xStep > 0 ? Math.round((xInViewBox - g.padL) / g.xStep) : 0;
    kbIndex = Math.max(0, Math.min(dates.length - 1, idx));
    showAtIndex(kbIndex);
  });
  hit.addEventListener('pointerleave', hideTooltip);
  hit.addEventListener('focus', () => showAtIndex(kbIndex));
  hit.addEventListener('blur', hideTooltip);
  hit.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowLeft') { kbIndex = Math.max(0, kbIndex - 1); showAtIndex(kbIndex); ev.preventDefault(); }
    else if (ev.key === 'ArrowRight') { kbIndex = Math.min(dates.length - 1, kbIndex + 1); showAtIndex(kbIndex); ev.preventDefault(); }
  });
}

function renderChartLegend(legendEl, allSeries, isolatedKey, onToggle) {
  legendEl.innerHTML = '';
  allSeries.forEach((s) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'legend-item line';
    if (isolatedKey === s.key) btn.classList.add('isolated');
    else if (isolatedKey) btn.classList.add('dimmed');
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = s.color;
    btn.appendChild(sw);
    btn.appendChild(document.createTextNode(s.label));
    btn.title = isolatedKey === s.key ? 'Clique pra mostrar todas de novo' : 'Clique pra isolar essa série';
    btn.addEventListener('click', () => onToggle(s.key));
    legendEl.appendChild(btn);
  });
}

function renderLineChartTable(tableEl, dates, series) {
  tableEl.innerHTML = '';
  if (!dates.length || !series.length) {
    tableEl.hidden = true;
    return;
  }
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const thDate = document.createElement('th');
  thDate.textContent = 'Data';
  headRow.appendChild(thDate);
  series.forEach((s) => {
    const th = document.createElement('th');
    th.textContent = s.label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement('tbody');
  dates.forEach((d, i) => {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = fmtLongDate(d);
    tr.appendChild(tdDate);
    series.forEach((s) => {
      const td = document.createElement('td');
      const v = s.values[i];
      td.textContent = v == null ? '—' : String(v);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  tableEl.appendChild(tbody);
}

// Uma "controller" por gráfico de tendência — guarda o estado de isolar-série e
// ver-como-tabela de cada um separadamente, mas os dois leem o mesmo filtro global.
function makeTrendChartController(metricKey, ids, showSnapshotNote) {
  let isolated = null;
  let showTable = false;

  function draw() {
    const dates = lastNDates(sortedDates(currentSnapshots), filterState.range);
    const sources = enabledSources();
    const allSeries = sources.map((key) => ({
      key,
      label: SOURCE_META[key].label,
      color: SOURCE_META[key].color,
      values: buildSeriesValues(currentSnapshots, dates, SOURCE_META[key].stateKey, metricKey),
    }));
    const visible = isolated ? allSeries.filter((s) => s.key === isolated) : allSeries;

    renderLineChartSvg(el(ids.svg), dates, visible, el(ids.wrap), el(ids.tooltip));
    renderChartLegend(el(ids.legend), allSeries, isolated, (key) => {
      isolated = isolated === key ? null : key;
      draw();
    });
    if (showTable) renderLineChartTable(el(ids.table), dates, visible);

    if (showSnapshotNote) {
      const note = el('snapshotNote');
      if (!dates.length) {
        note.textContent = '';
      } else {
        const lastDate = dates[dates.length - 1];
        const lastSnap = currentSnapshots[lastDate];
        note.textContent = lastSnap && lastSnap.approximated
          ? `O ponto mais recente (${fmtShortDate(lastDate)}) é uma aproximação a partir do estado atual — o Hub ainda não registrou o fechamento "de verdade" desse dia (só acontece a partir das 17h com o Chrome aberto).`
          : '';
      }
    }
  }

  el(ids.tableBtn).addEventListener('click', () => {
    showTable = !showTable;
    el(ids.tableBtn).textContent = showTable ? 'Ocultar tabela' : 'Ver como tabela';
    el(ids.table).hidden = !showTable;
    draw();
  });

  return { draw };
}

const abertosChart = makeTrendChartController('abertos', {
  svg: 'chartAbertos', wrap: 'wrapAbertos', tooltip: 'tooltipAbertos',
  legend: 'legendAbertos', table: 'tableAbertos', tableBtn: 'btnTableAbertos',
}, true);

const paradosChart = makeTrendChartController('parados', {
  svg: 'chartParados', wrap: 'wrapParados', tooltip: 'tooltipParados',
  legend: 'legendParados', table: 'tableParados', tableBtn: 'btnTableParados',
}, false);

// ---------- atividade recente (events, por tipo, com drill-down por dia) ----------
// Separado por tipo de evento (barras empilhadas) em vez de um total único — o array de
// eventos inclui casos conhecidos de falso positivo (ex: GLPI reaparecendo sem mudança
// real), e um número só esconderia isso. A janela respeita o período do filtro global,
// limitada a 60 dias por legibilidade (uma coluna por dia fica ilegível além disso).

const CHANGE_ORDER = ['novo', 'status', 'sumiu', 'atualizacao', 'acompanhando', 'parado'];
const CHANGE_COLORS = {
  atualizacao: 'var(--activity-atualizacao)',
  parado: 'var(--activity-parado)',
  novo: 'var(--activity-novo)',
  status: 'var(--activity-status)',
  acompanhando: 'var(--activity-acompanhando)',
  sumiu: 'var(--activity-sumiu)',
};
const CHANGE_LABELS = {
  novo: 'Novo na lista',
  status: 'Mudança de status',
  sumiu: 'Sumiu da lista',
  atualizacao: 'Nova tramitação',
  acompanhando: 'Adicionado (avulso)',
  parado: 'Alerta de "parado"',
};

let activityByDay = {};
let activityDays = [];
let activityShowTable = false;

function activityWindowSize() {
  return Math.min(filterState.range, 60);
}

function renderActivity() {
  const windowSize = activityWindowSize();
  const now = new Date();
  activityDays = [];
  for (let i = windowSize - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    activityDays.push(localDateStr(d));
  }
  const sources = enabledSources();
  activityByDay = Object.fromEntries(activityDays.map((d) => [d, Object.fromEntries(CHANGE_ORDER.map((c) => [c, 0]))]));

  currentEvents.forEach((e) => {
    if (!e || !e.ts) return;
    const sourceKey = Object.keys(SOURCE_META).find((k) => SOURCE_META[k].label === baseSourceName(e.source));
    if (sourceKey && !sources.includes(sourceKey)) return;
    const dayStr = localDateStr(new Date(e.ts));
    if (!activityByDay[dayStr]) return;
    if (!CHANGE_ORDER.includes(e.change)) return;
    activityByDay[dayStr][e.change]++;
  });

  el('activitySubtitle').textContent = `(últimos ${windowSize} dia${windowSize === 1 ? '' : 's'}, por tipo)`;

  const totals = activityDays.map((d) => CHANGE_ORDER.reduce((sum, c) => sum + activityByDay[d][c], 0));
  const maxTotal = Math.max(1, ...totals);

  const container = el('activityChart');
  container.innerHTML = '';
  activityDays.forEach((d) => {
    const dayCol = document.createElement('div');
    dayCol.className = 'activity-day';
    if (d === selectedDay) dayCol.classList.add('selected');
    const wrap = document.createElement('div');
    wrap.className = 'activity-col-wrap';
    CHANGE_ORDER.forEach((c) => {
      const count = activityByDay[d][c];
      if (!count) return;
      const seg = document.createElement('div');
      seg.className = 'activity-seg';
      seg.style.height = `${(count / maxTotal) * 100}%`;
      seg.style.background = CHANGE_COLORS[c];
      seg.tabIndex = 0;
      seg.setAttribute('role', 'img');
      seg.setAttribute('aria-label', `${fmtLongDate(d)} — ${CHANGE_LABELS[c]}: ${count}`);
      const showTip = (ev) => showActivityTooltip(ev, d, c, count);
      seg.addEventListener('pointerenter', showTip);
      seg.addEventListener('pointermove', showTip);
      seg.addEventListener('pointerleave', hideActivityTooltip);
      seg.addEventListener('focus', showTip);
      seg.addEventListener('blur', hideActivityTooltip);
      wrap.appendChild(seg);
    });
    dayCol.appendChild(wrap);
    const label = document.createElement('div');
    label.className = 'activity-day-label';
    label.textContent = fmtShortDate(d);
    dayCol.appendChild(label);
    dayCol.addEventListener('click', () => {
      selectedDay = selectedDay === d ? null : d;
      renderActivity();
      renderDayDetail();
    });
    container.appendChild(dayCol);
  });

  const legend = el('legendActivity');
  legend.innerHTML = '';
  CHANGE_ORDER.forEach((c) => {
    const span = document.createElement('span');
    span.className = 'legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = CHANGE_COLORS[c];
    span.appendChild(swatch);
    span.appendChild(document.createTextNode(CHANGE_LABELS[c]));
    legend.appendChild(span);
  });

  if (activityShowTable) renderActivityTable();
  renderDayDetail();
}

function showActivityTooltip(ev, dayStr, changeKey, count) {
  const tooltip = el('tooltipActivity');
  const wrap = el('wrapActivity');
  const wrapRect = wrap.getBoundingClientRect();
  tooltip.innerHTML = '';
  const dateEl = document.createElement('div');
  dateEl.className = 'tt-date';
  dateEl.textContent = fmtLongDate(dayStr);
  tooltip.appendChild(dateEl);
  const row = document.createElement('div');
  row.className = 'tt-row';
  const key = document.createElement('div');
  key.className = 'tt-key';
  const sw = document.createElement('span');
  sw.className = 'swatch-box';
  sw.style.background = CHANGE_COLORS[changeKey];
  key.appendChild(sw);
  key.appendChild(document.createTextNode(CHANGE_LABELS[changeKey]));
  const val = document.createElement('div');
  val.className = 'tt-value';
  val.textContent = String(count);
  row.appendChild(key);
  row.appendChild(val);
  tooltip.appendChild(row);

  const targetRect = ev.currentTarget.getBoundingClientRect();
  // Posição vertical fixa perto do topo do gráfico (não segue a altura do segmento) —
  // assim o tooltip não pula de lugar dependendo de qual tipo de evento foi hoverado.
  tooltip.style.left = `${targetRect.left - wrapRect.left + targetRect.width / 2}px`;
  tooltip.style.top = '4px';
  tooltip.hidden = false;
}
function hideActivityTooltip() {
  el('tooltipActivity').hidden = true;
}

function renderActivityTable() {
  const table = el('tableActivity');
  table.innerHTML = '';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  ['Dia', ...CHANGE_ORDER.map((c) => CHANGE_LABELS[c]), 'Total'].forEach((label) => {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  activityDays.forEach((d) => {
    const tr = document.createElement('tr');
    const tdDate = document.createElement('td');
    tdDate.textContent = fmtLongDate(d);
    tr.appendChild(tdDate);
    let total = 0;
    CHANGE_ORDER.forEach((c) => {
      const td = document.createElement('td');
      const count = activityByDay[d][c];
      total += count;
      td.textContent = String(count);
      tr.appendChild(td);
    });
    const tdTotal = document.createElement('td');
    tdTotal.textContent = String(total);
    tr.appendChild(tdTotal);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
}

el('btnTableActivity').addEventListener('click', () => {
  activityShowTable = !activityShowTable;
  el('btnTableActivity').textContent = activityShowTable ? 'Ocultar tabela' : 'Ver como tabela';
  el('tableActivity').hidden = !activityShowTable;
  if (activityShowTable) renderActivityTable();
});

function eventLinkFor(e) {
  if (e.url) return e.url;
  const base = baseSourceName(e.source);
  if (base === 'GLPI') return `${GLPI_BASE}/front/ticket.form.php?id=${e.id}`;
  if (base === 'Movidesk') return `${MOVIDESK_BASE}/Ticket/Edit/${e.id}`;
  return null;
}

function buildEventLi(e) {
  const li = document.createElement('li');
  li.className = e.change;
  const body = document.createElement('div');
  body.className = 'event-body';
  const link = eventLinkFor(e);
  const idLabel = `[${e.source}] ${e.id}`;
  const idPart = link ? `<a href="${link}" target="_blank">${idLabel}</a>` : idLabel;
  body.innerHTML = `<strong>${idPart}</strong> — ${e.title || ''}<div class="event-meta">${e.detail || ''} · Hub verificou em ${new Date(e.ts).toLocaleTimeString('pt-BR')}</div>`;
  li.appendChild(body);
  return li;
}

function renderDayDetail() {
  const panel = el('dayDetail');
  if (!selectedDay) {
    panel.hidden = true;
    return;
  }
  const sources = enabledSources();
  const dayEvents = currentEvents.filter((e) => {
    if (!e || !e.ts) return false;
    if (localDateStr(new Date(e.ts)) !== selectedDay) return false;
    const sourceKey = Object.keys(SOURCE_META).find((k) => SOURCE_META[k].label === baseSourceName(e.source));
    if (sourceKey && !sources.includes(sourceKey)) return false;
    return true;
  }).sort((a, b) => b.ts - a.ts);

  el('dayDetailTitle').textContent = `Eventos em ${fmtLongDate(selectedDay)} (${dayEvents.length})`;
  const ul = el('dayDetailList');
  ul.innerHTML = '';
  if (!dayEvents.length) {
    ul.innerHTML = '<li class="muted">Nenhum evento registrado nesse dia com o filtro de fontes atual.</li>';
  } else {
    dayEvents.slice(0, 200).forEach((e) => ul.appendChild(buildEventLi(e)));
  }
  panel.hidden = false;
}

el('btnCloseDayDetail').addEventListener('click', () => {
  selectedDay = null;
  renderActivity();
});

// ---------- rankings (quem edita mais / requerentes, GLPI) — clicáveis ----------

function frequencyBars(container, items, max, field) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<p class="muted small">Sem dados suficientes ainda.</p>';
    return;
  }
  items.forEach(({ name, count }) => {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'hbar-row';
    if (personFilter && personFilter.field === field && personFilter.value === name) row.classList.add('active');
    const nameEl = document.createElement('span');
    nameEl.className = 'hbar-name';
    nameEl.textContent = name;
    nameEl.title = name;
    const track = document.createElement('span');
    track.className = 'hbar-track';
    const fill = document.createElement('span');
    fill.className = 'hbar-fill';
    fill.style.width = `${max ? (count / max) * 100 : 0}%`;
    track.appendChild(fill);
    const countEl = document.createElement('span');
    countEl.className = 'hbar-count';
    countEl.textContent = String(count);
    row.appendChild(nameEl);
    row.appendChild(track);
    row.appendChild(countEl);
    row.title = 'Clique pra filtrar "chamados parados agora" por essa pessoa';
    row.addEventListener('click', () => {
      const isActive = personFilter && personFilter.field === field && personFilter.value === name;
      personFilter = isActive ? null : { field, value: name };
      renderParados();
      renderEditorsAndRequesters();
    });
    container.appendChild(row);
  });
}

function topFrequency(map, field, limit) {
  const counts = {};
  Object.values(map || {}).forEach((data) => {
    const v = data && data[field];
    if (!v) return;
    counts[v] = (counts[v] || 0) + 1;
  });
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function renderEditorsAndRequesters() {
  if (!enabledSources().includes('glpi')) {
    el('editorsBars').innerHTML = '<p class="muted small">Habilite a fonte GLPI no filtro acima pra ver esse ranking.</p>';
    el('requestersBars').innerHTML = '<p class="muted small">Habilite a fonte GLPI no filtro acima pra ver esse ranking.</p>';
    return;
  }
  const editors = topFrequency(currentState.glpi, 'lastUpdateBy', 10);
  const requesters = topFrequency(currentState.glpi, 'requester', 10);
  const maxEditors = Math.max(1, ...editors.map((e) => e.count));
  const maxRequesters = Math.max(1, ...requesters.map((r) => r.count));
  frequencyBars(el('editorsBars'), editors, maxEditors, 'lastUpdateBy');
  frequencyBars(el('requestersBars'), requesters, maxRequesters, 'requester');
}

// ---------- orquestração ----------

function renderAll() {
  renderKpis();
  renderParados();
  abertosChart.draw();
  paradosChart.draw();
  renderActivity();
  renderEditorsAndRequesters();
}

async function loadMetrics() {
  const { dailySnapshots, events, state, config } = await chrome.storage.local.get([
    'dailySnapshots', 'events', 'state', 'config',
  ]);
  currentSnapshots = dailySnapshots || {};
  currentEvents = events || [];
  currentState = state || {};
  currentConfig = config || {};
  renderAll();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.uiTheme) setThemeAttr(changes.uiTheme.newValue || null);
  if (changes.metricsFilters) {
    filterState = changes.metricsFilters.newValue || filterState;
    syncFilterControls();
  }
  if (changes.dailySnapshots || changes.events || changes.state || changes.config) {
    loadMetrics();
  }
});

(async () => {
  await loadFilterState();
  await loadMetrics();
})();
