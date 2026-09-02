// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
const GLPI_BASE = 'http://chamadosti.holambra.corp';
const MOVIDESK_BASE = 'https://keyrus-brasil.movidesk.com';

const el = (id) => document.getElementById(id);

// Filtros de exibição das tabelas — só afetam o que é mostrado no Hub, não o que é
// verificado/salvo (a checagem continua olhando a lista completa, então o Hub ainda
// consegue detectar mudança de status e "sumiu da lista" mesmo com o filtro ligado).
// Ficam só em memória (não persistem entre aberturas do Hub) e "ocultar encerrados"
// já nasce marcado, já que é isso que resolve a poluição visual reclamada.
const tableFilters = {
  glpi: { search: '', hideClosed: true },
  evo: { search: '', hideClosed: true },
};
const CLOSED_STATUS_RE = /encerr|fechad|solucion|resolvid|cancel|conclu[ií]d/i;
let lastState = {};

function fmtTime(ts) {
  if (!ts) return 'Nunca verificado';
  const d = new Date(ts);
  return `Última verificação: ${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR')}`;
}

function fmtEventTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
}

async function loadAll() {
  const { config, state, events, lastCheck, lastCheckOk, lastCheckError, sourceErrors, updateInfo } = await chrome.storage.local.get([
    'config', 'state', 'events', 'lastCheck', 'lastCheckOk', 'lastCheckError', 'sourceErrors', 'updateInfo',
  ]);
  lastState = state || {};
  renderConfig(config || {});
  renderState(lastState);
  renderEvents(events || []);
  renderStatus(lastCheck, lastCheckOk, lastCheckError);
  renderSourceErrors(sourceErrors || {});
  renderUpdateBanner(updateInfo);
}

// Aviso de versão nova disponível no repositório do GitHub (ver checkForUpdate em
// background.js) — a URL do version.json é fixa no código do background.js, não tem
// campo de configuração aqui. Esse aviso só aparece quando a versão do
// version.json é mais nova que a instalada. O botão "Baixar" só baixa o .zip pra pasta
// Downloads (é o máximo que a permissão "downloads" do Chrome permite) — a extensão não
// consegue descompactar nem substituir os arquivos sozinha (o Chrome bloqueia isso de
// propósito, senão qualquer extensão poderia se auto-modificar com código de qualquer
// lugar da internet). Ainda precisa extrair o .zip, substituir os arquivos na pasta
// onde a extensão está instalada, e recarregar em chrome://extensions.
function renderUpdateBanner(info) {
  const banner = el('updateBanner');
  if (info && info.available) {
    const link = info.url ? ` <a href="${info.url}" target="_blank">abrir repositório</a>` : '';
    banner.innerHTML =
      `Nova versão do Hub disponível: <strong>v${info.version}</strong>${info.notes ? ` — ${info.notes}` : ''}${link}` +
      (info.zipUrl ? ' <button id="btnDownloadUpdate" class="btn">Baixar atualização (.zip)</button>' : '') +
      '<div class="muted small" style="margin-top:4px;">Baixa pra pasta Downloads — depois é só extrair e substituir os arquivos desta pasta, e recarregar a extensão em chrome://extensions.</div>';
    banner.className = 'banner update';
    if (info.zipUrl) {
      el('btnDownloadUpdate').addEventListener('click', () => {
        chrome.downloads.download({ url: info.zipUrl, filename: `hub-chamados-v${info.version}.zip` });
      });
    }
  } else {
    banner.className = 'banner update hidden';
  }
}

function renderSourceErrors(errors) {
  const map = { errorGlpi: errors.glpi, errorEvo: errors.evolutize, errorMd: errors.movidesk };
  Object.entries(map).forEach(([elId, msg]) => {
    const node = el(elId);
    if (msg) {
      node.textContent = `Aviso: ${msg}`;
      node.classList.remove('hidden');
    } else {
      node.classList.add('hidden');
    }
  });
}

