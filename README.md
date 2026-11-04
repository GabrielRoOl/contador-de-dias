# Contador de Dias

PWA para contar há quantos dias você parou de fazer algo (ou mantém um hábito). Funciona offline e sem login.


## Estrutura

```
public/
  index.html            página
  app.css, app.js       estilo e interface
  textos.js             todas as frases do app, com variações
  logica.js             lógica pura (dias, marcos, economia, check-in, migração v1→v2)
  fonts/                Big Shoulders Display e Instrument Sans (woff2, latin)
  sw.js                 service worker (rede primeiro; offline pelo cache)
scripts/versao.js       sobe a versão do cache e do ?v= dos arquivos
  manifest.webmanifest  instalação como app
  icon-*.png            ícones
```

## Rodar

```bash
python3 -m http.server 8000 --directory public
```

Abra `http://localhost:8000`. O service worker funciona em `localhost`.

## Ao alterar qualquer arquivo de `public/`

Rode `node scripts/versao.js`. Ele sobe o número do cache em `public/sw.js` e o `?v=` de CSS e JS no `index.html`, para o navegador baixar tudo novo de uma vez (sem misturar HTML novo com JS antigo). Se criar um arquivo novo, inclua-o na lista `ARQUIVOS` do `sw.js`. Depois de uma atualização, o celular pode precisar de uma recarga extra para trocar o service worker antigo.

## Testes

```bash
node --test tests/*.test.js                             # unitários (Node 20+)
python3 tests/e2e.py               # ponta a ponta no Chromium (Playwright para Python)
```

O e2e cobre os dois tipos (parar e manter), deslize, recomeço, check-in, editar, excluir, ajustes, migração v1→v2, dados corrompidos, persistência e offline. Passe uma pasta como argumento para salvar capturas de tela.
