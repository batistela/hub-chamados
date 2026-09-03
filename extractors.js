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

// Antes essa função só devolvia um hash da página inteira, e o Hub usava "o hash mudou"
// como sinal de "algo mudou no chamado, abra pra conferir" — só que o hash pega QUALQUER
// diferença de texto na página (widgets dinâmicos, ordem de anexos, etc.), o que gerava
// avisos de "conteúdo mudou" com frequência mesmo sem nada de novo pro Murilo conferir —
// inclusive quando só o status tinha mudado (ex: pausado -> atribuído). A pedido dele,
// isso foi substituído por dois sinais bem mais específicos: status (pra pegar mudança de
// situação) e "última atualização" (pra pegar qualquer tramitação nova, igual já fazíamos
// pro GLPI da lista principal e pra Evolutize) — sem hash nenhum.
//
// IMPORTANTE: os dois seletores/padrões abaixo são "melhor esforço" — não temos como
// testar contra a instalação real de GLPI do Murilo antes de entregar. Se depois de subir
// essa mudança os avulsos do GLPI pararem de detectar tramitação nova (status funcionando
// mas "última atualização" nunca aparecendo), o próximo passo é o Murilo abrir um chamado
// avulso no GLPI, dar Ctrl+F por "atualiza" na página, e me passar o texto exato que
// aparece ali (rótulo + como a data é mostrada) pra eu ajustar o regex/seletor.
export function extractGLPIAvulso() {
  const title = (document.title || '').replace(/\s+-\s+GLPI$/, '').trim();
  const bodyText = document.body ? document.body.innerText || '' : '';

  // Status: primeiro tenta o <select> do formulário do chamado (como o GLPI representa
  // status na grande maioria das instalações/temas); se não achar, tenta uma "pastilha"
  // de status com o nome no atributo title (outro padrão comum em temas do GLPI).
  function readStatus() {
    const select = document.querySelector('select[name="status"], select#status');
    if (select && select.selectedIndex >= 0) {
      const opt = select.options[select.selectedIndex];
      if (opt && opt.text.trim()) return opt.text.trim();
    }
    const badge = document.querySelector('[class*="itilstatus"][title], [class*="status_"][title]');
    if (badge) {
      const t = (badge.getAttribute('title') || '').trim();
      if (t) return t;
    }
    return '';
  }

  // Última atualização: em vez de depender de um elemento específico (que muda de tema
  // pra tema), procura no texto da página por uma linha que comece com um rótulo
  // conhecido ("Última atualização"/"Atualizado em"/etc.) e pega a data que aparece nela
  // ou na linha seguinte — mais tolerante a diferenças de estrutura HTML.
  function findLastUpdate() {
    const lines = bodyText.split('\n').map((s) => s.trim()).filter(Boolean);
    const labelRe = /^(última atualiza|ultima atualiza|atualizado em|dernière modification)/i;
    const dateRe = /(\d{2}[\/\-]\d{2}[\/\-]\d{4}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)/;
    for (let i = 0; i < lines.length; i++) {
      if (!labelRe.test(lines[i])) continue;
      let m = lines[i].match(dateRe);
      if (m) return m[1];
      if (lines[i + 1]) {
        m = lines[i + 1].match(dateRe);
        if (m) return m[1];
      }
    }
    return '';
  }

  const status = readStatus();
  const lastUpdate = findLastUpdate();
  const notFound = (/não existe|not found|erro/i.test(title) && bodyText.trim().length < 200) || (!title && !status && !lastUpdate);
  return { title, status, lastUpdate, notFound };
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
  // Tentativa de pegar "última atualização" do mesmo jeito estruturado (campo com
  // rótulo, igual ao Status acima) — se o Movidesk não expuser esse campo com um desses
  // nomes exatos, fica vazio e essa fonte cai pro mesmo comportamento "só status" do
  // GLPI avulso (sem hash de página inteira, que foi removido dos dois).
  const lastUpdate = fieldValue('Última atualização') || fieldValue('Data da última atualização') || '';
  const notFound = !title && !status;
  return { title, status, lastUpdate, notFound };
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

// ---------- fontes personalizadas (avulso, cadastradas pelo usuário) ----------
// Diferente das outras extractXxx acima (seletores fixos, escritos à mão pra um site
// específico), essa é genérica: o mapeamento vem de fora (config.customSources, montado
// pelo assistente addSource.js) — não um seletor por chamado individual, mas COLUNAS
// dentro da grade que já lista todos os chamados (a pedido do Murilo: mais fácil de
// mapear clicando numa lista já visível do que abrindo uma página de detalhe por número).
// Uma chamada só dessa função resolve TODOS os avulsos daquela fonte de uma vez (uma
// leitura da grade inteira), em vez de uma navegação por chamado como as outras fontes
// fazem — mais rápido e mais simples de mapear.
//
// Reconhece dois "formatos" de grade: uma <table> HTML de verdade (table/tr/td — GLPI,
// Evolutize, a maioria dos sistemas mais simples), OU uma grade construída com <div> e
// papéis ARIA (role="grid"/"row"/"gridcell"/"columnheader" — padrão usado por vários
// componentes de grade React/Fluent UI, incluindo listas modernas do SharePoint). Os
// mesmos seletores CSS_CELL/CSS_ROW/CSS_GRID cobrem os dois formatos ao mesmo tempo (numa
// <table> comum, nenhum elemento tem esses atributos role, então só os seletores
// td/th/tr/table batem — comportamento idêntico a antes). Grades que não usam nem
// <table> nem esses papéis ARIA (ex: puro <div> sem nenhuma semântica de tabela) ainda não
// são suportadas.
//
// `columns` — a pedido do Murilo (04/09/2026), os campos além do número não são mais um
// conjunto fixo de 4 nomes conhecidos: `{ number: {tableSelector,columnIndex,headerText},
// fields: [{key,label,role,tableSelector,columnIndex,headerText}, ...] }`. `number`
// continua sendo o único campo estruturalmente especial e obrigatório (é como o Hub acha a
// linha certa). `fields` é uma lista LIVRE — o usuário escolhe quantos campos quer, o nome
// (`label`) de cada um, e a ORDEM (a ordem do array = ordem de exibição no Hub). `role`
// (opcional, `'info'` se ausente) é o que conecta um campo à detecção inteligente de
// mudança sem depender do NOME do campo: `'status'` alimenta a mensagem "X → Y" de mudança
// de status, `'lastUpdate'` alimenta "nova tramitação em..." e o aviso de "chamado
// parado", `'lastUpdateBy'` só complementa a mensagem de `'lastUpdate'` com "por fulano".
// Só o primeiro campo de cada papel é usado se o usuário marcar mais de um com o mesmo
// papel (ver checkCustomAvulsos em background.js, que faz essa resolução por papel — essa
// função aqui é "burra": só extrai o texto de cada `fields[i]` pela posição/cabeçalho
// mapeado, sem saber nada sobre papéis). Formato antigo (antes dessa mudança, sem
// `fields`, com `status/requester/lastUpdate/lastUpdateBy` como chaves fixas direto em
// `columns`) ainda é aceito aqui — normalizeCustomListColumns (função irmã, não injetada,
// usada por background.js/addSource.js) converte pro formato novo; como essa função
// PRECISA ficar self-contained (é injetada sozinha via chrome.scripting.executeScript),
// ela tem sua própria normalização inline equivalente, duplicada de propósito.
//
// Se a grade mapeada não for mais encontrada (seletor não bate com nada E não existe
// nenhuma outra grade com linhas na página), devolve pageError — trata como sessão
// caída/página não carregada, igual às outras fontes com lista (ver checkGLPIList etc.),
// pra não confundir isso com "os chamados sumiram". Já um chamado específico não aparecer
// na grade (mas ela existir normalmente) é tratado como notFound — situação normal
// (chamado fechado/fora do filtro atual), não erro.
//
// Versão não-injetada da normalização acima — usada por background.js (pra resolver quem
// é o campo de status/data/etc. por PAPEL antes de montar o objeto que diffAvulsoSource
// espera) e por addSource.js (pra pré-preencher o assistente em modo "Remapear campos"
// com uma fonte salva antes dessa mudança). NÃO é chamada de dentro de
// extractCustomListRows (que precisa ficar self-contained pra injeção).
export function normalizeCustomListColumns(columns) {
  const cols = columns || {};
  if (Array.isArray(cols.fields)) {
    return { number: cols.number || null, fields: cols.fields };
  }
  const fields = [];
  if (cols.status) fields.push({ key: 'status', label: 'Status', role: 'status', ...cols.status });
  if (cols.requester) fields.push({ key: 'requester', label: 'Requerente', role: 'info', ...cols.requester });
  if (cols.lastUpdate) fields.push({ key: 'lastUpdate', label: 'Data e hora da atualização', role: 'lastUpdate', ...cols.lastUpdate });
  if (cols.lastUpdateBy) fields.push({ key: 'lastUpdateBy', label: 'Usuário da tramitação', role: 'lastUpdateBy', ...cols.lastUpdateBy });
  return { number: cols.number || null, fields };
}
//
// IMPORTANTE (adicionado depois de testar com SharePoint de verdade): grades ARIA como as
// do SharePoint costumam ser preenchidas por JavaScript DEPOIS que a página já "terminou
// de carregar" (o evento que o background.js usa pra saber quando é hora de ler —
// navigateAndWait/waitForTabComplete). Ler na hora, sem esperar, corre o risco de pegar a
// grade ainda vazia (só o cabeçalho, sem nenhuma linha de dado) — o que essa função
// devolvia como pageError, mesmo com a página certa aberta e o mapeamento certo ("abriu
// mas não achou nada"). Mesmo raciocínio já usado em runEvolutizeList: em vez de tentar só
// uma vez, fica checando a cada 500ms se já apareceu uma grade com pelo menos uma linha de
// dado, por até 12s — assim que aparecer, segue na hora; só desiste (pageError) se passar
// o teto todo sem nada. Uma <table> comum do GLPI já vem pronta no primeiro carregamento,
// então esse caso só espera 0 vezes e segue igual a antes.
export async function extractCustomListRows(columns, numbers) {
  // IMPORTANTE (bug real encontrado em 04/09/2026, não uma particularidade do
  // SharePoint): essa função é injetada sozinha via chrome.scripting.executeScript, que
  // serializa só o CORPO dela (Function.prototype.toString()) e reconstrói/roda isso numa
  // outra página, num contexto novo — QUALQUER referência a algo declarado FORA do corpo
  // da função (ex: um `const` no nível do módulo) simplesmente não existe mais nesse
  // contexto e vira ReferenceError. Essas três constantes ficavam declaradas fora da
  // função (nível de módulo) até essa correção — o que fazia TODA extração de fontes
  // personalizadas (não só SharePoint: qualquer <table> também, já que o erro acontece
  // antes de sequer olhar a página) falhar silenciosamente: a Promise rejeitava dentro do
  // mundo isolado da aba injetada, e o chrome.scripting.executeScript devolvia
  // `result: null` pro chamador (addSource.js / background.js) SEM lançar nenhum erro
  // visível ali — só apareceria um ReferenceError no console da ABA DO SITE sendo lida,
  // não no console da tela do Hub, o que tornou o bug bem mais difícil de perceber. Os
  // testes com jsdom nunca pegaram isso porque lá a função é chamada via import normal
  // (com escopo/closure de verdade), não via serialização — só reproduz o problema real
  // do navegador. Por isso agora ficam declaradas AQUI DENTRO, como injectPicker
  // (addSource.js) já fazia certo com sua própria cópia local.
  const CUSTOM_GRID_SEL = 'table, [role="grid"], [role="table"], [role="treegrid"]';
  const CUSTOM_ROW_SEL = 'tr, [role="row"]';
  const CUSTOM_CELL_SEL = 'td, th, [role="gridcell"], [role="columnheader"], [role="cell"], [role="rowheader"]';

  const rawCols = columns || {};
  // Normalização inline do formato antigo (sem `fields`) — duplicada de
  // normalizeCustomListColumns de propósito, ver comentário acima: essa função precisa
  // ficar self-contained pra ser injetada sozinha via chrome.scripting.executeScript.
  const numberCol = rawCols.number || null;
  let fieldList = Array.isArray(rawCols.fields) ? rawCols.fields : null;
  if (!fieldList) {
    fieldList = [];
    if (rawCols.status) fieldList.push({ key: 'status', ...rawCols.status });
    if (rawCols.requester) fieldList.push({ key: 'requester', ...rawCols.requester });
    if (rawCols.lastUpdate) fieldList.push({ key: 'lastUpdate', ...rawCols.lastUpdate });
    if (rawCols.lastUpdateBy) fieldList.push({ key: 'lastUpdateBy', ...rawCols.lastUpdateBy });
  }

  const wanted = Array.from(new Set((numbers || []).map(String)));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function rowsOf(root) {
    return Array.from(root.querySelectorAll(CUSTOM_ROW_SEL)).filter((r) => r.closest(CUSTOM_GRID_SEL) === root);
  }
  function cellsOf(row) {
    return Array.from(row.querySelectorAll(CUSTOM_CELL_SEL)).filter((c) => c.closest(CUSTOM_ROW_SEL) === row);
  }

  function findGrid(sel) {
    if (sel) {
      try {
        const g = document.querySelector(sel);
        if (g && rowsOf(g).length > 1) return g;
      } catch (e) {
        // seletor salvo não é mais válido nessa página — cai pro fallback abaixo
      }
    }
    // Fallback: a maior grade da página (mais linhas) — cobre o caso do seletor salvo
    // ter parado de bater (ex: o site trocou a classe do contêiner).
    const candidates = Array.from(document.querySelectorAll(CUSTOM_GRID_SEL));
    let best = null;
    let bestRows = 1;
    for (const g of candidates) {
      const n = rowsOf(g).length;
      if (n > bestRows) {
        best = g;
        bestRows = n;
      }
    }
    return best;
  }

  // Grades preenchidas via JS (SharePoint e outras SPAs) podem ainda não ter nenhuma
  // linha de dado no instante em que a página "termina de carregar" — fica tentando por
  // até 12s antes de desistir, em vez de uma única tentativa. Numa página que já carrega
  // pronta (GLPI, a maioria dos sites), findGrid acha de primeira e esse laço nem espera.
  let grid = null;
  let allRows = [];
  const deadline = Date.now() + 12000;
  do {
    grid = findGrid(numberCol && numberCol.tableSelector);
    allRows = grid ? rowsOf(grid) : [];
    if (grid && allRows.length >= 2) break;
    await sleep(500);
  } while (Date.now() < deadline);
  if (!grid) return { pageError: 'sem-tabela' };
  if (allRows.length < 2) return { pageError: 'sem-tabela' };

  const headRow = allRows[0];
  const headerCells = cellsOf(headRow).map((c) => (c.innerText || c.textContent || '').trim().toUpperCase());

  // Prefere casar por TEXTO do cabeçalho salvo (mais resistente a mudança de layout do
  // que um índice fixo — colunas às vezes são reordenadas ou uma nova é inserida no
  // meio); só cai pro índice salvo se não achar por texto (cabeçalho mudou de nome, ou
  // não tem uma linha de cabeçalho clara nessa grade). Usado só como ÍNDICE DE
  // REFERÊNCIA (pra achar o cabeçalho, e como último recurso — ver resolveCell abaixo).
  function resolveIndex(colInfo) {
    if (!colInfo) return -1;
    if (colInfo.headerText) {
      const idx = headerCells.indexOf(String(colInfo.headerText).trim().toUpperCase());
      if (idx >= 0) return idx;
    }
    return typeof colInfo.columnIndex === 'number' ? colInfo.columnIndex : -1;
  }

  // IMPORTANTE (descoberto testando com SharePoint de verdade): algumas grades modernas
  // (o "htmlGrid" do SharePoint, por exemplo) posicionam as células visualmente via CSS
  // Grid (`grid-column: calc(N + ...)`), NÃO pela ordem em que elas aparecem no DOM — ou
  // seja, o ÍNDICE de uma célula dentro de `cellsOf(row)` pode não representar a mesma
  // coluna visual em linhas diferentes (ou entre a linha de cabeçalho e as linhas de
  // dado). Isso quebra silenciosamente a extração por índice: os campos ficavam com o
  // valor da coluna ERRADA em vez de vazio, e por isso o número procurado nunca batia.
  // Esses gridcells do SharePoint carregam `data-automationid="field-<id>"` — um
  // identificador de coluna ESTÁVEL, igual em toda linha, independente da posição no DOM.
  // `columnKey` (capturado pelo assistente no clique — ver injectPicker, em
  // addSource.js) guarda esse valor quando existe; resolveCell tenta casar por ele
  // PRIMEIRO, e só cai pro índice posicional (resolveIndex acima) se a célula não tiver
  // esse atributo (grades sem esse problema — GLPI, Evolutize, a maioria dos sites).
  function resolveCell(row, colInfo, idx) {
    const cells = cellsOf(row);
    if (colInfo && colInfo.columnKey) {
      const byKey = cells.find((c) => c.getAttribute('data-automationid') === colInfo.columnKey);
      if (byKey) return byKey;
    }
    return idx != null && idx >= 0 ? cells[idx] : null;
  }
  function cellTextFor(row, colInfo, idx) {
    const cell = resolveCell(row, colInfo, idx);
    if (!cell) return '';
    return (cell.innerText || cell.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const numberIdx = resolveIndex(numberCol);
  if (numberIdx < 0 && !(numberCol && numberCol.columnKey)) return { pageError: 'sem-tabela' };
  // Índice resolvido por CAMPO (não por nome fixo) — `fields` é uma lista livre definida
  // pelo usuário no assistente, cada item já sabendo sua própria `key` (gerada uma vez,
  // nunca muda) e opcionalmente um `role` (que essa função nem olha — quem decide o que
  // fazer com cada papel é checkCustomAvulsos, em background.js).
  const resolvedFields = fieldList.map((f) => ({ key: f.key, colInfo: f, idx: resolveIndex(f) }));

  const bodyRows = allRows.slice(1);

  function rowLink(row) {
    const numCell = resolveCell(row, numberCol, numberIdx);
    const a = (numCell && numCell.querySelector('a[href]')) || row.querySelector('a[href]');
    return a ? new URL(a.getAttribute('href'), document.baseURI).toString() : '';
  }

  const out = {};
  const stillWanted = new Set(wanted);
  for (const row of bodyRows) {
    if (!stillWanted.size) break;
    const numTxt = cellTextFor(row, numberCol, numberIdx);
    if (!numTxt) continue;
    // Casa por igualdade exata primeiro (mais seguro); senão por "contém" — números de
    // chamado às vezes vêm com prefixo/sufixo na grade (ex: "#12345", "12345 (e-mail)").
    let matched = null;
    for (const want of stillWanted) {
      if (numTxt === want || numTxt.includes(want)) {
        matched = want;
        break;
      }
    }
    if (!matched) continue;
    const fieldsOut = {};
    for (const rf of resolvedFields) fieldsOut[rf.key] = cellTextFor(row, rf.colInfo, rf.idx);
    out[matched] = { number: numTxt, fields: fieldsOut, url: rowLink(row), notFound: false };
    stillWanted.delete(matched);
  }
  for (const want of stillWanted) {
    out[want] = { number: want, fields: {}, notFound: true };
  }
  // Diagnóstico — só pra ajudar a entender um "não encontrei" quando o mapeamento PARECE
  // certo (ex: o Murilo via um chamado na tela e mesmo assim a busca não achou). Não é lido
  // por checkCustomAvulsos (background.js), que só olha as chaves por número — é lido só
  // pelo botão "Testar a busca" (addSource.js), pra mostrar o que a busca realmente viu na
  // coluna do número, sem precisar abrir o DevTools.
  out.__debug = {
    gridInfo: `${grid.tagName.toLowerCase()}${grid.id ? '#' + grid.id : ''}${grid.getAttribute('role') ? `[role="${grid.getAttribute('role')}"]` : ''}`,
    totalBodyRows: bodyRows.length,
    numberColumnHeaderText: headerCells[numberIdx] || '',
    numberColumnKey: (numberCol && numberCol.columnKey) || '',
    numberColumnSample: bodyRows.slice(0, 25).map((row) => cellTextFor(row, numberCol, numberIdx)),
  };
  return out;
}
