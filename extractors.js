// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
// Funções injetadas nas páginas via chrome.scripting.executeScript.
// Cada uma roda DENTRO do contexto da página (não tem acesso ao chrome.storage etc).
// Ficam num arquivo separado só pra ficar mais fácil de ler/ajustar; o background.js
// referencia essas mesmas funções (copiadas) na hora de injetar, porque
// chrome.scripting.executeScript precisa da função "self-contained" (sem depender
// de imports externos).

export function extractGLPIList() {
  // Mesmo raciocínio já aplicado na Evolutize: se a pesquisa salva não retorna NENHUM
  // chamado, é bem mais provável ser sessão expirada, página não carregada corretamente,
  // ou a URL salva ter parado de funcionar do que a pesquisa estar genuinamente vazia —
  // então isso conta como possível problema de acesso (pageError), não como "lista vazia
  // real". Sem essa validação, uma falha de carregamento faz o Hub achar que todos os
  // chamados acompanhados "sumiram" de uma vez.
  const table = document.querySelector('table.search-results');
  if (!table) return { pageError: 'sessao' };
  const rows = Array.from(table.querySelectorAll('tr'));
  if (rows.length <= 1) return { pageError: 'sessao' };
  const headerCells = Array.from(rows[0].querySelectorAll('th,td')).map((c) => c.innerText.trim().toUpperCase());
  const idx = (name) => headerCells.indexOf(name);
  // GLPI às vezes duplica o nome do grupo no cabeçalho da coluna (ex: "Requerente -
  // Requerente"), então em vez de exigir igualdade exata pra essa aqui, aceita qualquer
  // cabeçalho que COMECE com um dos nomes esperados.
  const idxStartingWith = (prefixes) => headerCells.findIndex((h) => prefixes.some((p) => h.startsWith(p)));
  const iId = idx('ID');
  const iTitle = idx('TÍTULO');
  const iStatus = idx('STATUS');
  const iUpdate = idx('ÚLTIMA ATUALIZAÇÃO');
  // Coluna "Requerente"/"Solicitante" só aparece se estiver configurada na pesquisa
  // salva do GLPI (mesma lógica de "Última atualização") — se não estiver, essa coluna
  // simplesmente não é encontrada e o campo fica vazio (o Hub não quebra por isso).
  const iRequester = idxStartingWith(['REQUERENTE', 'SOLICITANTE', 'ABERTO POR']);
  // Coluna "Última edição por" — adicionada na pesquisa salva pra alimentar o mesmo
  // "quem" que já existia pra Evolutize (lastUpdateBy). Mesma lógica de tolerância a
  // prefixo/duplicação de nome de grupo que as outras colunas opcionais.
  const iUpdateBy = idxStartingWith(['ÚLTIMA EDIÇÃO POR', 'ÚLTIMO EDITOR', 'EDITADO POR', 'MODIFICADO POR']);
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll('td'));
    if (!cells.length) continue;
    const get = (i) => (i >= 0 && cells[i] ? cells[i].innerText.trim() : '');
    const id = get(iId).replace(/\s+/g, '');
    if (!/^\d+$/.test(id)) continue;
    out.push({
      id,
      title: get(iTitle),
      status: get(iStatus),
      lastUpdate: get(iUpdate),
      lastUpdateBy: get(iUpdateBy),
      requester: get(iRequester),
    });
  }
  // A tabela existia e tinha linhas, mas nenhuma passou como um chamado válido — mesmo
  // sinal de alerta que os casos acima, então trata do mesmo jeito.
  if (!out.length) return { pageError: 'sessao' };
  return out;
}

