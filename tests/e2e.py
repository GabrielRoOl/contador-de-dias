"""Teste de ponta a ponta no Chromium (Playwright para Python).
Uso: python3 tests/e2e.py [pasta_para_capturas]"""
import datetime, json, os, shutil, subprocess, sys, tempfile, time
from playwright.sync_api import sync_playwright

PUB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
CAPTURAS = sys.argv[1] if len(sys.argv) > 1 else None
URL = 'http://127.0.0.1:8765/'
ok = True


def check(cond, msg):
    global ok
    print(('OK    ' if cond else 'FALHA ') + msg)
    ok = ok and bool(cond)


def dias_atras(n):
    return (datetime.date.today() - datetime.timedelta(days=n)).isoformat()


def foto(pg, nome):
    if CAPTURAS:
        os.makedirs(CAPTURAS, exist_ok=True)
        pg.screenshot(path=os.path.join(CAPTURAS, nome + '.png'), full_page=True)


def nova_contagem(pg, tipo, nome, data=None, custo=None):
    if not pg.evaluate("document.getElementById('nova').open"):
        pg.click('#toggle-form')
    pg.check(f'input[name=f-tipo][value={tipo}]', force=True)
    pg.fill('#f-name', nome)
    if tipo == 'parar':
        pg.fill('#f-date', data)
        pg.fill('#f-time', '00:00')
        if custo:
            pg.fill('#f-custo', custo)
    pg.click('#new-form button[type=submit]')
    pg.wait_for_function("!document.getElementById('nova').open")


def card(pg, nome):
    return pg.locator('.card', has=pg.locator('h2', has_text=nome))


