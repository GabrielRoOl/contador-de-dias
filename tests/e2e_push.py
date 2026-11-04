"""Teste de ponta a ponta das notificações: Chromium + servidor Kotlin de verdade (jar, SQLite, API, arquivos do app).
Uso: python3 tests/e2e_push.py [pasta_para_capturas]

O que NÃO é de verdade: o Chromium headless não fala com o FCM, então só PushManager.subscribe/getSubscription são trocados por
uma inscrição falsa (chaves P-256 reais, endpoint de aparência FCM). O envio servidor -> serviço de push é coberto pelos testes
Kotlin; aqui a entrega ao service worker usa o CDP (ServiceWorker.deliverPushMessage). Nenhum serviço de push real é contatado:
o horário do resumo fica 12 h longe de agora, então o agendador nunca dispara."""
import datetime, json, os, shutil, socket, sqlite3, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

RAIZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
PUB = os.path.abspath(os.path.join(RAIZ, 'public'))
SERVIDOR = os.path.abspath(os.path.join(RAIZ, 'servidor'))
JAR = os.path.join(SERVIDOR, 'target', 'contador.jar')
CAPTURAS = sys.argv[1] if len(sys.argv) > 1 else None
ok = True


def check(cond, msg):
    global ok
    print(('OK    ' if cond else 'FALHA ') + msg)
    ok = ok and bool(cond)


def foto(pg, nome):
    if CAPTURAS:
        os.makedirs(CAPTURAS, exist_ok=True)
        pg.screenshot(path=os.path.join(CAPTURAS, nome + '.png'), full_page=True)


BOMBA = [None]  # o Playwright síncrono só processa eventos do CDP dentro de chamadas dele: sleep sozinho não basta


def espera(cond, tempo=8.0, passo=0.1):
    fim = time.time() + tempo
    while time.time() < fim:
        v = cond()
        if v:
            return v
        time.sleep(passo)
        if BOMBA[0]:
            BOMBA[0]()
    return cond()


def porta_livre():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


# ---------- servidor de verdade ----------
if not os.path.exists(JAR):
    subprocess.run(['mvn', '-B', '-q', '-DskipTests', 'package'], cwd=SERVIDOR, check=True)
TMP = tempfile.mkdtemp()
vapid = subprocess.run(['java', '-jar', JAR, 'gerar-vapid'], capture_output=True, text=True, check=True).stdout
with open(os.path.join(TMP, '.env'), 'w') as f:
    f.write(vapid)
PORTA = porta_livre()
BASE = f'http://127.0.0.1:{PORTA}/contador/'
DB = os.path.join(TMP, 'contador.db')
AMBIENTE = dict(os.environ, PORT=str(PORTA), BIND='127.0.0.1', STATIC_DIR=PUB, DB_PATH=DB)
servidor = None


def subir():
    global servidor
    servidor = subprocess.Popen(['java', '-Xmx160m', '-jar', JAR], cwd=TMP, env=AMBIENTE, stdout=open(os.path.join(TMP, 'srv.log'), 'a'), stderr=subprocess.STDOUT)
    def no_ar():
        try:
            return json.load(urllib.request.urlopen(BASE + 'api/saude', timeout=1))
        except Exception:
            return None
    return espera(no_ar, 30, 0.3)


def derrubar():
    global servidor
    servidor.terminate(); servidor.wait(10); servidor = None


def linhas(sql, *args):
    con = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    try:
        return con.execute(sql, args).fetchall()
    finally:
        con.close()


def dispositivos():
    return linhas('SELECT id, push_endpoint, push_p256dh, push_auth, hora_resumo, fuso, estado_json FROM dispositivos')


