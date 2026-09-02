// Hub de Chamados — autoria original: Murilo (murilobats@gmail.com), início em ago/2026.
import {
  extractGLPIList,
  extractGLPIAvulso,
  runEvolutizeList,
  searchEvolutizeAvulso,
  extractEvolutizeAvulsoDetail,
  extractEvolutizeTramitacao,
  runMovidesk,
  extractMovideskAvulso,
} from './extractors.js';

const GLPI_BASE = 'http://chamadosti.holambra.corp';
const EVOLUTIZE_LIST_URL = 'https://suporte.evolutize.com.br/servlet/br.com.delsoftsistemas.cha_chamadosupww';
const MOVIDESK_BASE = 'https://keyrus-brasil.movidesk.com';
const MOVIDESK_URL = `${MOVIDESK_BASE}/Ticket`;
// Mesmo critério usado no filtro "ocultar encerrados" do dashboard — usado aqui pra
// decidir em quais chamados da lista principal da Evolutize vale a pena abrir a página
// de detalhe pra buscar a última tramitação (ver checkEvolutizeList).
const CLOSED_STATUS_RE = /encerr|fechad|solucion|resolvid|cancel|conclu[ií]d/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tenta de novo antes de desistir. Cobre falhas passageiras — um carregamento lento
// pontual, uma resposta truncada da página, uma instabilidade momentânea de rede — que
// se resolvem sozinhas numa segunda tentativa alguns segundos depois, sem precisar
// esperar a próxima checagem agendada (que às vezes só roda de novo daqui 15-45 min).
// Só entra em ação quando a função passada lança erro — hoje, os sentinelas de
// "pageError" do GLPI/Evolutize/Movidesk (ver checkGLPIList/checkEvolutizeList/
// checkMovidesk) — e não muda nada quando a checagem funciona de primeira. Se mesmo
// assim continuar falhando depois de todas as tentativas (ex: sessão realmente
// expirada, precisa de login manual), o erro final ainda sobe normalmente pro catch de
// cada fonte em runCheck(), que preserva o state antigo — isso aqui só reduz quantas
// vezes um problema PASSAGEIRO chega a aparecer como erro pro usuário.
async function withRetries(fn, { attempts = 2, delayMs = 6000, label = '' } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) {
        console.warn(`${label || 'checagem'}: tentativa ${i + 1}/${attempts} falhou, tentando de novo em ${delayMs / 1000}s`, e);
        await sleep(delayMs);
      }
    }
  }
  throw lastErr;
}

const DEFAULT_CONFIG = {
  intervalMinutes: 15,
  glpiSearchUrl: '',
  glpiAvulsos: [],
  glpiOnlyAvulsos: false,
  evolutizeAvulsos: [],
  evolutizeOnlyAvulsos: false,
  evolutizeAvulsoUrls: {},
  movideskAvulsos: [],
  movideskOnlyAvulsos: false,
  soundEnabled: true,
  // "Chamado parado": alerta quando um chamado fica X dias sem nova tramitação — o
  // oposto do resto do Hub, que só avisa quando algo MUDA. staleDays é o padrão geral
  // (0 = desativado); os três mapas abaixo permitem um valor próprio por chamado avulso
  // (pra casos mais urgentes que não devem esperar o padrão geral).
  staleDays: 0,
  glpiAvulsoStaleDays: {},
  evolutizeAvulsoStaleDays: {},
  movideskAvulsoStaleDays: {},
  // Atalhos puros (label + URL) pra outros sistemas que o Hub não monitora — só usados
  // pelo dashboard.js pra renderizar links, o background.js nunca lê isso.
  customLinks: [],
  // Não tem mais um campo "updateCheckUrl" aqui — o link do version.json (aviso de
  // versão nova) agora é fixo no código, ver UPDATE_CHECK_URL mais abaixo.
};

// ---------- utilidades de storage ----------

async function getConfig() {
  const { config } = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...(config || {}) };
}

async function setConfig(partial) {
  const current = await getConfig();
  const next = { ...current, ...partial };
  await chrome.storage.local.set({ config: next });
  return next;
}

async function getState() {
  const { state } = await chrome.storage.local.get('state');
  return (
    state || {
      glpi: {},
      glpiAvulsos: {},
      evolutize: {},
      evolutizeAvulsos: {},
      movidesk: {},
      movideskAvulsos: {},
      staleAlerted: {},
    }
  );
}

async function setState(state) {
  await chrome.storage.local.set({ state });
}

async function pushEvents(newEvents) {
  const { events } = await chrome.storage.local.get('events');
  const existing = events || [];
  if (!newEvents.length) return existing;
  // Cada evento ganha um eventId único (pra poder marcar como visto individualmente)
  // e nasce como acknowledged:false — some da lista "Atualizações recentes" só quando
  // o usuário confirma que viu, e vai pro histórico.
  const stamped = newEvents.map((e, i) => ({
    ...e,
    ts: Date.now(),
    eventId: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    acknowledged: false,
  }));
  // Limite alto de propósito (era 200) — agora que a extensão tem unlimitedStorage, não
  // faz sentido descartar histórico rápido só por causa da cota padrão de 10MB do
  // chrome.storage.local. Isso alimenta tanto "Atualizações recentes"/"Histórico" quanto
  // o contador do badge (que soma os não confirmados).
  const merged = [...stamped, ...existing].slice(0, 5000);
  await chrome.storage.local.set({ events: merged });
  return merged;
}

// "Evolutize" e "Evolutize (avulso)" são o mesmo chamado visto por dois caminhos
// diferentes (lista principal vs. avulso) — pro histórico por chamado, tratamos os dois
// como a mesma fonte (ex: "Evolutize"), senão uma busca por número não encontraria o
// que aconteceu enquanto o chamado era avulso e vice-versa.
function baseSourceName(source) {
  return String(source || '').replace(/\s*\(avulso\)\s*$/i, '').trim();
}

