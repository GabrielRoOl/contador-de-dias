"""Teste de ponta a ponta das notificações: Chromium + servidor Kotlin de verdade (jar, SQLite, API, arquivos do app).
Uso: python3 tests/e2e_push.py [pasta_para_capturas]

O que NÃO é de verdade: o Chromium headless não fala com o FCM, então só PushManager.subscribe/getSubscription são trocados por
uma inscrição falsa (chaves P-256 reais, endpoint de aparência FCM). O envio servidor -> serviço de push é coberto pelos testes
Kotlin; aqui a entrega ao service worker usa o CDP (ServiceWorker.deliverPushMessage). Nenhum serviço de push real é contatado:
o horário do resumo fica 12 h longe de agora, então o agendador nunca dispara."""
import datetime, json, os, re, shutil, socket, sqlite3, subprocess, sys, tempfile, time, urllib.request
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


def espera(cond, tempo=25.0, passo=0.1):
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
    ctx.set_default_timeout(90000)  # máquina lenta não pode reprovar o teste
    ctx.grant_permissions(['notifications'], origin=f'http://127.0.0.1:{PORTA}')  # o SW precisa para showNotification
    ctx.add_init_script(INIT)
    if resposta:
        ctx.add_init_script(f"localStorage.setItem('__resposta', '{resposta}')")
    return ctx


VIOLACOES_CSP = []


def CODIGO_NAO_GUARDADO(pg, codigo):
    return codigo not in pg.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))")


