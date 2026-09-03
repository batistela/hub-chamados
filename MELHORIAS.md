# Ideias de melhoria (backlog)

Lista de ideias registradas pra implementar depois — sem prazo, só pra não esquecer. Cada item vira uma seção quando for implementado (data + o que foi feito).

## Tema claro e escuro — feito

Registrado em: 02/09/2026. Implementado em: 02/09/2026.

Hoje o Hub (`dashboard.css`) só tem um tema (claro), com as cores fixas em `:root`. A ideia é adicionar um tema escuro, alternável manualmente e/ou detectando a preferência do sistema operacional (`prefers-color-scheme`).

Implementado: cores convertidas pra variáveis CSS, com um tema escuro completo (segue `prefers-color-scheme` por padrão, ou pode ser forçado manualmente pelo botão 🌓 no topbar — ciclo automático → claro → escuro). A escolha manual fica salva (`uiTheme` no storage) e vale pras duas páginas do Hub (`dashboard.html` e a nova `metrics.html`).

## Botão pra limpar o histórico de alterações, com controle — feito

Registrado em: 03/09/2026. Implementado em: 03/09/2026.

Hoje não tem como limpar `events` (Atualizações recentes/Histórico) nem `ticketHistory` (histórico por chamado) — só cresce (até os limites de 5000/2000 por chamado). A ideia é um botão de limpeza com mais controle do que "apagar tudo de uma vez": por idade (ex: "limpar atualizações com mais de N dias"), separando "Atualizações/Histórico" de "histórico por chamado", com confirmação em duas etapas antes de apagar de verdade.

Implementado: novo card "Manutenção de dados" no Hub, com um contador (quantos registros existem em cada store, e a data do mais antigo) e dois botões independentes — um pra "Atualizações recentes/Histórico" (`events`), outro pra "Histórico por chamado" (`ticketHistory`) — cada um com um campo "mais antigo que N dias" (0 = apaga tudo) e confirmação em duas etapas (clique uma vez pra armar, clique de novo em até 4s pra confirmar). A lógica de checagem não mudou em nada — é só filtragem do que já estava salvo.

## Habilitar/desabilitar cada fonte por analista — feito

Registrado em: 03/09/2026. Implementado em: 03/09/2026.

Hoje "mostrar só os avulsos" existe pra cada fonte, mas não dá pra desligar uma fonte inteira — nem os avulsos. Tem analista sem acesso ao Movidesk (por exemplo), que hoje mesmo assim tem a checagem tentando entrar lá toda vez, gerando erro de "sessão" falso e perdendo tempo à toa. A ideia é um checkbox por fonte (GLPI/Evolutize/Movidesk) que pula a checagem inteira quando desmarcado — não só os avulsos — e esconde/esmaece a seção correspondente no Hub.

Implementado: checkbox "Verificar esta fonte" no topo do bloco de configuração de cada fonte (GLPI/Evolutize/Movidesk), marcado por padrão. Desmarcado, o `background.js` pula a fonte inteira (lista + avulsos, sem abrir nenhuma página) na próxima checagem, sem gerar erro de "sessão" — e o Hub esmaece o card da tabela, o bloco de configuração de avulsos e a coluna de status de avulsos daquela fonte, com um selo "desativada".

## Suporte a outros fornecedores/sites de chamados, configurável pelo usuário — feito (modo avulso)

Registrado em: 03/09/2026. Implementado em: 03/09/2026.

Ideia mais ambiciosa: deixar o analista cadastrar outro site de chamados sem precisar de código novo — apontar a URL de busca, a extensão abre a página, e o usuário clica nos elementos que quer capturar (número do chamado, status, data/hora da última tramitação, por quem). Avaliação original: dá pra pedir permissão de um domínio novo em tempo real (`chrome.permissions.request`), sem precisar republicar a extensão pra cada fornecedor novo. O modo "avulso" (um chamado por vez, por número) é viável reaproveitando a lógica de diff que já existe, só trocando os seletores fixos por seletores escolhidos pelo usuário. Já o modo "lista" (uma grade inteira tipo pesquisa salva do GLPI) ficou de fora — precisaria de um "gerador de padrão" a partir de um exemplo clicado, o que na prática é construir uma ferramenta de scraping genérica, bem mais arriscado.

**Nome da fonte na interface**: não é detectado automaticamente do domínio (domínios genéricos tipo `chamados.empresa.com.br` não viram um nome útil sozinhos, e duas instâncias do mesmo produto — ex: Zendesk de dois clientes — precisariam de nomes diferentes). O assistente pede o nome pra você digitar, com uma sugestão pré-preenchida a partir do domínio (editável, nunca travada). Por baixo dos panos, o nome de exibição (`label`) é separado de um identificador interno fixo (`id`, gerado uma vez e nunca muda) — assim renomear a fonte depois não quebra o histórico já salvo (`ticketHistory`/`events`, que usam o nome como chave).

Implementado: novo card "Fontes personalizadas" no Hub (Configurações), com um assistente dedicado (`addSource.html`) — você informa nome + URL do chamado (com `{numero}` no lugar do número) + um número de chamado real pra abrir a página de exemplo, e depois clica em cada um dos 5 campos ("Número do ticket", "Status", "Requerente", "Data e hora da atualização", "Usuário da tramitação") na aba aberta, com opção de pular qualquer campo que não exista nesse site. Cada clique gera um seletor CSS (tenta id/atributos estáveis primeiro, cai pra um caminho por posição só se precisar) e mostra o texto capturado, pra você confirmar antes de seguir pro próximo campo. A permissão do domínio novo é pedida em tempo real (`chrome.permissions.request`, com `optional_host_permissions: ["*://*/*"]` no manifest) — sem precisar editar/republicar a extensão pra cada fornecedor. Uma fonte cadastrada tem seu próprio checkbox "Verificar esta fonte", sua própria lista de avulsos (números acompanhados) com override de dias-parado por chamado, e "Remapear campos" pra corrigir os seletores se o site mudar de layout (problema real e esperado — seletor de site com framework JS pode parar de bater depois de um deploy do fornecedor; por isso o remapeamento existe como fluxo separado, não exige recadastrar a fonte inteira).
