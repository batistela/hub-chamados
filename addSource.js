// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
// Assistente de "adicionar fonte personalizada" — abre a tela onde o fornecedor lista
// TODOS os chamados (não uma página de detalhe por número, a pedido do Murilo: mais fácil
// de mapear os campos clicando numa lista já visível), pede pra clicar em cada uma das 5
// colunas (número, status, requerente, data/hora da atualização, usuário da tramitação),
// e salva isso em config.customSources. A checagem de verdade (background.js) usa
// exatamente esse mapeamento depois, via extractCustomListRows (extractors.js) — mesma
// função usada aqui no botão "Testar", pra garantir que o comportamento é idêntico.

import { extractCustomListRows } from './extractors.js';

const el = (id) => document.getElementById(id);

const FIELDS = [
  { key: 'number', label: 'Número do ticket', required: true },
  { key: 'status', label: 'Status' },
  { key: 'requester', label: 'Requerente' },
  { key: 'lastUpdate', label: 'Data e hora da atualização' },
  { key: 'lastUpdateBy', label: 'Usuário da tramitação' },
];

let sampleTabId = null;
// key -> { tableSelector, columnIndex, headerText, preview, fromPrevious? } | 'skipped' | undefined
let picked = {};
let editingSource = null;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- tema claro/escuro (mesma lógica do dashboard.js, pra ficar consistente) ----------
async function applyStoredTheme() {
  const { uiTheme } = await chrome.storage.local.get('uiTheme');
  if (uiTheme === 'dark' || uiTheme === 'light') document.documentElement.dataset.theme = uiTheme;
}
applyStoredTheme();

// ---------- sugestão de nome a partir do domínio ----------
// Só preenche automaticamente se o campo de nome ainda estiver vazio — nunca sobrescreve
// o que o usuário já digitou. Heurística simples: pega o penúltimo pedaço do domínio (ex:
// "suporte.evolutize.com.br" -> "evolutize"; "empresa.zendesk.com" -> "zendesk"); se isso
// cair num sufixo genérico tipo "com"/"com.br", usa o primeiro pedaço em vez disso.
function suggestLabelFromUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const host = u.hostname.replace(/^www\./, '');
    const parts = host.split('.');
    if (!parts.length) return '';
    let core = parts.length >= 2 ? parts[parts.length - 2] : parts[0];
    if (['com', 'com.br', 'co', 'org', 'net', 'gov'].includes(core)) core = parts[0];
    if (!core) return '';
    return core.charAt(0).toUpperCase() + core.slice(1);
  } catch (e) {
    return '';
  }
}

el('sourceListUrl').addEventListener('blur', () => {
  if (el('sourceLabel').value.trim()) return;
  const suggestion = suggestLabelFromUrl(el('sourceListUrl').value.trim());
  if (suggestion) el('sourceLabel').value = suggestion;
});

// ---------- modo edição (remapear colunas de uma fonte já existente) ----------

async function initEditMode() {
  const params = new URLSearchParams(location.search);
  const editId = params.get('edit');
  if (!editId) return;
  const { config } = await chrome.storage.local.get('config');
  const found = ((config && config.customSources) || []).find((s) => s.id === editId);
  if (!found) return;
  editingSource = found;
  el('wizardTitle').textContent = `Remapear colunas — ${found.label}`;
  el('sourceLabel').value = found.label;
  el('sourceListUrl').value = found.listUrl || '';
  picked = {};
  Object.entries(found.columns || {}).forEach(([key, col]) => {
    picked[key] = { ...col, fromPrevious: true };
  });
  // Mostra o mapeamento já salvo mesmo antes de reabrir a aba — dá pra só corrigir o
  // nome e salvar de novo sem precisar remapear nada, se for só isso que mudou.
  el('stepPicker').classList.remove('hidden');
  el('stepTest').classList.remove('hidden');
  el('stepSave').classList.remove('hidden');
  renderPickerFields();
}

// ---------- passo 1: abrir a tela com a lista ----------

