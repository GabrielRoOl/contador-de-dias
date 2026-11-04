"""Gera os ícones do PWA (anéis de semana, mês e ano) com o Chromium do Playwright.
Uso: python3 scripts/icones.py   (grava em public/)"""
import os
from playwright.sync_api import sync_playwright

PUB = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public')

def svg(escala):
    def anel(r, fracao, cor):
        return (f'<circle cx="256" cy="256" r="{r}" fill="none" stroke="rgba(120,170,255,0.16)" stroke-width="26"/>'
                f'<circle cx="256" cy="256" r="{r}" fill="none" stroke="{cor}" stroke-width="26" stroke-linecap="round" pathLength="100" '
                f'stroke-dasharray="{fracao} 100" transform="rotate(-90 256 256)" filter="url(#brilho)"/>'
                f'<circle cx="256" cy="256" r="{r}" fill="none" stroke="{cor}" stroke-width="26" stroke-linecap="round" pathLength="100" '
                f'stroke-dasharray="{fracao} 100" transform="rotate(-90 256 256)"/>')
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<defs>
  <radialGradient id="fundo" cx="50%" cy="38%" r="75%"><stop offset="0" stop-color="#0E2036"/><stop offset="1" stop-color="#050912"/></radialGradient>
  <filter id="brilho" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
</defs>
<rect width="512" height="512" fill="url(#fundo)"/>
<g transform="translate(256 256) scale({escala}) translate(-256 -256)">
  {anel(170, 30, '#FF5CC8')}
  {anel(132, 56, '#8F7CFF')}
  {anel(94, 80, '#38D9FF')}
  <circle cx="256" cy="256" r="24" fill="#38D9FF" filter="url(#brilho)"/><circle cx="256" cy="256" r="24" fill="#38D9FF"/>
</g></svg>'''

def renderizar(pg, escala, tamanho, arquivo):
    desenho = svg(escala).replace('width="512" height="512"', f'width="{tamanho}" height="{tamanho}"')
    pg.set_viewport_size({'width': tamanho, 'height': tamanho})
    pg.set_content(f'<html><body style="margin:0;background:#050912">{desenho}</body></html>')
    pg.screenshot(path=os.path.join(PUB, arquivo), clip={'x': 0, 'y': 0, 'width': tamanho, 'height': tamanho})

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page()
    renderizar(pg, 1.12, 512, 'icon-512.png')      # "any": os anéis ocupam mais o quadro
    renderizar(pg, 1.12, 192, 'icon-192.png')
    renderizar(pg, 1.0, 512, 'icon-maskable-512.png')  # "maskable": tudo dentro da zona segura (círculo de 80%)
    b.close()
print('ícones gerados em public/')