def abrir(ctx):
    pg = ctx.new_page()
    erros = []
    pg.on('pageerror', lambda e: erros.append(str(e)))
    pg.on('console', lambda m: VIOLACOES_CSP.append(m.text) if 'Content Security Policy' in m.text else None)
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
    return pg.evaluate("navigator.serviceWorker.ready.then(r => r.getNotifications()).then(l => l.map(n => ({titulo: n.title, corpo: n.body, tag: n.tag, url: n.data && n.data.url, icone: n.icon, badge: n.badge, acoes: (n.actions || []).map(a => a.action), vibrar: n.vibrate ? n.vibrate.length : 0})))")


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

        # --- CSP: o app inteiro funciona sob a política e um script injetado é recusado
        csp = urllib.request.urlopen(BASE).headers.get('Content-Security-Policy') or ''
        check("script-src 'self' 'sha256-" in csp and 'unsafe' not in csp and "object-src 'none'" in csp, 'o servidor envia a CSP com o hash do script do tema')
        check(VIOLACOES_CSP == [], f'CSP: o app em si (scripts, estilos, fontes, API, service worker) não gera nenhuma violação {VIOLACOES_CSP[:2]}')
        pg.evaluate("""() => { const s = document.createElement('script'); s.textContent = 'window.__injetado = 1'; document.head.appendChild(s); }""")
        pg.wait_for_timeout(200)
        check(pg.evaluate('window.__injetado === undefined'), 'CSP: script injetado no DOM não executa')
        pg.evaluate("""() => { const i = document.createElement('img'); i.src = 'x'; i.setAttribute('onerror', 'window.__handler = 1'); document.body.appendChild(i); }""")
        pg.wait_for_timeout(200)
        check(pg.evaluate('window.__handler === undefined'), 'CSP: handler onerror= injetado não executa')
        pg.evaluate("document.querySelectorAll('img[onerror]').forEach(e => e.remove())")

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

        # --- Pomodoro: o alarme no servidor acompanha o relógio do app
        def alarme():
            r = linhas('SELECT alarme_em, alarme_fase, alarme_proxima FROM dispositivos')
            return r[0] if r and r[0][0] is not None else None

        def fim_local():
            return json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:pomodoro')"))['fimEm']

        pg.evaluate("location.hash = '#pomodoro'")
        pg.wait_for_selector('#tela-pomodoro:not([hidden])')
        check(alarme() is None and pg.locator('#pomo-aviso').is_hidden(), 'Pomodoro parado: sem alarme no servidor e sem a dica de ativar notificações')
        pg.click('#pomo-principal')
        check(espera(alarme), 'iniciar o foco cria o alarme no servidor')
        a = alarme()
        check(a[0] == fim_local() and a[1:] == ('foco', 'pausa'), f'o alarme coincide com o fim do foco ({a})')
        check(abs(a[0] - time.time() * 1000 - 25 * 60000) < 15000, 'o alarme está a ~25 minutos')
        check(json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:push')")).get('alarme', {}).get('em') == a[0], 'o app lembra o que o servidor tem')
        pg.click('#pomo-principal')  # Pausar
        check(espera(lambda: alarme() is None), 'pausar cancela o alarme')
        time.sleep(1.2)
        pg.click('#pomo-principal')  # Continuar
        check(espera(alarme) and alarme()[0] == fim_local(), 'continuar cria o alarme de novo, no novo fim')
        pg.click('#pomo-pular')
        check(espera(lambda: alarme() is None), 'pular cancela o alarme')
        pg.click('#pomo-principal')
        check(espera(alarme) and alarme()[1:] == ('pausa', 'foco'), 'a pausa agenda o alarme da pausa, que leva ao foco')
        pg.reload(); pg.wait_for_selector('#tela-pomodoro:not([hidden])')
        pg.evaluate('navigator.serviceWorker.ready')
        time.sleep(1.5)
        check(alarme() is not None and alarme()[0] == fim_local(), 'recarregar com a sessão rodando mantém o mesmo alarme')
        pg.click('#pomo-parar'); pg.click('#pomo-parar')
        check(espera(lambda: alarme() is None), 'parar (com a confirmação) cancela o alarme')
        pg.click('#pomo-principal')
        espera(alarme)
        pg.evaluate("location.hash = ''")
        check(alarme() is not None, 'sair da tela do Pomodoro não cancela o alarme')
        # --- notificação fixa do Pomodoro e botões que agem com o app fechado
        def do_pomo(tag='pomodoro'):
            return [n for n in notificacoes(pg) if n['tag'] == tag]

        check(espera(do_pomo), 'com o foco rodando, a notificação fixa do Pomodoro aparece na bandeja')
        n = do_pomo()[0]
        check(n['titulo'] == 'Foco 1 de 4' and n['corpo'].startswith('Termina às ') and n['acoes'] == ['pausar', 'parar'], f'ela mostra o fim e tem Pausar e Parar ({n["titulo"]}, {n["corpo"]}, {n["acoes"]})')
        check(n['url'] == './#pomodoro', 'tocar nela leva à tela do Pomodoro')
        sw0 = next(w for w in ctx.service_workers if w.url.endswith('/sw.js'))
        BOMBA[0] = ctx.cookies
        cdp0 = ctx.new_cdp_session(pg)
        regs0 = {}
        cdp0.on('ServiceWorker.workerRegistrationUpdated', lambda e: regs0.update({r['registrationId']: r for r in e['registrations']}))
        cdp0.send('ServiceWorker.enable')
        espera(lambda: regs0)
        reg0 = next(iter(regs0))

        def entregar0(dados):
            cdp0.send('ServiceWorker.deliverPushMessage', {'origin': f'http://127.0.0.1:{PORTA}', 'registrationId': reg0, 'data': dados})

        def botao_notificacao(acao):
            sw0.evaluate("""async (acao) => {
              const [n] = await self.registration.getNotifications({ tag: 'pomodoro' });
              self.dispatchEvent(new NotificationEvent('notificationclick', { notification: n, action: acao }));
              await new Promise((r) => setTimeout(r, 300));
            }""", acao)

        def estado_pomo():
            return json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:pomodoro')"))

        pg.evaluate("location.hash = '#pomodoro'")
        pg.wait_for_selector('#tela-pomodoro:not([hidden])')
        botao_notificacao('pausar')
        check(espera(lambda: alarme() is None), 'botão Pausar da notificação cancela o alarme no servidor')
        check(espera(lambda: do_pomo() and '(pausado)' in do_pomo()[0]['titulo'] and do_pomo()[0]['acoes'] == ['continuar', 'parar']), 'a notificação vira "pausado" com Continuar e Parar')
        check(espera(lambda: pg.locator('#pomo-principal').text_content() == 'Continuar' and estado_pomo()['rodando'] is False), 'o app aberto adota o estado pausado feito pela notificação')
        botao_notificacao('continuar')
        check(espera(alarme), 'botão Continuar da notificação recria o alarme')
        check(espera(lambda: pg.locator('#pomo-principal').text_content() == 'Pausar' and estado_pomo()['rodando'] is True and alarme()[0] == estado_pomo()['fimEm']), 'o app adota o estado rodando e o alarme coincide com o fim')
        botao_notificacao('parar')
        check(espera(lambda: alarme() is None and not do_pomo()), 'botão Parar apaga a notificação e o alarme')
        check(espera(lambda: pg.locator('#pomo-principal').text_content() == 'Iniciar foco' and estado_pomo()['rodando'] is False), 'o app volta ao início')

        # aviso de fim com o botão "Iniciar pausa": simula que o foco acabou há 1 minuto com o app em segundo plano
        manter = json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:v2')"))['contagens']
        vazia = next(c for c in manter if not c.get('checkins'))
        pg.evaluate("location.hash = ''")
        agora_ms = int(time.time() * 1000)
        fim = {'versao': 1, 'fase': 'foco', 'ciclo': 1, 'rodando': True, 'fimEm': agora_ms - 60000, 'restanteMs': 1500000, 'contagemId': vazia['id'], 'dias': {}, 'atualizadoEm': agora_ms - 1000}
        pg.evaluate("(e) => Armazem.gravar('pomodoro', e)", fim)
        entregar0(json.dumps({'titulo': 'Foco concluído', 'corpo': 'Hora da pausa de 5 min.', 'tag': 'pomodoro', 'url': './#pomodoro', 'proxima': 'pausa'}))
        check(espera(do_pomo) and do_pomo()[0]['acoes'] == ['iniciar'] and do_pomo()[0]['vibrar'] == 5, 'o aviso de fim traz o botão "Iniciar pausa" e vibra')
        botao_notificacao('iniciar')
        check(espera(alarme) and alarme()[1:] == ('pausa', 'foco'), 'Iniciar pausa agenda o alarme da pausa no servidor, sem abrir o app')
        check(espera(lambda: do_pomo() and do_pomo()[0]['titulo'] == 'Pausa' and do_pomo()[0]['acoes'] == ['pausar', 'parar']), 'a notificação passa a mostrar a pausa em andamento')
        check(espera(lambda: estado_pomo()['fase'] == 'pausa' and estado_pomo()['rodando'] is True and sum(estado_pomo()['dias'].values()) == 1), 'o app adota a pausa em andamento, com o pomodoro contado')
        hoje = datetime.date.today().isoformat()
        est_v2 = lambda: next(c for c in json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:v2')"))['contagens'] if c['id'] == vazia['id'])
        check(espera(lambda: hoje in (est_v2().get('checkins') or [])), 'o foco concluído pela notificação marca o check-in da contagem vinculada')
        # estatísticas sob a CSP: o desenho das barras (altura por CSSOM) não pode gerar violação
        n_csp = len(VIOLACOES_CSP)
        pg.evaluate("location.hash = '#pomodoro'")
        pg.wait_for_selector('#tela-pomodoro:not([hidden])')
        pg.click('#pomo-historico-abrir')
        check(pg.locator('#pomo-stats').is_visible() and pg.locator('#ps-barras .col').count() == 7 and pg.locator('#ps-barras .col.hoje .barra').evaluate('e => e.offsetHeight') > 20, 'estatísticas do pomodoro aparecem com as barras desenhadas')
        check(len(VIOLACOES_CSP) == n_csp, f'estatísticas: nenhuma violação da CSP {VIOLACOES_CSP[n_csp:][:2]}')
        pg.keyboard.press('Escape')
        pg.evaluate("location.hash = ''")
        botao_notificacao('parar')
        check(espera(lambda: alarme() is None and not do_pomo()), 'Parar encerra tudo: sem alarme e sem notificação no fim')
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

        # alarme do Pomodoro chegando pelo push: tag própria (não substitui o resumo) e leva à tela do Pomodoro
        cdp = ctx.new_cdp_session(pg)  # a sessão anterior morreu junto com a página fechada acima
        cdp.send('ServiceWorker.enable')
        entregar(json.dumps({'titulo': 'Foco concluído', 'corpo': 'Hora da pausa de 5 min.', 'tag': 'pomodoro', 'url': './#pomodoro', 'marco': False}))
        lista = espera(lambda: notificacoes(pg))
        check(len(lista) == 1 and lista[0]['tag'] == 'pomodoro' and lista[0]['corpo'] == 'Hora da pausa de 5 min.' and lista[0]['url'] == BASE + '#pomodoro', 'push do alarme do Pomodoro vira notificação que leva a #pomodoro')
        entregar(json.dumps(carga)); espera(lambda: len(notificacoes(pg)) == 2)
        check(sorted(n['tag'] for n in notificacoes(pg)) == ['pomodoro', 'resumo-diario'], 'o aviso do Pomodoro e o resumo diário convivem na bandeja')
        sw.evaluate("async () => { for (const n of await self.registration.getNotifications()) n.close(); }")

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

        # =============== convites individuais ===============
        derrubar()
        ADMIN = 'admin-e2e-0123456789abcdefghij'
        AMBIENTE['ADMIN'] = ADMIN
        check(subir() is not None, 'servidor reiniciado com ADMIN')
        req = urllib.request.Request(BASE + 'api/dispositivos', method='POST')
        try:
            urllib.request.urlopen(req); status = 201
        except urllib.error.HTTPError as e:
            status = e.code
        check(status == 403, 'sem código, a API recusa o cadastro (403)')
        antes = len(dispositivos())

        def ativar_com(pg, codigo=None):
            ajustes(pg)
            pg.fill('#a-hora', hora_longe()); pg.dispatch_event('#a-hora', 'change')
            pg.click('#a-notif-botao')
            if codigo is None:
                return
            check(espera(lambda: 'código de convite' in pg.locator('#a-notif-erro').inner_text()), 'servidor com convites: o app explica que pede o código')
            pg.fill('#a-convite-campo', codigo)
            pg.click('#a-notif-botao')

        # --- administrador
        ctxA = novo_contexto(b)
        pgA, errosA = abrir(ctxA)
        ativar_com(pgA)
        check(espera(lambda: 'código de convite' in pgA.locator('#a-notif-erro').inner_text()), 'sem código: o app explica que o servidor pede convite')
        check(pgA.locator('#a-convite').is_visible() and pgA.evaluate("document.activeElement.id") == 'a-convite-campo', 'o campo de código aparece e recebe o foco')
        check(pgA.get_attribute('#a-convite-campo', 'type') == 'password' and pgA.get_attribute('#a-convite-campo', 'autocomplete') == 'off', 'o campo é de senha e sem autocompletar')
        check(len(dispositivos()) == antes, 'nada foi cadastrado sem o código')
        foto(pgA, '26-convite-pedido')
        pgA.fill('#a-convite-campo', 'codigo-errado-0123456789')
        pgA.click('#a-notif-botao')
        check(espera(lambda: 'inválido' in pgA.locator('#a-notif-erro').inner_text()), 'código errado: mensagem de código inválido')
        pgA.fill('#a-convite-campo', ADMIN)
        pgA.click('#a-notif-botao')
        check(espera(lambda: texto_notif(pgA).startswith('Ativas.')), 'chave de administrador: notificações ativas')
        check(linhas('SELECT admin FROM dispositivos ORDER BY criado_em DESC LIMIT 1')[0][0] == 1, 'o aparelho foi cadastrado como administrador')
        check(espera(lambda: pgA.locator('#a-convites').is_visible()), 'o painel de convites aparece para o administrador')
        check(pgA.locator('#a-convite').is_hidden() and pgA.input_value('#a-convite-campo') == '', 'depois de ativar o campo de código some e é limpo')
        pgA.fill('#a-convite-nome', 'Maria')
        pgA.click('#a-convite-gerar')
        check(espera(lambda: pgA.locator('#a-convite-novo').is_visible()), 'gerar convite mostra o código')
        codigo = pgA.locator('#a-convite-codigo').inner_text()
        check(re.fullmatch(r'([A-HJ-NP-Z2-9]{4}-){4}[A-HJ-NP-Z2-9]{4}', codigo) is not None, f'código no formato esperado ({codigo})')
        check(pgA.locator('#a-convites-lista li', has_text='Maria').count() == 1 and 'Pendente' in pgA.locator('#a-convites-lista').inner_text(), 'a lista mostra o convite pendente')
        guardado = pgA.evaluate("JSON.stringify(Object.fromEntries(Object.entries(localStorage)))")
        check(codigo not in guardado and ADMIN not in guardado, 'nem o código gerado nem a chave de administrador ficam guardados')
        foto(pgA, '27-convite-gerado')

        # --- convidada: usa o código uma vez
        ctxB = novo_contexto(b)
        pgB, errosB = abrir(ctxB)
        ativar_com(pgB, codigo.lower().replace('-', ' '))
        check(espera(lambda: texto_notif(pgB).startswith('Ativas.')), 'convidada: o código (em minúsculas, com espaços) ativa as notificações')
        check(linhas('SELECT admin FROM dispositivos ORDER BY criado_em DESC LIMIT 1')[0][0] == 0, 'o aparelho convidado não é administrador')
        pgB.wait_for_timeout(600)
        check(pgB.locator('#a-convites').is_hidden(), 'aparelho comum não vê o painel de convites')
        check(CODIGO_NAO_GUARDADO(pgB, codigo), 'o código usado não fica guardado no aparelho convidado')
        ctxB.close()

        # --- o mesmo código não vale duas vezes
        ctxC = novo_contexto(b)
        pgC, errosC = abrir(ctxC)
        ativar_com(pgC, codigo)
        check(espera(lambda: 'inválido' in pgC.locator('#a-notif-erro').inner_text()), 'código já usado: convite inválido')
        check(len(dispositivos()) == antes + 2, 'código já usado não cadastra de novo')
        ctxC.close()

        # --- administrador remove o aparelho que usou o convite
        pgA.keyboard.press('Escape'); ajustes(pgA)
        check(espera(lambda: 'Usado' in pgA.locator('#a-convites-lista').inner_text()), 'a lista passa a mostrar o convite como usado')
        pgA.click('#a-convites-lista button'); pgA.click('#a-convites-lista button')
        check(espera(lambda: len(dispositivos()) == antes + 1), 'dois toques em "Remover aparelho" apagam o aparelho convidado')

        # --- convite por link: um toque ativa, sem digitar nada
        pgA.fill('#a-convite-nome', 'Joana')
        pgA.click('#a-convite-gerar')
        check(espera(lambda: pgA.locator('#a-convite-novo').is_visible() and pgA.locator('#a-convite-codigo').inner_text() != codigo), 'segundo convite gerado (Joana)')
        codigo2 = pgA.locator('#a-convite-codigo').inner_text()
        total = len(dispositivos())
        ctxD = novo_contexto(b)
        pgD = ctxD.new_page()
        errosD = []
        pgD.on('pageerror', lambda e: errosD.append(str(e)))
        pgD.goto(BASE + '#convite=' + codigo2.lower().replace('-', ''))
        pgD.wait_for_selector('#convite-cartao:not([hidden])')
        pgD.evaluate('navigator.serviceWorker.ready')
        check(pgD.evaluate('location.hash') == '' and 'convite' not in pgD.url, 'o convite sai do endereço depois de lido')
        check('convidado' in pgD.locator('#convite-cartao').inner_text() and pgD.locator('#convite-ativar').is_visible(), 'o cartão "Você foi convidado" aparece com o botão')
        check(pgD.evaluate("JSON.parse(localStorage.getItem('contagem-de-dias:convite')).codigo") == codigo2, 'o código fica guardado só até ser usado')
        check(pgD.evaluate('window.__pedidos') == 0 and len(dispositivos()) == total, 'abrir o link não pede permissão nem cadastra nada')
        foto(pgD, '28-convite-link')
        pgD.click('#convite-ativar')
        check(espera(lambda: pgD.locator('#convite-cartao').is_hidden()), 'um toque ativa os avisos e o cartão some')
        check(pgD.evaluate('window.__pedidos') == 1, 'a permissão foi pedida uma vez, após o toque')
        check(len(dispositivos()) == total + 1 and linhas('SELECT admin FROM dispositivos ORDER BY criado_em DESC LIMIT 1')[0][0] == 0, 'o aparelho convidado pelo link foi cadastrado, sem poder de administrador')
        check(pgD.evaluate("localStorage.getItem('contagem-de-dias:convite')") is None and CODIGO_NAO_GUARDADO(pgD, codigo2), 'depois de usar, o código não fica guardado')
        ctxD.close()

        # --- o mesmo link de novo: convite usado, mensagem clara e nada guardado
        ctxE = novo_contexto(b)
        pgE = ctxE.new_page()
        pgE.goto(BASE + '#convite=' + codigo2)
        pgE.wait_for_selector('#convite-cartao:not([hidden])')
        pgE.click('#convite-ativar')
        check(espera(lambda: 'não vale mais' in pgE.locator('#convite-erro').inner_text()), 'link já usado: o cartão explica que o convite não vale mais')
        check(pgE.evaluate("localStorage.getItem('contagem-de-dias:convite')") is None and len(dispositivos()) == total + 1, 'convite inválido é descartado e nada é cadastrado')
        # endereço com convite malformado: nada aparece e o endereço é limpo
        pgE.goto(BASE + '#convite=isso-nao-e-um-convite'); pgE.reload()
        pgE.wait_for_selector('.card')
        check(pgE.evaluate('location.hash') == '' and pgE.locator('#convite-cartao').is_hidden() or 'não vale mais' in pgE.locator('#convite-cartao').inner_text(), 'convite malformado não vira cartão')
        ctxE.close()
        check(not errosA and not errosB and not errosC and not errosD, f'convites sem erros de JavaScript {errosA + errosB + errosC + errosD}')
        ctxA.close()
        b.close()
    check(not linhas('SELECT 1 FROM dispositivos WHERE push_endpoint IS NOT NULL AND ultimo_envio IS NOT NULL'), 'o servidor nunca tentou enviar um aviso durante o teste')
finally:
    if servidor:
        servidor.terminate()
    shutil.rmtree(TMP, ignore_errors=True)
sys.exit(0 if ok else 1)
