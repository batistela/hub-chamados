// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
// Segunda página do Hub — métricas/dashboard. Lê os mesmos dados que o background.js já
// salva no chrome.storage.local (state, events, dailySnapshots, config) — não faz nenhuma
// checagem própria, só apresenta o que já existe de outro jeito.

const GLPI_BASE = 'http://chamadosti.holambra.corp';
const MOVIDESK_BASE = 'https://keyrus-brasil.movidesk.com';

const el = (id) => document.getElementById(id);

const CLOSED_STATUS_RE = /encerr|fechad|solucion|resolvid|cancel|conclu[ií]d/i;

// ---------- tema claro/escuro ----------
// Mesmo mecanismo do dashboard.js (chave própria "uiTheme" no storage, fora de `config`)
// — duplicado aqui porque cada página da extensão roda seu próprio script isolado, sem
// nada compartilhado em memória entre dashboard.js e metrics.js.
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
// Duplicado do background.js de propósito — os dois precisam interpretar exatamente os
// mesmos formatos de `lastUpdate` (Evolutize sempre "DD/MM/AAAA HH:MM"; GLPI depende da
// coluna configurada na pesquisa salva, por isso os formatos alternativos).
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

// 'YYYY-MM-DD' -> 'DD/MM', só pra rótulo de eixo/coluna (não precisa do ano — os
// seletores de período vão no máximo até 365 dias).
function fmtShortDate(dateStr) {
  const [, mo, d] = dateStr.split('-');
  return `${d}/${mo}`;
}

// ---------- chamados parados agora ----------
// GLPI e Evolutize capturam "última tramitação" na leitura principal; Movidesk não tem
// esse dado hoje, então fica de fora dessa lista (avisado no próprio HTML).

function ticketLink(source, id, data) {
  if (data && data.url) return data.url;
  if (source === 'GLPI') return `${GLPI_BASE}/front/ticket.form.php?id=${id}`;
  if (source === 'Movidesk') return `${MOVIDESK_BASE}/Ticket/Edit/${id}`;
  return null;
}