# ---------- inscrição falsa e permissão como no Chrome do celular ----------
INIT = r"""
(() => {
  const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let perm = localStorage.getItem('__perm') || 'default';
  Object.defineProperty(Notification, 'permission', { get: () => perm });
  window.__pedidos = 0; window.__desinscricoes = 0; window.__inscricoes = 0;
  Notification.requestPermission = function () {
    window.__pedidos++; perm = localStorage.getItem('__resposta') || 'granted'; localStorage.setItem('__perm', perm);
    return Promise.resolve(perm);
  };
  function montar(d) {
    return { endpoint: d.endpoint, expirationTime: null, options: { applicationServerKey: new Uint8Array(d.chave).buffer },
      toJSON() { return { endpoint: d.endpoint, expirationTime: null, keys: { p256dh: d.p256dh, auth: d.auth } }; },
      unsubscribe() { localStorage.removeItem('__sub'); window.__desinscricoes++; return Promise.resolve(true); } };
  }
  PushManager.prototype.getSubscription = function () {
    const d = JSON.parse(localStorage.getItem('__sub') || 'null');
    return Promise.resolve(d ? montar(d) : null);
  };
  PushManager.prototype.subscribe = async function (o) {
    const par = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const d = { endpoint: 'https://fcm.googleapis.com/fcm/send/falso-' + Math.random().toString(36).slice(2),
      p256dh: b64u(await crypto.subtle.exportKey('raw', par.publicKey)), auth: b64u(crypto.getRandomValues(new Uint8Array(16))),
      chave: [...new Uint8Array(o.applicationServerKey)] };
    localStorage.setItem('__sub', JSON.stringify(d)); window.__inscricoes++;
    return montar(d);
  };
})();
"""


def novo_contexto(b, resposta=None):
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
    ctx.grant_permissions(['notifications'], origin=f'http://127.0.0.1:{PORTA}')  # o SW precisa para showNotification
    ctx.add_init_script(INIT)
    if resposta:
        ctx.add_init_script(f"localStorage.setItem('__resposta', '{resposta}')")
    return ctx


def abrir(ctx):
    pg = ctx.new_page()
    erros = []
    pg.on('pageerror', lambda e: erros.append(str(e)))
    pg.goto(BASE)
    pg.wait_for_selector('.card.example, .card')
    pg.evaluate('navigator.serviceWorker.ready')
    return pg, erros


def nova_contagem(pg, nome, custo=None):
    pg.click('#toggle-form')
    pg.check('input[name=f-tipo][value=manter]', force=True)
    pg.fill('#f-name', nome)
    pg.click('#new-form button[type=submit]')
    pg.wait_for_function("!document.getElementById('nova').open")


def ajustes(pg):
    if not pg.evaluate("document.getElementById('ajustes').open"):
        pg.click('#toggle-ajustes')


def texto_notif(pg):
    return pg.locator('#a-notif-texto').inner_text()


def hora_longe():
    return (datetime.datetime.now() + datetime.timedelta(hours=12)).strftime('%H:%M')


def hora_longe_2():
    return (datetime.datetime.now() + datetime.timedelta(hours=14)).strftime('%H:%M')


def notificacoes(pg):
    return pg.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.map(n => ({titulo: n.title, corpo: n.body, tag: n.tag, url: n.data && n.data.url, icone: n.icon, badge: n.badge})))")


