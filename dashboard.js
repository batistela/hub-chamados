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
let lastConfig = {};

// ---------- tema claro/escuro ----------
// Guardado em uma chave própria do storage (não dentro de `config`) — é preferência
// pessoal de exibição, não configuração operacional, então fica de fora do
// exportar/importar configurações. `null`/ausente = "automático" (segue
// prefers-color-scheme do sistema, via CSS); 'light'/'dark' = escolha manual, que
// sempre vence a preferência do sistema (ver dashboard.css).
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

function fmtTime(ts) {
  if (!ts) return 'Nunca verificado';
  const d = new Date(ts);
  return `Última verificação: ${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR')}`;
}

function fmtEventTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR');
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Tenta ler `raw` como uma URL completa de chamado (colada de uma fonte personalizada) e
// extrair só o número dela — pra quem prefere colar a URL da barra de endereço em vez de
// digitar o número igual aparece na tabela da lista. Primeiro tenta um parâmetro de query
// comum (?id=, ?ticket=, etc.); se não achar, usa o último trecho do caminho que tiver
// algum dígito. Devolve null se `raw` não for uma URL válida (nesse caso o texto digitado
// é usado como o próprio número, igual sempre funcionou).
function extractTicketUrlInfo(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return null;
  }
  // IMPORTANTE: URLSearchParams.get() é sensível a maiúsculas/minúsculas no nome do
  // parâmetro — "?ID=410" (SharePoint, ex: o link de "Copiar link" de um item de lista)
  // não batia com a busca por 'id' antes dessa correção, porque get('id') não acha 'ID'.
  // Por isso comparamos em minúsculas manualmente em vez de usar searchParams.get direto.
  const wanted = ['id', 'ticket', 'numero', 'number', 'num'];
  for (const [key, v] of u.searchParams.entries()) {
    if (wanted.includes(key.toLowerCase()) && v && /\d/.test(v)) return { number: v, url: raw };
  }
  const segments = u.pathname.split('/').filter(Boolean);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (/\d/.test(segments[i])) return { number: decodeURIComponent(segments[i]), url: raw };
  }
  return null;
}

async function loadAll() {
  const { config, state, events, ticketHistory, lastCheck, lastCheckOk, lastCheckError, sourceErrors, updateInfo } = await chrome.storage.local.get([
    'config', 'state', 'events', 'ticketHistory', 'lastCheck', 'lastCheckOk', 'lastCheckError', 'sourceErrors', 'updateInfo',
  ]);
  lastState = state || {};
  lastConfig = config || {};
  renderConfig(lastConfig);
  renderState(lastState);
  renderEvents(events || []);
  renderMaintenanceStats(events || [], ticketHistory || {});
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
  el('glpiEnabled').checked = config.glpiEnabled !== false;
  el('evolutizeEnabled').checked = config.evolutizeEnabled !== false;
  el('movideskEnabled').checked = config.movideskEnabled !== false;
  renderAvulsoList('glpiAvulsoList', config.glpiAvulsos || [], config.glpiAvulsoStaleDays || {}, removeGlpiAvulso, updateGlpiAvulsoStale);
  renderAvulsoList('evoAvulsoList', config.evolutizeAvulsos || [], config.evolutizeAvulsoStaleDays || {}, removeEvoAvulso, updateEvoAvulsoStale);
  renderAvulsoList('mdAvulsoList', config.movideskAvulsos || [], config.movideskAvulsoStaleDays || {}, removeMdAvulso, updateMdAvulsoStale);
  renderCustomLinks(config.customLinks || []);
  renderCustomSources(config);
  renderQueryTicketSourceOptions(config);

  el('filterGlpi').value = tableFilters.glpi.search;
  el('hideClosedGlpi').checked = tableFilters.glpi.hideClosed;
  el('filterEvo').value = tableFilters.evo.search;
  el('hideClosedEvo').checked = tableFilters.evo.hideClosed;

  updateSourceDisabledUI(config);
}

