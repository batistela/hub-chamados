// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
// Assistente de "adicionar fonte personalizada" — abre a tela onde o fornecedor lista
// TODOS os chamados (não uma página de detalhe por número, a pedido do Murilo: mais fácil
// de mapear os campos clicando numa lista já visível), pede pra mapear a coluna do
// "Número do ticket" (única obrigatória e estruturalmente especial — é como o Hub acha a
// linha certa depois) e, opcionalmente, quantos outros campos o usuário quiser (nome e
// ordem livres, a pedido do Murilo em 04/09/2026 — antes eram 4 campos fixos com nome
// travado tipo "Requerente"). Cada campo extra pode receber um "papel"
// (status/data-hora/quem-atualizou) que conecta ele à detecção inteligente de mudança do
// Hub sem depender do nome escolhido (ver checkCustomAvulsos, em background.js — essa
// resolução por papel acontece lá, não aqui). Salva tudo em config.customSources. A
// checagem de verdade (background.js) usa exatamente esse mapeamento depois, via
// extractCustomListRows (extractors.js) — mesma função usada aqui no botão "Testar", pra
// garantir que o comportamento é idêntico.

import { extractCustomListRows, normalizeCustomListColumns } from './extractors.js';

const el = (id) => document.getElementById(id);

const ROLES = [
  { value: 'info', label: 'Só mostrar (sem papel especial)' },
  { value: 'status', label: 'Status' },
  { value: 'lastUpdate', label: 'Data/hora da atualização' },
  { value: 'lastUpdateBy', label: 'Quem fez a atualização' },
];

