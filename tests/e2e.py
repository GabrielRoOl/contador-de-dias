import subprocess, time, sys, datetime
from playwright.sync_api import sync_playwright
import os
PUB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')
srv = subprocess.Popen(['python3','-m','http.server','8765','--directory',PUB,'--bind','127.0.0.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1)
ok = True
def check(c, msg):
    global ok
    print(('OK   ' if c else 'FALHA ') + msg)
    ok = ok and c
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context()
        pg = ctx.new_page()
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
        pg.on('pageerror', lambda e: errs.append(str(e)))
        failed = []
        pg.on('requestfailed', lambda r: failed.append(r.url))
        pg.goto('http://127.0.0.1:8765/')
        pg.wait_for_selector('.card.example')
        check(pg.locator('.card.example').count() == 1, 'cartao de exemplo aparece sem contagens')
        fams = pg.evaluate("Promise.all([...document.fonts].map(f=>f.load().then(()=>f.family+' '+f.weight+' '+f.status)))")
        check(all('loaded' in f for f in fams) and len(fams) == 4, f'4 fontes carregam de arquivo: {fams}')
        pg.evaluate("navigator.serviceWorker.ready")
        pg.reload(); pg.wait_for_selector('.card.example')
        # criar contagem com data passada (7 dias atras)
        d = (datetime.date.today() - datetime.timedelta(days=7)).isoformat()
        pg.fill('#f-name', 'Refrigerante'); pg.fill('#f-date', d); pg.fill('#f-time', '00:00')
        pg.click('#new-form button[type=submit]')
        n = pg.locator('.live:not([data-example]) .num').first.inner_text()
        check(n in ('7','8'), f'contagem com data passada mostra {n} dias')
        # persistencia
        pg.reload(); pg.wait_for_selector('.card h2')
        check(pg.locator('.card h2').first.inner_text() == 'Refrigerante', 'persiste apos recarregar')
        # offline
        ctx.set_offline(True)
        pg.reload(); pg.wait_for_selector('.card h2')
        check(pg.locator('.card h2').first.inner_text() == 'Refrigerante', 'abre offline')
        fams2 = pg.evaluate("Promise.all([...document.fonts].map(f=>f.load().then(()=>f.status)))")
        check(all(s == 'loaded' for s in fams2), 'fontes offline')
        ctx.set_offline(False)
        # recomecei guarda recorde
        pg.click('[data-act=ask-reset]'); pg.click('[data-act=do-reset]')
        check('Recorde anterior' in pg.locator('.rec').inner_text(), 'Recomecei guarda o recorde')
        check(pg.locator('.live .num').first.inner_text() == '0', 'contagem volta a 0')
        keys = pg.evaluate("Object.keys(localStorage)")
        check(keys == ['contagem-de-dias:v1'], f'chave localStorage inalterada {keys}')
        check(pg.evaluate("typeof Logica === 'object' && Logica.marcoDoDia(Date.now(), 30).tipo === 'mes'"), 'Logica carregada no navegador')
        check(not errs, f'sem erros de console {errs}')
        check(not failed, f'sem requisicoes falhas {failed}')
        b.close()
finally:
    srv.terminate()
sys.exit(0 if ok else 1)
