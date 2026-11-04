"""Gera as imagens do README (docs/img) com dados de exemplo, em um celular de 390x844 e relógio congelado.
Uso: python3 scripts/capturas.py     (precisa de Playwright para Python e Chromium)
Nada aqui usa dados reais: as contagens, o histórico e as datas são inventados."""
import datetime, json, os, socket, subprocess, sys, time
from playwright.sync_api import sync_playwright

RAIZ = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SAIDA = os.path.join(RAIZ, 'docs', 'img')
os.makedirs(SAIDA, exist_ok=True)

AGORA = datetime.datetime(2026, 11, 4, 10, 0, 0)
MS = lambda dt: int(dt.timestamp() * 1000)
DIA = datetime.timedelta(days=1)


def dias_atras(n, hora=8):
    d = (AGORA - n * DIA).replace(hour=hora, minute=0)
    return MS(d)


def estado(modo):
    checkins = [(AGORA - i * DIA).date().isoformat() for i in range(12)]
    return {
        'versao': 2,
        'preferencias': {'horaResumo': '09:00', 'fuso': 'America/Sao_Paulo', 'modo': modo, 'visual': 'futurista'},
        'contagens': [
            {'id': 'c1', 'nome': 'Refrigerante', 'tipo': 'parar', 'inicio': dias_atras(47), 'custoDia': 6.5, 'recorde': 47,
             'deslizes': [{'em': dias_atras(30), 'nota': ''}], 'tentativas': [{'inicio': dias_atras(80), 'fim': dias_atras(47), 'dias': 33, 'nota': ''}], 'checkins': []},
            {'id': 'c2', 'nome': 'Estudar inglês', 'tipo': 'manter', 'inicio': dias_atras(30), 'custoDia': None, 'recorde': 0, 'deslizes': [], 'tentativas': [], 'checkins': checkins},
            {'id': 'c3', 'nome': 'Fumar', 'tipo': 'parar', 'inicio': dias_atras(385), 'custoDia': 25, 'recorde': 385, 'deslizes': [], 'tentativas': [], 'checkins': []},
            {'id': 'c4', 'nome': 'Redes sociais à noite', 'tipo': 'parar', 'inicio': dias_atras(9), 'custoDia': None, 'recorde': 9, 'deslizes': [], 'tentativas': [], 'checkins': []},
        ],
        'atualizadoEm': MS(AGORA),
    }


def pomodoro(fase='foco', rodando=True, restante_ms=18 * 60000 + 32000, ciclo=2):
    dias = {}
    for i, n in enumerate([6, 5, 8, 4, 7, 3, 0, 5, 6]):
        dias[(AGORA - (i + 1) * DIA).date().isoformat()] = n
    dias[AGORA.date().isoformat()] = 3
    dias = {k: v for k, v in dias.items() if v}
    e = {'versao': 1, 'fase': fase, 'ciclo': ciclo, 'rodando': rodando, 'fimEm': MS(AGORA) + restante_ms if rodando else 0,
         'restanteMs': restante_ms, 'contagemId': 'c2', 'dias': dias, 'atualizadoEm': 0}
    return e


def porta_livre():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


PORTA = porta_livre()
servidor = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORTA), '--bind', '127.0.0.1', '--directory', os.path.join(RAIZ, 'public')],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1)
URL = f'http://127.0.0.1:{PORTA}/'


def abrir(b, esquema, modo, pomo=None, hash_=''):
    ctx = b.new_context(viewport={'width': 390, 'height': 900 if not hash_ else 844}, device_scale_factor=2, color_scheme=esquema, service_workers='block', locale='pt-BR', timezone_id='America/Sao_Paulo')
    ctx.add_init_script(f"localStorage.setItem('contagem-de-dias:v2', {json.dumps(json.dumps(estado(modo)))});"
                        + (f"localStorage.setItem('contagem-de-dias:pomodoro', {json.dumps(json.dumps(pomo))});" if pomo else ''))
    pg = ctx.new_page()
    pg.clock.install(time=AGORA)
    pg.goto(URL + hash_)
    pg.wait_for_selector('#tela-pomodoro:not([hidden])' if hash_ else '#list .card')
    pg.clock.pause_at(AGORA + datetime.timedelta(seconds=2))
    pg.wait_for_timeout(600)
    return ctx, pg


def foto(pg, nome, cheia=False):
    destino = os.path.join(SAIDA, nome + '.png')
    pg.screenshot(path=destino, full_page=cheia)
    try:  # PNG menor (paleta de 256 cores) para o repositório não inchar; sem o Pillow, fica como saiu
        from PIL import Image
        Image.open(destino).convert('RGB').quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(destino, optimize=True)
    except ImportError:
        pass
    print('ok', nome, os.path.getsize(destino) // 1024, 'KB')


try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx, pg = abrir(b, 'light', 'claro')
        pg.locator('#list .card', has_text='Estudar inglês').scroll_into_view_if_needed()
        pg.evaluate("document.querySelector('#list .card:nth-child(2)').scrollIntoView({block: 'start'})"); pg.wait_for_timeout(300)
        foto(pg, 'contagem-claro'); ctx.close()
        ctx, pg = abrir(b, 'dark', 'escuro'); foto(pg, 'contagens-escuro')
        pg.click('#toggle-form'); pg.wait_for_timeout(400); foto(pg, 'nova-contagem'); pg.keyboard.press('Escape')
        pg.click('#toggle-ajustes'); pg.wait_for_timeout(400); foto(pg, 'ajustes'); ctx.close()
        ctx, pg = abrir(b, 'dark', 'escuro', pomodoro(), '#pomodoro'); foto(pg, 'pomodoro-foco')
        pg.click('#pomo-historico-abrir'); pg.wait_for_timeout(400); foto(pg, 'pomodoro-historico'); ctx.close()
        ctx, pg = abrir(b, 'light', 'claro', pomodoro('pausa', False, 5 * 60000 - 90000, 2), '#pomodoro'); foto(pg, 'pomodoro-pausa'); ctx.close()
        b.close()
finally:
    servidor.terminate()
