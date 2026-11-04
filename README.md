# Contador de Dias

PWA para contar há quantos dias você parou de fazer algo (ou mantém um hábito). Funciona offline e sem login.


## Estrutura

```
public/
  index.html            página
  app.css, app.js       estilo e lógica
  fonts/                Big Shoulders Display e Instrument Sans (woff2, latin)
  sw.js                 service worker (offline)
  manifest.webmanifest  instalação como app
  icon-*.png            ícones
```

## Rodar

```bash
python3 -m http.server 8000 --directory public
```

Abra `http://localhost:8000`. O service worker funciona em `localhost`.

## Ao alterar qualquer arquivo de `public/`

Mude a versão de `CACHE` em `public/sw.js`, senão o celular continua com a versão antiga. Se criar um arquivo novo, inclua-o na lista `ARQUIVOS`.

## Testes

```bash
python3 tests/e2e.py
```

Teste de ponta a ponta no Chromium (Playwright para Python): carga, fontes, criar contagem, persistência, offline e "Recomecei". Os testes unitários das funções puras entram na etapa 2.