// Histórico por chamado: diferente do array `events` (que existe pra alimentar
// "Atualizações recentes"/"Histórico" e é limitado a 200 entradas no total, somando
// todas as fontes), aqui guardamos, por chamado, todas as mudanças já vistas — pra dar
// pra consultar "o que aconteceu com o chamado X" mesmo depois que o `events` geral já
// tiver rotacionado esse evento pra fora, ou depois que o chamado já tiver saído da
// lista principal (foi encerrado, por exemplo). Cada chamado guarda até 300 entradas —
// bem mais do que o normal precisa, já que só grava quando algo realmente muda.
async function recordTicketHistory(newEvents) {
  if (!newEvents.length) return;
  const { ticketHistory } = await chrome.storage.local.get('ticketHistory');
  const map = ticketHistory || {};
  const now = Date.now();
  for (const e of newEvents) {
    const key = `${baseSourceName(e.source)}::${e.id}`;
    const list = map[key] || [];
    list.unshift({ ts: now, source: e.source, id: e.id, title: e.title, change: e.change, detail: e.detail });
    // Também elevado (era 300) pelo mesmo motivo do array `events` acima — com
    // unlimitedStorage, não há razão pra descartar histórico de um chamado específico
    // tão cedo, e é justamente esse histórico por chamado que fica disponível na
    // consulta mesmo depois do chamado já ter saído das listas principais.
    map[key] = list.slice(0, 2000);
  }
  await chrome.storage.local.set({ ticketHistory: map });
}

async function acknowledgeEvent(eventId) {
  const { events } = await chrome.storage.local.get('events');
  const list = events || [];
  const next = list.map((e) => (e.eventId === eventId ? { ...e, acknowledged: true } : e));
  await chrome.storage.local.set({ events: next });
  updateBadge(next.filter((e) => !e.acknowledged).length);
  return next;
}

async function acknowledgeAllEvents() {
  const { events } = await chrome.storage.local.get('events');
  const list = events || [];
  const next = list.map((e) => ({ ...e, acknowledged: true }));
  await chrome.storage.local.set({ events: next });
  updateBadge(0);
  return next;
}

// ---------- alarme ----------

async function ensureAlarm() {
  const config = await getConfig();
  const existing = await chrome.alarms.get('pollTickets');

  // "0" (ou vazio/negativo) = verificação automática desativada: só roda quando o
  // usuário clicar em "Verificar agora". Garante que nenhum alarme fique agendado.
  if (!config.intervalMinutes || config.intervalMinutes <= 0) {
    if (existing) await chrome.alarms.clear('pollTickets');
    return;
  }

  if (!existing || existing.periodInMinutes !== config.intervalMinutes) {
    await chrome.alarms.clear('pollTickets');
    // IMPORTANTE: sem `delayInMinutes` aqui — antes usávamos `delayInMinutes: 1`, o que
    // fazia a primeira checagem disparar ~1 minuto depois de QUALQUER recriação do
    // alarme, não só quando o usuário muda o intervalo de propósito. Isso incluía toda
    // vez que o service worker era reiniciado sem o alarme sobreviver (ex: recarregar a
    // extensão em chrome://extensions), causando checagens extras e inesperadas perto
    // umas das outras — provavelmente foi isso que abriu a janela do worker 2x seguidas
    // depois de mudar o intervalo. Passando só `periodInMinutes`, o Chrome agenda o
    // primeiro disparo depois de um intervalo completo (não quase imediato) e repete
    // nesse mesmo intervalo — comportamento previsível em qualquer situação (mudança de
    // config, reinício do navegador, reload da extensão).
    chrome.alarms.create('pollTickets', { periodInMinutes: config.intervalMinutes });
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const config = await getConfig();
  await setConfig(config);
  await ensureAlarm();
  checkForUpdate().catch((e) => console.warn('checkForUpdate falhou', e));
});

chrome.runtime.onStartup.addListener(async () => {
  ensureAlarm();
  checkForUpdate().catch((e) => console.warn('checkForUpdate falhou', e));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollTickets') runCheck().catch((e) => console.error('runCheck falhou', e));
});

// ---------- helpers de aba/janela ----------

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, timeoutMs);
  });
}

async function navigateAndWait(tabId, url) {
  await chrome.tabs.update(tabId, { url });
  await waitForTabComplete(tabId);
}

async function withWorkerTab(fn) {
  // Antes usávamos state:'minimized'. Suspeita: o Chrome parece pausar/represar o
  // layout e a renderização de janelas minimizadas em algumas versões/SOs, o que pode
  // fazer APIs que dependem de layout (getBoundingClientRect, elementFromPoint — usadas
  // pra achar o elemento certo pra clicar na busca da Evolutize) devolverem valores
  // errados ou desatualizados.
  //
  // Tentamos state:'maximized' + focused:false, mas o Chrome recusa essa combinação
  // (erro "Invalid value for state") — no Windows, maximizar uma janela implica trazer
  // ela pra frente/foco, então as duas coisas juntas são contraditórias pro navegador.
  // Como alternativa, criamos uma janela "normal" (não minimizada, então renderiza de
  // verdade) só que grande — do tamanho de uma tela cheia comum — e sem foco. Não é
  // tecnicamente "maximizada" no sentido do SO, mas resolve o problema de fundo (layout
  // pausado) sem brigar com o navegador, e continua atrás da janela que o usuário está
  // usando.
  const win = await chrome.windows.create({
    url: 'about:blank',
    focused: false,
    width: 1600,
    height: 1000,
    left: 0,
    top: 0,
  });
  const tabId = win.tabs[0].id;
  try {
    return await fn(tabId);
  } finally {
    try {
      await chrome.windows.remove(win.id);
    } catch (e) {
      /* janela já pode ter sido fechada manualmente */
    }
  }
}