async function openSample() {
  const listUrl = el('sourceListUrl').value.trim();
  el('basicsHint').classList.remove('source-error-text');

  if (!listUrl) {
    el('basicsHint').textContent = 'Informe a URL da tela com a lista de chamados.';
    el('basicsHint').classList.add('source-error-text');
    return;
  }

  let origin;
  try {
    origin = `${new URL(listUrl).origin}/*`;
  } catch (e) {
    el('basicsHint').textContent = 'Essa URL não parece válida — confira se começa com http:// ou https://.';
    el('basicsHint').classList.add('source-error-text');
    return;
  }

  // Pede permissão pro domínio do fornecedor em tempo real — não precisa estar em
  // manifest.json de antemão (host_permissions fixo só cobre GLPI/Evolutize/Movidesk).
  // Só funciona porque estamos respondendo direto a um clique do usuário (o botão
  // "Abrir essa tela"); chrome.permissions.request() exige esse gesto.
  try {
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (!already) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        el('basicsHint').textContent = 'Sem permissão pra esse site, o Hub não consegue ler a tabela. Clique de novo em "Abrir essa tela" se mudar de ideia.';
        el('basicsHint').classList.add('source-error-text');
        return;
      }
    }
  } catch (e) {
    el('basicsHint').textContent = `Não consegui pedir permissão pra esse domínio: ${(e && e.message) || e}`;
    el('basicsHint').classList.add('source-error-text');
    return;
  }

  el('basicsHint').textContent = '';
  if (sampleTabId) {
    try {
      await chrome.tabs.update(sampleTabId, { url: listUrl, active: true });
    } catch (e) {
      sampleTabId = null;
    }
  }
  if (!sampleTabId) {
    const tab = await chrome.tabs.create({ url: listUrl });
    sampleTabId = tab.id;
  }

  el('stepPicker').classList.remove('hidden');
  el('stepTest').classList.remove('hidden');
  el('stepSave').classList.remove('hidden');
  renderPickerFields();
}

el('btnOpenSample').addEventListener('click', openSample);
el('btnOpenSampleAgain').addEventListener('click', openSample);

// ---------- passo 2: selecionar colunas ----------

function columnSummary(state) {
  if (state.headerText) return `coluna "${escapeHtml(state.headerText)}"`;
  return `coluna nº ${Number(state.columnIndex) + 1} (sem cabeçalho detectado)`;
}

function renderPickerFields() {
  const ul = el('pickerFields');
  ul.innerHTML = '';
  FIELDS.forEach((f) => {
    const state = picked[f.key];
    const li = document.createElement('li');
    li.className = 'picker-field';
    let statusHtml;
    if (state === 'skipped') {
      statusHtml = '<span class="muted">pulado — essa coluna não existe nesse site</span>';
    } else if (state && state.fromPrevious) {
      statusHtml = `<span class="muted">mapeamento salvo: ${columnSummary(state)} — clique em "Selecionar" pra atualizar</span>`;
    } else if (state) {
      statusHtml = `<span class="picked-preview">${columnSummary(state)} — ex: "${escapeHtml((state.preview || '').slice(0, 60))}"</span>`;
    } else {
      statusHtml = '<span class="muted">não selecionado ainda</span>';
    }
    const requiredTag = f.required ? '<span class="required-tag">obrigatório</span>' : '';
    const skipBtn = f.required ? '' : `<button class="btn" data-action="skip" data-field="${f.key}">Pular</button>`;
    li.innerHTML = `
      <div class="picker-field-label"><strong>${escapeHtml(f.label)}${requiredTag}</strong>${statusHtml}</div>
      <div class="picker-field-actions">
        <button class="btn" data-action="pick" data-field="${f.key}">Selecionar</button>
        ${skipBtn}
      </div>`;
    ul.appendChild(li);
  });
  updateSaveButtonState();
}

function updateSaveButtonState() {
  const numberMapped = picked.number && picked.number !== 'skipped';
  el('btnSaveSource').disabled = !numberMapped;
}

el('pickerFields').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const field = btn.dataset.field;
  if (btn.dataset.action === 'skip') {
    picked[field] = 'skipped';
    renderPickerFields();
    return;
  }
  if (btn.dataset.action === 'pick') startPickingField(field);
});

async function startPickingField(fieldKey) {
  if (!sampleTabId) {
    el('pickerStatus').textContent = 'Nenhuma tela aberta — clique em "Reabrir a tela" primeiro.';
    return;
  }
  const fieldLabel = FIELDS.find((f) => f.key === fieldKey).label;
  el('pickerStatus').textContent = `Clique em qualquer célula da coluna "${fieldLabel}" na aba que foi trazida pra frente (Esc cancela).`;
  try {
    await chrome.tabs.update(sampleTabId, { active: true });
    const tab = await chrome.tabs.get(sampleTabId);
    await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    el('pickerStatus').textContent = 'A aba não está mais disponível — clique em "Reabrir a tela".';
    sampleTabId = null;
    return;
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId: sampleTabId }, func: injectPicker, args: [fieldKey] });
  } catch (e) {
    el('pickerStatus').textContent = `Não consegui preparar a seleção nessa página: ${(e && e.message) || e}`;
  }
}

