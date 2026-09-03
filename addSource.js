// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
// Assistente de "adicionar fonte personalizada" — pede pra clicar em cada campo (número,
// status, requerente, data/hora da atualização, usuário da tramitação) na página real do
// site do fornecedor, monta um seletor CSS pra cada um, e salva isso em
// config.customSources. A checagem de verdade (background.js) usa exatamente esses
// seletores depois, via extractCustomAvulso (extractors.js).

const el = (id) => document.getElementById(id);

const FIELDS = [
  { key: 'number', label: 'Número do ticket' },
  { key: 'status', label: 'Status' },
  { key: 'requester', label: 'Requerente' },
  { key: 'lastUpdate', label: 'Data e hora da atualização' },
  { key: 'lastUpdateBy', label: 'Usuário da tramitação' },
];

let sampleTabId = null;
let picked = {}; // key -> { selector, preview } | 'skipped' | undefined
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
    const probe = urlStr.includes('{numero}') ? urlStr.replace('{numero}', '1') : urlStr;
    const u = new URL(probe);
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

el('sourceUrlTemplate').addEventListener('blur', () => {
  if (el('sourceLabel').value.trim()) return;
  const suggestion = suggestLabelFromUrl(el('sourceUrlTemplate').value.trim());
  if (suggestion) el('sourceLabel').value = suggestion;
});

// ---------- modo edição (remapear campos de uma fonte já existente) ----------

async function initEditMode() {
  const params = new URLSearchParams(location.search);
  const editId = params.get('edit');
  if (!editId) return;
  const { config } = await chrome.storage.local.get('config');
  const found = ((config && config.customSources) || []).find((s) => s.id === editId);
  if (!found) return;
  editingSource = found;
  el('wizardTitle').textContent = `Remapear campos — ${found.label}`;
  el('sourceLabel').value = found.label;
  el('sourceUrlTemplate').value = found.urlTemplate || '';
  picked = {};
  Object.entries(found.selectors || {}).forEach(([key, selector]) => {
    picked[key] = { selector, preview: selector, fromPrevious: true };
  });
}

// ---------- passo 1: abrir a página de exemplo ----------

async function openSample() {
  const template = el('sourceUrlTemplate').value.trim();
  const sample = el('sampleNumber').value.trim();
  el('basicsHint').classList.remove('source-error-text');

  if (!template.includes('{numero}')) {
    el('basicsHint').textContent = 'A URL precisa conter {numero} no lugar do número do chamado (ex: https://site.com/tickets/{numero}).';
    el('basicsHint').classList.add('source-error-text');
    return;
  }
  if (!sample) {
    el('basicsHint').textContent = 'Informe um número de chamado real pra abrir a página de exemplo.';
    el('basicsHint').classList.add('source-error-text');
    return;
  }

  const url = template.replace('{numero}', encodeURIComponent(sample));
  let origin;
  try {
    origin = `${new URL(url).origin}/*`;
  } catch (e) {
    el('basicsHint').textContent = 'Essa URL não parece válida — confira se começa com http:// ou https://.';
    el('basicsHint').classList.add('source-error-text');
    return;
  }

  // Pede permissão pro domínio do fornecedor em tempo real — não precisa estar em
  // manifest.json de antemão (host_permissions fixo só cobre GLPI/Evolutize/Movidesk).
  // Isso só funciona porque estamos respondendo direto a um clique do usuário (o botão
  // "Abrir página de exemplo"); chrome.permissions.request() exige esse gesto.
  try {
    const already = await chrome.permissions.contains({ origins: [origin] });
    if (!already) {
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) {
        el('basicsHint').textContent = 'Sem permissão pra esse site, o Hub não consegue ler os campos da página. Clique de novo em "Abrir página de exemplo" se mudar de ideia.';
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
      await chrome.tabs.update(sampleTabId, { url, active: true });
    } catch (e) {
      sampleTabId = null;
    }
  }
  if (!sampleTabId) {
    const tab = await chrome.tabs.create({ url });
    sampleTabId = tab.id;
  }

  el('stepPicker').classList.remove('hidden');
  renderPickerFields();
}

el('btnOpenSample').addEventListener('click', openSample);
el('btnOpenSampleAgain').addEventListener('click', openSample);

// ---------- passo 2: selecionar campos ----------

