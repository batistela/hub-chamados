# Hub de Chamados

Extensão para Chrome que monitora em segundo plano chamados de suporte em três sistemas (um interno e dois de fornecedores externos), e avisa (notificação + som) quando algo muda — status, novo chamado no seu escopo, ou chamado que some da lista (geralmente porque foi fechado).

## 1. Instalar

1. Baixe/extraia esta pasta em algum lugar do computador (ex: Documentos).
2. No Chrome, acesse `chrome://extensions`.
3. Ative **Modo do desenvolvedor** (chave no canto superior direito).
4. Clique em **Carregar sem compactação** e selecione esta pasta.
5. O ícone da extensão aparece na barra de ferramentas. Clique nele a qualquer momento para abrir o **Hub**.

Não precisa de conta, login separado nem senha — a extensão usa a sua sessão já autenticada no navegador em cada sistema. Continue logado normalmente em cada um deles.

## 2. Primeira configuração

Abra o Hub (clique no ícone da extensão) e preencha:

**URL da pesquisa salva do sistema interno** — abra o sistema, aplique o filtro que vocês já ajustaram (Atribuído OU Observador = você, Status ≠ Fechado, agrupado corretamente), clique em Pesquisar, e copie a URL completa da barra de endereço para esse campo do Hub.

**Intervalo de verificação** — padrão 15 minutos, ajustável de 1 a 180 (0 desativa a verificação automática).

**Chamados avulsos** — adicione aqui os números de chamados específicos que não aparecem nos filtros principais (ex: repassados informalmente). Nem todo sistema monitorado precisa disso — em alguns, a visão já usada mostra tudo que sua conta tem permissão de ver (seus + onde você é observador).

Clique em **Salvar configurações**.

## 3. Uso do dia a dia

O Hub verifica sozinho, no intervalo configurado, mesmo com a aba do Hub fechada — só precisa do Chrome aberto (não precisa estar na aba ativa). Quando alguma checagem roda, uma janela é aberta rapidamente em segundo plano para carregar as páginas — isso é normal e não deve atrapalhar o que você está fazendo.

Quando algo muda, você recebe uma notificação nativa do Chrome com som. Abrindo o Hub, a seção **Atualizações recentes** mostra o histórico, e as tabelas de cada sistema mostram o estado mais recente capturado.

Use o botão **Verificar agora** para forçar uma checagem imediata, sem esperar o intervalo — bom para testar se está tudo funcionando.

## 4. Limitações importantes

- Só funciona com o Chrome aberto (não roda com o navegador fechado).
- Alguns dos avulsos usam detecção por "mudou ou não mudou o conteúdo da página" — não mostram exatamente o que mudou, só sinalizam que vale a pena abrir o chamado pra conferir. Os três painéis principais mostram status detalhado.
- Se o layout de alguma dessas páginas mudar (atualização do sistema do fornecedor), a extração pode parar de funcionar corretamente — nesse caso, me avise que ajustamos o código.
- Primeira checagem depois de instalar roda só depois de um intervalo completo (não é imediata); depois disso segue o intervalo configurado.

## 5. Estrutura dos arquivos (caso queira mexer)

- `manifest.json` — configuração da extensão.
- `background.js` — o "cérebro": agenda as checagens, compara com o estado anterior, dispara notificação.
- `extractors.js` — as funções que leem os dados de cada site.
- `dashboard.html/css/js` — o Hub que você vê ao clicar no ícone.
- `offscreen.html/js` — toca o som de notificação (truque técnico exigido pelo Chrome para tocar áudio em segundo plano).
- `version.json` — usado só pelo aviso de "versão nova" dentro do Hub; não faz parte da extensão em si.