// Injetada na aba de exemplo via chrome.scripting.executeScript — roda isolada, sem
// acesso ao escopo daqui (por isso é totalmente self-contained, igual às funções de
// extractors.js). Fica esperando o próximo clique numa célula de tabela (captura, então
// intercepta ANTES de qualquer link/botão do próprio site reagir) e manda a coluna
// (índice + texto do cabeçalho, se achar) de volta pro assistente via
// chrome.runtime.sendMessage — disponível mesmo em scripts injetados assim, desde que a
// extensão tenha permissão pro domínio (foi isso que pedimos antes de abrir essa aba).
function injectPicker(fieldKey) {
  if (window.__hubPickerCleanup) window.__hubPickerCleanup();

  const HILITE = '2px solid #4f46e5';
  let lastEl = null;

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^a-zA-Z0-9_-])/g, '\\$1');
  }
  function buildSelector(target) {
    if (target.id) return `#${cssEscape(target.id)}`;
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'name']) {
      const v = target.getAttribute(attr);
      if (v) return `[${attr}="${cssEscape(v)}"]`;
    }
    const path = [];
    let node = target;
    while (node && node.nodeType === 1 && node !== document.body) {
      let sel = node.tagName.toLowerCase();
      if (typeof node.className === 'string' && node.className.trim()) {
        const cls = node.className.trim().split(/\s+/).filter((c) => c && !/^\d/.test(c)).slice(0, 2);
        if (cls.length) sel += '.' + cls.map(cssEscape).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      path.unshift(sel);
      node = parent;
      const candidate = path.join(' > ');
      try {
        if (document.querySelectorAll(candidate).length === 1) return candidate;
      } catch (e) {
        // combinação de seletor inválida nesse ponto — segue subindo na árvore
      }
    }
    return path.join(' > ');
  }

  function onOver(e) {
    const cell = e.target.closest('td, th');
    if (lastEl) lastEl.style.outline = '';
    lastEl = cell || null;
    if (lastEl) lastEl.style.outline = HILITE;
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const cell = e.target.closest('td, th');
    if (!cell) {
      chrome.runtime.sendMessage({
        type: 'hubFieldPickError',
        field: fieldKey,
        message: 'Clique dentro de uma célula da tabela (uma coluna de um chamado na lista) — pode tentar de novo.',
      });
      return; // não limpa — deixa tentar de novo sem precisar clicar "Selecionar" outra vez
    }
    const table = cell.closest('table');
    if (!table) {
      cleanup();
      chrome.runtime.sendMessage({
        type: 'hubFieldPickError',
        field: fieldKey,
        message: 'Essa célula não está dentro de uma <table> — esse modo só funciona com listas em formato de tabela.',
      });
      return;
    }
    const row = cell.parentElement;
    const columnIndex = Array.from(row.children).indexOf(cell);
    const headRow = (table.tHead && table.tHead.rows[0]) || table.rows[0];
    const headerCell = headRow ? headRow.cells[columnIndex] : null;
    const headerText = headerCell ? (headerCell.innerText || headerCell.textContent || '').trim() : '';
    const preview = (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim();
    const tableSelector = buildSelector(table);
    cleanup();
    chrome.runtime.sendMessage({ type: 'hubFieldPicked', field: fieldKey, tableSelector, columnIndex, headerText, preview });
  }

  function onKeydown(e) {
    if (e.key !== 'Escape') return;
    cleanup();
    chrome.runtime.sendMessage({ type: 'hubFieldPickCancelled', field: fieldKey });
  }

  function cleanup() {
    if (lastEl) lastEl.style.outline = '';
    document.removeEventListener('mouseover', onOver, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.__hubPickerCleanup = null;
  }

  window.__hubPickerCleanup = cleanup;
  document.addEventListener('mouseover', onOver, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'hubFieldPicked') {
    picked[msg.field] = { tableSelector: msg.tableSelector, columnIndex: msg.columnIndex, headerText: msg.headerText, preview: msg.preview };
    renderPickerFields();
    const fieldLabel = FIELDS.find((f) => f.key === msg.field)?.label || msg.field;
    el('pickerStatus').textContent = `Coluna de "${fieldLabel}" capturada${msg.headerText ? ` (cabeçalho: "${msg.headerText}")` : ''}.`;
  }
  if (msg?.type === 'hubFieldPickError') {
    el('pickerStatus').textContent = msg.message;
  }
  if (msg?.type === 'hubFieldPickCancelled') {
    el('pickerStatus').textContent = 'Seleção cancelada.';
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sampleTabId) {
    sampleTabId = null;
    el('pickerStatus').textContent = 'A aba foi fechada — clique em "Reabrir a tela" pra continuar selecionando colunas.';
  }
});