function renderPickerFields() {
  const ul = el('pickerFields');
  ul.innerHTML = '';
  FIELDS.forEach((f) => {
    const state = picked[f.key];
    const li = document.createElement('li');
    li.className = 'picker-field';
    let statusHtml;
    if (state === 'skipped') {
      statusHtml = '<span class="muted">pulado — esse campo não existe nesse site</span>';
    } else if (state && state.fromPrevious) {
      statusHtml = `<span class="muted">mapeamento salvo: <code>${escapeHtml(state.selector)}</code> — clique em "Selecionar" pra atualizar</span>`;
    } else if (state) {
      statusHtml = `<span class="picked-preview">"${escapeHtml((state.preview || '').slice(0, 80))}"</span>`;
    } else {
      statusHtml = '<span class="muted">não selecionado ainda</span>';
    }
    li.innerHTML = `
      <div class="picker-field-label"><strong>${escapeHtml(f.label)}</strong>${statusHtml}</div>
      <div class="picker-field-actions">
        <button class="btn" data-action="pick" data-field="${f.key}">Selecionar</button>
        <button class="btn" data-action="skip" data-field="${f.key}">Pular</button>
      </div>`;
    ul.appendChild(li);
  });
  updateSaveButtonState();
}

function updateSaveButtonState() {
  const anyMapped = FIELDS.some((f) => picked[f.key] && picked[f.key] !== 'skipped');
  el('btnSaveSource').disabled = !anyMapped;
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
    el('pickerStatus').textContent = 'Nenhuma página de exemplo aberta — clique em "Reabrir página de exemplo" primeiro.';
    return;
  }
  const fieldLabel = FIELDS.find((f) => f.key === fieldKey).label;
  el('pickerStatus').textContent = `Clique no elemento certo pra "${fieldLabel}" na aba que foi trazida pra frente (Esc cancela).`;
  try {
    await chrome.tabs.update(sampleTabId, { active: true });
    await chrome.windows.update((await chrome.tabs.get(sampleTabId)).windowId, { focused: true });
  } catch (e) {
    el('pickerStatus').textContent = 'A aba de exemplo não está mais disponível — clique em "Reabrir página de exemplo".';
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
// extractors.js). Fica esperando o próximo clique na página inteira (captura, então
// intercepta ANTES de qualquer link/botão do próprio site reagir — importante pra não
// navegar embora sem querer) e manda o seletor + um preview do texto de volta pro
// assistente via chrome.runtime.sendMessage (disponível mesmo em scripts injetados assim,
// desde que a extensão tenha permissão pro domínio — foi isso que pedimos antes de abrir
// essa aba).
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
    if (lastEl) lastEl.style.outline = '';
    lastEl = e.target;
    lastEl.style.outline = HILITE;
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    const selector = buildSelector(target);
    const preview = (target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim();
    cleanup();
    chrome.runtime.sendMessage({ type: 'hubFieldPicked', field: fieldKey, selector, preview });
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
    picked[msg.field] = { selector: msg.selector, preview: msg.preview };
    renderPickerFields();
    const fieldLabel = FIELDS.find((f) => f.key === msg.field)?.label || msg.field;
    el('pickerStatus').textContent = `Campo "${fieldLabel}" capturado — seletor: ${msg.selector}`;
  }
  if (msg?.type === 'hubFieldPickCancelled') {
    el('pickerStatus').textContent = 'Seleção cancelada.';
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === sampleTabId) {
    sampleTabId = null;
    el('pickerStatus').textContent = 'A aba de exemplo foi fechada — clique em "Reabrir página de exemplo" pra continuar selecionando campos.';
  }
});

// ---------- salvar ----------

function genId() {
  return `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

el('btnSaveSource').addEventListener('click', async () => {
  const label = el('sourceLabel').value.trim();
  const urlTemplate = el('sourceUrlTemplate').value.trim();
  if (!label) {
    el('pickerStatus').textContent = 'Dê um nome pra essa fonte antes de salvar.';
    return;
  }
  if (!urlTemplate.includes('{numero}')) {
    el('pickerStatus').textContent = 'A URL precisa conter {numero} no lugar do número do chamado.';
    return;
  }
  const selectors = {};
  FIELDS.forEach((f) => {
    const p = picked[f.key];
    if (p && p !== 'skipped') selectors[f.key] = p.selector;
  });
  if (!Object.keys(selectors).length) {
    el('pickerStatus').textContent = 'Selecione pelo menos um campo antes de salvar.';
    return;
  }

  const { config } = await chrome.storage.local.get('config');
  const cfg = config || {};
  const list = [...(cfg.customSources || [])];

  if (editingSource) {
    const idx = list.findIndex((s) => s.id === editingSource.id);
    if (idx !== -1) list[idx] = { ...list[idx], label, urlTemplate, selectors };
  } else {
    list.push({ id: genId(), label, urlTemplate, selectors, avulsos: [], avulsoStaleDays: {}, enabled: true });
  }
  cfg.customSources = list;
  await chrome.storage.local.set({ config: cfg });

  if (sampleTabId) {
    try { await chrome.tabs.remove(sampleTabId); } catch (e) { /* aba já pode ter sido fechada */ }
  }
  window.location.href = 'dashboard.html';
});

initEditMode();
