#!/usr/bin/env python3
"""Vigia o Contador de Dias pela URL pública e avisa por e-mail quando ele cai e quando volta.

Roda a cada 5 minutos (timer do systemd do usuário, veja scripts/systemd/). Só biblioteca padrão do Python.
- Só avisa depois de 2 falhas seguidas (10 min), para não alarmar por um tropeço de rede.
- Se o próprio computador estiver sem internet, a rodada é ignorada (não dá para culpar o servidor).
- Um e-mail quando cai, um lembrete a cada 6 h se continuar fora, um aviso quando volta.
- Se o envio do e-mail falhar, tenta de novo na rodada seguinte.

Configuração (fora do git): ~/.config/contador-monitor/config.env, formato CHAVE=valor:
  ALERTA_PARA=um@exemplo.com,outro@exemplo.com
  SMTP_HOST=smtp.gmail.com
  SMTP_PORTA=465
  SMTP_SEGURANCA=ssl            (ssl ou starttls)
  SMTP_USUARIO=conta@exemplo.com
  SMTP_SENHA=senha-de-app       (nunca a senha normal da conta)
  URL=https://grodev.com.br/contador/api/saude   (opcional)

Uso: scripts/monitor.py              uma checagem (é o que o timer chama)
     scripts/monitor.py --testar-email   manda um e-mail de teste e sai
"""
import json
import os
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.request
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path

CONFIG_PADRAO = Path(os.environ.get('MONITOR_CONFIG', Path.home() / '.config' / 'contador-monitor' / 'config.env'))
ESTADO_PADRAO = Path(os.environ.get('MONITOR_ESTADO', Path.home() / '.local' / 'state' / 'contador-monitor' / 'estado.json'))
URL_PADRAO = 'https://grodev.com.br/contador/api/saude'
CONTROLE = 'https://www.cloudflare.com/cdn-cgi/trace'  # se nem isto abre, o problema é a internet daqui
FALHAS_PARA_ALERTAR = 2
LEMBRETE_S = 6 * 3600
LIMITE_REDE_S = 15


def ler_config(caminho):
    cfg = {}
    for linha in Path(caminho).read_text(encoding='utf-8').splitlines():
        linha = linha.strip()
        if not linha or linha.startswith('#') or '=' not in linha:
            continue
        chave, valor = linha.split('=', 1)
        cfg[chave.strip()] = valor.strip().strip('"').strip("'")
    return cfg


def destinatarios(cfg):
    return [e.strip() for e in cfg.get('ALERTA_PARA', '').split(',') if '@' in e]


def checar(url, abrir=urllib.request.urlopen):
    """(ok, detalhe). Só vale se responder 200 com {"ok": true}."""
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'contador-monitor'})
        with abrir(req, timeout=LIMITE_REDE_S) as r:
            corpo = r.read(2000).decode('utf-8', 'replace')
            if r.status != 200:
                return False, f'HTTP {r.status}'
        try:
            if json.loads(corpo).get('ok') is True:
                return True, 'ok'
        except ValueError:
            pass
        return False, 'resposta inesperada: ' + corpo[:80].replace('\n', ' ')
    except urllib.error.HTTPError as e:
        return False, f'HTTP {e.code}'
    except Exception as e:  # DNS, timeout, conexão recusada, TLS
        return False, f'{type(e).__name__}: {str(e)[:80]}'


def tem_internet(abrir=urllib.request.urlopen):
    try:
        with abrir(urllib.request.Request(CONTROLE, headers={'User-Agent': 'contador-monitor'}), timeout=LIMITE_REDE_S) as r:
            return r.status == 200
    except Exception:
        return False


def decidir(estado, ok, agora):
    """Devolve (novo_estado, acao) com acao em None, 'fora', 'lembrete' ou 'voltou'. Não faz E/S."""
    e = dict(falhas=0, primeira_falha=None, ultimo_aviso=None)
    e.update(estado or {})
    if ok:
        acao = 'voltou' if e['ultimo_aviso'] else None
        return dict(falhas=0, primeira_falha=e['primeira_falha'] if acao else None, ultimo_aviso=e['ultimo_aviso'] if acao else None), acao
    e['falhas'] += 1
    e['primeira_falha'] = e['primeira_falha'] or agora
    if e['falhas'] >= FALHAS_PARA_ALERTAR and e['ultimo_aviso'] is None:
        return e, 'fora'
    if e['ultimo_aviso'] and agora - e['ultimo_aviso'] >= LEMBRETE_S:
        return e, 'lembrete'
    return e, None


def hora(ts):
    return time.strftime('%H:%M', time.localtime(ts))