try:
    check(subir() is not None, 'servidor Kotlin no ar')
    check(json.load(urllib.request.urlopen(BASE + 'api/saude'))['push'] is True, 'servidor tem as chaves VAPID (push ativo)')
    with sync_playwright() as p:
        b = p.chromium.launch(channel='chromium')  # headless novo: o headless-shell nega Notification.permission ao service worker

        # =============== fluxo principal ===============
        ctx = novo_contexto(b)
        pg, erros = abrir(ctx)
        check(pg.evaluate('window.__pedidos') == 0, 'abrir o app não pede permissão')
        check(len(dispositivos()) == 0, 'abrir o app não contata a API de dispositivos')

        nova_contagem(pg, 'Estudar inglês')
        ajustes(pg)
        pg.fill('#a-hora', hora_longe()); pg.dispatch_event('#a-hora', 'change')
        check(pg.evaluate('window.__pedidos') == 0 and 'resumo por dia' in texto_notif(pg), 'Ajustes mostra o estado desligado, sem pedir nada')
        foto(pg, '20-ativar-desligado')

        pg.click('#a-notif-botao')
        check(espera(lambda: texto_notif(pg).startswith('Ativas.')), 'toque em "Ativar notificações" leva ao estado ativo')
        check(pg.evaluate('window.__pedidos') == 1, 'a permissão foi pedida uma vez, após o toque')
        check(pg.locator('#a-notif-botao').inner_text() == 'Desativar', 'botão vira "Desativar"')
        foto(pg, '21-ativo')
        cred = json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:push')"))
        check(cred['ativo'] is True and len(cred['id']) > 8 and len(cred['segredo']) > 16, 'credenciais guardadas no aparelho')
        linha = dispositivos()
        check(len(linha) == 1 and linha[0][0] == cred['id'], 'um dispositivo criado no servidor')
        sub = json.loads(pg.evaluate("localStorage.getItem('__sub')"))
        check(linha[0][1] == sub['endpoint'] and linha[0][2] == sub['p256dh'] and linha[0][3] == sub['auth'], 'inscrição de push gravada no servidor')
        estado = json.loads(linha[0][6])
        check([c['nome'] for c in estado['contagens']] == ['Estudar inglês'] and estado['contagens'][0]['tipo'] == 'manter', 'estado das contagens espelhado no servidor')
        horaA = pg.input_value('#a-hora')
        check(linha[0][4] == horaA, f'horário do resumo no servidor ({linha[0][4]}) = o do app ({horaA})')
        check(linha[0][5] == pg.evaluate('Intl.DateTimeFormat().resolvedOptions().timeZone'), 'fuso do aparelho no servidor')
        check(json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:push')")).get('pendente') is False, 'nada pendente depois de sincronizar')

        # --- espelho contínuo, com debounce
        pg.keyboard.press('Escape')
        nova_contagem(pg, 'Alongar')
        nova_contagem(pg, 'Meditar')
        ok_estado = espera(lambda: len(json.loads(dispositivos()[0][6])['contagens']) == 3)
        check(ok_estado, 'novas contagens chegam ao servidor sozinhas')
        ajustes(pg)
        h2 = hora_longe_2()
        pg.fill('#a-hora', h2); pg.dispatch_event('#a-hora', 'change')
        check(espera(lambda: dispositivos()[0][4] == h2), 'mudar o horário do resumo chega ao servidor')
        check('às ' + h2 in texto_notif(pg), 'o texto de Ajustes mostra o novo horário')
        pg.keyboard.press('Escape')
        pg.locator('.card button[data-act=checkin]').first.click()
        espera(lambda: any(c.get('checkins') for c in json.loads(dispositivos()[0][6])['contagens']))
        est = json.loads(dispositivos()[0][6])
        check(any(c.get('checkins') for c in est['contagens']), 'check-in também é espelhado')

        # --- reabrir: continua ativo, sem pedir permissão nem recriar nada
        pg.reload(); pg.wait_for_selector('.card')
        pg.evaluate('navigator.serviceWorker.ready')
        ajustes(pg)
        check(texto_notif(pg).startswith('Ativas.') and pg.evaluate('window.__pedidos') == 0, 'ao reabrir continua ativo, sem pedir permissão')
        check(len(dispositivos()) == 1, 'reabrir não cria outro dispositivo')
        pg.keyboard.press('Escape')

        # --- service worker: push de verdade (CDP) e clique
        BOMBA[0] = ctx.cookies
        cdp = ctx.new_cdp_session(pg)
        registros = {}
        cdp.on('ServiceWorker.workerRegistrationUpdated', lambda e: registros.update({r['registrationId']: r for r in e['registrations']}))
        cdp.send('ServiceWorker.enable')
        espera(lambda: registros)
        reg_id = next(iter(registros))
        origem = f'http://127.0.0.1:{PORTA}'

        def entregar(dados):
            cdp.send('ServiceWorker.deliverPushMessage', {'origin': origem, 'registrationId': reg_id, 'data': dados})

        carga = {'titulo': 'Contagem de Dias', 'corpo': '10 dias sem refrigerante.', 'tag': 'resumo-diario', 'url': './', 'marco': False}
        entregar(json.dumps(carga))
        lista = espera(lambda: notificacoes(pg))
        check(len(lista) == 1 and lista[0]['titulo'] == 'Contagem de Dias' and lista[0]['corpo'] == '10 dias sem refrigerante.' and lista[0]['tag'] == 'resumo-diario', 'push do servidor vira notificação com o texto certo')
        check(lista[0]['url'] == BASE and lista[0]['icone'].endswith('/icon-192.png') and lista[0]['badge'].endswith('/icon-badge.png'), 'notificação leva a url do app e os ícones')
        carga['corpo'] = '11 dias sem refrigerante. Uma semana inteira!'
        entregar(json.dumps(carga))
        espera(lambda: notificacoes(pg) and notificacoes(pg)[0]['corpo'].startswith('11'))
        lista = notificacoes(pg)
        check(len(lista) == 1 and lista[0]['corpo'].startswith('11'), 'o mesmo tag substitui a notificação anterior')

        entregar('')
        espera(lambda: notificacoes(pg) and 'Abra o app' in notificacoes(pg)[0]['corpo'])
        lista = notificacoes(pg)
        check(len(lista) == 1 and 'Abra o app' in lista[0]['corpo'], 'push vazio ainda mostra uma notificação (genérica)')
        entregar('{isso não é json')
        espera(lambda: notificacoes(pg) and notificacoes(pg)[0]['corpo'] == '{isso não é json')
        check(notificacoes(pg)[0]['corpo'] == '{isso não é json', 'push ilegível não derruba o service worker')
        entregar(json.dumps(carga))
        espera(lambda: notificacoes(pg) and notificacoes(pg)[0]['corpo'].startswith('11'))

        # clique: o CDP não dispara o clique de uma notificação do sistema; entrega o evento ao SW e grava o que ele chamou.
        sw = next(w for w in ctx.service_workers if w.url.endswith('/sw.js'))
        sw.evaluate("""() => {
          self.__registro = [];
          self.clients.openWindow = (u) => { self.__registro.push(['abriu', u]); return Promise.resolve(null); };
          const f = WindowClient.prototype.focus; WindowClient.prototype.focus = function () { self.__registro.push(['focou', this.url]); return Promise.resolve(this); };
        }""")

        def clicar():
            sw.evaluate("""async () => {
              const [n] = await self.registration.getNotifications();
              self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n }));
              await new Promise((r) => setTimeout(r, 400));
            }""")
        try:
            clicar()
            reg = sw.evaluate('self.__registro')
        except Exception as e:
            reg = [['erro', str(e)]]
        check(reg and reg[0][0] == 'focou' and reg[0][1].startswith(BASE), f'clique com o app aberto foca a janela dele ({reg})')
        check(len(notificacoes(pg)) == 0, 'clique fecha a notificação')
        check(len(ctx.pages) == 1, 'clique com o app aberto não abre outra janela')

        # clique com o app fechado: abre ./
        entregar(json.dumps(carga)); espera(lambda: notificacoes(pg))
        sw.evaluate('self.__registro.length = 0')
        pg.close()
        espera(lambda: sw.evaluate("self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => l.length)") == 0)
        clicar()
        reg = sw.evaluate('self.__registro')
        check(reg == [['abriu', BASE]], f'clique com o app fechado abre o app em ./ ({reg})')
        pg = ctx.new_page(); pg.goto(BASE); pg.wait_for_selector('.card'); pg.evaluate('navigator.serviceWorker.ready')

        # --- falha de rede: o app segue, o que mudou fica pendente e chega quando o servidor volta
        derrubar()
        nova_contagem(pg, 'Sem rede')
        time.sleep(2.6)
        c2 = json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:push')"))
        check(c2['pendente'] is True and pg.locator('.card', has=pg.locator('h2', has_text='Sem rede')).count() == 1, 'servidor fora do ar: o app continua funcionando e marca o envio como pendente')
        ajustes(pg)
        pg.click('#a-notif-botao')   # desativar sem servidor
        check(espera(lambda: 'Sem conexão' in pg.locator('#a-notif-erro').inner_text()), 'desativar sem conexão avisa em vez de fingir que apagou')
        check(texto_notif(pg).startswith('Ativas.') and pg.evaluate('window.__desinscricoes') == 0, 'desativar sem conexão mantém tudo como estava')
        foto(pg, '22-desativar-sem-conexao')
        pg.keyboard.press('Escape')
        check(subir() is not None, 'servidor voltou')
        pg.evaluate("window.dispatchEvent(new Event('online'))")
        check(espera(lambda: any(c['nome'] == 'Sem rede' for c in json.loads(dispositivos()[0][6])['contagens'])), 'ao voltar a rede, o que ficou pendente é enviado')
        check(json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:push')"))['pendente'] is False, 'pendência limpa depois do reenvio')

        # --- desativar
        ajustes(pg)
        pg.click('#a-notif-botao')
        check(espera(lambda: 'resumo por dia' in texto_notif(pg) and pg.locator('#a-notif-botao').inner_text() == 'Ativar notificações'), 'desativar volta ao estado desligado')
        check(len(dispositivos()) == 0, 'desativar apaga o dispositivo e as contagens no servidor')
        check(pg.evaluate("localStorage.getItem('contagem-de-dias:push')") is None and pg.evaluate('window.__desinscricoes') == 1, 'desativar apaga a credencial local e a inscrição do navegador')
        check(pg.locator('.card h2', has_text='Estudar inglês').count() == 1, 'as contagens continuam no aparelho depois de desativar')
        foto(pg, '23-desativado')
        pg.keyboard.press('Escape')

        # --- reativar cria um dispositivo novo
        ajustes(pg)
        pg.click('#a-notif-botao')
        check(espera(lambda: texto_notif(pg).startswith('Ativas.')) and len(dispositivos()) == 1, 'reativar funciona e cria um dispositivo novo')
        check(len(json.loads(dispositivos()[0][6])['contagens']) == 4, 'reativar espelha todas as contagens do aparelho')

        # --- dispositivo apagado no servidor: o app percebe (401) e volta ao estado desligado
        con = sqlite3.connect(DB); con.execute('DELETE FROM dispositivos'); con.commit(); con.close()
        pg.keyboard.press('Escape')
        nova_contagem(pg, 'Depois de apagar')
        check(espera(lambda: pg.evaluate("localStorage.getItem('contagem-de-dias:push')") is None, 10), 'dispositivo apagado no servidor: o app esquece a credencial (401)')
        ajustes(pg)
        check(pg.locator('#a-notif-botao').inner_text() == 'Ativar notificações', 'e oferece ativar de novo')
        pg.keyboard.press('Escape')
        check(not erros, f'sem erros de JavaScript {erros}')
        BOMBA[0] = None
        ctx.close()

        # =============== permissão negada ===============
        antes = len(dispositivos())
        ctx = novo_contexto(b, resposta='denied')
        pg, erros = abrir(ctx)
        ajustes(pg)
        pg.click('#a-notif-botao')
        check(espera(lambda: 'bloqueadas' in texto_notif(pg)), 'permissão negada: mostra o aviso de bloqueio, sem culpa')
        check(pg.locator('#a-notif-botao').is_hidden() and len(dispositivos()) == antes, 'permissão negada: sem botão e sem contatar o servidor')
        foto(pg, '24-bloqueado')
        check(not erros, f'permissão negada sem erros de JavaScript {erros}')
        ctx.close()

        # =============== visual clássico/escuro ===============
        ctx = novo_contexto(b)
        ctx.add_init_script("localStorage.getItem('contagem-de-dias:v2') || localStorage.setItem('contagem-de-dias:v2', JSON.stringify({versao:2,preferencias:{horaResumo:'09:00',fuso:'America/Sao_Paulo',visual:'classico',modo:'escuro'},contagens:[],atualizadoEm:1}))")
        pg, erros = abrir(ctx)
        ajustes(pg)
        pg.fill('#a-hora', hora_longe()); pg.dispatch_event('#a-hora', 'change')
        pg.click('#a-notif-botao')
        espera(lambda: texto_notif(pg).startswith('Ativas.'))
        foto(pg, '25-ativo-classico-escuro')
        check(pg.evaluate("document.documentElement.getAttribute('data-visual')") == 'classico', 'captura no visual clássico escuro')
        pg.click('#a-notif-botao')
        espera(lambda: 'resumo por dia' in texto_notif(pg))
        ctx.close()
        b.close()
    check(not linhas('SELECT 1 FROM dispositivos WHERE push_endpoint IS NOT NULL AND ultimo_envio IS NOT NULL'), 'o servidor nunca tentou enviar um aviso durante o teste')
finally:
    if servidor:
        servidor.terminate()
    shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
