"""Testes do scripts/monitor.py (sem rede e sem e-mail de verdade). Uso: python3 tests/monitor_test.py"""
import importlib.util
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path

caminho = Path(__file__).resolve().parent.parent / 'scripts' / 'monitor.py'
spec = importlib.util.spec_from_file_location('monitor', caminho)
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

CFG = {'ALERTA_PARA': 'a@exemplo.com, b@exemplo.com ,c@exemplo.com', 'SMTP_HOST': 'smtp.exemplo', 'SMTP_PORTA': '465',
       'SMTP_USUARIO': 'envio@exemplo.com', 'SMTP_SENHA': 'segredo-de-app', 'URL': 'https://exemplo/saude'}
T0 = 1_762_000_000


class Resposta:
    def __init__(self, corpo='{"ok":true,"push":true}', status=200):
        self.corpo, self.status = corpo.encode(), status
    def read(self, n=-1): return self.corpo[:n] if n > 0 else self.corpo
    def __enter__(self): return self
    def __exit__(self, *a): return False


def abrir_com(saude, internet=True):
    """Simula a rede: `saude` é uma Resposta ou uma exceção; o endereço de controle responde conforme `internet`."""
    def abrir(req, timeout=None):
        url = req.full_url
        if 'cloudflare.com' in url:
            if internet: return Resposta('ok')
            raise urllib.error.URLError('sem internet')
        if isinstance(saude, Exception): raise saude
        return saude
    return abrir


class SmtpFalso:
    enviados = []
    falhar = False
    def __init__(self): self.login_com = None
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def starttls(self, context=None): pass
    def login(self, u, s):
        if SmtpFalso.falhar: raise OSError('rede fora')
        self.login_com = (u, s)
    def send_message(self, msg, to_addrs=None): SmtpFalso.enviados.append((msg, to_addrs))