srv = subprocess.Popen(['python3', '-m', 'http.server', '8765', '--directory', PUB, '--bind', '127.0.0.1'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        pg = ctx.new_page()
        errs, falhas = [], []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.on('requestfailed', lambda r: falhas.append(r.url))

        # --- primeira abertura
        pg.goto(URL)
        pg.wait_for_selector('.card.example')
        check(pg.locator('.card.example .aneis .arco').count() == 3 and pg.locator('.card.example .legenda li').count() == 3, 'exemplo mostra os 3 anéis (semana, mês, ano) e a legenda')
        check('R$' in pg.locator('.card.example .economia').inner_text(), 'exemplo mostra economia')
        fams = pg.evaluate("Promise.all([...document.fonts].map(f=>f.load().then(()=>f.status)))")
        check(len(fams) == 4 and all(s == 'loaded' for s in fams), '4 fontes carregadas')
        check(pg.evaluate("typeof Logica==='object' && typeof Textos==='object'"), 'Logica e Textos carregados')
        foto(pg, '01-primeira-abertura')
        pg.evaluate("navigator.serviceWorker.ready")
        pg.reload(); pg.wait_for_selector('.card.example')

        # --- "Nova contagem" é um <dialog> nativo
        aberto = lambda: pg.evaluate("document.getElementById('nova').open")
        check(pg.evaluate("document.getElementById('nova').tagName") == 'DIALOG' and not aberto(), 'nova contagem é um <dialog> e começa fechado')
        pg.click('#toggle-form')
        check(aberto() and pg.evaluate("document.getElementById('nova').matches(':modal')"), 'botão abre o dialog como modal')
        check(pg.evaluate("document.activeElement.id") == 'f-name', 'foco vai para o campo de nome')
        pg.keyboard.press('Escape')
        check(not aberto() and pg.locator('.card.example').count() == 1, 'Esc fecha sem criar nada')
        pg.click('#toggle-form')
        pg.click('#new-form button[type=submit]')
        check(aberto() and 'nome' in pg.locator('#f-error').inner_text(), 'nome vazio: erro e o dialog continua aberto')
        pg.locator('input[name=f-tipo][value=manter]').click()
        check(pg.locator('#f-name-label').text_content() == 'O que você mantém' and pg.locator('#f-date').is_hidden(), 'tipo hábito troca o rótulo e esconde a data')
        pg.locator('input[name=f-tipo][value=parar]').click()
        foto(pg, '00-nova-contagem')
        pg.mouse.click(5, 5)
        check(not aberto(), 'clicar fora fecha')
        pg.click('#toggle-form'); pg.get_by_role('button', name='Fechar', exact=True).click()
        check(not aberto(), 'X fecha')

        # --- parar: criar com data passada e custo
        nova_contagem(pg, 'parar', 'refrigerante', dias_atras(7), '6,50')
        c = card(pg, 'refrigerante')
        check(c.locator('.num').inner_text() == '7', 'parar: 7 dias a partir de data passada')
        check('7 dias sem refrigerante' in c.locator('.marco').inner_text(), 'marco de semana no dia 7: ' + c.locator('.marco').inner_text())
        check('R$ 45,50' in c.locator('.economia').inner_text().replace('\xa0', ' '), 'economia 7 x 6,50 = R$ 45,50')
        check(c.locator('.lg-val').all_inner_texts() == ['0/7', '7/30', '7/365'], f"anéis {c.locator('.lg-val').all_inner_texts()}")
        check('Próxima marca: 2 semanas' in c.locator('.next').inner_text(), 'próxima marca: ' + c.locator('.next').inner_text())
        foto(pg, '02-parar-marco-semana')

        # --- número grande cabe dentro dos anéis (3 e 4 dígitos)
        for dias, rotulo in ((400, '3 dígitos'), (1200, '4 dígitos')):
            nova_contagem(pg, 'parar', f'antigo{dias}', dias_atras(dias))
            g = card(pg, f'antigo{dias}')
            caixa = g.locator('.aneis').bounding_box()
            centro = g.locator('.centro').evaluate("el => { const r = document.createRange(); r.selectNodeContents(el); const b = r.getBoundingClientRect(); return [b.width, b.height]; }")
            check(centro[0] <= caixa['width'] * (160 / 280) and centro[1] <= caixa['height'] * (160 / 280),
                  f'{rotulo}: conteúdo cabe no anel interno ({centro[0]:.0f}x{centro[1]:.0f} em {caixa["width"]:.0f})')
            if dias == 1200:
                foto(pg, '02b-quatro-digitos')
            g.get_by_role('button', name='Excluir').click(); g.get_by_role('button', name='Excluir').click()

        # --- deslize não zera
        c.get_by_role('button', name='Deslize').click()
        foto(pg, '03-deslize-form')
        c.locator('input[id^=ds-]').fill('festa de aniversário')
        c.get_by_role('button', name='Registrar').click()
        c = card(pg, 'refrigerante')
        check(c.locator('.num').inner_text() == '7', 'deslize não zera a contagem')
        check(c.locator('.stats dd').nth(2).inner_text() == '1', 'deslizes = 1')
        c.get_by_role('button', name='Histórico').click()
        check('festa de aniversário' in c.locator('.historico').inner_text(), 'histórico mostra a nota do deslize')
        foto(pg, '04-historico')

        # --- recomeço ontem
        c.get_by_role('button', name='Recomecei').click()
        foto(pg, '05-recomeco-form')
        c.locator('input[value=ontem]').click()
        c.locator('input[id^=rn-]').fill('estresse')
        c.get_by_role('button', name='Recomeçar').click()
        c = card(pg, 'refrigerante')
        check(c.locator('.num').inner_text() == '1', 'recomeço ontem: nova contagem com 1 dia')
        st = c.locator('.stats dd').all_inner_texts()
        check(st[0] == '6 dias' and st[1] == '7 dias' and st[3] == '2', f'recorde 6, total 7, 2 tentativas: {st}')
        check(c.locator('.retomada').count() == 1 and '6 dias' in c.locator('.retomada').inner_text(),
              'texto de retomada cita o recorde: ' + c.locator('.retomada').inner_text())
        foto(pg, '06-pos-recomeco')

        # recomeço antes do início é recusado
        c.get_by_role('button', name='Recomecei').click()
        c.locator('input[value=outro]').click()
        c.locator('input[id^=rd-]').fill(dias_atras(30))
        c.get_by_role('button', name='Recomeçar').click()
        check('antes' in card(pg, 'refrigerante').locator('.error').inner_text(), 'recomeço antes do início é recusado')
        card(pg, 'refrigerante').get_by_role('button', name='Cancelar').click()

        # --- manter
        nova_contagem(pg, 'manter', 'estudando inglês')
        m = card(pg, 'estudando inglês')
        check(m.locator('.num').inner_text() == '0', 'manter começa em 0')
        foto(pg, '07-manter-novo')
        m.get_by_role('button', name='Hoje eu fiz').click()
        m = card(pg, 'estudando inglês')
        check(m.locator('.num').inner_text() == '1' and 'Feito hoje' in m.inner_text(), 'check-in: 1 dia seguido, "Feito hoje"')
        m.get_by_role('button', name='Desfazer').click()
        m = card(pg, 'estudando inglês')
        check(m.locator('.num').inner_text() == '0' and m.get_by_role('button', name='Hoje eu fiz').count() == 1, 'desfazer check-in volta a 0')
        m.get_by_role('button', name='Hoje eu fiz').click()
        foto(pg, '08-manter-feito')

        # --- ajustes: engrenagem abre uma janela (dialog)
        check(pg.locator('#toggle-ajustes').get_attribute('aria-label') == 'Ajustes' and pg.locator('#toggle-ajustes svg').count() == 1, 'engrenagem é só um ícone, com rótulo acessível')
        box = pg.locator('#toggle-ajustes').bounding_box()
        check(box['x'] + box['width'] > 390 - 40, 'engrenagem no canto superior direito')
        check(not pg.evaluate("document.getElementById('ajustes').open"), 'janela de ajustes começa fechada')
        pg.click('#toggle-ajustes')
        check(pg.evaluate("document.getElementById('ajustes').open"), 'clicar na engrenagem abre a janela')
        pg.fill('#a-hora', '07:30')
        pg.dispatch_event('#a-hora', 'change')
        v2 = json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:v2')"))
        check(v2['preferencias']['horaResumo'] == '07:30' and v2['versao'] == 2, 'horário do resumo salvo no modelo v2')
        foto(pg, '09-ajustes')
        pg.get_by_role('button', name='Concluído').click()
        check(not pg.evaluate("document.getElementById('ajustes').open"), '"Concluído" fecha a janela')
        pg.click('#toggle-ajustes'); pg.keyboard.press('Escape')
        check(not pg.evaluate("document.getElementById('ajustes').open"), 'Esc fecha a janela')
        pg.click('#toggle-ajustes'); pg.mouse.click(5, 5)
        check(not pg.evaluate("document.getElementById('ajustes').open"), 'clicar fora fecha a janela')

        # --- visual: Futurista (padrão) e Clássico
        check(pg.evaluate("document.documentElement.getAttribute('data-visual')") == 'futurista', 'visual padrão é futurista')
        check(pg.evaluate("getComputedStyle(document.querySelector('.card'), '::before').display") == 'block', 'futurista: cantos de HUD visíveis')
        check(pg.locator('.marcas').first.evaluate("e => getComputedStyle(e).display") != 'none', 'futurista: marcas do mostrador visíveis')
        pg.click('#toggle-ajustes')
        check(pg.locator('input[name=a-visual][value=futurista]').is_checked(), 'ajustes: futurista marcado')
        pg.locator('input[name=a-visual][value=classico]').click()
        check(pg.evaluate("document.documentElement.getAttribute('data-visual')") == 'classico', 'clássico aplicado na hora')
        check(json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:v2')"))['preferencias']['visual'] == 'classico', 'clássico salvo nas preferências')
        pg.keyboard.press('Escape')
        check(pg.evaluate("getComputedStyle(document.querySelector('.card'), '::before').display") == 'none', 'clássico: sem cantos de HUD')
        check(pg.locator('.marcas').first.evaluate("e => getComputedStyle(e).display") == 'none', 'clássico: sem marcas de mostrador')
        check(pg.evaluate("getComputedStyle(document.body).backgroundImage") == 'none', 'clássico: sem grade no fundo')
        check(pg.evaluate("getComputedStyle(document.querySelector('.btn.primary')).boxShadow") in ('none', 'rgba(0, 0, 0, 0) 0px 0px 0px 0px'), 'clássico: botão sem brilho')
        check(card(pg, 'estudando inglês').locator('.aneis .arco').count() == 3, 'clássico mantém os 3 anéis')
        foto(pg, '12-classico-claro')
        pg.emulate_media(color_scheme='dark'); foto(pg, '12-classico-escuro'); pg.emulate_media(color_scheme='light')
        pg.click('#toggle-ajustes'); foto(pg, '12-classico-ajustes'); pg.keyboard.press('Escape')
        pg.reload(); pg.wait_for_selector('.card h2')
        check(pg.evaluate("document.documentElement.getAttribute('data-visual')") == 'classico', 'clássico persiste ao recarregar')
        pg.click('#toggle-ajustes')
        check(pg.locator('input[name=a-visual][value=classico]').is_checked(), 'ajustes: clássico marcado após recarregar')
        pg.locator('input[name=a-visual][value=futurista]').click(); pg.keyboard.press('Escape')
        check(pg.evaluate("document.documentElement.getAttribute('data-visual')") == 'futurista', 'volta ao futurista')

        # --- modo: automático, claro e escuro
        fundo = lambda: pg.evaluate("getComputedStyle(document.body).backgroundColor")
        tema = lambda: pg.evaluate("document.documentElement.getAttribute('data-theme')")
        barra = lambda: pg.evaluate("document.querySelector('meta[name=theme-color]').getAttribute('content')")
        pg.emulate_media(color_scheme='light')
        claro_auto = fundo()
        pg.click('#toggle-ajustes')
        check(pg.locator('input[name=a-modo][value=auto]').is_checked(), 'modo padrão: automático')
        pg.locator('input[name=a-modo][value=escuro]').click()
        escuro = fundo()
        check(tema() == 'dark' and escuro != claro_auto, 'escuro forçado com o aparelho em claro')
        check(json.loads(pg.evaluate("localStorage.getItem('contagem-de-dias:v2')"))['preferencias']['modo'] == 'escuro', 'modo escuro salvo')
        check(barra() == escuro, 'cor da barra do navegador acompanha o modo')
        foto(pg, '14-modo-escuro-forcado')
        pg.emulate_media(color_scheme='dark')
        pg.locator('input[name=a-modo][value=claro]').click()
        check(tema() == 'light' and fundo() == claro_auto, 'claro forçado com o aparelho em escuro')
        foto(pg, '14-modo-claro-forcado')
        pg.keyboard.press('Escape'); pg.reload(); pg.wait_for_selector('.card h2')
        check(tema() == 'light' and fundo() == claro_auto, 'modo claro persiste ao recarregar')
        pg.click('#toggle-ajustes')
        check(pg.locator('input[name=a-modo][value=claro]').is_checked(), 'ajustes: claro marcado após recarregar')
        pg.locator('input[name=a-modo][value=auto]').click()
        check(tema() is None and fundo() == escuro, 'automático volta a seguir o aparelho (escuro)')
        pg.emulate_media(color_scheme='light')
        check(fundo() == claro_auto, 'automático acompanha a troca do aparelho para claro')
        pg.keyboard.press('Escape')

        # --- persistência e offline
        pg.reload(); pg.wait_for_selector('.card h2')
        check(card(pg, 'refrigerante').count() == 1 and card(pg, 'estudando inglês').locator('.num').inner_text() == '1', 'persiste ao recarregar')
        ctx.set_offline(True)
        pg.reload(); pg.wait_for_selector('.card h2')
        check(card(pg, 'refrigerante').count() == 1, 'abre offline')
        ctx.set_offline(False)

        # --- editar e excluir
        c = card(pg, 'refrigerante')
        c.get_by_role('button', name='Editar').click()
        c.locator('input[id^=en-]').fill('refri')
        c.locator('input[id^=ec-]').fill('')
        c.get_by_role('button', name='Salvar').click()
        c = card(pg, 'refri')
        check(c.count() == 1 and c.locator('.economia').count() == 0, 'editar nome e remover custo')
        c.get_by_role('button', name='Excluir').click()
        c.get_by_role('button', name='Excluir').click()
        check(card(pg, 'refri').count() == 0 and card(pg, 'estudando inglês').count() == 1, 'excluir só a contagem escolhida')

        # --- tema escuro
        foto(pg, '10-claro')
        pg.emulate_media(color_scheme='dark')
        foto(pg, '10-escuro')
        pg.click('#toggle-ajustes'); foto(pg, '11-ajustes-escuro'); pg.keyboard.press('Escape')
        pg.click('#toggle-form'); foto(pg, '13-nova-escuro'); pg.keyboard.press('Escape')
        pg.emulate_media(color_scheme='light')

        check(not errs, f'sem erros de console {errs}')
        check(not falhas, f'sem requisições falhas {falhas}')
        ctx.close()

        # --- migração v1 -> v2
        ctx2 = b.new_context(viewport={'width': 390, 'height': 844})
        v1 = {'counters': [{'id': 'a1', 'name': 'Cigarro', 'start': 1761000000000, 'best': 12},
                           {'id': 'b2', 'name': 'Doces', 'start': 1750000000123, 'best': 0}], 'updatedAt': 1762000000000}
        ctx2.add_init_script("if(!localStorage.getItem('contagem-de-dias:v1')) localStorage.setItem('contagem-de-dias:v1', %s)" % json.dumps(json.dumps(v1)))
        pg2 = ctx2.new_page()
        errs2 = []
        pg2.on('pageerror', lambda e: errs2.append(str(e)))
        pg2.goto(URL); pg2.wait_for_selector('.card h2')
        check(pg2.locator('.card h2').all_inner_texts() == ['Doces', 'Cigarro'], 'migração: as 2 contagens aparecem')
        new = json.loads(pg2.evaluate("localStorage.getItem('contagem-de-dias:v2')"))
        check([x['inicio'] for x in new['contagens']] == [1761000000000, 1750000000123], 'migração: datas preservadas')
        check(new['contagens'][0]['recorde'] == 12 and new['contagens'][0]['tipo'] == 'parar', 'migração: recorde e tipo parar')
        check(json.loads(pg2.evaluate("localStorage.getItem('contagem-de-dias:v1')")) == v1, 'migração: chave v1 intacta')
        check(not errs2, f'migração sem erros {errs2}')
        ctx2.close()

        # --- v2 corrompida: não sobrescreve
        ctx3 = b.new_context()
        ctx3.add_init_script("localStorage.setItem('contagem-de-dias:v2','{quebrado')")
        pg3 = ctx3.new_page()
        pg3.goto(URL); pg3.wait_for_selector('#list > .error')
        check('Nada foi apagado' in pg3.locator('#list > .error').inner_text(), 'v2 corrompida: avisa o usuário')
        check(pg3.evaluate("localStorage.getItem('contagem-de-dias:v2')") == '{quebrado', 'v2 corrompida: não é sobrescrita')
        pg3.click('#toggle-form'); pg3.fill('#f-name', 'teste'); pg3.click('#new-form button[type=submit]')
        check('não puderam ser lidos' in pg3.locator('#f-error').inner_text() and pg3.evaluate("document.getElementById('nova').open"), 'v2 corrompida: criar mostra erro dentro do dialog')
        check(pg3.evaluate("localStorage.getItem('contagem-de-dias:v2')") == '{quebrado', 'v2 corrompida: continua intacta após tentar criar')
        ctx3.close()

        # --- notificações em Ajustes, sem servidor de push (o servidor estático não tem /api)
        # O Chromium headless sempre responde "denied" em Notification.permission; o teste simula o que o Chrome do celular faz.
        CONTA = ("let perm = 'default'; window.__pedidos = 0; Object.defineProperty(Notification, 'permission', { get: () => perm });"
                 "Notification.requestPermission = function () { window.__pedidos++; perm = window.__resposta || 'granted'; return Promise.resolve(perm); };")
        ctxn = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        ctxn.add_init_script(CONTA)
        pn = ctxn.new_page()
        errn = []
        pn.on('pageerror', lambda e: errn.append(str(e)))
        pn.goto(URL); pn.wait_for_selector('.card.example')
        check(pn.evaluate('window.__pedidos') == 0, 'notificações: abrir o app não pede permissão')
        pn.click('#toggle-ajustes')
        check(pn.evaluate('window.__pedidos') == 0, 'notificações: abrir Ajustes não pede permissão')
        check(pn.locator('#a-notif-botao').inner_text() == 'Ativar notificações' and 'resumo por dia' in pn.locator('#a-notif-texto').inner_text(), 'notificações: estado desligado com o botão Ativar')
        foto(pn, '10-notificacoes-desligadas')
        pn.click('#a-notif-botao')
        pn.wait_for_function("document.getElementById('a-notif-erro').textContent !== ''")
        check(pn.evaluate('window.__pedidos') == 1, 'notificações: a permissão só é pedida depois do toque')
        check('Sem conexão com o servidor' in pn.locator('#a-notif-erro').inner_text() and pn.locator('#a-notif-botao').inner_text() == 'Tentar de novo', 'notificações: servidor indisponível mostra erro sem culpa e "Tentar de novo"')
        check(pn.evaluate("localStorage.getItem('contagem-de-dias:push')") is None, 'notificações: falha ao criar o dispositivo não deixa credencial')
        foto(pn, '11-notificacoes-erro-rede')
        pn.keyboard.press('Escape')
        nova_contagem(pn, 'parar', 'Sem servidor', dias_atras(2))
        check(card(pn, 'Sem servidor').count() == 1, 'notificações: com o servidor fora do ar o app continua criando contagens')
        check(not errn, f'notificações sem erros de JavaScript {errn}')
        ctxn.close()

        ctxn = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        ctxn.add_init_script("delete window.PushManager;")
        pn = ctxn.new_page(); pn.goto(URL); pn.wait_for_selector('.card.example'); pn.click('#toggle-ajustes')
        check('não mostra notificações' in pn.locator('#a-notif-texto').inner_text() and pn.locator('#a-notif-botao').is_hidden() and pn.locator('#a-notif-nota').is_hidden(), 'notificações: sem suporte, só o aviso (sem botão)')
        foto(pn, '12-notificacoes-sem-suporte')
        ctxn.close()

        ctxn = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2)
        ctxn.add_init_script("Object.defineProperty(Notification, 'permission', { get: () => 'denied' });")
        pn = ctxn.new_page(); pn.goto(URL); pn.wait_for_selector('.card.example'); pn.click('#toggle-ajustes')
        check('bloqueadas' in pn.locator('#a-notif-texto').inner_text() and pn.locator('#a-notif-botao').is_hidden(), 'notificações: permissão negada, só o aviso (sem botão)')
        foto(pn, '13-notificacoes-bloqueadas')
        ctxn.close()

        # --- atualização: a versão nova chega na 1ª recarga e funciona offline (sem versão mista)
        tmp = tempfile.mkdtemp()
        shutil.copytree(PUB, tmp + '/s')
        srv2 = subprocess.Popen(['python3', '-m', 'http.server', '8766', '--directory', tmp + '/s', '--bind', '127.0.0.1'],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        try:
            ctx4 = b.new_context(viewport={'width': 390, 'height': 844})
            pg4 = ctx4.new_page()
            errs4 = []
            pg4.on('pageerror', lambda e: errs4.append(str(e)))
            pg4.goto('http://127.0.0.1:8766/'); pg4.evaluate("navigator.serviceWorker.ready"); pg4.reload(); pg4.wait_for_selector('.card.example')
            with open(tmp + '/s/app.js', 'a', encoding='utf-8') as f:
                f.write('\nwindow.__versao = 2;\n')
            # publicar = subir a versão (cache do sw.js e ?v= do HTML), como em scripts/versao.js
            subprocess.run(['node', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'scripts', 'versao.js'), tmp + '/s', '99'], check=True, stdout=subprocess.DEVNULL)
            pg4.reload(); pg4.wait_for_selector('.card.example')
            check(pg4.evaluate('window.__versao') == 2, 'atualização: arquivo novo chega já na primeira recarga')
            pg4.click('#toggle-ajustes')
            check(pg4.evaluate("document.getElementById('ajustes').open"), 'atualização: a engrenagem abre')
            pg4.keyboard.press('Escape')
            srv2.terminate(); time.sleep(0.5)
            ctx4.set_offline(True)
            pg4.reload(); pg4.wait_for_selector('.card.example')
            check(pg4.evaluate('window.__versao') == 2, 'offline: usa a versão nova guardada, não a antiga')
            check(not errs4, f'atualização sem erros {errs4}')
            ctx4.close()
        finally:
            srv2.terminate()
            shutil.rmtree(tmp, ignore_errors=True)
        b.close()
finally:
    srv.terminate()
sys.exit(0 if ok else 1)