def duracao(seg):
    m = int(seg // 60)
    return f'{m} min' if m < 60 else f'{m // 60} h {m % 60} min'


def montar_mensagem(acao, estado, detalhe, agora, url):
    desde = estado.get('primeira_falha') or agora
    if acao == 'voltou':
        assunto = '[Contador] voltou ao ar'
        corpo = f'O Contador de Dias voltou a responder às {hora(agora)}.\nFicou fora por cerca de {duracao(agora - desde)} (desde {hora(desde)}).\n'
    else:
        assunto = f'[Contador] fora do ar desde {hora(desde)}' if acao == 'fora' else f'[Contador] continua fora do ar (desde {hora(desde)})'
        corpo = (f'O Contador de Dias não responde.\n\nO que foi testado: {url}\nResultado: {detalhe}\nFora desde: {hora(desde)} ({duracao(agora - desde)}).\n\n'
                 'O que olhar, nesta ordem:\n'
                 '1. O celular está ligado e com internet (Wi-Fi ou 4G)?\n'
                 '2. ssh celular-wifi "~/contador/contador.sh status"  (use "celular" fora de casa)\n'
                 '3. ssh celular-wifi "tail -30 ~/logs/contador.log"\n'
                 '4. Se o servidor está de pé mas a URL não abre: o túnel do Cloudflare (tmux "site" no celular).\n'
                 '5. Para subir de novo: ~/contador/contador.sh restart\n')
    return assunto, corpo


def enviar(cfg, assunto, corpo, fabrica_smtp=None):
    para = destinatarios(cfg)
    if not para:
        raise ValueError('ALERTA_PARA vazio')
    msg = EmailMessage()
    msg['From'] = cfg['SMTP_USUARIO']
    msg['To'] = ', '.join(para)
    msg['Subject'] = assunto
    msg['Date'] = formatdate(localtime=True)
    msg['Message-ID'] = make_msgid(domain='contador.local')
    msg.set_content(corpo)
    host, porta = cfg['SMTP_HOST'], int(cfg.get('SMTP_PORTA', '465'))
    seguranca = cfg.get('SMTP_SEGURANCA', 'ssl').lower()
    if fabrica_smtp is None:
        contexto = ssl.create_default_context()
        fabrica_smtp = (lambda: smtplib.SMTP_SSL(host, porta, timeout=30, context=contexto)) if seguranca == 'ssl' else (lambda: smtplib.SMTP(host, porta, timeout=30))
    with fabrica_smtp() as s:
        if seguranca == 'starttls':
            s.starttls(context=ssl.create_default_context())
        s.login(cfg['SMTP_USUARIO'], cfg['SMTP_SENHA'])
        s.send_message(msg, to_addrs=para)


def ler_estado(caminho):
    try:
        return json.loads(Path(caminho).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return {}


def gravar_estado(caminho, estado):
    caminho = Path(caminho)
    caminho.parent.mkdir(parents=True, exist_ok=True)
    tmp = caminho.with_suffix('.tmp')
    tmp.write_text(json.dumps(estado), encoding='utf-8')
    tmp.replace(caminho)


def executar(cfg, caminho_estado, agora=None, abrir=urllib.request.urlopen, fabrica_smtp=None, log=print):
    """Uma checagem completa. Devolve a ação tomada (ou None)."""
    agora = time.time() if agora is None else agora
    url = cfg.get('URL', URL_PADRAO)
    ok, detalhe = checar(url, abrir)
    if not ok and not tem_internet(abrir):
        log('sem internet aqui: rodada ignorada')
        return None
    estado, acao = decidir(ler_estado(caminho_estado), ok, agora)
    if acao:
        assunto, corpo = montar_mensagem(acao, estado, detalhe, agora, url)
        try:
            enviar(cfg, assunto, corpo, fabrica_smtp)
            log(f'e-mail enviado: {assunto}')
            if acao == 'voltou':
                estado = dict(falhas=0, primeira_falha=None, ultimo_aviso=None)
            else:
                estado['ultimo_aviso'] = agora
        except Exception as e:  # sem e-mail agora: a próxima rodada tenta de novo (o estado não marca como avisado)
            log(f'FALHA ao enviar e-mail ({type(e).__name__}); tento de novo na próxima rodada')
    else:
        log('ok' if ok else f'falha {estado["falhas"]} de {FALHAS_PARA_ALERTAR}: {detalhe}')
    gravar_estado(caminho_estado, estado)
    return acao


def main(argv):
    if not CONFIG_PADRAO.exists():
        print(f'Falta o arquivo de configuração: {CONFIG_PADRAO} (veja o início deste script)', file=sys.stderr)
        return 2
    cfg = ler_config(CONFIG_PADRAO)
    faltam = [k for k in ('ALERTA_PARA', 'SMTP_HOST', 'SMTP_USUARIO', 'SMTP_SENHA') if not cfg.get(k)]
    if faltam:
        print('Configuração incompleta, faltam: ' + ', '.join(faltam), file=sys.stderr)
        return 2
    if '--testar-email' in argv:
        enviar(cfg, '[Contador] teste do monitor', 'Se você recebeu este e-mail, os avisos de queda do Contador de Dias vão chegar aqui.\n')
        print('e-mail de teste enviado para: ' + ', '.join(destinatarios(cfg)))
        return 0
    executar(cfg, ESTADO_PADRAO)
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
