# Servidor do Contador de Dias

Kotlin + Ktor (CIO) + SQLite. Serve o app em `/contador/`, guarda o estado de cada dispositivo e envia **um aviso por dia** por Web Push.

## Comandos

```bash
mvn test                      # 200 testes (precisa de Node só para regerar as fixtures)
mvn -DskipTests package       # gera target/contador.jar (fat jar, ~18 MB)
java -jar target/contador.jar gerar-vapid     # imprime as chaves VAPID para o .env
java -jar target/contador.jar gerar-admin     # imprime o ADMIN para o .env
java -Xmx160m -jar target/contador.jar        # sobe o servidor (lê o .env da pasta atual)
```

Configuração: copie `exemplo.env` para `.env`. Sem as chaves VAPID o servidor sobe, mas sem enviar notificações. Com `ADMIN` no `.env` (mín. 16 caracteres), `POST /dispositivos` exige o cabeçalho `X-Convite`: ou a chave de administrador (o aparelho vira administrador) ou um **convite individual de uso único** (20 símbolos, vale 7 dias, só o hash é guardado). O administrador gera, lista e revoga convites nos Ajustes do app. Sem `ADMIN` o cadastro é aberto, não há convites e o servidor avisa no log.

## API (`/contador/api`)

| Método e caminho | O que faz |
|---|---|
| `GET /saude` | `{ok, push}` |
| `GET /chave-publica` | chave VAPID pública, para o `pushManager.subscribe` |
| `POST /dispositivos` | cria um dispositivo anônimo: `{id, segredo}` (só o hash do segredo é guardado). Com `ADMIN` configurado exige `X-Convite`: 403 igual para ausente, errado, usado, revogado e expirado; 10 tentativas por hora por endereço, certas ou erradas |
| `PUT /dispositivos/{id}/estado` | sincroniza as contagens e preferências (JSON do modelo v2) |
| `PUT /dispositivos/{id}/push` | grava a inscrição (`{endpoint, keys:{p256dh, auth}}`) |
| `DELETE /dispositivos/{id}` | apaga tudo do dispositivo |
| `PUT /dispositivos/{id}/alarme` | alarme do Pomodoro: `{em, fase, proxima}` (`em` = fim da fase em ms, entre 1 min atrás e 2 h à frente; fases `foco`, `pausa`, `longa`). Substitui o anterior. 409 sem inscrição de push; 120 alterações por hora por aparelho |
| `DELETE /dispositivos/{id}/alarme` | cancela o alarme (idempotente) |
| `GET /dispositivos/{id}/convites` | só administrador (403 para os outros): lista os convites, sem os códigos |
| `POST /dispositivos/{id}/convites` | só administrador: `{nome}` → `{id, codigo, expiraEm}`; o código só aparece nesta resposta; no máximo 10 pendentes, 20 por hora |
| `DELETE /dispositivos/{id}/convites/{convite}` | só administrador: revoga o convite; se já foi usado, apaga o aparelho que o usou |

As rotas com `{id}` exigem `Authorization: Bearer <segredo>`. Id desconhecido e segredo errado dão o mesmo 401.

## Segurança

- Endpoint de push só em HTTPS e só de serviços conhecidos (FCM, Mozilla, Apple, Windows): evita que o servidor seja induzido a chamar URLs internas (SSRF). Redirecionamentos não são seguidos.
- Corpo limitado (256 KB), validação de tudo que chega, SQL parametrizado. Limite por IP: 240 req/min na API e 5 dispositivos novos por hora; IPv6 conta por bloco /64. O IP real vem do `CF-Connecting-IP`, só aceito quando a conexão vem de 127.0.0.1 e só se for mesmo um IP.
- Cota: `MAX_DISPOSITIVOS` (10 000) e `MAX_BYTES_MB` (200, soma dos estados guardados). Dispositivos que nunca foram usados (1 dia) ou ficam sem inscrição de push e parados (14 dias) são apagados.
- O servidor guarda só o que o aviso usa: notas, deslizes e o detalhe do histórico não são guardados.
- Arquivos do app com `Cache-Control: no-cache` e cabeçalhos `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, COOP/CORP e **CSP** (só scripts do próprio site; o script do tema entra pelo hash, recalculado quando o `index.html` muda). Não pode haver `style=`, `onclick=` nem outro `<script>` embutido no `index.html`: `RotasTest` e `tests/e2e_push.py` conferem.
- Dispositivos sem sincronizar há 365 dias são apagados (LGPD). Apagar é de verdade: `secure_delete` e checkpoint do WAL (o texto não fica no arquivo do banco). Logs não trazem segredos nem endpoints.

## Agendador

Roda a cada minuto. Envia para o dispositivo se já passou da `horaResumo` (no fuso dele), ainda estamos na janela de 3 h, e o dia não recebeu o aviso. O dia só conta como enviado após o sucesso; erros temporários repetem a cada 5 min (até 5 vezes); 404/410 removem a inscrição. `TTL` de 3 h e `Topic: resumo-diario`.

### Alarme do Pomodoro

Segunda rotina, a cada 15 s (`AgendadorAlarmes`): manda o push dos alarmes que venceram, com `tag: pomodoro`, `url: ./#pomodoro`, TTL de 2 min e sem nenhum nome de contagem. Alarme vencido há mais que o TTL é descartado sem enviar (um "acabou o foco" atrasado só atrapalha); falha repete a cada rodada, até 3 vezes; 404/410 removem a inscrição e o alarme. O app cancela o alarme ao pausar, pular, parar ou concluir a fase com a tela aberta.

## Decisões

- **Web Push implementado com a JVM pura** (RFC 8291 e VAPID/RFC 8292), sem BouncyCastle nem cliente HTTP assíncrono: jar menor no celular. Conferido contra a biblioteca `web-push` (usada só nos testes).
- **`sqlite-jdbc` fixado em 3.50.3.0**: as versões seguintes deixaram de trazer a biblioteca nativa para Android (Termux). Só ficam no jar as nativas de Linux comum e de Android.
- **Kotlin e JS dão o mesmo resultado**: `logica.js` e `textos.js` são a referência; `node scripts/fixtures.js` gera ~8,8 mil casos (7 fusos, horário de verão, 29/02) em `src/test/resources/fixtures-js.json` e `ParidadeJsTest` confere. Mudou uma regra ou frase? Rode o script de novo.
