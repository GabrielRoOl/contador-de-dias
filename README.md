# Contador de Dias

PWA para contar há quantos dias você parou de fazer algo (ou mantém um hábito). Funciona offline e sem login.


## Estrutura

```
public/
  index.html            página
  app.css, app.js       estilo e interface
  textos.js             todas as frases do app, com variações
  logica.js             lógica pura (dias, marcos, economia, check-in, migração v1→v2)
  pomodoro.js           lógica pura do Pomodoro (ciclo 25/5/15, pausar, pular, parar, histórico por dia, notificação fixa e botões)
  armazem.js            IndexedDB compartilhado com o service worker (estado do Pomodoro e credencial, para os botões da notificação)
  sincronia.js          notificações: inscrição no push e espelho do estado no servidor (falha de rede nunca quebra o app)
  fonts/                Big Shoulders Display e Instrument Sans (woff2, latin)
  sw.js                 service worker (rede primeiro; offline pelo cache; mostra as notificações e trata o clique)
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

## Implantar no celular

```bash
scripts/implantar.sh            # compila, copia jar e public/ e reinicia (celular-wifi, em casa)
scripts/implantar.sh celular    # fora de casa
```

Precisa do apelido ssh configurado e do servidor já instalado em `~/contador` (veja `servidor/README.md`). Antes, rode `node scripts/versao.js` se mudou algo em `public/`; o script recusa seguir com a versão fora de sincronia.

## Testes

```bash
node --test tests/*.test.js                             # unitários (Node 20+)
python3 tests/e2e.py               # ponta a ponta no Chromium (Playwright para Python)
python3 tests/e2e_push.py          # notificações: Chromium + servidor Kotlin de verdade (usa servidor/target/contador.jar)
```

O e2e cobre os dois tipos (parar e manter), deslize, recomeço, check-in, editar, excluir, ajustes, migração v1→v2, dados corrompidos, persistência e offline. Passe uma pasta como argumento para salvar capturas de tela.

O `e2e_push.py` sobe o jar com chaves VAPID temporárias e um banco temporário. Só a inscrição do navegador é simulada (o Chromium headless não fala com o FCM); o push chega ao service worker pelo CDP. Nenhum serviço de push real é contatado. Precisa do `mvn -DskipTests package` em `servidor/` antes (ele compila se o jar não existir).