export function extractGLPIAvulso() {
  const title = (document.title || '').replace(/\s+-\s+GLPI$/, '').trim();
  let bodyText = document.body ? document.body.innerText || '' : '';
  // Mitigação parcial pra um falso-positivo conhecido: o hash pega a página inteira, e
  // isso inclui qualquer texto de data/hora RELATIVA que o GLPI recalcula sozinho a cada
  // carregamento (ex: "há 3 minutos" em algum widget/menu não relacionado ao chamado em
  // si) — sem isso, a mera passagem do tempo já muda o hash mesmo sem nada mudar no
  // chamado. Isso não resolve 100% (a causa raiz pode ser outra coisa na página, ainda
  // sob investigação — ver conversa com o Murilo), mas remove uma fonte de ruído comum e
  // conhecida sem precisar restringir a um seletor específico que ainda não confirmamos.
  bodyText = bodyText.replace(/há\s+\d+\s+(segundo|minuto|hora|dia|semana|m[êe]s(?:es)?|ano)s?(\s+atr[áa]s)?/gi, '');
  let hash = 0;
  for (let i = 0; i < bodyText.length; i++) hash = (hash * 31 + bodyText.charCodeAt(i)) >>> 0;
  const notFound = /não existe|not found|erro/i.test(title) && bodyText.length < 200;
  return { title, hash, length: bodyText.length, notFound };
}

export async function runEvolutizeList() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // A Evolutize tem um bug conhecido de sessão: de tempos em tempos a sessão expira,
  // mas em vez de mandar pra tela de login ela mostra uma tela que PARECE autenticada
  // (mesmo layout de sempre) só que não está funcional — só volta a funcionar depois
  // de um login manual. Se isso acontecer, os elementos que esperamos (filtro de
  // situação, grade de resultados) não vão existir. Detectamos essa situação em vez de
  // deixar passar como "lista vazia" — porque uma lista vazia de verdade viraria um
  // monte de eventos falsos de "chamado sumiu/foi encerrado" pra tudo que já era
  // acompanhado, o que não é o que realmente aconteceu.
  const selects = Array.from(document.querySelectorAll('select'));
  const situacaoSelect = selects.find((s) => Array.from(s.options).some((o) => o.text.trim() === 'Todas'));
  if (!situacaoSelect) {
    return { pageError: 'sessao' };
  }
  const opt = Array.from(situacaoSelect.options).find((o) => o.text.trim() === 'Todas');
  situacaoSelect.value = opt.value;
  situacaoSelect.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(400);
  const btns = Array.from(document.querySelectorAll('button, input[type=button], a'));
  const pesquisar = btns.find((b) => (b.innerText || b.value || '').trim() === 'Pesquisar');
  if (pesquisar) pesquisar.click();

  // IMPORTANTE: antes esperávamos um tempo FIXO (4s) depois de clicar em "Pesquisar" e
  // já líamos a grade em seguida — mas o tempo que a Evolutize leva pra devolver o
  // resultado varia bastante (carga do servidor deles, rede, horário do dia), e 4s às
  // vezes não é suficiente mesmo com o acesso 100% normal. Quando isso acontecia, a
  // gente lia a grade ainda vazia/incompleta e tratava como se fosse sessão expirada —
  // gerando o erro "sem motivo aparente" mesmo com o login funcionando. Agora, em vez de
  // um tempo fixo, ficamos checando a cada 500ms se a grade já apareceu com pelo menos
  // uma linha de dado, por até 15s (bem mais generoso que os 4s de antes) — assim que
  // aparecer, segue na hora, sem esperar o teto todo à toa; só se passar os 15s inteiros
  // sem nada aparecer é que consideramos mesmo um problema de acesso/sessão.
  let table = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await sleep(500);
    const candidate = document.querySelector('#GridContainerTbl');
    if (candidate && candidate.querySelectorAll('tr').length > 1) {
      table = candidate;
      break;
    }
  }
  if (!table) table = document.querySelector('#GridContainerTbl');
  if (!table) return { pageError: 'sessao' };
  const rows = Array.from(table.querySelectorAll('tr'));
  // IMPORTANTE: `rows` inclui a linha de cabeçalho — então "rows.length <= 1" quer dizer
  // "nenhuma linha de dado voltou da pesquisa", não "a grade nem existe". Isso é
  // exatamente o caso que faltava cobrir: no bug de sessão "zumbi" da Evolutize, a tela
  // pode carregar normalmente (filtro de situação e grade presentes), só que a pesquisa
  // em si não retorna nada porque a sessão não está mais válida de verdade — e isso
  // passava batido pelas checagens acima, devolvendo uma lista vazia "de verdade" em vez
  // do sentinela de erro. Como a pesquisa aqui é sempre pela situação "Todas" (inclui
  // encerrados), é essencialmente impossível uma conta em uso legítima não ter NENHUM
  // chamado, nem mesmo antigo/encerrado — então tratamos "zero resultados" como sinal de
  // problema de acesso também, e não como "lista genuinamente vazia". Agora que já
  // esperamos até 15s pela grade acima, chegar aqui com rows.length <= 1 é bem mais
  // provável ser sessão mesmo (não mais lentidão de carregamento).
  if (rows.length <= 1) return { pageError: 'sessao' };
  const headerCells = Array.from(rows[0].querySelectorAll('th,td')).map((c) => c.innerText.trim());
  const iNum = headerCells.indexOf('Número');
  const iTitle = headerCells.indexOf('Título');
  const iSit = headerCells.indexOf('Situação');
  if (iNum < 0 || iTitle < 0 || iSit < 0) return { pageError: 'sessao' };
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = Array.from(rows[r].querySelectorAll('td'));
    if (cells.length < 5) continue;
    const num = (cells[iNum] ? cells[iNum].innerText : '').trim();
    if (!/^\d+$/.test(num)) continue;

    // Cada linha da grade já traz embutido um link direto pro chamado (o mesmo tipo de
    // link fixo que usamos nos avulsos) — não precisa abrir cada um pra conseguir a URL,
    // só ler o href que já está ali.
    const link = Array.from(rows[r].querySelectorAll('a')).find((a) => {
      const href = a.getAttribute('href') || '';
      return href.includes('cha_chamadosup') && !href.startsWith('javascript:');
    });
    const url = link ? new URL(link.getAttribute('href'), document.baseURI).toString() : '';

    out.push({
      id: num,
      title: (cells[iTitle] ? cells[iTitle].innerText : '').trim(),
      status: (cells[iSit] ? cells[iSit].innerText : '').trim(),
      url,
    });
  }
  return out;
}