async function exec(tabId, func, args = []) {
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return result;
}

// ---------- checagens por fonte ----------

async function checkGLPIList(tabId, url) {
  if (!url) return [];
  await navigateAndWait(tabId, url);
  const result = await exec(tabId, extractGLPIList);
  if (result && result.pageError) {
    // Mesma lógica da Evolutize: lança erro em vez de devolver [] pra não fazer o
    // runCheck() tratar isso como "0 chamados" e marcar tudo que já era acompanhado como
    // "sumiu". O catch em runCheck() mantém o state.glpi antigo intacto nesse caso.
    throw new Error(
      'A pesquisa salva do GLPI não retornou nenhum chamado — normalmente sinal de sessão ' +
      'expirada, página não carregada corretamente, ou a URL salva ter parado de funcionar. ' +
      'Abra o GLPI manualmente, confirme que a pesquisa salva ainda mostra resultados, e depois ' +
      'clique em "Verificar agora" no Hub.'
    );
  }
  return result || [];
}

async function checkGLPIAvulsos(tabId, numbers) {
  const out = {};
  for (const num of numbers) {
    const url = `${GLPI_BASE}/front/ticket.form.php?id=${encodeURIComponent(num)}`;
    await navigateAndWait(tabId, url);
    const data = await exec(tabId, extractGLPIAvulso);
    out[num] = data || { title: '', status: '', lastUpdate: '', notFound: true };
  }
  return out;
}

async function checkEvolutizeList(tabId, prevMap) {
  await navigateAndWait(tabId, EVOLUTIZE_LIST_URL);
  const result = await exec(tabId, runEvolutizeList);
  if (result && result.pageError) {
    // Lança erro em vez de devolver [] — isso impede que o runCheck() trate isso como
    // "0 chamados" e dispare uma avalanche de eventos falsos de "sumiu/encerrado" pra
    // tudo que já estava na lista. O catch lá em cima mantém o state.evolutize antigo
    // intacto quando isso acontece.
    throw new Error(
      'A tela da Evolutize não carregou como esperado (sem o filtro de situação/grade de ' +
      'resultados) — normalmente sinal de sessão expirada. Às vezes a Evolutize mostra a ' +
      'tela como se ainda estivesse logado, mas não está: clique em "Empresa" pra voltar à ' +
      'tela de login e entre de novo (se der erro de acesso na primeira tentativa, é um bug ' +
      'conhecido do site — só tentar de novo). Depois clique em "Verificar agora" no Hub.'
    );
  }
  const list = result || [];

  // A grade não traz "última tramitação" — só existe na página de detalhe de cada
  // chamado. Buscar isso pra lista inteira deixaria cada checagem bem mais lenta, então
  // fazemos só pros chamados em aberto (mesmo critério do filtro "ocultar encerrados" do
  // dashboard) — é onde essa informação realmente importa, já que chamados encerrados
  // não vão receber nova tramitação mesmo.
  //
  // IMPORTANTE: decide isso com base no ÚLTIMO status CONFIRMADO (prevMap, da checagem
  // anterior), não no status que acabou de ser lido agora. Se decidíssemos com base na
  // leitura atual, uma leitura ruim que faz um chamado aberto parecer "encerrado" por
  // engano faria o Hub nem buscar a tramitação dele — e é justamente essa tramitação que
  // o diffListSource usa pra desmentir uma mudança de status suspeita (ver lá). Chamados
  // novos (sem entrada em prevMap ainda) sempre buscam, já que não há confirmação prévia
  // pra confiar.
  for (const item of list) {
    if (!item.url) continue;
    const prevStatus = prevMap && prevMap[item.id] ? prevMap[item.id].status : undefined;
    const knownClosed = prevStatus !== undefined && CLOSED_STATUS_RE.test(prevStatus || '');
    if (knownClosed) continue;
    try {
      await navigateAndWait(tabId, item.url);
      const tramitacao = await exec(tabId, extractEvolutizeTramitacao);
      if (tramitacao) {
        item.lastUpdate = tramitacao.lastUpdate;
        item.lastUpdateBy = tramitacao.lastUpdateBy;
      }
    } catch (e) {
      console.warn(`Falha ao buscar última tramitação do chamado Evolutize ${item.id}`, e);
    }
  }

  return list;
}

async function checkEvolutizeAvulsos(tabId, numbers, avulsoUrls) {
  const out = {};
  const updatedUrls = { ...(avulsoUrls || {}) };

  for (const num of numbers) {
    let data = null;
    const cachedUrl = updatedUrls[num];

    // Caminho rápido: se já temos o link direto de uma checagem anterior (a página de
    // chamado da Evolutize aceita acesso direto por URL, sem precisar buscar), abrimos
    // ele de cara. Isso evita todo o processo de busca+clique na sugestão, que é mais
    // lento e mais frágil (depende de simular corretamente um clique num widget de
    // autocomplete de terceiros).
    if (cachedUrl) {
      try {
        await navigateAndWait(tabId, cachedUrl);
        const direct = await exec(tabId, extractEvolutizeAvulsoDetail, [num]);
        if (direct && direct.matchesNumber) {
          data = direct;
        }
      } catch (e) {
        console.warn(`Link fixo da Evolutize falhou para o chamado ${num}, caindo para busca`, e);
      }
    }

    // Sem link fixo ainda, ou o link salvo não abriu mais o chamado certo (token da
    // URL provavelmente expirou/mudou) — busca pelo número normalmente.
    if (!data) {
      await navigateAndWait(tabId, EVOLUTIZE_LIST_URL);
      const searchResult = await exec(tabId, searchEvolutizeAvulso, [num]);
      if (!searchResult || searchResult.error) {
        out[num] = searchResult || { error: 'falha desconhecida ao buscar', number: num };
        delete updatedUrls[num];
        continue;
      }
      // o clique no resultado da busca dispara navegação de página inteira — espera
      // terminar (do lado da extensão, não da página, que já foi destruída) antes de ler.
      await waitForTabComplete(tabId);
      const found = await exec(tabId, extractEvolutizeAvulsoDetail, [num]);
      if (!found) {
        out[num] = { error: 'falha ao ler os dados depois de abrir o chamado', number: num };
        delete updatedUrls[num];
        continue;
      }
      data = found;
    }

    if (data.url) updatedUrls[num] = data.url;
    out[num] = data;
  }

  return { results: out, avulsoUrls: updatedUrls };
}