function renderStatus(lastCheck, ok, err) {
  el('lastCheck').textContent = fmtTime(lastCheck);
  const banner = el('statusBanner');
  if (ok === false) {
    banner.textContent = `Última verificação falhou: ${err || 'erro desconhecido'}`;
    banner.className = 'banner error';
  } else {
    banner.className = 'banner hidden';
  }
}

function renderConfig(config) {
  el('intervalMinutes').value = config.intervalMinutes ?? 15;
  el('autoCheckStatus').textContent = (config.intervalMinutes ?? 15) > 0 ? '' : '· verificação automática desativada';
  el('soundEnabled').checked = config.soundEnabled !== false;
  el('glpiSearchUrl').value = config.glpiSearchUrl || '';
  el('staleDays').value = config.staleDays ?? 0;
  el('glpiOnlyAvulsos').checked = !!config.glpiOnlyAvulsos;
  el('evolutizeOnlyAvulsos').checked = !!config.evolutizeOnlyAvulsos;
  el('movideskOnlyAvulsos').checked = !!config.movideskOnlyAvulsos;
  renderAvulsoList('glpiAvulsoList', config.glpiAvulsos || [], config.glpiAvulsoStaleDays || {}, removeGlpiAvulso, updateGlpiAvulsoStale);
  renderAvulsoList('evoAvulsoList', config.evolutizeAvulsos || [], config.evolutizeAvulsoStaleDays || {}, removeEvoAvulso, updateEvoAvulsoStale);
  renderAvulsoList('mdAvulsoList', config.movideskAvulsos || [], config.movideskAvulsoStaleDays || {}, removeMdAvulso, updateMdAvulsoStale);
  renderCustomLinks(config.customLinks || []);

  el('filterGlpi').value = tableFilters.glpi.search;
  el('hideClosedGlpi').checked = tableFilters.glpi.hideClosed;
  el('filterEvo').value = tableFilters.evo.search;
  el('hideClosedEvo').checked = tableFilters.evo.hideClosed;
}

