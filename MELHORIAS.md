# Ideias de melhoria (backlog)

Lista de ideias registradas pra implementar depois — sem prazo, só pra não esquecer. Cada item vira uma seção quando for implementado (data + o que foi feito).

## Tema claro e escuro — feito

Registrado em: 02/09/2026. Implementado em: 02/09/2026.

Hoje o Hub (`dashboard.css`) só tem um tema (claro), com as cores fixas em `:root`. A ideia é adicionar um tema escuro, alternável manualmente e/ou detectando a preferência do sistema operacional (`prefers-color-scheme`).

Implementado: cores convertidas pra variáveis CSS, com um tema escuro completo (segue `prefers-color-scheme` por padrão, ou pode ser forçado manualmente pelo botão 🌓 no topbar — ciclo automático → claro → escuro). A escolha manual fica salva (`uiTheme` no storage) e vale pras duas páginas do Hub (`dashboard.html` e a nova `metrics.html`).

## Botão pra limpar o histórico de alterações, com controle

Registrado em: 03/09/2026.

Hoje não tem como limpar `events` (Atualizações recentes/Histórico) nem `ticketHistory` (histórico por chamado) — só cresce (até os limites de 5000/2000 por chamado). A ideia é um botão de limpeza com mais controle do que "apagar tudo de uma vez": por idade (ex: "limpar atualizações com mais de N dias"), separando "Atualizações/Histórico" de "histórico por chamado", com confirmação em duas etapas antes de apagar de verdade. Complexidade baixa — é só filtrar o que já está salvo, sem mudar a lógica de checagem. Bom momento pra isso: dá pra usar já de cara pra limpar o ruído das falsas "Conteúdo do chamado mudou" de antes da correção de hoje.

## Habilitar/desabilitar cada fonte por analista

Registrado em: 03/09/2026.

Hoje "mostrar só os avulsos" existe pra cada fonte, mas não dá pra desligar uma fonte inteira — nem os avulsos. Tem analista sem acesso ao Movidesk (por exemplo), que hoje mesmo assim tem a checagem tentando entrar lá toda vez, gerando erro de "sessão" falso e perdendo tempo à toa. A ideia é um checkbox por fonte (GLPI/Evolutize/Movidesk) que pula a checagem inteira quando desmarcado — não só os avulsos — e esconde/esmaece a seção correspondente no Hub. Complexidade baixa — estende o mesmo padrão de config que já existe pra "só avulsos".

## Suporte a outros fornecedores/sites de chamados, configurável pelo usuário

Registrado em: 03/09/2026.

Ideia mais ambiciosa: deixar o analista cadastrar outro site de chamados sem precisar de código novo — apontar a URL de busca, a extensão abre a página, e o usuário clica nos elementos que quer capturar (número do chamado, status, data/hora da última tramitação, por quem). Avaliação: dá pra pedir permissão de um domínio novo em tempo real (`chrome.permissions.request`), sem precisar republicar a extensão pra cada fornecedor novo — essa parte é tranquila. O modo "avulso" (um chamado por vez, por número — igual já funciona pro GLPI/Movidesk hoje) também é viável: reaproveitaria quase toda a lógica de diff que já existe, só trocando os seletores fixos por seletores escolhidos pelo usuário. Já o modo "lista" (uma grade inteira tipo pesquisa salva do GLPI) é bem mais complexo — precisaria de um "gerador de padrão" a partir de um exemplo clicado (generalizar de uma linha pra todas), o que na prática é construir uma ferramenta de scraping genérica, não só mais um recurso da extensão — e mesmo os extratores escritos à mão hoje (GLPI/Evolutize/Movidesk) precisaram de vários ajustes ao longo do tempo pra ficar confiáveis (esperas adaptativas, retentativas, detecção de sessão caída) que uma versão genérica também precisaria ter. Recomendação: se for pra frente, começar só pelo modo avulso.