// IMPORTANTE: clicar no resultado da busca dispara uma navegação de página inteira
// (o GeneXus troca a URL). Se a mesma injeção de script continuasse rodando depois
// do clique (esperando e lendo o resultado), o contexto de JS seria destruído no meio
// e a chamada inteira falhava com "resultado indefinido". Por isso dividimos em duas
// funções: uma que só busca e clica (fase 1, roda ANTES da navegação) e outra que lê
// os dados já na página de destino (fase 2, chamada pelo background.js DEPOIS de
// esperar a navegação terminar via chrome.tabs.onUpdated).

export async function searchEvolutizeAvulso(number) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.querySelector('#vSEARCH_MPAGE');
  if (!input) return { error: 'campo de busca não encontrado', number };
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

  // O popover de sugestões desse campo só abre com um clique real (data-trigger="click"),
  // então primeiro clicamos e focamos antes de "digitar".
  input.click();
  input.focus();
  setter.call(input, '');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);

  let current = '';
  for (const ch of String(number)) {
    current += ch;
    setter.call(input, current);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(150);
  }

  const findMatch = () => {
    const candidates = Array.from(document.querySelectorAll('a, div, li, span'));
    return candidates.find((elm) => {
      const t = (elm.innerText || '').trim();
      if (!t.startsWith(String(number))) return false;
      if (t.length > 160) return false;
      const rest = t.slice(String(number).length);
      return /^[\s\-–(]/.test(rest);
    });
  };

  let match = null;
  for (let attempt = 0; attempt < 4 && !match; attempt++) {
    await sleep(900);
    match = findMatch();
  }
  if (!match) return { error: 'chamado não encontrado na busca', number };

  // IMPORTANTE: `match` é o elemento encontrado por querySelectorAll('a, div, li, span'),
  // que retorna os elementos em ordem de documento — ou seja, o PRIMEIRO encontrado é o
  // <div> mais externo que envolve a linha inteira do resultado, não o elemento clicável
  // de verdade. Um clique sintético nesse wrapper nunca chega no listener real (que está
  // num elemento mais interno, como o <span> do título), porque dispatchEvent só propaga
  // do alvo PARA CIMA (bubbling), nunca para os descendentes. Um clique de mouse real
  // funciona porque o navegador entrega o evento no elemento mais profundo sob o cursor.
  // Por isso replicamos isso com elementFromPoint: pegamos as coordenadas do meio do
  // wrapper e buscamos o elemento mais interno ali, e é nele que disparamos o clique.
  const rect = match.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const deepTarget = document.elementFromPoint(cx, cy) || match;
  const clickOpts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
  deepTarget.dispatchEvent(new MouseEvent('pointerdown', clickOpts));
  deepTarget.dispatchEvent(new MouseEvent('mousedown', clickOpts));
  deepTarget.dispatchEvent(new MouseEvent('pointerup', clickOpts));
  deepTarget.dispatchEvent(new MouseEvent('mouseup', clickOpts));
  deepTarget.dispatchEvent(new MouseEvent('click', clickOpts));
  // Não espera nem lê nada aqui — a navegação já pode ter começado.
  return { clicked: true, number };
}