class Monitor(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.estado = Path(self.dir.name) / 'estado.json'
        SmtpFalso.enviados = []; SmtpFalso.falhar = False
        self.logs = []

    def tearDown(self): self.dir.cleanup()

    def rodar(self, saude, t, internet=True):
        return M.executar(CFG, self.estado, agora=t, abrir=abrir_com(saude, internet), fabrica_smtp=SmtpFalso, log=self.logs.append)

    # ---- checar
    def test_checar_aceita_so_200_com_ok_true(self):
        self.assertEqual(M.checar('https://u', abrir_com(Resposta())), (True, 'ok'))
        self.assertFalse(M.checar('https://u', abrir_com(Resposta('{"ok":false}')))[0])
        self.assertFalse(M.checar('https://u', abrir_com(Resposta('<html>502</html>')))[0])
        self.assertEqual(M.checar('https://u', abrir_com(Resposta('{"ok":true}', 503))), (False, 'HTTP 503'))
        self.assertEqual(M.checar('https://u', abrir_com(urllib.error.HTTPError('u', 502, 'x', {}, None))), (False, 'HTTP 502'))
        self.assertFalse(M.checar('https://u', abrir_com(TimeoutError('lento')))[0])

    # ---- decidir (sem E/S)
    def test_decidir_so_alerta_na_segunda_falha_seguida(self):
        e, a = M.decidir({}, False, T0); self.assertIsNone(a)
        e, a = M.decidir(e, False, T0 + 300); self.assertEqual(a, 'fora'); self.assertEqual(e['primeira_falha'], T0)

    def test_decidir_uma_falha_isolada_some_sem_aviso(self):
        e, _ = M.decidir({}, False, T0)
        e, a = M.decidir(e, True, T0 + 300)
        self.assertIsNone(a); self.assertEqual(e['falhas'], 0)

    def test_decidir_lembrete_depois_de_6_horas_e_nao_antes(self):
        e = dict(falhas=5, primeira_falha=T0, ultimo_aviso=T0 + 600)
        self.assertIsNone(M.decidir(e, False, T0 + 600 + M.LEMBRETE_S - 1)[1])
        self.assertEqual(M.decidir(e, False, T0 + 600 + M.LEMBRETE_S)[1], 'lembrete')

    def test_decidir_voltou_so_se_o_aviso_de_queda_saiu(self):
        self.assertEqual(M.decidir(dict(falhas=3, primeira_falha=T0, ultimo_aviso=T0 + 600), True, T0 + 900)[1], 'voltou')
        self.assertIsNone(M.decidir(dict(falhas=1, primeira_falha=T0, ultimo_aviso=None), True, T0 + 900)[1])

    # ---- executar (com e-mail falso)
    def test_ciclo_completo_cai_lembra_e_volta(self):
        ruim = urllib.error.URLError('recusou')
        self.assertIsNone(self.rodar(ruim, T0))
        self.assertEqual(self.rodar(ruim, T0 + 300), 'fora')
        self.assertEqual(len(SmtpFalso.enviados), 1)
        for i in range(2, 10): self.assertIsNone(self.rodar(ruim, T0 + 300 * i), 'não repete o aviso a cada rodada')
        self.assertEqual(len(SmtpFalso.enviados), 1)
        self.assertEqual(self.rodar(ruim, T0 + 600 + M.LEMBRETE_S), 'lembrete')
        self.assertEqual(self.rodar(Resposta(), T0 + 600 + M.LEMBRETE_S + 300), 'voltou')
        self.assertEqual(len(SmtpFalso.enviados), 3)
        self.assertIsNone(self.rodar(Resposta(), T0 + 99999), 'normalizado: nada mais a dizer')
        self.assertEqual(json.loads(self.estado.read_text()), {'falhas': 0, 'primeira_falha': None, 'ultimo_aviso': None})

    def test_email_vai_para_os_tres_com_remetente_e_sem_a_senha(self):
        self.rodar(OSError('x'), T0); self.rodar(OSError('x'), T0 + 300)
        msg, para = SmtpFalso.enviados[0]
        self.assertEqual(para, ['a@exemplo.com', 'b@exemplo.com', 'c@exemplo.com'])
        self.assertEqual(msg['From'], 'envio@exemplo.com')
        self.assertIn('fora do ar', msg['Subject'])
        self.assertNotIn('segredo-de-app', msg.as_string())
        self.assertIn('contador.sh', msg.get_content())

    def test_sem_internet_aqui_a_rodada_e_ignorada_e_nao_conta_falha(self):
        for i in range(5): self.assertIsNone(self.rodar(OSError('x'), T0 + 300 * i, internet=False))
        self.assertEqual(SmtpFalso.enviados, [])
        self.assertFalse(self.estado.exists())
        self.assertIsNone(self.rodar(OSError('x'), T0 + 3000), 'a primeira falha com internet é só a primeira')

    def test_falha_no_envio_tenta_de_novo_na_proxima_rodada(self):
        ruim = OSError('x'); SmtpFalso.falhar = True
        self.rodar(ruim, T0); self.rodar(ruim, T0 + 300)
        self.assertEqual(SmtpFalso.enviados, [])
        SmtpFalso.falhar = False
        self.assertEqual(self.rodar(ruim, T0 + 600), 'fora')
        self.assertEqual(len(SmtpFalso.enviados), 1)

    def test_aviso_de_volta_que_falha_e_repetido(self):
        ruim = OSError('x'); self.rodar(ruim, T0); self.rodar(ruim, T0 + 300)
        SmtpFalso.falhar = True
        self.assertEqual(self.rodar(Resposta(), T0 + 600), 'voltou')
        SmtpFalso.falhar = False
        self.assertEqual(self.rodar(Resposta(), T0 + 900), 'voltou')
        self.assertEqual(len(SmtpFalso.enviados), 2)

    def test_estado_corrompido_nao_derruba(self):
        self.estado.write_text('{lixo')
        self.assertIsNone(self.rodar(Resposta(), T0))

    # ---- config e e-mail
    def test_ler_config_ignora_comentarios_e_aspas(self):
        p = Path(self.dir.name) / 'c.env'
        p.write_text('# comentario\nALERTA_PARA="x@y.com,z@w.com"\n\nSMTP_SENHA=abc=def\nlixo sem igual\n')
        cfg = M.ler_config(p)
        self.assertEqual(M.destinatarios(cfg), ['x@y.com', 'z@w.com'])
        self.assertEqual(cfg['SMTP_SENHA'], 'abc=def')

    def test_enviar_sem_destinatario_recusa(self):
        with self.assertRaises(ValueError): M.enviar({**CFG, 'ALERTA_PARA': ''}, 'a', 'b', SmtpFalso)

    def test_enviar_usa_login_da_config(self):
        M.enviar(CFG, 'assunto', 'corpo', SmtpFalso)
        self.assertEqual(len(SmtpFalso.enviados), 1)


if __name__ == '__main__':
    unittest.main(verbosity=1)