// ---------- passo 3: testar ----------

function buildColumnsFromPicked() {
  const columns = {};
  FIELDS.forEach((f) => {
    const p = picked[f.key];
    if (p && p !== 'skipped') columns[f.key] = { tableSelector: p.tableSelector, columnIndex: p.columnIndex, headerText: p.headerText };
  });
  return columns;
}

el('btnTestLookup').addEventListener('click', async () => {
  if (!sampleTabId) {
    el('testResult').textContent = 'Abra a tela primeiro.';
    return;
  }
  const num = el('testNumber').value.trim();
  if (!num) {
    el('testResult').textContent = 'Informe um número de chamado pra testar.';
    return;
  }
  const columns = buildColumnsFromPicked();
  if (!columns.number) {
    el('testResult').textContent = 'Mapeie a coluna "Número do ticket" primeiro.';
    return;
  }
  el('testResult').textContent = 'Testando...';
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: sampleTabId },
      func: extractCustomListRows,
      args: [columns, [num]],
    });
    if (result && result.pageError) {
      el('testResult').textContent = 'Não encontrei nenhuma tabela nessa página — confira se a aba ainda está na tela certa.';
      return;
    }
    const row = result && result[num];
    if (!row || row.notFound) {
      el('testResult').textContent = `Não encontrei o chamado ${num} nessa lista — pode estar filtrado/fora da página atual, ou o mapeamento de colunas não bateu. Confira se a coluna "Número do ticket" foi mapeada certa.`;
    } else {
      el('testResult').textContent =
        `Encontrado — status: "${row.status || '—'}"` +
        (columns.requester ? `, requerente: "${row.requester || '—'}"` : '') +
        (columns.lastUpdate ? `, última atualização: "${row.lastUpdate || '—'}"` : '') +
        (columns.lastUpdateBy && row.lastUpdateBy ? ` (${row.lastUpdateBy})` : '') +
        '.';
    }
  } catch (e) {
    el('testResult').textContent = `Erro ao testar: ${(e && e.message) || e}`;
  }
});

// ---------- salvar ----------

function genId() {
  return `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

el('btnSaveSource').addEventListener('click', async () => {
  const label = el('sourceLabel').value.trim();
  const listUrl = el('sourceListUrl').value.trim();
  if (!label) {
    el('pickerStatus').textContent = 'Dê um nome pra essa fonte antes de salvar.';
    return;
  }
  if (!listUrl) {
    el('pickerStatus').textContent = 'Informe a URL da lista antes de salvar.';
    return;
  }
  const columns = buildColumnsFromPicked();
  if (!columns.number) {
    el('pickerStatus').textContent = 'Mapeie a coluna "Número do ticket" antes de salvar — é como o Hub encontra a linha certa.';
    return;
  }

  const { config } = await chrome.storage.local.get('config');
  const cfg = config || {};
  const list = [...(cfg.customSources || [])];

  if (editingSource) {
    const idx = list.findIndex((s) => s.id === editingSource.id);
    if (idx !== -1) list[idx] = { ...list[idx], label, listUrl, columns };
  } else {
    list.push({ id: genId(), label, listUrl, columns, avulsos: [], avulsoStaleDays: {}, avulsoUrls: {}, enabled: true });
  }
  cfg.customSources = list;
  await chrome.storage.local.set({ config: cfg });

  if (sampleTabId) {
    try { await chrome.tabs.remove(sampleTabId); } catch (e) { /* aba já pode ter sido fechada */ }
  }
  window.location.href = 'dashboard.html';
});

initEditMode();