function renderAvulsoList(listId, items, staleOverrides, onRemove, onStaleChange) {
  const ul = el(listId);
  ul.innerHTML = '';
  if (!items.length) {
    ul.innerHTML = '<li class="muted">Nenhum chamado avulso cadastrado.</li>';
    return;
  }
  items.forEach((num) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = num;
    const staleInput = document.createElement('input');
    staleInput.type = 'number';
    staleInput.min = '0';
    staleInput.max = '365';
    staleInput.className = 'avulso-stale-input';
    staleInput.placeholder = 'padrão';
    staleInput.title = 'Dias sem tramitação até alertar esse chamado (vazio = usa o padrão geral)';
    const override = staleOverrides ? staleOverrides[num] : null;
    staleInput.value = override != null ? override : '';
    staleInput.addEventListener('change', () => onStaleChange(num, staleInput.value));
    const btn = document.createElement('button');
    btn.textContent = 'remover';
    btn.addEventListener('click', () => onRemove(num));
    li.appendChild(span);
    li.appendChild(staleInput);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function currentConfig() {
  const { config } = await chrome.storage.local.get('config');
  return config || {};
}

// Lê o valor digitado no campo de dias por avulso e salva no mapa de overrides
// correspondente — vazio ou 0 remove o override (volta a usar o padrão geral).
function applyStaleOverride(map, num, value) {
  const next = { ...(map || {}) };
  const n = Number(value);
  if (value === '' || !Number.isFinite(n) || n <= 0) delete next[num];
  else next[num] = Math.min(365, n);
  return next;
}

async function removeGlpiAvulso(num) {
  const config = await currentConfig();
  config.glpiAvulsos = (config.glpiAvulsos || []).filter((n) => n !== num);
  if (config.glpiAvulsoStaleDays) delete config.glpiAvulsoStaleDays[num];
  await chrome.storage.local.set({ config });
  loadAll();
}

async function removeEvoAvulso(num) {
  const config = await currentConfig();
  config.evolutizeAvulsos = (config.evolutizeAvulsos || []).filter((n) => n !== num);
  if (config.evolutizeAvulsoUrls) delete config.evolutizeAvulsoUrls[num];
  if (config.evolutizeAvulsoStaleDays) delete config.evolutizeAvulsoStaleDays[num];
  await chrome.storage.local.set({ config });
  loadAll();
}

async function removeMdAvulso(num) {
  const config = await currentConfig();
  config.movideskAvulsos = (config.movideskAvulsos || []).filter((n) => n !== num);
  if (config.movideskAvulsoStaleDays) delete config.movideskAvulsoStaleDays[num];
  await chrome.storage.local.set({ config });
  loadAll();
}

async function updateGlpiAvulsoStale(num, value) {
  const config = await currentConfig();
  config.glpiAvulsoStaleDays = applyStaleOverride(config.glpiAvulsoStaleDays, num, value);
  await chrome.storage.local.set({ config });
  loadAll();
}

async function updateEvoAvulsoStale(num, value) {
  const config = await currentConfig();
  config.evolutizeAvulsoStaleDays = applyStaleOverride(config.evolutizeAvulsoStaleDays, num, value);
  await chrome.storage.local.set({ config });
  loadAll();
}

async function updateMdAvulsoStale(num, value) {
  const config = await currentConfig();
  config.movideskAvulsoStaleDays = applyStaleOverride(config.movideskAvulsoStaleDays, num, value);
  await chrome.storage.local.set({ config });
  loadAll();
}

// ---------- links rápidos (atalhos, sem monitoramento) ----------

function renderCustomLinks(links) {
  const ul = el('customLinkList');
  ul.innerHTML = '';
  if (!links.length) {
    ul.innerHTML = '<li class="muted">Nenhum link cadastrado.</li>';
    return;
  }
  links.forEach((link, idx) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.textContent = link.label || link.url;
    const btn = document.createElement('button');
    btn.textContent = 'remover';
    btn.addEventListener('click', () => removeCustomLink(idx));
    li.appendChild(a);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

async function removeCustomLink(idx) {
  const config = await currentConfig();
  config.customLinks = (config.customLinks || []).filter((_, i) => i !== idx);
  await chrome.storage.local.set({ config });
  loadAll();
}

function renderState(state) {
  fillTable('tableGlpi', 'countGlpi', state.glpi || {}, (id) => `${GLPI_BASE}/front/ticket.form.php?id=${id}`, ['title', 'status', 'requester', 'lastUpdate'], tableFilters.glpi);
  fillTable('tableEvo', 'countEvo', state.evolutize || {}, null, ['title', 'status', 'lastUpdate'], tableFilters.evo);
  fillTable('tableMd', 'countMd', state.movidesk || {}, (id) => `${MOVIDESK_BASE}/Ticket/Edit/${id}`, ['title', 'status']);

  fillAvulsoStatus('glpiAvulsoStatus', state.glpiAvulsos || {}, (id) => `${GLPI_BASE}/front/ticket.form.php?id=${id}`);
  fillAvulsoStatus('evoAvulsoStatus', state.evolutizeAvulsos || {}, null);
  fillAvulsoStatus('mdAvulsoStatus', state.movideskAvulsos || {}, (id) => `${MOVIDESK_BASE}/Ticket/Edit/${id}`);
}

function applyTableFilter(entries, filter) {
  if (!filter) return entries;
  let out = entries;
  if (filter.hideClosed) {
    out = out.filter(([, data]) => !CLOSED_STATUS_RE.test(data.status || ''));
  }
  const term = (filter.search || '').trim().toLowerCase();
  if (term) {
    out = out.filter(([id, data]) => {
      const haystack = `${id} ${data.title || ''} ${data.status || ''} ${data.requester || ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }
  return out;
}

function fillTable(tableId, countId, map, linkFn, fields, filter) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  const allEntries = Object.entries(map);
  const entries = applyTableFilter(allEntries, filter);
  if (!allEntries.length) {
    el(countId).textContent = '';
  } else if (entries.length === allEntries.length) {
    el(countId).textContent = `(${allEntries.length})`;
  } else {
    el(countId).textContent = `(${entries.length} de ${allEntries.length})`;
  }
  if (!allEntries.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = fields.length + 1;
    td.className = 'muted';
    td.textContent = 'Sem dados ainda — clique em "Verificar agora".';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  if (!entries.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = fields.length + 1;
    td.className = 'muted';
    td.textContent = 'Nenhum chamado corresponde ao filtro atual.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
  entries.forEach(([id, data]) => {
    const tr = document.createElement('tr');
    const tdId = document.createElement('td');
    // Pra Evolutize, `data.url` vem direto da grade (cada linha já traz um link
    // embutido pro chamado) — usa esse quando existir, senão cai pro linkFn estático
    // (GLPI/Movidesk, que têm URL previsível por ID).
    const href = data.url || (linkFn ? linkFn(id) : null);
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.textContent = id;
      tdId.appendChild(a);
    } else {
      tdId.textContent = id;
    }
    tr.appendChild(tdId);
    fields.forEach((f) => {
      const td = document.createElement('td');
      td.textContent = data[f] || '—';
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
}

function fillAvulsoStatus(listId, map, linkFn) {
  const ul = el(listId);
  ul.innerHTML = '';
  const entries = Object.entries(map);
  if (!entries.length) {
    ul.innerHTML = '<li class="muted">Nenhum chamado avulso configurado.</li>';
    return;
  }
  entries.forEach(([id, data]) => {
    const li = document.createElement('li');
    if (data.error) {
      li.className = 'err';
      li.textContent = `${id}: ${data.error}`;
    } else {
      const title = data.title || '(sem título capturado)';
      const statusTxt = data.status ? ` [${data.status}]` : '';
      const updateTxt = data.lastUpdate
        ? ` — última tramitação: ${data.lastUpdate}${data.lastUpdateBy ? ` (${data.lastUpdateBy})` : ''}`
        : '';
      // Pra Evolutize, `data.url` é o link fixo descoberto/confirmado na última
      // checagem — usa ele quando existir, já que é o mesmo link salvo em
      // config.evolutizeAvulsoUrls e evita depender só da busca por número.
      const href = data.url || (linkFn ? linkFn(id) : null);
      if (href) {
        li.innerHTML = `<a href="${href}" target="_blank">${id}</a> — ${title}${statusTxt}${updateTxt}`;
      } else {
        li.textContent = `${id} — ${title}${statusTxt}${updateTxt}`;
      }
    }
    ul.appendChild(li);
  });
}

// Link do chamado pra usar nos itens de "Atualizações recentes"/"Histórico"/"Consultar
// chamado". A Evolutize não tem URL previsível por número (o link inclui um token
// descoberto na leitura), então esses eventos já vêm com `e.url` gravado no momento em
// que aconteceram (ver background.js). GLPI e Movidesk têm URL sempre previsível a
// partir do número, então nem precisam guardar isso — é só montar aqui. Eventos antigos
// (gravados antes dessa mudança) simplesmente não têm `e.url`; pra GLPI/Movidesk isso não
// importa (a gente monta do mesmo jeito), só pra Evolutize é que um evento bem antigo
// pode ficar sem link.
function eventLinkFor(e) {
  if (e.url) return e.url;
  const base = (e.source || '').replace(/\s*\(avulso\)\s*$/i, '');
  if (base === 'GLPI') return `${GLPI_BASE}/front/ticket.form.php?id=${e.id}`;
  if (base === 'Movidesk') return `${MOVIDESK_BASE}/Ticket/Edit/${e.id}`;
  return null;
}

function buildEventLi(e, withAckButton) {
  const li = document.createElement('li');
  li.className = e.change;
  const body = document.createElement('div');
  body.className = 'event-body';
  const link = eventLinkFor(e);
  const idLabel = `[${e.source}] ${e.id}`;
  const idPart = link ? `<a href="${link}" target="_blank">${idLabel}</a>` : idLabel;
  // "Hub verificou em" é de propósito, não só a hora crua — esse horário é de quando o
  // HUB rodou a checagem, não de quando o chamado foi atualizado na fonte (GLPI,
  // Evolutize, etc). Quando a fonte informa a data/hora real da última tramitação, ela
  // já vem embutida em `e.detail` (ver lastUpdateSuffix em background.js) — é essa data
  // que vale a pena conferir na aba de histórico da própria fonte, não a daqui.
  body.innerHTML = `<strong>${idPart}</strong> — ${e.title || ''}<br>${e.detail}<div class="event-meta">Hub verificou em: ${fmtEventTime(e.ts)}</div>`;
  li.appendChild(body);
  if (withAckButton) {
    const btn = document.createElement('button');
    btn.className = 'ack-btn';
    btn.textContent = 'marcar como visto';
    btn.addEventListener('click', () => acknowledgeEvent(e.eventId));
    li.appendChild(btn);
  }
  return li;
}

function renderEvents(events) {
  // "Atualizações recentes" mostra só o que ainda não foi confirmado. Assim que o
  // usuário marca como visto, o item some dali e passa a aparecer só no histórico
  // (a lista recolhida logo abaixo).
  const pending = events.filter((e) => !e.acknowledged);
  const history = events.filter((e) => e.acknowledged);

  const pendingUl = el('eventsList');
  pendingUl.innerHTML = '';
  if (!pending.length) {
    pendingUl.innerHTML = '<li class="muted">Nenhuma atualização pendente — tudo verificado.</li>';
  } else {
    pending.slice(0, 100).forEach((e) => pendingUl.appendChild(buildEventLi(e, true)));
  }
  el('eventsPendingCount').textContent = pending.length ? `(${pending.length})` : '';
  el('btnAckAll').classList.toggle('hidden', pending.length === 0);

  const historyUl = el('historyList');
  historyUl.innerHTML = '';
  if (!history.length) {
    historyUl.innerHTML = '<li class="muted">Nenhuma atualização verificada ainda.</li>';
  } else {
    history.slice(0, 300).forEach((e) => historyUl.appendChild(buildEventLi(e, false)));
  }
  el('historyCount').textContent = history.length ? `(${history.length})` : '';
}

async function acknowledgeEvent(eventId) {
  await chrome.runtime.sendMessage({ type: 'acknowledgeEvent', eventId });
  loadAll();
}

async function acknowledgeAllEvents() {
  await chrome.runtime.sendMessage({ type: 'acknowledgeAllEvents' });
  loadAll();
}

// ---------- consulta de histórico por chamado ----------
// Independente do array `events` (limitado a 200 no total), o background.js mantém um
// histórico por chamado (chrome.storage.local, chave "ticketHistory") sem esse limite
// global — aqui só lê e filtra pelo número (e opcionalmente pela fonte) digitados.

async function queryTicketHistory(sourceFilter, number) {
  const { ticketHistory } = await chrome.storage.local.get('ticketHistory');
  const map = ticketHistory || {};
  const sources = sourceFilter ? [sourceFilter] : ['GLPI', 'Evolutize', 'Movidesk'];
  let combined = [];
  for (const src of sources) {
    const list = map[`${src}::${number}`];
    if (list) combined = combined.concat(list);
  }
  combined.sort((a, b) => b.ts - a.ts);
  return combined;
}

async function runTicketQuery() {
  const number = el('queryTicketNumber').value.trim();
  const source = el('queryTicketSource').value;
  const ul = el('queryTicketResult');
  ul.innerHTML = '';
  if (!number) {
    ul.innerHTML = '<li class="muted">Digite um número de chamado.</li>';
    return;
  }
  const results = await queryTicketHistory(source, number);
  if (!results.length) {
    ul.innerHTML = '<li class="muted">Nenhuma mudança registrada para esse chamado desde que o Hub começou a acompanhá-lo (ou o número não corresponde a nada verificado ainda).</li>';
    return;
  }
  results.forEach((e) => ul.appendChild(buildEventLi(e, false)));
}

// ---------- ações ----------

el('btnCheckNow').addEventListener('click', async () => {
  el('btnCheckNow').disabled = true;
  el('btnCheckNow').textContent = 'Verificando...';
  try {
    await chrome.runtime.sendMessage({ type: 'runCheckNow' });
  } finally {
    el('btnCheckNow').disabled = false;
    el('btnCheckNow').textContent = 'Verificar agora';
    // Não limpa mais o badge automaticamente aqui — ele agora reflete quantas
    // atualizações ainda não foram marcadas como vistas, e só zera quando o usuário
    // confirma isso explicitamente (botão "marcar como visto" / "marcar tudo como visto").
    loadAll();
  }
});

el('btnSaveConfig').addEventListener('click', async () => {
  const config = await currentConfig();
  // "0" precisa continuar 0 (desativa a verificação automática) — o antigo
  // `Number(...) || 15` tratava 0 como "sem valor" e trocava silenciosamente por 15,
  // então não dava pra desativar. Só cai pro padrão (15) quando o campo está vazio ou
  // o valor não é um número válido; qualquer valor positivo fica limitado a 1–180
  // (1 é o mínimo que o chrome.alarms realmente respeita — só afeta valores digitados
  // abaixo disso).
  //
  // ACHADO: até essa correção, o mínimo aqui era 5 — então digitar "1" pra testar era
  // silenciosamente trocado por "5" sem nenhum aviso (o campo até corrigia sozinho pra
  // "5" depois de salvar, mas fácil de não notar). Se você configurou 1 minuto pra
  // testar e esperou só 1-2 minutos sem nada acontecer, é bem provável que essa troca
  // silenciosa pra 5 tenha sido a causa — o Hub estava, na prática, esperando 5 minutos,
  // não 1.
  const rawValue = el('intervalMinutes').value.trim();
  let minutes = rawValue === '' ? 15 : Number(rawValue);
  if (!Number.isFinite(minutes) || minutes < 0) minutes = 15;
  if (minutes > 0) minutes = Math.max(1, Math.min(180, minutes));
  config.intervalMinutes = minutes;
  config.soundEnabled = el('soundEnabled').checked;
  config.glpiSearchUrl = el('glpiSearchUrl').value.trim();
  config.glpiOnlyAvulsos = el('glpiOnlyAvulsos').checked;
  config.evolutizeOnlyAvulsos = el('evolutizeOnlyAvulsos').checked;
  config.movideskOnlyAvulsos = el('movideskOnlyAvulsos').checked;
  const staleRaw = el('staleDays').value.trim();
  let staleDays = staleRaw === '' ? 0 : Number(staleRaw);
  if (!Number.isFinite(staleDays) || staleDays < 0) staleDays = 0;
  config.staleDays = Math.min(365, staleDays);
  await chrome.storage.local.set({ config });
  await chrome.runtime.sendMessage({ type: 'updateInterval', minutes });
  el('btnSaveConfig').textContent = 'Salvo!';
  setTimeout(() => { el('btnSaveConfig').textContent = 'Salvar configurações'; }, 1500);
});

// ---------- exportar/importar configuração ----------
// Exporta só a CONFIGURAÇÃO (o que você preenche nas Configurações) — não inclui os
// dados coletados (chamados, histórico, eventos). Serve pra não ter que redigitar tudo
// na mão se reinstalar a extensão, trocar de máquina, ou passar a configuração adiante.

const CONFIG_FIELDS = [
  'intervalMinutes', 'soundEnabled', 'glpiSearchUrl',
  'glpiAvulsos', 'glpiOnlyAvulsos', 'glpiAvulsoStaleDays',
  'evolutizeAvulsos', 'evolutizeOnlyAvulsos', 'evolutizeAvulsoUrls', 'evolutizeAvulsoStaleDays',
  'movideskAvulsos', 'movideskOnlyAvulsos', 'movideskAvulsoStaleDays',
  'staleDays', 'customLinks',
];

function showImportStatus(message, isError) {
  const p = el('importStatus');
  p.textContent = message;
  p.classList.remove('hidden');
  p.classList.toggle('source-error', !!isError);
  p.classList.toggle('muted', !isError);
  setTimeout(() => p.classList.add('hidden'), 4000);
}

async function exportConfig() {
  const config = await currentConfig();
  const payload = {
    hubConfigVersion: 1,
    exportedAt: new Date().toISOString(),
    config: Object.fromEntries(CONFIG_FIELDS.map((k) => [k, config[k]])),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `hub-chamados-config-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Aceita tanto o formato exportado ({config: {...}}) quanto um JSON "cru" de config, e
// valida/normaliza campo a campo — um arquivo malformado ou de outra origem não deve
// corromper a configuração atual (campo com tipo errado é simplesmente ignorado, mantendo
// o valor que já estava salvo).
function sanitizeImportedConfig(incoming) {
  const asArrayOfStrings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String) : undefined);
  const asPlainObject = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : undefined);
  const asNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
  const asBoolean = (v) => (typeof v === 'boolean' ? v : undefined);
  const asString = (v) => (typeof v === 'string' ? v : undefined);
  const asCustomLinks = (v) =>
    Array.isArray(v)
      ? v
          .filter((x) => x && typeof x === 'object' && typeof x.url === 'string' && x.url)
          .map((x) => ({ label: typeof x.label === 'string' && x.label ? x.label : x.url, url: x.url }))
      : undefined;

  const out = {
    intervalMinutes: asNumber(incoming.intervalMinutes),
    soundEnabled: asBoolean(incoming.soundEnabled),
    glpiSearchUrl: asString(incoming.glpiSearchUrl),
    glpiAvulsos: asArrayOfStrings(incoming.glpiAvulsos),
    glpiOnlyAvulsos: asBoolean(incoming.glpiOnlyAvulsos),
    glpiAvulsoStaleDays: asPlainObject(incoming.glpiAvulsoStaleDays),
    evolutizeAvulsos: asArrayOfStrings(incoming.evolutizeAvulsos),
    evolutizeOnlyAvulsos: asBoolean(incoming.evolutizeOnlyAvulsos),
    evolutizeAvulsoUrls: asPlainObject(incoming.evolutizeAvulsoUrls),
    evolutizeAvulsoStaleDays: asPlainObject(incoming.evolutizeAvulsoStaleDays),
    movideskAvulsos: asArrayOfStrings(incoming.movideskAvulsos),
    movideskOnlyAvulsos: asBoolean(incoming.movideskOnlyAvulsos),
    movideskAvulsoStaleDays: asPlainObject(incoming.movideskAvulsoStaleDays),
    staleDays: asNumber(incoming.staleDays),
    customLinks: asCustomLinks(incoming.customLinks),
  };
  // Remove campos que não bateram na validação, pra não sobrescrever o que já estava
  // salvo com "undefined".
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

async function importConfigFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const parsed = JSON.parse(String(reader.result));
      const incoming = parsed && typeof parsed === 'object' && parsed.config ? parsed.config : parsed;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        throw new Error('o arquivo não parece ter uma configuração válida');
      }
      const cleaned = sanitizeImportedConfig(incoming);
      if (!Object.keys(cleaned).length) {
        throw new Error('nenhum campo reconhecido foi encontrado no arquivo');
      }
      const current = await currentConfig();
      const merged = { ...current, ...cleaned };
      await chrome.storage.local.set({ config: merged });
      // Garante que o alarme do background já reflita o intervalo importado, mesmo que
      // seja diferente do que estava configurado antes.
      await chrome.runtime.sendMessage({ type: 'updateInterval', minutes: merged.intervalMinutes ?? 15 });
      showImportStatus('Configurações importadas com sucesso.', false);
      loadAll();
    } catch (e) {
      showImportStatus(`Erro ao importar: ${(e && e.message) || e}`, true);
    }
  };
  reader.onerror = () => showImportStatus('Não foi possível ler o arquivo selecionado.', true);
  reader.readAsText(file);
}

el('btnExportConfig').addEventListener('click', () => exportConfig());
el('btnImportConfig').addEventListener('click', () => el('importConfigInput').click());
el('importConfigInput').addEventListener('change', () => {
  const input = el('importConfigInput');
  const file = input.files && input.files[0];
  if (file) importConfigFile(file);
  input.value = '';
});

el('btnAddGlpiAvulso').addEventListener('click', async () => {
  const input = el('glpiAvulsoInput');
  const num = input.value.trim();
  if (!/^\d+$/.test(num)) return;
  const config = await currentConfig();
  config.glpiAvulsos = [...new Set([...(config.glpiAvulsos || []), num])];
  await chrome.storage.local.set({ config });
  input.value = '';
  loadAll();
});

el('btnAddEvoAvulso').addEventListener('click', async () => {
  const input = el('evoAvulsoInput');
  const num = input.value.trim();
  if (!/^\d+$/.test(num)) return;
  const config = await currentConfig();
  config.evolutizeAvulsos = [...new Set([...(config.evolutizeAvulsos || []), num])];
  await chrome.storage.local.set({ config });
  input.value = '';
  loadAll();
});

el('btnAddMdAvulso').addEventListener('click', async () => {
  const input = el('mdAvulsoInput');
  const num = input.value.trim();
  if (!/^\d+$/.test(num)) return;
  const config = await currentConfig();
  config.movideskAvulsos = [...new Set([...(config.movideskAvulsos || []), num])];
  await chrome.storage.local.set({ config });
  input.value = '';
  loadAll();
});

el('btnAddCustomLink').addEventListener('click', async () => {
  const labelInput = el('customLinkLabel');
  const urlInput = el('customLinkUrl');
  const label = labelInput.value.trim();
  let url = urlInput.value.trim();
  if (!url) return;
  // Aceita colar a URL sem "https://" na frente — completa automaticamente.
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const config = await currentConfig();
  config.customLinks = [...(config.customLinks || []), { label: label || url, url }];
  await chrome.storage.local.set({ config });
  labelInput.value = '';
  urlInput.value = '';
  loadAll();
});

el('filterGlpi').addEventListener('input', () => {
  tableFilters.glpi.search = el('filterGlpi').value;
  renderState(lastState);
});
el('hideClosedGlpi').addEventListener('change', () => {
  tableFilters.glpi.hideClosed = el('hideClosedGlpi').checked;
  renderState(lastState);
});
el('filterEvo').addEventListener('input', () => {
  tableFilters.evo.search = el('filterEvo').value;
  renderState(lastState);
});
el('hideClosedEvo').addEventListener('change', () => {
  tableFilters.evo.hideClosed = el('hideClosedEvo').checked;
  renderState(lastState);
});

el('btnAckAll').addEventListener('click', () => acknowledgeAllEvents());

el('btnQueryTicket').addEventListener('click', () => runTicketQuery());
el('queryTicketNumber').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') runTicketQuery();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') loadAll();
});

loadAll();