export async function extractEvolutizeAvulsoDetail(number) {
  // IMPORTANTE: essa função é serializada e injetada sozinha via
  // chrome.scripting.executeScript — só o código dela mesma vai junto, nenhuma outra
  // função do módulo. Por isso o helper de leitura de campo precisa estar DEFINIDO AQUI
  // DENTRO (igual já era feito em extractMovideskAvulso) em vez de ser uma função
  // separada no arquivo: uma referência a uma função "de fora" vira um ReferenceError
  // silencioso dentro da página, que o Chrome não repassa como erro visível — só faz o
  // resultado da injeção voltar undefined, e foi exatamente isso que causava o
  // "falha ao ler os dados depois de abrir o chamado" mesmo com o chamado abrindo certinho.
  function findFieldValue(labelText) {
    const all = Array.from(document.querySelectorAll('div,span,p'));
    for (const elm of all) {
      if (elm.children.length > 4) continue;
      const txt = (elm.innerText || '').trim();
      if (!txt) continue;
      const lines = txt.split('\n').map((s) => s.trim()).filter(Boolean);
      if (lines[0] && lines[0].toUpperCase() === labelText.toUpperCase() && lines.length >= 2) {
        return lines[1];
      }
    }
    return '';
  }

  const status = findFieldValue('SITUAÇÃO');
  const title = findFieldValue('TÍTULO');

  // Histórico de tramitação: cada interação no chamado (abertura + respostas)
  // aparece como um div.box-usu-abertura, na ordem em que aconteceu. A primeira
  // é sempre "Aberto por: ... em DD/MM/AAAA HH:MM"; as seguintes são
  // "Tramitado por: ... em DD/MM/AAAA HH:MM". A última do DOM é a mais recente,
  // então usamos ela como "última atualização" do chamado.
  const boxes = Array.from(document.querySelectorAll('.box-usu-abertura'));
  let lastUpdate = '';
  let lastUpdateBy = '';
  if (boxes.length) {
    const lastText = (boxes[boxes.length - 1].innerText || '').trim();
    const m = lastText.match(/^(?:Aberto por|Tramitado por):\s*(.+?)\s+em\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/);
    if (m) {
      lastUpdateBy = m[1].trim();
      lastUpdate = m[2].trim();
    }
  }

  const bodyText = document.body ? document.body.innerText || '' : '';
  let hash = 0;
  for (let i = 0; i < bodyText.length; i++) hash = (hash * 31 + bodyText.charCodeAt(i)) >>> 0;

  // O título da aba/documento nessa tela é sempre "Chamado <número>". Usamos isso pra
  // confirmar que a página realmente é a do chamado esperado — importante quando
  // chegamos aqui através de um link fixo salvo de uma busca anterior: se o token da
  // URL expirou ou mudou, a página pode carregar outra coisa (ou dar erro) e não
  // queremos confundir isso com um chamado "sem título/status capturado".
  const pageTitle = (document.title || '').trim();
  const matchesNumber = number == null || pageTitle === `Chamado ${number}` || pageTitle.includes(String(number));

  return {
    title: title || pageTitle,
    status,
    lastUpdate,
    lastUpdateBy,
    hash,
    length: bodyText.length,
    url: location.href,
    matchesNumber,
  };
}

