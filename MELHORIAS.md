# Ideias de melhoria (backlog)

Lista de ideias registradas pra implementar depois — sem prazo, só pra não esquecer. Cada item vira uma seção quando for implementado (data + o que foi feito).

## Tema claro e escuro — feito

Registrado em: 02/09/2026. Implementado em: 02/09/2026.

Hoje o Hub (`dashboard.css`) só tem um tema (claro), com as cores fixas em `:root`. A ideia é adicionar um tema escuro, alternável manualmente e/ou detectando a preferência do sistema operacional (`prefers-color-scheme`).

Implementado: cores convertidas pra variáveis CSS, com um tema escuro completo (segue `prefers-color-scheme` por padrão, ou pode ser forçado manualmente pelo botão 🌓 no topbar — ciclo automático → claro → escuro). A escolha manual fica salva (`uiTheme` no storage) e vale pras duas páginas do Hub (`dashboard.html` e a nova `metrics.html`).