// Esconde/esmaece a UI de uma fonte desligada (checkbox "Verificar esta fonte" nas
// Configurações) — o card da tabela, o bloco de config de avulsos e a coluna de status
// de avulsos correspondentes, mais um selo "desativada" nos dois lugares onde faz
// sentido (título do card e dentro do bloco de configuração).
function updateSourceDisabledUI(config) {
  const apply = (enabled, cardId, avulsoConfigId, avulsoStatusColId, cardBadgeId, configBadgeId) => {
    const disabled = enabled === false;
    el(cardId)?.classList.toggle('source-disabled', disabled);
    el(avulsoConfigId)?.classList.toggle('source-disabled', disabled);
    el(avulsoStatusColId)?.classList.toggle('source-disabled', disabled);
    el(cardBadgeId)?.classList.toggle('hidden', !disabled);
    el(configBadgeId)?.classList.toggle('hidden', !disabled);
  };
  apply(config.glpiEnabled, 'cardGlpi', 'glpiAvulsoConfig', 'glpiAvulsoStatusCol', 'glpiCardDisabledBadge', 'glpiDisabledBadge');
  apply(config.evolutizeEnabled, 'cardEvo', 'evoAvulsoConfig', 'evoAvulsoStatusCol', 'evoCardDisabledBadge', 'evoDisabledBadge');
  apply(config.movideskEnabled, 'cardMd', 'mdAvulsoConfig', 'mdAvulsoStatusCol', 'mdCardDisabledBadge', 'mdDisabledBadge');
}

function renderAvulsoList(listId, items, staleOverrides, onRemove, onStaleChange) {
  renderAvulsoListInto(el(listId), items, staleOverrides, onRemove, onStaleChange);
}