async function checkMovidesk(tabId) {
  await navigateAndWait(tabId, MOVIDESK_URL);
  const result = await exec(tabId, runMovidesk);
  if (result && result.pageError) {
    // Mesma lógica da Evolutize/GLPI — ver comentário em checkGLPIList.
    throw new Error(
      'A visão "Teste" do Movidesk não retornou nenhum card — normalmente sinal de sessão ' +
      'expirada ou página não carregada corretamente. Abra o Movidesk manualmente, confirme que ' +
      'a visão "Teste" ainda mostra chamados, e depois clique em "Verificar agora" no Hub.'
    );
  }
  return result || [];
}

async function checkMovideskAvulsos(tabId, numbers) {
  const out = {};
  for (const num of numbers) {
    const url = `${MOVIDESK_BASE}/Ticket/Edit/${encodeURIComponent(num)}`;
    await navigateAndWait(tabId, url);
    const data = await exec(tabId, extractMovideskAvulso);
    out[num] = data || { title: '', status: '', lastUpdate: '', notFound: true };
  }
  return out;
}

// ---------- diffing ----------

function toMap(list) {
  const m = {};
  for (const item of list) m[item.id] = item;
  return m;
}

// Monta um sufixo tipo " (última tramitação segundo o GLPI: 19/08/2026 14:32)" pra
// anexar no detalhe do evento. Existe porque a data/hora que aparece normalmente no
// evento (fmtEventTime no dashboard.js) é de quando o HUB checou — não de quando o
// chamado foi de fato atualizado na fonte. Isso gerava confusão na hora de conferir um
// evento suspeito no histórico da própria fonte (ex: aba "Histórico" do GLPI): sem essa
// data, não dá pra saber qual horário procurar lá. Só aparece quando a fonte realmente
// captura essa informação (hoje: GLPI e Evolutize) — pra Movidesk, que não tem, o
// sufixo fica vazio.
function lastUpdateSuffix(data) {
  if (!data || !data.lastUpdate) return '';
  const who = data.lastUpdateBy ? ` por ${data.lastUpdateBy}` : '';
  return ` (última tramitação segundo a fonte: ${data.lastUpdate}${who})`;
}

function diffListSource(sourceLabel, prevMap, nextList, opts = {}) {
  const events = [];
  const rawNextMap = toMap(nextList);
  const nextMap = {};
  for (const id of Object.keys(rawNextMap)) {
    const next = rawNextMap[id];
    const prev = prevMap[id];
    if (!prev) {
      events.push({ source: sourceLabel, id, title: next.title, url: next.url || null, change: 'novo', detail: `Passou a aparecer na lista (status: ${next.status || '—'})${lastUpdateSuffix(next)}` });
      nextMap[id] = next;
      continue;
    }
    if (prev.status !== next.status) {
      // Cruza com a data da última tramitação, quando as duas leituras têm essa
      // informação (hoje: GLPI e Evolutize) — toda mudança de status real é acompanhada
      // de uma tramitação nova, então se a data continuar EXATAMENTE igual à da checagem
      // anterior, é bem mais provável ser uma leitura ruim (timing/renderização parcial
      // no momento do scrape) do que uma mudança de verdade. Nesse caso, ignora a
      // leitura suspeita e mantém os dados antigos em vez de registrar um evento que
      // pode ser falso — o pior caso é uma mudança real demorar mais uma checagem pra
      // ser confirmada (quando a tramitação nova também aparecer), o que é bem mais
      // seguro do que reportar algo errado agora.
      if (next.lastUpdate && prev.lastUpdate && next.lastUpdate === prev.lastUpdate) {
        nextMap[id] = prev;
        continue;
      }
      events.push({ source: sourceLabel, id, title: next.title, url: next.url || null, change: 'status', detail: `${prev.status || '—'} → ${next.status || '—'}${lastUpdateSuffix(next)}` });
      nextMap[id] = next;
      continue;
    }
    // opts.trackLastUpdate liga o aviso de "tramitação nova sem mudança de status"
    // (ex: resposta do suporte que não muda a situação) — hoje ligado pra GLPI e
    // Evolutize, as duas fontes que capturam essa data na lista principal.
    if (opts.trackLastUpdate && next.lastUpdate && prev.lastUpdate && next.lastUpdate !== prev.lastUpdate) {
      const who = next.lastUpdateBy ? ` por ${next.lastUpdateBy}` : '';
      events.push({ source: sourceLabel, id, title: next.title, url: next.url || null, change: 'atualizacao', detail: `Nova tramitação em ${next.lastUpdate}${who}` });
    }
    nextMap[id] = next;
  }
  for (const id of Object.keys(prevMap)) {
    if (!rawNextMap[id]) {
      events.push({ source: sourceLabel, id, title: prevMap[id].title, url: prevMap[id].url || null, change: 'sumiu', detail: `Não aparece mais na lista (provavelmente foi encerrado/concluído)${lastUpdateSuffix(prevMap[id])}` });
    }
  }
  return { nextMap, events };
}

