# Hub de Chamados — Holambra

Extensão para Chrome que monitora em segundo plano os seus chamados no **GLPI**, **Evolutize** e **Movidesk (Keyrus)**, e avisa (notificação + som) quando algo muda — status, novo chamado no seu escopo, ou chamado que some da lista (geralmente porque foi fechado).

## 1. Instalar

1. Baixe/extraia esta pasta em algum lugar do computador (ex: Documentos).
2. No Chrome, acesse `chrome://extensions`.
3. Ative **Modo do desenvolvedor** (chave no canto superior direito).
4. Clique em **Carregar sem compactação** e selecione esta pasta.
5. O ícone da extensão aparece na barra de ferramentas. Clique nele a qualquer momento para abrir o **Hub**.

Não precisa de conta, login separado nem senha — a extensão usa a sua sessão já autenticada no navegador em cada sistema. Continue logado normalmente no GLPI, Evolutize e Movidesk.

## 2. Primeira configuração

Abra o Hub (clique no ícone da extensão) e preencha:

**URL da pesquisa salva do GLPI** — abra o GLPI, aplique o filtro que vocês já ajustaram (Atribuído OU Observador = você, Status ≠ Fechado, agrupado corretamente), clique em Pesquisar, e copie a URL completa da barra de endereço para esse campo do Hub.

**Intervalo de verificação** — padrão 15 minutos, ajustável de 5 a 180.

**Chamados avulsos (GLPI e Evolutize)** — adicione aqui os números de chamados específicos que não aparecem nos filtros principais (ex: repassados informalmente). Não precisa fazer isso para a Movidesk: lá a visão "Teste" já mostra tudo que sua conta tem permissão de ver (seus + onde você é observador).

Clique em **Salvar configurações**.

## 3. Uso do dia a dia

O Hub verifica sozinho, no intervalo configurado, mesmo com a aba do Hub fechada — só precisa do Chrome aberto (não precisa estar na aba ativa). Quando alguma checagem roda, uma janela minimizada é aberta rapidamente em segundo plano para carregar as páginas — isso é normal e não deve atrapalhar o que você está fazendo.

Quando algo muda, você recebe uma notificação nativa do Chrome com som. Abrindo o Hub, a seção **Atualizações recentes** mostra o histórico, e as tabelas de cada sistema mostram o estado mais recente capturado.

Use o botão **Verificar agora** para forçar uma checagem imediata, sem esperar o intervalo — bom para testar se está tudo funcionando.

## 4. Limitações importantes

- Só funciona com o Chrome aberto (não roda com o navegador fechado).
- Os avulsos (GLPI e Evolutize) usam detecção por "mudou ou não mudou o conteúdo da página" — não mostram exatamente o que mudou, só sinalizam que vale a pena abrir o chamado pra conferir. Já os três painéis principais (GLPI, Evolutize, Movidesk) mostram status detalhado.
- Se o layout de alguma dessas páginas mudar (atualização do sistema do fornecedor), a extração pode parar de funcionar corretamente — nesse caso, me avise que ajustamos o código.
- Primeira checagem depois de instalar roda cerca de 1 minuto após ligar a extensão; depois disso segue o intervalo configurado.

## 5. Estrutura dos arquivos (caso queira mexer)

- `manifest.json` — configuração da extensão.
- `background.js` — o "cérebro": agenda as checagens, compara com o estado anterior, dispara notificação.
- `extractors.js` — as funções que leem os dados de cada site.
- `dashboard.html/css/js` — o Hub que você vê ao clicar no ícone.
- `offscreen.html/js` — toca o som de notificação (truque técnico exigido pelo Chrome para tocar áudio em segundo plano).
- `version.json` — usado só pelo aviso de "versão nova" (ver seção 6 abaixo); não faz parte da extensão em si.

## 6. Publicando atualizações no GitHub (aviso de versão nova)

O Hub pode avisar sozinho, na tela, quando existe uma versão mais nova disponível — mas como a extensão é instalada via "Carregar sem compactação" (modo desenvolvedor), o Chrome não tem nenhum mecanismo de auto-update pra ela: o Hub só **avisa**, com um link pra pegar a atualização; baixar e recarregar em `chrome://extensions` continua manual, pra cada pessoa.

Isso funciona comparando a versão instalada com um arquivo `version.json` neste repositório. Pra publicar uma atualização nova:

1. Suba as mudanças pro GitHub (`git add`, `git commit`, `git push`).
2. Aumente o número em `"version"` no `manifest.json`.
3. Atualize `version.json` na raiz do repositório com o mesmo número e, em `"notes"`, um resumo curto do que mudou.
4. Faça commit e push desses dois arquivos.

Assim que o `version.json` publicado tiver uma versão maior que a instalada, quem tiver o campo "URL do arquivo de versão" preenchido nas Configurações do Hub vê o aviso automaticamente (a checagem roda a cada ~12h, e também ao clicar em "Verificar agora"). Pra ativar isso pela primeira vez, cada pessoa cola nesse campo a URL "raw" do `version.json` no GitHub — algo como `https://raw.githubusercontent.com/SEU-USUARIO/SEU-REPOSITORIO/main/version.json`.

**Importante:** esse recurso só funciona bem com repositório **público** (ou visível pra organização, se o GitHub da Holambra tiver isso) — `raw.githubusercontent.com` não aceita autenticação vinda da extensão, então um repositório privado faria essa checagem sempre falhar silenciosamente (sem quebrar o resto do Hub, só sem avisar de versão nova).