function renderAvulsoListInto(ul, items, staleOverrides, onRemove, onStaleChange) {
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

// ---------- fontes personalizadas (cadastradas via addSource.html) ----------

async function updateCustomSource(id, mutator) {
  const config = await currentConfig();
  const list = config.customSources || [];
  const idx = list.findIndex((s) => s.id === id);
  if (idx === -1) return;
  const next = { ...list[idx] };
  mutator(next);
  list[idx] = next;
  config.customSources = list;
  await chrome.storage.local.set({ config });
  loadAll();
}

async function removeCustomSource(id) {
  const config = await currentConfig();
  config.customSources = (config.customSources || []).filter((s) => s.id !== id);
  await chrome.storage.local.set({ config });
  // Limpa o resto do estado salvo dessa fonte também — senão fica órfão até o
  // background.js podar sozinho na próxima checagem (o que já faz, mas não custa nada
  // já deixar limpo aqui pra UI não mostrar lixo até lá).
  const { state } = await chrome.storage.local.get('state');
  if (state && state.customAvulsos && state.customAvulsos[id]) {
    delete state.customAvulsos[id];
    await chrome.storage.local.set({ state });
  }
  loadAll();
}

function renderCustomSources(config) {
  const container = el('customSourcesList');
  const sources = config.customSources || [];
  if (!sources.length) {
    container.innerHTML = '<p class="muted small">Nenhuma fonte personalizada cadastrada ainda.</p>';
    return;
  }
  container.innerHTML = '';
  sources.forEach((source) => {
    const columnCount = Object.keys(source.columns || {}).length;
    const block = document.createElement('div');
    block.className = 'custom-source-block';
    block.innerHTML = `
      <h3>${escapeHtml(source.label)}</h3>
      <label class="checkbox-row small source-enable-row">
        <input type="checkbox" class="cs-enabled" ${source.enabled !== false ? 'checked' : ''} />
        Verificar esta fonte
      </label>
      <p class="muted small">Lista: <code>${escapeHtml(source.listUrl || '')}</code> — ${columnCount} coluna(s) mapeada(s)</p>
      <div class="avulso-add">
        <input type="text" class="cs-avulso-input" placeholder="Número do chamado, ou cole a URL dele" />
        <button class="btn cs-add-avulso">Adicionar</button>
      </div>
      <ul class="avulso-list cs-avulso-list"></ul>
      <div class="custom-source-actions">
        <a href="addSource.html?edit=${encodeURIComponent(source.id)}" class="btn">Remapear campos</a>
        <button class="btn danger cs-remove">Remover fonte</button>
      </div>
    `;

    const ul = block.querySelector('.cs-avulso-list');
    renderAvulsoListInto(
      ul,
      source.avulsos || [],
      source.avulsoStaleDays || {},
      (num) => updateCustomSource(source.id, (s) => {
        s.avulsos = (s.avulsos || []).filter((n) => n !== num);
        if (s.avulsoStaleDays) delete s.avulsoStaleDays[num];
        if (s.avulsoUrls) delete s.avulsoUrls[num];
      }),
      (num, value) => updateCustomSource(source.id, (s) => {
        s.avulsoStaleDays = applyStaleOverride(s.avulsoStaleDays, num, value);
      })
    );

    block.querySelector('.cs-enabled').addEventListener('change', (ev) => {
      updateCustomSource(source.id, (s) => { s.enabled = ev.target.checked; });
    });
    block.querySelector('.cs-add-avulso').addEventListener('click', () => {
      const input = block.querySelector('.cs-avulso-input');
      const raw = input.value.trim();
      if (!raw) return;
      // Aceita colar a URL do chamado em vez de digitar o número — mais fácil quando você
      // já está com a página do chamado aberta. Extrai o número dela (query param comum
      // primeiro, senão o último trecho do caminho que tiver dígito) e guarda a URL
      // completa como link direto pra esse chamado (usada no lugar do link achado na
      // linha da tabela, que às vezes não existe ou não aponta direto pro chamado).
      const parsedUrl = extractTicketUrlInfo(raw);
      const num = parsedUrl ? parsedUrl.number : raw;
      if (!num || /\s/.test(num)) return; // menos rígido que o \d+ das três fontes fixas — números alfanuméricos são aceitos (ex: "TCK-1234")
      updateCustomSource(source.id, (s) => {
        s.avulsos = [...new Set([...(s.avulsos || []), num])];
        if (parsedUrl) s.avulsoUrls = { ...(s.avulsoUrls || {}), [num]: parsedUrl.url };
      });
      input.value = '';
    });
    wireConfirmButton(block.querySelector('.cs-remove'), 'Confirma? (clique de novo)', () => removeCustomSource(source.id));

    container.appendChild(block);
  });
}

function renderCustomAvulsoStatus(state, config) {
  const wrap = el('customAvulsoStatusGrid');
  const sources = config.customSources || [];
  if (!sources.length) {
    wrap.innerHTML = '';
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  wrap.innerHTML = '';
  sources.forEach((source) => {
    const div = document.createElement('div');
    const h3 = document.createElement('h3');
    h3.textContent = source.label;
    const ul = document.createElement('ul');
    ul.className = 'avulso-status-list';
    div.appendChild(h3);
    div.appendChild(ul);
    wrap.appendChild(div);
    const map = (state.customAvulsos && state.customAvulsos[source.id]) || {};
    fillAvulsoStatusInto(ul, map, null, source.enabled === false, (source.avulsos || []).length);
  });
}

// "Consultar chamado" também precisa listar as fontes personalizadas cadastradas, não só
// as três fixas — senão não dá pra filtrar a busca por elas (buscar em "Todas as fontes"
// ainda funciona sem isso, só o filtro específico que ficaria faltando).
function renderQueryTicketSourceOptions(config) {
  const select = el('queryTicketSource');
  const previousValue = select.value;
  Array.from(select.querySelectorAll('option[data-dynamic]')).forEach((o) => o.remove());
  (config.customSources || []).forEach((source) => {
    const opt = document.createElement('option');
    opt.value = source.label;
    opt.textContent = source.label;
    opt.dataset.dynamic = '1';
    select.appendChild(opt);
  });
  if (Array.from(select.options).some((o) => o.value === previousValue)) select.value = previousValue;
}

function renderState(state) {
  const glpiDisabled = lastConfig.glpiEnabled === false;
  const evoDisabled = lastConfig.evolutizeEnabled === false;
  const mdDisabled = lastConfig.movideskEnabled === false;
  const disabledMsg = 'Fonte desativada nas configurações.';

  fillTable('tableGlpi', 'countGlpi', state.glpi || {}, (id) => `${GLPI_BASE}/front/ticket.form.php?id=${id}`, ['title', 'status', 'requester', 'lastUpdate', 'lastUpdateBy'], tableFilters.glpi, glpiDisabled ? disabledMsg : null);
  fillTable('tableEvo', 'countEvo', state.evolutize || {}, null, ['title', 'status', 'lastUpdate'], tableFilters.evo, evoDisabled ? disabledMsg : null);
  fillTable('tableMd', 'countMd', state.movidesk || {}, (id) => `${MOVIDESK_BASE}/Ticket/Edit/${id}`, ['title', 'status'], null, mdDisabled ? disabledMsg : null);

  fillAvulsoStatus('glpiAvulsoStatus', state.glpiAvulsos || {}, (id) => `${GLPI_BASE}/front/ticket.form.php?id=${id}`, glpiDisabled, (lastConfig.glpiAvulsos || []).length);
  fillAvulsoStatus('evoAvulsoStatus', state.evolutizeAvulsos || {}, null, evoDisabled, (lastConfig.evolutizeAvulsos || []).length);
  fillAvulsoStatus('mdAvulsoStatus', state.movideskAvulsos || {}, (id) => `${MOVIDESK_BASE}/Ticket/Edit/${id}`, mdDisabled, (lastConfig.movideskAvulsos || []).length);

  renderCustomAvulsoStatus(state, lastConfig);
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
      const haystack = `${id} ${data.title || ''} ${data.status || ''} ${data.requester || ''} ${data.lastUpdateBy || ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }
  return out;
}

function fillTable(tableId, countId, map, linkFn, fields, filter, disabledMessage) {
  const tbody = document.querySelector(`#${tableId} tbody`);
  tbody.innerHTML = '';
  if (disabledMessage) {
    el(countId).textContent = '';
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = fields.length + 1;
    td.className = 'muted';
    td.textContent = disabledMessage;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }
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

function fillAvulsoStatus(listId, map, linkFn, disabled, configuredCount) {
  fillAvulsoStatusInto(el(listId), map, linkFn, disabled, configuredCount);
}

function fillAvulsoStatusInto(ul, map, linkFn, disabled, configuredCount) {
  ul.innerHTML = '';
  if (disabled) {
    ul.innerHTML = configuredCount
      ? `<li class="muted">Fonte desativada nas configurações — ${configuredCount} avulso(s) configurado(s), mas não verificado(s) agora.</li>`
      : '<li class="muted">Fonte desativada nas configurações.</li>';
    return;
  }
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
      // `requester` só existe pra fontes personalizadas (extractCustomAvulso) — nas
      // fontes fixas (GLPI/Evolutize/Movidesk) esse campo nunca vem preenchido no
      // avulso, então essa parte simplesmente não aparece pra elas.
      const requesterTxt = data.requester ? ` — requerente: ${data.requester}` : '';
      const updateTxt = data.lastUpdate
        ? ` — última tramitação: ${data.lastUpdate}${data.lastUpdateBy ? ` (${data.lastUpdateBy})` : ''}`
        : '';
      // Pra Evolutize e pras fontes personalizadas, `data.url` é o link direto da
      // checagem mais recente — usa ele quando existir; GLPI/Movidesk têm URL sempre
      // previsível por ID (linkFn).
      const href = data.url || (linkFn ? linkFn(id) : null);
      if (href) {
        li.innerHTML = `<a href="${href}" target="_blank">${escapeHtml(id)}</a> — ${escapeHtml(title)}${escapeHtml(statusTxt)}${escapeHtml(requesterTxt)}${escapeHtml(updateTxt)}`;
      } else {
        li.textContent = `${id} — ${title}${statusTxt}${requesterTxt}${updateTxt}`;
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

// ---------- manutenção de dados ----------

function renderMaintenanceStats(events, ticketHistory) {
  const list = events || [];
  const pending = list.filter((e) => !e.acknowledged).length;
  let oldestTs = null;
  for (const e of list) {
    if (oldestTs == null || e.ts < oldestTs) oldestTs = e.ts;
  }
  const oldestTxt = oldestTs ? `a mais antiga é de ${fmtEventTime(oldestTs)}` : 'nenhuma registrada ainda';

  const map = ticketHistory || {};
  let thTotal = 0;
  let thTickets = 0;
  for (const l of Object.values(map)) {
    if (Array.isArray(l) && l.length) {
      thTotal += l.length;
      thTickets += 1;
    }
  }

  el('maintenanceStats').textContent =
    `Atualizações/Histórico: ${list.length} registro(s) (${pending} pendente(s)) — ${oldestTxt}. ` +
    `Histórico por chamado: ${thTotal} registro(s) em ${thTickets} chamado(s).`;
}

function showMaintenanceStatus(message) {
  const p = el('maintenanceStatus');
  p.textContent = message;
  p.classList.remove('hidden');
  setTimeout(() => p.classList.add('hidden'), 5000);
}

// Confirmação em duas etapas: primeiro clique só avisa e vira "confirmar" por alguns
// segundos; segundo clique dentro desse prazo executa de verdade. Passado o prazo sem
// confirmar, volta ao estado normal sem fazer nada — evita apagar histórico sem querer.
function wireConfirmButton(btn, confirmLabel, onConfirm) {
  const original = btn.textContent;
  let timer = null;
  btn.addEventListener('click', () => {
    if (btn.classList.contains('confirming')) {
      clearTimeout(timer);
      btn.classList.remove('confirming');
      btn.textContent = original;
      onConfirm();
    } else {
      btn.classList.add('confirming');
      btn.textContent = confirmLabel;
      timer = setTimeout(() => {
        btn.classList.remove('confirming');
        btn.textContent = original;
      }, 4000);
    }
  });
}

wireConfirmButton(el('btnClearEvents'), 'Confirma? (clique de novo)', async () => {
  const days = Math.max(0, Number(el('clearEventsDays').value) || 0);
  const res = await chrome.runtime.sendMessage({ type: 'clearEvents', olderThanDays: days });
  showMaintenanceStatus(`Atualizações/Histórico: ${res.removed} registro(s) removido(s), ${res.remaining} restante(s).`);
  loadAll();
});

wireConfirmButton(el('btnClearTicketHistory'), 'Confirma? (clique de novo)', async () => {
  const days = Math.max(0, Number(el('clearTicketHistoryDays').value) || 0);
  const res = await chrome.runtime.sendMessage({ type: 'clearTicketHistory', olderThanDays: days });
  showMaintenanceStatus(`Histórico por chamado: ${res.removed} registro(s) removido(s), ${res.remaining} restante(s).`);
  loadAll();
});

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
  const customLabels = (lastConfig.customSources || []).map((s) => s.label);
  const sources = sourceFilter ? [sourceFilter] : ['GLPI', 'Evolutize', 'Movidesk', ...customLabels];
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
  config.glpiEnabled = el('glpiEnabled').checked;
  config.evolutizeEnabled = el('evolutizeEnabled').checked;
  config.movideskEnabled = el('movideskEnabled').checked;
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
  'glpiEnabled', 'evolutizeEnabled', 'movideskEnabled',
  'glpiAvulsos', 'glpiOnlyAvulsos', 'glpiAvulsoStaleDays',
  'evolutizeAvulsos', 'evolutizeOnlyAvulsos', 'evolutizeAvulsoUrls', 'evolutizeAvulsoStaleDays',
  'movideskAvulsos', 'movideskOnlyAvulsos', 'movideskAvulsoStaleDays',
  'staleDays', 'customLinks', 'customSources',
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
  const COLUMN_KEYS = ['number', 'status', 'requester', 'lastUpdate', 'lastUpdateBy'];
  const asColumnInfo = (v) =>
    v && typeof v === 'object' && !Array.isArray(v) && typeof v.tableSelector === 'string' && Number.isFinite(Number(v.columnIndex))
      ? { tableSelector: v.tableSelector, columnIndex: Number(v.columnIndex), headerText: typeof v.headerText === 'string' ? v.headerText : '' }
      : undefined;
  const asCustomSources = (v) =>
    Array.isArray(v)
      ? v
          .filter((x) => x && typeof x === 'object' && typeof x.id === 'string' && x.id && typeof x.label === 'string' && x.label && typeof x.listUrl === 'string')
          .map((x) => {
            const columns = {};
            if (x.columns && typeof x.columns === 'object' && !Array.isArray(x.columns)) {
              for (const key of COLUMN_KEYS) {
                const col = asColumnInfo(x.columns[key]);
                if (col) columns[key] = col;
              }
            }
            return {
              id: x.id,
              label: x.label,
              listUrl: x.listUrl,
              columns,
              avulsos: asArrayOfStrings(x.avulsos) || [],
              avulsoStaleDays: asPlainObject(x.avulsoStaleDays) || {},
              avulsoUrls: asPlainObject(x.avulsoUrls) || {},
              enabled: typeof x.enabled === 'boolean' ? x.enabled : true,
            };
          })
          .filter((x) => x.columns.number) // sem coluna de número não dá pra achar a linha certa depois
      : undefined;

  const out = {
    intervalMinutes: asNumber(incoming.intervalMinutes),
    soundEnabled: asBoolean(incoming.soundEnabled),
    glpiSearchUrl: asString(incoming.glpiSearchUrl),
    glpiEnabled: asBoolean(incoming.glpiEnabled),
    evolutizeEnabled: asBoolean(incoming.evolutizeEnabled),
    movideskEnabled: asBoolean(incoming.movideskEnabled),
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
    customSources: asCustomSources(incoming.customSources),
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

el('btnToggleTheme').addEventListener('click', async () => {
  const { uiTheme } = await chrome.storage.local.get('uiTheme');
  // Ciclo: automático (segue o sistema) → claro → escuro → automático de novo.
  const next = uiTheme === 'light' ? 'dark' : uiTheme === 'dark' ? null : 'light';
  if (next) {
    await chrome.storage.local.set({ uiTheme: next });
  } else {
    await chrome.storage.local.remove('uiTheme');
  }
  setThemeAttr(next);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  // Mantém outras abas do Hub abertas em sincronia se o tema for trocado em uma delas.
  if (changes.uiTheme) setThemeAttr(changes.uiTheme.newValue || null);
  loadAll();
});

loadAll();