function diffAvulsoSource(sourceLabel, prevMap, nextMap) {
  const events = [];
  const resultMap = {};
  for (const id of Object.keys(nextMap)) {
    const next = nextMap[id];
    const prev = prevMap[id];
    if (next.error) {
      resultMap[id] = next;
      continue;
    }
    if (!prev) {
      events.push({ source: sourceLabel, id, title: next.title, url: next.url || null, change: 'acompanhando', detail: `Adicionado à lista de avulsos${lastUpdateSuffix(next)}` });
      resultMap[id] = next;
      continue;
    }
    if (next.status && prev.status && prev.status !== next.status) {
      // Mesmo raciocínio do diffListSource: cruza com a última tramitação quando as duas
      // leituras têm essa data — hoje Evolutize sempre tem, e GLPI/Movidesk avulso têm
      // quando conseguem achar isso na página de detalhe (best-effort, ver
      // extractGLPIAvulso/extractMovideskAvulso); quando não conseguem, essa checagem
      // simplesmente não se aplica e o evento de status segue direto. Status parecendo
      // diferente mas tramitação igual à da checagem anterior é sinal de leitura ruim,
      // não de mudança real — mantém os dados antigos nesse caso.
      if (next.lastUpdate && prev.lastUpdate && next.lastUpdate === prev.lastUpdate) {
        resultMap[id] = prev;
        continue;
      }
      events.push({ source: sourceLabel, id, title: next.title, url: next.url || null, change: 'status', detail: `${prev.status} → ${next.status}${lastUpdateSuffix(next)}` });
      resultMap[id] = next;
      continue;
    }
    // Nova tramitação que não muda o status (ex: resposta do suporte que mantém a mesma
    // situação) — hoje a Evolutize sempre captura "última tramitação", e o GLPI/Movidesk
    // avulso capturam quando conseguem achar isso na página de detalhe (ver
    // extractGLPIAvulso/extractMovideskAvulso).
    if (next.lastUpdate && prev.lastUpdate && next.lastUpdate !== prev.lastUpdate) {
      const who = next.lastUpdateBy ? ` por ${next.lastUpdateBy}` : '';
      events.push({ source: sourceLabel, id, title: next.title, url: next.url || null, change: 'atualizacao', detail: `Nova tramitação em ${next.lastUpdate}${who}` });
    }
    // NÃO existe mais uma checagem de "conteúdo mudou" via hash da página inteira aqui —
    // foi removida a pedido do Murilo. Ela pegava qualquer diferença de texto na página
    // (timestamps relativos, widgets dinâmicos, ordem de anexos, etc.), sem relação
    // necessária com o chamado em si, e por isso avisava demais — inclusive quando só o
    // status tinha mudado (ex: pausado -> atribuído), o que já é coberto pelo bloco de
    // status logo acima. Trade-off consciente: se uma fonte não conseguir capturar nem
    // status nem "última atualização" pra um chamado avulso específico, esse chamado
    // simplesmente para de gerar avisos de conteúdo — nunca mais um falso positivo, mas
    // também nenhum aviso "eu não sei o quê, mas mudou algo".
    resultMap[id] = next;
  }
  return { resultMap, events };
}

// ---------- chamado "parado" (sem tramitação há muito tempo) ----------
// Diferente do resto do Hub, que só avisa quando algo MUDA, isso avisa quando algo NÃO
// muda por tempo demais — sinal de chamado esquecido, não de chamado resolvido.

// Tenta interpretar os formatos de data que as fontes hoje devolvem em `lastUpdate`:
// Evolutize sempre manda "DD/MM/AAAA HH:MM" (formato que a gente mesmo define no regex
// de extração), então esse sempre funciona. Já o GLPI manda o texto cru da coluna
// "Última atualização" configurada pelo usuário na pesquisa salva — o formato exato
// depende da instalação/local, então tentamos alguns formatos comuns; se nenhum bater,
// devolve null e o chamado simplesmente é ignorado nessa checagem (nunca quebra nem
// dispara alerta errado por não conseguir entender a data).
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
  if (diffMs < 0) return null; // data no futuro — algo não bate, melhor ignorar do que alertar errado
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