function renderParados(state, config) {
  const globalDays = Number(config.staleDays) > 0 ? Number(config.staleDays) : null;
  const rows = [];

  const collect = (map, source) => {
    Object.entries(map || {}).forEach(([id, data]) => {
      if (!data || data.error) return;
      if (CLOSED_STATUS_RE.test(data.status || '')) return;
      const days = daysSinceUpdate(data.lastUpdate);
      if (days == null) return;
      rows.push({ source, id, title: data.title, status: data.status, days, lastUpdate: data.lastUpdate, url: ticketLink(source, id, data) });
    });
  };
  collect(state.glpi, 'GLPI');
  collect(state.evolutize, 'Evolutize');
  rows.sort((a, b) => b.days - a.days);

  el('countParados').textContent = rows.length ? `(${rows.length})` : '';
  const ul = el('paradosList');
  ul.innerHTML = '';
  if (!rows.length) {
    ul.innerHTML = '<li class="muted">Nenhum chamado em aberto com data de última tramitação disponível no momento.</li>';
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

// ---------- gráficos de tendência (a partir de dailySnapshots) ----------

let currentSnapshots = {};

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

function renderLineChart(svgEl, dates, series) {
  const width = 680;
  const height = 200;
  const padL = 34;
  const padR = 10;
  const padT = 10;
  const padB = 20;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const ns = 'http://www.w3.org/2000/svg';

  svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svgEl.innerHTML = '';

  if (!dates.length) {
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', '10');
    text.setAttribute('y', '100');
    text.setAttribute('class', 'chart-axis-label');
    text.textContent = 'Ainda não há dados suficientes — volte depois de alguns dias de uso.';
    svgEl.appendChild(text);
    return;
  }

  let maxVal = 1;
  series.forEach((s) => s.values.forEach((v) => { if (v != null && v > maxVal) maxVal = v; }));
  maxVal = Math.max(1, Math.ceil(maxVal * 1.15));

  const xStep = dates.length > 1 ? innerW / (dates.length - 1) : 0;
  const xFor = (i) => padL + xStep * i;
  const yFor = (v) => padT + innerH - (v / maxVal) * innerH;

  const gridCount = 4;
  for (let g = 0; g <= gridCount; g++) {
    const y = padT + (innerH / gridCount) * g;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', String(padL));
    line.setAttribute('x2', String(width - padR));
    line.setAttribute('y1', String(y));
    line.setAttribute('y2', String(y));
    line.setAttribute('class', 'chart-grid');
    svgEl.appendChild(line);

    const val = Math.round(maxVal - (maxVal / gridCount) * g);
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', '2');
    text.setAttribute('y', String(y + 3));
    text.setAttribute('class', 'chart-axis-label');
    text.textContent = String(val);
    svgEl.appendChild(text);
  }

  const labelEvery = Math.max(1, Math.ceil(dates.length / 6));
  dates.forEach((d, i) => {
    if (i % labelEvery !== 0 && i !== dates.length - 1) return;
    const text = document.createElementNS(ns, 'text');
    text.setAttribute('x', String(xFor(i)));
    text.setAttribute('y', String(height - 4));
    text.setAttribute('class', 'chart-axis-label');
    text.setAttribute('text-anchor', i === dates.length - 1 ? 'end' : 'middle');
    text.textContent = fmtShortDate(d);
    svgEl.appendChild(text);
  });

  series.forEach((s) => {
    const points = [];
    dates.forEach((d, i) => {
      const v = s.values[i];
      if (v == null) return;
      points.push(`${xFor(i)},${yFor(v)}`);
    });
    if (points.length < 2) return;
    const poly = document.createElementNS(ns, 'polyline');
    poly.setAttribute('points', points.join(' '));
    poly.setAttribute('style', `fill:none;stroke:${s.color};stroke-width:2`);
    svgEl.appendChild(poly);

    // Marca o último ponto com aproximação (dia recuperado por "olhar hoje pra trás")
    // com um contorno tracejado, pra deixar claro que esse valor específico é uma
    // estimativa, não uma leitura real do fim daquele dia.
    dates.forEach((d, i) => {
      const v = s.values[i];
      if (v == null) return;
      const snap = currentSnapshots[d];
      const isLast = i === dates.length - 1;
      const circle = document.createElementNS(ns, 'circle');
      circle.setAttribute('cx', String(xFor(i)));
      circle.setAttribute('cy', String(yFor(v)));
      circle.setAttribute('r', isLast ? '3.5' : '2');
      circle.setAttribute('fill', snap && snap.approximated ? 'var(--card-bg)' : s.color);
      circle.setAttribute('stroke', s.color);
      circle.setAttribute('stroke-width', '1.5');
      svgEl.appendChild(circle);
    });
  });
}

function renderLegend(container, series) {
  container.innerHTML = '';
  series.forEach((s) => {
    const span = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = s.color;
    span.appendChild(swatch);
    span.appendChild(document.createTextNode(s.label));
    container.appendChild(span);
  });
}

function seriesForMetric(dates, metricKey) {
  return [
    { key: 'glpi', label: 'GLPI', color: 'var(--chart-1)', values: buildSeriesValues(currentSnapshots, dates, 'glpi', metricKey) },
    { key: 'evolutize', label: 'Evolutize', color: 'var(--chart-2)', values: buildSeriesValues(currentSnapshots, dates, 'evolutize', metricKey) },
    { key: 'movidesk', label: 'Movidesk', color: 'var(--chart-3)', values: buildSeriesValues(currentSnapshots, dates, 'movidesk', metricKey) },
  ];
}

function updateSnapshotNote(dates) {
  const note = el('snapshotNote');
  if (!dates.length) {
    note.textContent = '';
    return;
  }
  const lastDate = dates[dates.length - 1];
  const lastSnap = currentSnapshots[lastDate];
  if (lastSnap && lastSnap.approximated) {
    note.textContent = `O ponto mais recente (${fmtShortDate(lastDate)}) é uma aproximação a partir do estado atual — o Hub ainda não registrou o fechamento "de verdade" desse dia (só acontece a partir das 17h com o Chrome aberto).`;
  } else {
    note.textContent = '';
  }
}

function refreshAbertosChart() {
  const range = Number(el('rangeAbertos').value) || 30;
  const dates = lastNDates(sortedDates(currentSnapshots), range);
  const series = seriesForMetric(dates, 'abertos');
  renderLineChart(el('chartAbertos'), dates, series);
  renderLegend(el('legendAbertos'), series);
  updateSnapshotNote(dates);
}

function refreshParadosChart() {
  const range = Number(el('rangeParados').value) || 30;
  const dates = lastNDates(sortedDates(currentSnapshots), range);
  const series = seriesForMetric(dates, 'parados');
  renderLineChart(el('chartParados'), dates, series);
  renderLegend(el('legendParados'), series);
}

function renderTrendCharts(snapshots) {
  currentSnapshots = snapshots || {};
  refreshAbertosChart();
  refreshParadosChart();
}

el('rangeAbertos').addEventListener('change', refreshAbertosChart);
el('rangeParados').addEventListener('change', refreshParadosChart);

// ---------- atividade recente (events, últimos 14 dias, por tipo) ----------
// Deliberadamente separado por tipo de evento (barras empilhadas), em vez de um único
// número por dia — Murilo já observou que o array `events` inclui casos de falso
// positivo conhecidos (ex: chamado do GLPI reaparecendo sem mudança real). Um total
// único esconderia isso; separado por tipo, dá pra ver a barra de "nova tramitação"
// isoladamente e julgar o volume com mais contexto.
const CHANGE_COLORS = {
  novo: 'var(--new-border)',
  status: 'var(--changed-border)',
  sumiu: 'var(--gone-border)',
  atualizacao: 'var(--chart-1)',
  acompanhando: 'var(--chart-2)',
  parado: 'var(--parado-border)',
};
const CHANGE_LABELS = {
  novo: 'Novo na lista',
  status: 'Mudança de status',
  sumiu: 'Sumiu da lista',
  atualizacao: 'Nova tramitação',
  acompanhando: 'Adicionado (avulso)',
  parado: 'Alerta de "parado"',
};
const CHANGE_ORDER = ['novo', 'status', 'sumiu', 'atualizacao', 'acompanhando', 'parado'];

function renderActivity(events) {
  const days = [];
  const now = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(localDateStr(d));
  }
  const byDay = Object.fromEntries(days.map((d) => [d, Object.fromEntries(CHANGE_ORDER.map((c) => [c, 0]))]));

  events.forEach((e) => {
    if (!e || !e.ts) return;
    const dayStr = localDateStr(new Date(e.ts));
    if (!byDay[dayStr]) return;
    const key = CHANGE_ORDER.includes(e.change) ? e.change : null;
    if (!key) return;
    byDay[dayStr][key]++;
  });

  const totals = days.map((d) => CHANGE_ORDER.reduce((sum, c) => sum + byDay[d][c], 0));
  const maxTotal = Math.max(1, ...totals);

  const container = el('activityChart');
  container.innerHTML = '';
  days.forEach((d, i) => {
    const dayCol = document.createElement('div');
    dayCol.className = 'activity-day';
    const wrap = document.createElement('div');
    wrap.className = 'activity-col-wrap';
    CHANGE_ORDER.forEach((c) => {
      const count = byDay[d][c];
      if (!count) return;
      const seg = document.createElement('div');
      seg.className = 'activity-seg';
      seg.style.height = `${(count / maxTotal) * 100}%`;
      seg.style.background = CHANGE_COLORS[c];
      seg.title = `${CHANGE_LABELS[c]}: ${count}`;
      wrap.appendChild(seg);
    });
    dayCol.appendChild(wrap);
    const label = document.createElement('div');
    label.className = 'activity-day-label';
    label.textContent = fmtShortDate(d);
    dayCol.appendChild(label);
    container.appendChild(dayCol);
  });

  const legend = el('legendActivity');
  legend.innerHTML = '';
  CHANGE_ORDER.forEach((c) => {
    const span = document.createElement('span');
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = CHANGE_COLORS[c];
    span.appendChild(swatch);
    span.appendChild(document.createTextNode(CHANGE_LABELS[c]));
    legend.appendChild(span);
  });
}

// ---------- rankings (quem edita mais / chamados por requerente, GLPI) ----------

function frequencyBars(container, items, max) {
  container.innerHTML = '';
  if (!items.length) {
    container.innerHTML = '<p class="muted small">Sem dados suficientes ainda.</p>';
    return;
  }
  items.forEach(({ name, count }) => {
    const row = document.createElement('div');
    row.className = 'hbar-row';
    const nameEl = document.createElement('div');
    nameEl.className = 'hbar-name';
    nameEl.textContent = name;
    nameEl.title = name;
    const track = document.createElement('div');
    track.className = 'hbar-track';
    const fill = document.createElement('div');
    fill.className = 'hbar-fill';
    fill.style.width = `${max ? (count / max) * 100 : 0}%`;
    track.appendChild(fill);
    const countEl = document.createElement('div');
    countEl.className = 'hbar-count';
    countEl.textContent = String(count);
    row.appendChild(nameEl);
    row.appendChild(track);
    row.appendChild(countEl);
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

function renderEditorsAndRequesters(state) {
  const editors = topFrequency(state.glpi, 'lastUpdateBy', 10);
  const requesters = topFrequency(state.glpi, 'requester', 10);
  const maxEditors = Math.max(1, ...editors.map((e) => e.count));
  const maxRequesters = Math.max(1, ...requesters.map((r) => r.count));
  frequencyBars(el('editorsBars'), editors, maxEditors);
  frequencyBars(el('requestersBars'), requesters, maxRequesters);
}

// ---------- carregamento ----------

async function loadMetrics() {
  const { dailySnapshots, events, state, config } = await chrome.storage.local.get([
    'dailySnapshots', 'events', 'state', 'config',
  ]);
  renderParados(state || {}, config || {});
  renderTrendCharts(dailySnapshots || {});
  renderActivity(events || []);
  renderEditorsAndRequesters(state || {});
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.uiTheme) setThemeAttr(changes.uiTheme.newValue || null);
  loadMetrics();
});

loadMetrics();