// Lê só a última tramitação da página de detalhe de um chamado Evolutize — usada pela
// lista principal de acompanhamento (checkEvolutizeList), que já chega aqui através do
// link direto extraído da grade (não precisa buscar nem confirmar número, já sabemos
// que é o chamado certo porque o link veio da própria linha dele).
export function extractEvolutizeTramitacao() {
  const boxes = Array.from(document.querySelectorAll('.box-usu-abertura'));
  if (!boxes.length) return { lastUpdate: '', lastUpdateBy: '' };
  const lastText = (boxes[boxes.length - 1].innerText || '').trim();
  const m = lastText.match(/^(?:Aberto por|Tramitado por):\s*(.+?)\s+em\s+(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2})/);
  if (!m) return { lastUpdate: '', lastUpdateBy: '' };
  return { lastUpdateBy: m[1].trim(), lastUpdate: m[2].trim() };
}

export async function extractMovideskAvulso() {
  function fieldValue(label) {
    const td = Array.from(document.querySelectorAll('td.info-section-title')).find(
      (t) => (t.innerText || '').trim() === label
    );
    if (!td) return null;
    const tr = td.closest('tr');
    const nextTr = tr ? tr.nextElementSibling : null;
    return nextTr ? nextTr.innerText.trim() : null;
  }
  const subjectEl = document.querySelector('.ticket-subject');
  const title = subjectEl ? subjectEl.innerText.trim() : '';
  const status = fieldValue('Status');
  const notFound = !title && !status;
  const bodyText = document.body ? document.body.innerText || '' : '';
  let hash = 0;
  for (let i = 0; i < bodyText.length; i++) hash = (hash * 31 + bodyText.charCodeAt(i)) >>> 0;
  return { title, status, hash, notFound };
}

export async function runMovidesk() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const navItems = Array.from(document.querySelectorAll('.nav-pills.nav-stacked li'));
  const testeItem = navItems.find((li) => (li.innerText || '').trim() === 'Teste');
  if (testeItem) {
    if (!testeItem.className.includes('active')) {
      testeItem.click();
      await sleep(2800);
    } else {
      await sleep(800);
    }
  } else {
    await sleep(800);
  }
  const headers = Array.from(document.querySelectorAll('.column-name')).map((h) => ({
    text: h.innerText.trim(),
    rect: h.getBoundingClientRect(),
  }));
  const cards = Array.from(document.querySelectorAll('div.field-item.kanban-dragable-item'));

  // Mesmo raciocínio da Evolutize/GLPI: nenhum card encontrado depois de tentar abrir a
  // visão "Teste" é bem mais provável ser sessão caída ou página não carregada do que a
  // visão estar genuinamente vazia — trata como problema de acesso em vez de "lista
  // vazia real" pra não marcar tudo que já era acompanhado como "sumiu".
  if (!cards.length) {
    return { pageError: 'sessao' };
  }

  return cards.map((card) => {
    const r = card.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    let best = null;
    let bestDist = Infinity;
    for (const h of headers) {
      const hcx = h.rect.left + h.rect.width / 2;
      const d = Math.abs(hcx - cx);
      if (d < bestDist) {
        bestDist = d;
        best = h.text;
      }
    }
    const lines = (card.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    return { id: card.dataset.number || lines[0] || '', title: lines[1] || '', status: best || '' };
  });
}