// Recalcula do zero a cada checagem (não herda do `state.staleAlerted` anterior) — só
// entram aqui os chamados que ESTÃO estourando o limite agora. Isso naturalmente "limpa"
// sozinho quem teve tramitação nova, foi encerrado ou saiu de acompanhamento: se não
// está mais na lista de "estourando agora", o marcador antigo simplesmente não é
// recriado. O evento só dispara quando o valor de `lastUpdate` é diferente do que já
// gerou alerta da última vez — ou seja, alerta uma vez por "parada", não a cada checagem
// enquanto o chamado continuar parado.
function checkStaleTickets(config, state) {
  const globalDays = Number(config.staleDays) > 0 ? Number(config.staleDays) : null;
  const prevAlerted = state.staleAlerted || {};
  const nextAlerted = {};
  const events = [];

  const sources = [
    { key: 'glpi', label: 'GLPI', map: state.glpi || {}, avulso: false },
    { key: 'glpi', label: 'GLPI (avulso)', map: state.glpiAvulsos || {}, avulso: true, overrides: config.glpiAvulsoStaleDays },
    { key: 'evolutize', label: 'Evolutize', map: state.evolutize || {}, avulso: false },
    { key: 'evolutize', label: 'Evolutize (avulso)', map: state.evolutizeAvulsos || {}, avulso: true, overrides: config.evolutizeAvulsoStaleDays },
    { key: 'movidesk', label: 'Movidesk', map: state.movidesk || {}, avulso: false },
    { key: 'movidesk', label: 'Movidesk (avulso)', map: state.movideskAvulsos || {}, avulso: true, overrides: config.movideskAvulsoStaleDays },
  ];

  for (const src of sources) {
    for (const [id, data] of Object.entries(src.map)) {
      if (!data || data.error) continue;
      const days = daysSinceUpdate(data.lastUpdate);
      if (days == null) continue; // sem data confiável pra essa fonte/chamado — não avalia
      let threshold = globalDays;
      const override = src.avulso && src.overrides ? Number(src.overrides[id]) : NaN;
      if (Number.isFinite(override) && override > 0) threshold = override;
      if (!threshold) continue; // nem padrão geral nem override configurado pra esse chamado
      if (days < threshold) continue;

      const alertKey = `${src.label}::${id}`;
      nextAlerted[alertKey] = data.lastUpdate;
      if (prevAlerted[alertKey] !== data.lastUpdate) {
        events.push({
          source: src.label,
          id,
          title: data.title,
          url: data.url || null,
          change: 'parado',
          detail: `Sem tramitação há ${days} dia${days === 1 ? '' : 's'} (limite: ${threshold}) — última em ${data.lastUpdate}`,
        });
      }
    }
  }

  return { events, staleAlerted: nextAlerted };
}

// ---------- histórico diário (snapshot pra gráfico de tendência) ----------
// Guarda, uma vez por dia, um RESUMO pequeno do estado (total/abertos/encerrados/
// parados por fonte) — não os chamados inteiros. É o que alimenta o gráfico de
// tendência na página de métricas; sem isso, o Hub só sabe o estado ATUAL, nunca
// consegue mostrar "como estava há duas semanas", porque `state` é sobrescrito a cada
// checagem e `events` só registra mudanças pontuais, não uma fotografia completa.

function localDateStr(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Conta quantos chamados do mapa de uma fonte estão parados AGORA, segundo o padrão
// geral configurado (staleDays). É uma versão simplificada do que checkStaleTickets faz
// pra decidir se dispara alerta — aqui só queremos o total corrente pro snapshot, sem
// mexer no dedup de alerta (staleAlerted) nem considerar overrides por avulso (o
// snapshot é sobre a lista principal; um resumo diário não precisa desse nível de
// detalhe pra ser útil como tendência).
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

function summarizeSourceForSnapshot(map) {
  const entries = Object.values(map || {});
  let abertos = 0;
  let encerrados = 0;
  for (const t of entries) {
    if (CLOSED_STATUS_RE.test(t.status || '')) encerrados++;
    else abertos++;
  }
  return { total: entries.length, abertos, encerrados };
}

function buildDailySnapshot(dateStr, config, state, approximated) {
  return {
    date: dateStr,
    approximated: !!approximated,
    glpi: { ...summarizeSourceForSnapshot(state.glpi), parados: countStaleNow(config, state.glpi) },
    evolutize: { ...summarizeSourceForSnapshot(state.evolutize), parados: countStaleNow(config, state.evolutize) },
    movidesk: { ...summarizeSourceForSnapshot(state.movidesk), parados: countStaleNow(config, state.movidesk) },
  };
}

const SNAPSHOT_RETENTION_DAYS = 365;

// Roda em toda checagem (não precisa de alarme próprio). Duas coisas, nessa ordem:
// 1) se falta o snapshot de ONTEM, salva agora usando o estado atual como aproximação
//    (sinal de que o Chrome esteve fechado no fim do dia anterior) — só recupera o dia
//    imediatamente anterior, nunca uma sequência inteira de dias perdidos (ver
//    explicação completa dada ao Murilo: aproximar um único dia é razoável, encadear
//    vários já não seria confiável).
// 2) se ainda não tem o de HOJE e já são 17h ou mais (horário local), salva o de hoje —
//    esse já não é aproximado, é a leitura "de verdade" do fim do dia.
async function maybeSnapshotDaily(config, state) {
  const { dailySnapshots } = await chrome.storage.local.get('dailySnapshots');
  const snapshots = dailySnapshots || {};
  const now = new Date();
  const todayStr = localDateStr(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = localDateStr(yesterday);

  let changed = false;
  if (!snapshots[yesterdayStr]) {
    snapshots[yesterdayStr] = buildDailySnapshot(yesterdayStr, config, state, true);
    changed = true;
  }
  if (!snapshots[todayStr] && now.getHours() >= 17) {
    snapshots[todayStr] = buildDailySnapshot(todayStr, config, state, false);
    changed = true;
  }
  if (!changed) return;

  // Poda qualquer coisa mais velha que a retenção — comparação por string funciona
  // porque o formato YYYY-MM-DD já ordena igual cronologicamente.
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - SNAPSHOT_RETENTION_DAYS);
  const cutoffStr = localDateStr(cutoff);
  for (const d of Object.keys(snapshots)) {
    if (d < cutoffStr) delete snapshots[d];
  }

  await chrome.storage.local.set({ dailySnapshots: snapshots });
}

// ---------- checagem de versão nova (GitHub) ----------
// A extensão está instalada via "Load unpacked" (modo desenvolvedor) — esse modo não
// tem nenhum mecanismo de auto-update oferecido pelo Chrome (isso só existe pra
// extensões da Chrome Web Store, ou via política corporativa com um .crx assinado).
// Então isso aqui NÃO baixa nem substitui nada sozinho: só compara a versão instalada
// (a que está em manifest.json) com um arquivo version.json hospedado no repositório do
// GitHub e, se tiver uma versão mais nova, guarda um aviso pro dashboard.js mostrar,
// com link pra pegar a atualização.

// Fixo no código de propósito — não é uma opção de configuração (não tem campo pra isso
// no Hub). É o repositório oficial do projeto; só faz sentido mudar isso editando o
// código mesmo (ex: se o repositório for renomeado ou movido).
const UPDATE_CHECK_URL = 'https://raw.githubusercontent.com/batistela/hub-chamados/main/version.json';

// Comparação numérica por partes (1.9.0 < 1.10.0) — comparar como texto puro erraria
// esse caso ("1.10.0" < "1.9.0" alfabeticamente).
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

// Não busca a cada checagem de chamados (que pode rodar a cada 15-45min) — não faz
// sentido bater no GitHub com essa frequência só pra checar versão. 12h é generoso o
// suficiente pra avisar rápido sem gerar tráfego à toa.
const UPDATE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

async function checkForUpdate() {
  const { lastUpdateCheckTs } = await chrome.storage.local.get('lastUpdateCheckTs');
  if (lastUpdateCheckTs && Date.now() - lastUpdateCheckTs < UPDATE_CHECK_INTERVAL_MS) return;
  await chrome.storage.local.set({ lastUpdateCheckTs: Date.now() });
  try {
    const res = await fetch(UPDATE_CHECK_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const current = chrome.runtime.getManifest().version;
    const remote = String(data.version || '').trim();
    if (remote && compareVersions(remote, current) > 0) {
      // zipUrl: de onde o botão "Baixar atualização" no Hub pega o arquivo. Se o
      // version.json não trouxer um `zipUrl` explícito, monta a partir da URL do
      // repositório (`data.url`) assumindo o padrão de link de "baixar .zip da branch"
      // do próprio GitHub — funciona pra qualquer repositório público sem precisar de
      // configuração extra, só quebra se a branch principal não se chamar "main".
      const repoUrl = (data.url || '').replace(/\/+$/, '');
      const zipUrl = data.zipUrl || (repoUrl ? `${repoUrl}/archive/refs/heads/main.zip` : '');
      await chrome.storage.local.set({
        updateInfo: { available: true, version: remote, notes: data.notes || '', url: data.url || '', zipUrl },
      });
    } else {
      await chrome.storage.local.set({ updateInfo: null });
    }
  } catch (e) {
    // Falha ao checar (repositório privado sem acesso público, GitHub fora do ar,
    // version.json com formato inválido, etc.) — só loga. De propósito NÃO mexe no
    // updateInfo aqui: se a última checagem bem-sucedida já tinha achado uma versão
    // nova, o aviso continua na tela até uma checagem que confirme que já atualizou.
    console.warn('Falha ao checar versão nova no GitHub', e);
  }
}

// ---------- notificação + som ----------

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument?.();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: 'Tocar som de notificação quando um chamado é atualizado',
  });
}