let sampleTabId = null;
// { tableSelector, columnIndex, headerText, preview, fromPrevious? } | null
let numberField = null;
// Lista livre, na ordem de exibição escolhida pelo usuário — cada item:
// { key, label, role, tableSelector?, columnIndex?, headerText?, preview?, fromPrevious? }
// (sem tableSelector = ainda não mapeado; não entra no que é salvo).
let fields = [];
let editingSource = null;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function genFieldKey() {
  return `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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
  // normalizeCustomListColumns converte o formato antigo (sem `fields`, com
  // status/requester/lastUpdate/lastUpdateBy fixos) pro formato novo — assim reabrir uma
  // fonte cadastrada antes dessa mudança já aparece aqui como campos livres editáveis,
  // sem perder o mapeamento que já existia.
  const normalized = normalizeCustomListColumns(found.columns || {});
  numberField = normalized.number ? { ...normalized.number, fromPrevious: true } : null;
  fields = (normalized.fields || []).map((f) => ({ ...f, fromPrevious: true }));
  // Mostra o mapeamento já salvo mesmo antes de reabrir a aba — dá pra só corrigir o
  // nome e salvar de novo sem precisar remapear nada, se for só isso que mudou.
  el('stepPicker').classList.remove('hidden');
  el('stepTest').classList.remove('hidden');
  el('stepSave').classList.remove('hidden');
  renderAll();
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
  renderAll();
}

el('btnOpenSample').addEventListener('click', openSample);
el('btnOpenSampleAgain').addEventListener('click', openSample);

// ---------- passo 2: selecionar colunas ----------
// "Número do ticket" é a única coluna estruturalmente especial (obrigatória, sem "papel",
// sem poder remover) — renderizada à parte em #pickerFieldsFixed. Os demais campos são uma
// lista livre (#pickerFields): quantidade, nome e ordem escolhidos pelo usuário, cada um
// com um "papel" opcional que conecta ele à detecção inteligente de mudança.

function columnSummary(state) {
  if (state.headerText) return `coluna "${escapeHtml(state.headerText)}"`;
  return `coluna nº ${Number(state.columnIndex) + 1} (sem cabeçalho detectado)`;
}

function renderAll() {
  renderNumberField();
  renderCustomFieldsList();
  updateSaveButtonState();
}

function renderNumberField() {
  const ul = el('pickerFieldsFixed');
  ul.innerHTML = '';
  const li = document.createElement('li');
  li.className = 'picker-field';
  let statusHtml;
  if (numberField && numberField.fromPrevious) {
    statusHtml = `<span class="muted">mapeamento salvo: ${columnSummary(numberField)} — clique em "Selecionar" pra atualizar</span>`;
  } else if (numberField) {
    statusHtml = `<span class="picked-preview">${columnSummary(numberField)} — ex: "${escapeHtml((numberField.preview || '').slice(0, 60))}"</span>`;
  } else {
    statusHtml = '<span class="muted">não selecionado ainda</span>';
  }
  li.innerHTML = `
    <div class="picker-field-label"><strong>Número do ticket<span class="required-tag">obrigatório</span></strong>${statusHtml}</div>
    <div class="picker-field-actions">
      <button class="btn" data-action="pick-number">Selecionar</button>
    </div>`;
  ul.appendChild(li);
}

function renderCustomFieldsList() {
  const ul = el('pickerFields');
  ul.innerHTML = '';
  if (!fields.length) {
    ul.innerHTML = '<li class="muted small">Nenhum campo extra adicionado ainda — clique em "+ Adicionar campo" se quiser capturar mais alguma coisa (status, requerente, data, etc.).</li>';
    return;
  }
  fields.forEach((f, i) => {
    const li = document.createElement('li');
    li.className = 'picker-field custom-field';
    li.dataset.key = f.key;
    let statusHtml;
    if (f.tableSelector && f.fromPrevious) {
      statusHtml = `<span class="muted">mapeamento salvo: ${columnSummary(f)} — clique em "Selecionar" pra atualizar</span>`;
    } else if (f.tableSelector) {
      statusHtml = `<span class="picked-preview">${columnSummary(f)} — ex: "${escapeHtml((f.preview || '').slice(0, 60))}"</span>`;
    } else {
      statusHtml = '<span class="muted">coluna ainda não selecionada</span>';
    }
    const roleOptions = ROLES.map((r) => `<option value="${r.value}"${f.role === r.value ? ' selected' : ''}>${escapeHtml(r.label)}</option>`).join('');
    li.innerHTML = `
      <div class="field-row-top">
        <input type="text" class="field-label-input" value="${escapeHtml(f.label || '')}" placeholder="Nome do campo (ex: Requerente)" />
        <select class="field-role-select">${roleOptions}</select>
        <div class="field-reorder">
          <button class="btn icon-btn" data-action="up" ${i === 0 ? 'disabled' : ''} title="Mover pra cima">▲</button>
          <button class="btn icon-btn" data-action="down" ${i === fields.length - 1 ? 'disabled' : ''} title="Mover pra baixo">▼</button>
          <button class="btn danger icon-btn" data-action="remove" title="Remover campo">✕</button>
        </div>
      </div>
      <div class="field-row-bottom">
        ${statusHtml}
        <button class="btn" data-action="pick">Selecionar</button>
      </div>`;
    ul.appendChild(li);
  });
}

function updateSaveButtonState() {
  el('btnSaveSource').disabled = !(numberField && numberField.tableSelector);
}

function moveField(key, delta) {
  const idx = fields.findIndex((f) => f.key === key);
  if (idx < 0) return;
  const newIdx = idx + delta;
  if (newIdx < 0 || newIdx >= fields.length) return;
  const [item] = fields.splice(idx, 1);
  fields.splice(newIdx, 0, item);
  renderAll();
}

el('pickerFieldsFixed').addEventListener('click', (ev) => {
  if (ev.target.closest('button[data-action="pick-number"]')) startPickingField('__number__');
});

el('btnAddField').addEventListener('click', () => {
  fields.push({ key: genFieldKey(), label: `Campo ${fields.length + 1}`, role: 'info' });
  renderAll();
});

el('pickerFields').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-key]');
  if (!li) return;
  const key = li.dataset.key;
  const btn = ev.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'pick') startPickingField(key);
  if (action === 'remove') { fields = fields.filter((f) => f.key !== key); renderAll(); }
  if (action === 'up') moveField(key, -1);
  if (action === 'down') moveField(key, 1);
});

// Atualiza o estado direto, sem re-renderizar a lista inteira — evita perder o foco/cursor
// no meio da digitação do nome do campo (renderAll() recria o DOM da lista).
el('pickerFields').addEventListener('input', (ev) => {
  const li = ev.target.closest('li[data-key]');
  if (!li) return;
  const f = fields.find((x) => x.key === li.dataset.key);
  if (!f) return;
  if (ev.target.classList.contains('field-label-input')) f.label = ev.target.value;
});
el('pickerFields').addEventListener('change', (ev) => {
  const li = ev.target.closest('li[data-key]');
  if (!li) return;
  const f = fields.find((x) => x.key === li.dataset.key);
  if (!f) return;
  if (ev.target.classList.contains('field-role-select')) f.role = ev.target.value;
});

async function startPickingField(fieldKey) {
  if (!sampleTabId) {
    el('pickerStatus').textContent = 'Nenhuma tela aberta — clique em "Reabrir a tela" primeiro.';
    return;
  }
  const fieldLabel = fieldKey === '__number__' ? 'Número do ticket' : (fields.find((f) => f.key === fieldKey)?.label || 'campo selecionado');
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
// extractors.js — os seletores CUSTOM_GRID_SEL/CUSTOM_ROW_SEL/CUSTOM_CELL_SEL de lá estão
// duplicados aqui embaixo por esse mesmo motivo, não dá pra importar/referenciar). Fica
// esperando o próximo clique numa célula (captura, então intercepta ANTES de qualquer
// link/botão do próprio site reagir) e manda a coluna (índice + texto do cabeçalho, se
// achar) de volta pro assistente via chrome.runtime.sendMessage — disponível mesmo em
// scripts injetados assim, desde que a extensão tenha permissão pro domínio (foi isso que
// pedimos antes de abrir essa aba).
//
// Reconhece tanto <table> de verdade quanto grades feitas com <div> + papéis ARIA
// (role="grid"/"row"/"gridcell"/"columnheader" — padrão usado por vários componentes de
// grade React/Fluent UI, incluindo listas modernas do SharePoint) — mesmo raciocínio já
// aplicado em extractCustomListRows (extractors.js), pra a busca de verdade reconhecer o
// que foi mapeado aqui.
function injectPicker(fieldKey) {
  if (window.__hubPickerCleanup) window.__hubPickerCleanup();

  const GRID_SEL = 'table, [role="grid"], [role="table"], [role="treegrid"]';
  const ROW_SEL = 'tr, [role="row"]';
  const CELL_SEL = 'td, th, [role="gridcell"], [role="columnheader"], [role="cell"], [role="rowheader"]';

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

  // Mesma lógica de rowsOf/cellsOf de extractCustomListRows: usa .closest() pra garantir
  // que a linha/célula pertence mesmo à grade/linha em questão (evita pegar uma linha de
  // uma sub-grade aninhada por engano).
  function rowsOf(root) {
    return Array.from(root.querySelectorAll(ROW_SEL)).filter((r) => r.closest(GRID_SEL) === root);
  }
  function cellsOf(row) {
    return Array.from(row.querySelectorAll(CELL_SEL)).filter((c) => c.closest(ROW_SEL) === row);
  }

  function onOver(e) {
    const cell = e.target.closest(CELL_SEL);
    if (lastEl) lastEl.style.outline = '';
    lastEl = cell || null;
    if (lastEl) lastEl.style.outline = HILITE;
  }

  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const cell = e.target.closest(CELL_SEL);
    if (!cell) {
      chrome.runtime.sendMessage({
        type: 'hubFieldPickError',
        field: fieldKey,
        message: 'Clique dentro de uma célula da lista (uma coluna de um chamado) — pode tentar de novo.',
      });
      return; // não limpa — deixa tentar de novo sem precisar clicar "Selecionar" outra vez
    }
    const row = cell.closest(ROW_SEL);
    const grid = row ? row.closest(GRID_SEL) : null;
    if (!row || !grid) {
      cleanup();
      chrome.runtime.sendMessage({
        type: 'hubFieldPickError',
        field: fieldKey,
        message:
          'Não consegui identificar uma linha/tabela em volta dessa célula — esse site parece usar um formato de ' +
          'lista diferente dos suportados (tabela HTML ou grade com papéis ARIA tipo as listas modernas do SharePoint).',
      });
      return;
    }
    const cellsInRow = cellsOf(row);
    const columnIndex = cellsInRow.indexOf(cell);
    const rowsInGrid = rowsOf(grid);
    const headRow = rowsInGrid[0];
    const headerCells = headRow ? cellsOf(headRow) : [];
    const headerCell = headerCells[columnIndex];
    const headerText = headerCell ? (headerCell.innerText || headerCell.textContent || '').trim() : '';
    const preview = (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim();
    const tableSelector = buildSelector(grid);
    // Alguns sites (ex.: listas modernas do SharePoint) posicionam as células visualmente via
    // CSS Grid (grid-column: calc(...)), o que pode deixar a ordem visual/lógica de uma coluna
    // desalinhada da ordem em que ela aparece no DOM — em linhas diferentes, o mesmo índice pode
    // corresponder a colunas diferentes. Quando a célula tem um data-automationid estável (como
    // o SharePoint usa), guardamos ele como um identificador de coluna mais confiável que o
    // índice puro, e extractCustomListRows tenta usá-lo primeiro antes de cair pro índice.
    const columnKey = cell.getAttribute('data-automationid') || '';
    cleanup();
    chrome.runtime.sendMessage({ type: 'hubFieldPicked', field: fieldKey, tableSelector, columnIndex, columnKey, headerText, preview });
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
    const sel = {
      tableSelector: msg.tableSelector,
      columnIndex: msg.columnIndex,
      columnKey: msg.columnKey || '',
      headerText: msg.headerText,
      preview: msg.preview,
    };
    let fieldLabel = msg.field;
    if (msg.field === '__number__') {
      numberField = sel;
      fieldLabel = 'Número do ticket';
    } else {
      const f = fields.find((x) => x.key === msg.field);
      if (f) {
        Object.assign(f, sel, { fromPrevious: false });
        fieldLabel = f.label || msg.field;
      }
    }
    renderAll();
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

// Só entram no que é testado/salvo os campos extras que já têm uma coluna mapeada — um
// campo adicionado mas ainda não clicado simplesmente não vai junto (fica só na tela até o
// usuário mapear ou remover).
function buildColumns() {
  const columns = { fields: [] };
  if (numberField && numberField.tableSelector) {
    columns.number = {
      tableSelector: numberField.tableSelector,
      columnIndex: numberField.columnIndex,
      columnKey: numberField.columnKey || '',
      headerText: numberField.headerText,
    };
  }
  columns.fields = fields
    .filter((f) => f.tableSelector)
    .map((f) => ({
      key: f.key,
      label: (f.label || '').trim() || 'Campo',
      role: f.role || 'info',
      tableSelector: f.tableSelector,
      columnIndex: f.columnIndex,
      columnKey: f.columnKey || '',
      headerText: f.headerText,
    }));
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
  const columns = buildColumns();
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
      const dbg = result && result.__debug;
      let extra = '';
      if (dbg) {
        const sample = (dbg.numberColumnSample || []).map((v) => `"${v || '—'}"`).join(', ') || '(nenhum valor lido)';
        extra = ` [diagnóstico: grade ${dbg.gridInfo}, ${dbg.totalBodyRows} linha(s) de dado, cabeçalho da coluna "Número do ticket" = "${dbg.numberColumnHeaderText || '(vazio)'}", primeiros valores vistos nessa coluna: ${sample}]`;
      }
      el('testResult').textContent = `Não encontrei o chamado ${num} nessa lista — pode estar filtrado/fora da página atual, ou o mapeamento de colunas não bateu. Confira se a coluna "Número do ticket" foi mapeada certa.${extra}`;
    } else {
      const rowFields = row.fields || {};
      const parts = columns.fields.map((f) => `${f.label}: "${rowFields[f.key] || '—'}"`).join(', ');
      el('testResult').textContent = `Encontrado${parts ? ` — ${parts}` : ''}.`;
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
  const columns = buildColumns();
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