async function playSound() {
  try {
    await ensureOffscreen();
    chrome.runtime.sendMessage({ type: 'playSound' });
  } catch (e) {
    console.warn('não foi possível tocar som', e);
  }
}

async function notify(events) {
  if (!events.length) return;
  const config = await getConfig();
  const lines = events.slice(0, 5).map((e) => `[${e.source}] ${e.id} — ${e.detail}`);
  const extra = events.length > 5 ? `\n(+${events.length - 5} outras atualizações)` : '';
  chrome.notifications.create(`hub-${Date.now()}`, {
    type: 'basic',
    iconUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    title: `Hub de Chamados — ${events.length} atualização(ões)`,
    message: lines.join('\n') + extra,
    priority: 2,
  });
  if (config.soundEnabled) playSound();
}

// ---------- checagem completa ----------

let checkInFlight = null;

async function runCheck() {
  if (checkInFlight) return checkInFlight;
  checkInFlight = (async () => {
    const config = await getConfig();
    const state = await getState();
    const allEvents = [];

    const errors = {};

    // Não depende da janela/aba de trabalho (é só um fetch direto) e não deve travar a
    // checagem de chamados se falhar — por isso roda solto aqui, com seu próprio
    // try/catch interno (ver checkForUpdate).
    checkForUpdate().catch((e) => console.warn('checkForUpdate falhou', e));

    await withWorkerTab(async (tabId) => {
      // GLPI - lista principal (pulada se "só avulsos" estiver marcado)
      if (config.glpiOnlyAvulsos) {
        state.glpi = {};
        errors.glpi = null;
      } else if (config.glpiSearchUrl) {
        try {
          const glpiList = await withRetries(() => checkGLPIList(tabId, config.glpiSearchUrl), { label: 'GLPI' });
          // trackLastUpdate:true também liga o cruzamento de status × última tramitação
          // (ver diffListSource) — importante pro GLPI porque a coluna "Última
          // atualização" já vem na mesma leitura da grade.
          const { nextMap, events } = diffListSource('GLPI', state.glpi || {}, glpiList, { trackLastUpdate: true });
          state.glpi = nextMap;
          allEvents.push(...events);
          errors.glpi = glpiList.length ? null : 'A checagem rodou mas não encontrou nenhuma linha na tabela de resultados (ver detalhes no README/console).';
        } catch (e) {
          console.error('Falha ao checar GLPI', e);
          errors.glpi = String(e && e.message ? e.message : e);
        }
      } else {
        errors.glpi = 'Nenhuma URL de pesquisa salva configurada no Hub.';
      }

      // GLPI - avulsos
      if (config.glpiAvulsos.length) {
        try {
          const glpiAv = await checkGLPIAvulsos(tabId, config.glpiAvulsos);
          const { resultMap: glpiAvResult, events } = diffAvulsoSource('GLPI (avulso)', state.glpiAvulsos || {}, glpiAv);
          state.glpiAvulsos = glpiAvResult;
          allEvents.push(...events);
        } catch (e) {
          console.error('Falha ao checar avulsos GLPI', e);
          errors.glpiAvulsos = String(e && e.message ? e.message : e);
        }
      }

      // Evolutize - lista principal (pulada se "só avulsos" estiver marcado)
      if (config.evolutizeOnlyAvulsos) {
        state.evolutize = {};
        errors.evolutize = null;
      } else {
        try {
          const evoList = await withRetries(() => checkEvolutizeList(tabId, state.evolutize || {}), { label: 'Evolutize' });
          const evoDiff = diffListSource('Evolutize', state.evolutize || {}, evoList, { trackLastUpdate: true });
          state.evolutize = evoDiff.nextMap;
          allEvents.push(...evoDiff.events);
          errors.evolutize = evoList.length ? null : 'A checagem rodou mas não encontrou nenhuma linha na grade de resultados.';
        } catch (e) {
          console.error('Falha ao checar Evolutize', e);
          errors.evolutize = String(e && e.message ? e.message : e);
        }
      }

      // Evolutize - avulsos
      if (config.evolutizeAvulsos.length) {
        try {
          const { results: evoAv, avulsoUrls } = await checkEvolutizeAvulsos(
            tabId,
            config.evolutizeAvulsos,
            config.evolutizeAvulsoUrls
          );
          const { resultMap: evoAvResult, events } = diffAvulsoSource('Evolutize (avulso)', state.evolutizeAvulsos || {}, evoAv);
          state.evolutizeAvulsos = evoAvResult;
          allEvents.push(...events);
          // Guarda os links fixos descobertos/confirmados nessa rodada pra próxima
          // checagem poder pular a busca.
          await setConfig({ evolutizeAvulsoUrls: avulsoUrls });
        } catch (e) {
          console.error('Falha ao checar avulsos Evolutize', e);
          errors.evolutizeAvulsos = String(e && e.message ? e.message : e);
        }
      }

      // Movidesk - lista principal (pulada se "só avulsos" estiver marcado)
      if (config.movideskOnlyAvulsos) {
        state.movidesk = {};
        errors.movidesk = null;
      } else {
        try {
          const mdList = await withRetries(() => checkMovidesk(tabId), { label: 'Movidesk' });
          const mdDiff = diffListSource('Movidesk', state.movidesk || {}, mdList);
          state.movidesk = mdDiff.nextMap;
          allEvents.push(...mdDiff.events);
          errors.movidesk = mdList.length ? null : 'A checagem rodou mas não encontrou nenhum card na visão "Teste".';
        } catch (e) {
          console.error('Falha ao checar Movidesk', e);
          errors.movidesk = String(e && e.message ? e.message : e);
        }
      }

      // Movidesk - avulsos
      if (config.movideskAvulsos.length) {
        try {
          const mdAv = await checkMovideskAvulsos(tabId, config.movideskAvulsos);
          const { resultMap: mdAvResult, events } = diffAvulsoSource('Movidesk (avulso)', state.movideskAvulsos || {}, mdAv);
          state.movideskAvulsos = mdAvResult;
          allEvents.push(...events);
        } catch (e) {
          console.error('Falha ao checar avulsos Movidesk', e);
          errors.movideskAvulsos = String(e && e.message ? e.message : e);
        }
      }
    });

    // Roda depois de todas as fontes terem sido atualizadas (ou preservado o estado
    // anterior, se alguma falhou) — avalia o `state` já consolidado dessa checagem.
    const stale = checkStaleTickets(config, state);
    state.staleAlerted = stale.staleAlerted;
    allEvents.push(...stale.events);

    // Mesma lógica: só depois do state consolidado, pra o snapshot refletir o resultado
    // final da checagem (não um estado parcial). Tem seu próprio try/catch — uma falha
    // aqui não pode derrubar o resto da checagem de chamados.
    try {
      await maybeSnapshotDaily(config, state);
    } catch (e) {
      console.warn('maybeSnapshotDaily falhou', e);
    }

    await setState(state);
    const mergedEvents = await pushEvents(allEvents);
    await recordTicketHistory(allEvents);
    await chrome.storage.local.set({ lastCheck: Date.now(), lastCheckOk: true, sourceErrors: errors });
    await notify(allEvents);
    // O badge mostra quantas atualizações ainda não foram marcadas como vistas —
    // acumula entre checagens, não é só "quantas mudaram agora". Só zera quando o
    // usuário confirma (marcar como visto / marcar tudo como visto no Hub).
    updateBadge(mergedEvents.filter((e) => !e.acknowledged).length);
    return allEvents;
  })()
    .catch(async (e) => {
      console.error('Erro no runCheck', e);
      await chrome.storage.local.set({ lastCheck: Date.now(), lastCheckOk: false, lastCheckError: String(e) });
      return [];
    })
    .finally(() => {
      checkInFlight = null;
    });
  return checkInFlight;
}

function updateBadge(count) {
  chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#d33' });
}

// ---------- mensagens vindas do hub ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'runCheckNow') {
    runCheck().then((events) => sendResponse({ ok: true, events }));
    return true;
  }
  if (msg?.type === 'updateInterval') {
    setConfig({ intervalMinutes: msg.minutes }).then(async () => {
      await ensureAlarm();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg?.type === 'clearBadge') {
    updateBadge(0);
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'acknowledgeEvent') {
    acknowledgeEvent(msg.eventId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'acknowledgeAllEvents') {
    acknowledgeAllEvents().then(() => sendResponse({ ok: true }));
    return true;
  }
});

// ---------- abrir o hub ao clicar no ícone ----------

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    chrome.tabs.create({ url });
  }
});
