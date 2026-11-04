const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../public/sincronia.js');

/* Ambiente falso: servidor em memória, navegador com permissão e inscrição, timers que só disparam quando mandamos. */
function ambiente(opc = {}) {
  const guardado = {};
  const chamadas = [];
  const timers = [];
  const srv = { rede: true, dispositivos: 0, respostas: {}, ...opc.srv };
  const sub = {
    unsub: 0,
    endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
    options: { applicationServerKey: S.base64UrlParaBytes('BAUDBw') },
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'BAUDBw', auth: 'AQID' } }; },
    unsubscribe() { this.unsub++; reg.sub = null; return Promise.resolve(true); }
  };
  const reg = {
    sub: opc.semInscricao ? null : sub,
    pushManager: {
      getSubscription: () => Promise.resolve(reg.sub),
      subscribe: (o) => { chamadas.push(['subscribe', o]); reg.sub = sub; return Promise.resolve(sub); }
    }
  };
  const Notification = { permission: opc.permissao || 'default', requestPermission() { chamadas.push(['permissao']); Notification.permission = opc.resposta || 'granted'; return Promise.resolve(Notification.permission); } };
  const env = {
    storage: { getItem: (k) => (k in guardado ? guardado[k] : null), setItem: (k, v) => { guardado[k] = String(v); }, removeItem: (k) => { delete guardado[k]; } },
    navigator: { serviceWorker: { ready: Promise.resolve(reg), getRegistration: () => Promise.resolve(reg) } },
    Notification, PushManager: function () {},
    setTimeout: (f) => { timers.push(f); return timers.length; },
    clearTimeout: (id) => { timers[id - 1] = null; },
    fetch: (url, init) => {
      chamadas.push([init.method, url, init.headers.Authorization || null, init.body ? JSON.parse(init.body) : null, init.headers['X-Convite'] || null]);
      if (!srv.rede) return Promise.reject(new TypeError('Failed to fetch'));
      const chave = init.method + ' ' + url.replace(/dispositivos\/[^/]+/, 'dispositivos/ID');
      let r = srv.respostas[chave];
      if (typeof r === 'function') r = r();
      if (!r) {
        if (chave === 'POST ./api/dispositivos') { srv.dispositivos++; r = { status: 201, corpo: { id: 'dev' + srv.dispositivos, segredo: 's3gr3d0' } }; }
        else if (chave === 'GET ./api/chave-publica') r = { status: 200, corpo: { chave: 'BAUDBw' } };
        else r = { status: 204 };
      }
      return Promise.resolve({ status: r.status, text: () => Promise.resolve(r.corpo ? JSON.stringify(r.corpo) : '') });
    }
  };
  if (opc.semSuporte) delete env.PushManager;
  return { env, chamadas, timers, srv, reg, sub, guardado, Notification };
}
const estado = { versao: 2, contagens: [] };
const metodos = (a) => a.chamadas.map((c) => c[0] + (typeof c[1] === 'string' ? ' ' + c[1].replace('./api/', '').replace(/dispositivos\/[^/]+/, 'dispositivos/ID') : '')).join(' | ');
const disparar = async (a) => { const fs = a.timers.splice(0).filter(Boolean); for (const f of fs) await f(); };

test('base64url vai e volta, e a inscrição incompleta é recusada', () => {
  const b = new Uint8Array([251, 255, 0, 1, 2, 250]);
  assert.deepEqual([...S.base64UrlParaBytes(S.bytesParaBase64Url(b))], [...b]);
  assert.ok(!/[+/=]/.test(S.bytesParaBase64Url(b)));
  assert.throws(() => S.corpoInscricao({ toJSON: () => ({ endpoint: 'https://x', keys: {} }) }));
});

test('status: sem suporte, bloqueado, desligado e ativo', async () => {
  assert.equal(S.criar(ambiente({ semSuporte: true }).env).status(), 'nao-suportado');
  assert.equal(S.criar(ambiente({ permissao: 'denied' }).env).status(), 'bloqueado');
  const a = ambiente();
  const s = S.criar(a.env);
  assert.equal(s.status(), 'desligado');
  await s.ativar(estado);
  assert.equal(s.status(), 'ativo');
});

test('ativar: pede a permissão antes de qualquer rede e segue a ordem combinada', async () => {
  const a = ambiente({ semInscricao: true });
  const s = S.criar(a.env);
  const r = await s.ativar(estado);
  assert.deepEqual(r, { ok: true });
  assert.equal(metodos(a), 'permissao | POST dispositivos | GET chave-publica | subscribe | PUT dispositivos/ID/push | PUT dispositivos/ID/estado');
  const push = a.chamadas.find((c) => typeof c[1] === 'string' && c[1].endsWith('/push'));
  assert.equal(push[2], 'Bearer s3gr3d0');
  assert.deepEqual(push[3], { endpoint: a.sub.endpoint, keys: { p256dh: 'BAUDBw', auth: 'AQID' } });
  assert.equal(JSON.parse(a.guardado['contagem-de-dias:push']).ativo, true);
});

test('ativar: permissão negada ou dispensada não contata o servidor', async () => {
  for (const [resposta, motivo] of [['denied', 'bloqueado'], ['default', 'dispensado']]) {
    const a = ambiente({ resposta });
    const r = await S.criar(a.env).ativar(estado);
    assert.deepEqual(r, { ok: false, motivo });
    assert.equal(metodos(a), 'permissao');
  }
});

test('ativar sem suporte não faz nada', async () => {
  const a = ambiente({ semSuporte: true });
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: false, motivo: 'nao-suportado' });
  assert.equal(a.chamadas.length, 0);
});

test('ativar sem rede falha com "rede" e a nova tentativa reaproveita o dispositivo', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  const rede = a.env.fetch;
  a.env.fetch = (u, i) => (u.endsWith('/estado') ? Promise.reject(new TypeError('off')) : rede(u, i));
  assert.deepEqual(await s.ativar(estado), { ok: false, motivo: 'rede' });
  assert.equal(s.status(), 'desligado');
  a.env.fetch = rede;
  assert.deepEqual(await s.ativar(estado), { ok: true });
  assert.equal(a.srv.dispositivos, 1, 'só um POST /dispositivos');
});

test('ativar: erros do servidor viram motivos claros', async () => {
  let a = ambiente({ srv: { respostas: { 'POST ./api/dispositivos': { status: 429 } } } });
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: false, motivo: 'limite' });
  a = ambiente({ srv: { respostas: { 'GET ./api/chave-publica': { status: 503 } } } });
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: false, motivo: 'servidor-sem-push' });
  a = ambiente({ srv: { respostas: { 'PUT ./api/dispositivos/ID/push': { status: 400 } } } });
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: false, motivo: 'inscricao' });
});

test('ativar: dispositivo apagado no servidor (401) é recriado uma vez', async () => {
  const a = ambiente();
  a.guardado['contagem-de-dias:push'] = JSON.stringify({ id: 'velho', segredo: 'x', ativo: false });
  let primeira = true;
  a.srv.respostas['PUT ./api/dispositivos/ID/push'] = () => { if (primeira) { primeira = false; return { status: 401 }; } return { status: 204 }; };
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: true });
  assert.equal(a.srv.dispositivos, 1);
  assert.equal(JSON.parse(a.guardado['contagem-de-dias:push']).id, 'dev1');
});

test('inscrição com outra chave é trocada', async () => {
  const a = ambiente();
  a.sub.options.applicationServerKey = new Uint8Array([9, 9, 9]);
  await S.criar(a.env).ativar(estado);
  assert.equal(a.sub.unsub, 1);
  assert.ok(a.chamadas.some((c) => c[0] === 'subscribe' && c[1].userVisibleOnly === true));
});

test('desativar: apaga no servidor, solta a inscrição e esquece o dispositivo', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.chamadas.length = 0;
  assert.deepEqual(await s.desativar(), { ok: true });
  assert.equal(metodos(a), 'DELETE dispositivos/ID');
  assert.equal(a.sub.unsub, 1);
  assert.equal(a.guardado['contagem-de-dias:push'], undefined);
  assert.equal(s.status(), 'desligado');
});

test('desativar sem rede continua ativo e avisa', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.srv.rede = false;
  assert.deepEqual(await s.desativar(), { ok: false, motivo: 'rede' });
  assert.equal(s.status(), 'ativo');
  assert.equal(a.sub.unsub, 0);
});

test('agendar: junta várias mudanças em um envio com o estado mais novo', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.chamadas.length = 0;
  s.agendar({ versao: 2, n: 1 }); s.agendar({ versao: 2, n: 2 }); s.agendar({ versao: 2, n: 3 });
  await disparar(a);
  assert.equal(a.chamadas.length, 1);
  assert.equal(a.chamadas[0][3].n, 3);
  assert.equal(JSON.parse(a.guardado['contagem-de-dias:push']).pendente, false);
});

test('agendar não faz nada enquanto as notificações estão desligadas', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  s.agendar(estado);
  await disparar(a);
  assert.equal(a.chamadas.length, 0);
});

test('envio que falha fica pendente e retomar reenvia', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.srv.rede = false;
  s.agendar({ versao: 2, n: 7 });
  await disparar(a);
  assert.equal(JSON.parse(a.guardado['contagem-de-dias:push']).pendente, true);
  a.srv.rede = true;
  a.chamadas.length = 0;
  await s.retomar({ versao: 2, n: 8 });
  assert.equal(a.chamadas.length, 1);
  assert.equal(a.chamadas[0][3].n, 8);
  assert.equal(JSON.parse(a.guardado['contagem-de-dias:push']).pendente, false);
  await s.retomar(estado);
  assert.equal(a.chamadas.length, 1, 'sem pendência não reenvia');
});

test('401 ao sincronizar apaga o dispositivo local e avisa os ouvintes', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  let avisos = 0;
  s.ouvir(() => avisos++);
  a.srv.respostas['PUT ./api/dispositivos/ID/estado'] = { status: 401 };
  s.agendar(estado);
  await disparar(a);
  assert.equal(s.status(), 'desligado');
  assert.equal(avisos, 1);
});

test('descarregar envia na hora, sem esperar o tempo de junção', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.chamadas.length = 0;
  s.agendar(estado);
  await s.descarregar();
  assert.equal(a.chamadas.length, 1);
});

test('verificar: inscrição que o navegador perdeu volta o status para desligado', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.reg.sub = null;
  await s.verificar();
  assert.equal(s.status(), 'desligado');
});

test('verificar: endpoint novo é reenviado ao servidor', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.chamadas.length = 0;
  a.sub.endpoint = 'https://fcm.googleapis.com/fcm/send/outro';
  await s.verificar();
  assert.equal(metodos(a), 'PUT dispositivos/ID/push');
  assert.equal(a.chamadas[0][3].endpoint, a.sub.endpoint);
});

test('verificar nunca pede permissão', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado);
  a.chamadas.length = 0;
  await s.verificar();
  assert.ok(!a.chamadas.some((c) => c[0] === 'permissao'));
});

const comNotas = {
  versao: 2,
  contagens: [{
    id: 'a1', nome: 'Cigarro', tipo: 'parar', inicio: 1, custoDia: 5, recorde: 3, checkins: ['2026-11-01'],
    deslizes: [{ em: 2, nota: 'NOTA_DE_DESLIZE' }],
    tentativas: [{ inicio: 1, fim: 2, dias: 1, nota: 'NOTA_DE_RECOMECO' }, { inicio: 3, fim: 4, dias: 1, nota: 'OUTRA_NOTA' }]
  }]
};

test('espelho: notas e deslizes não saem do aparelho, o resto segue igual', () => {
  const e = S.espelho(comNotas);
  const c = e.contagens[0];
  assert.deepEqual(c.deslizes, []);
  assert.equal(c.tentativas.length, 1);
  assert.equal(c.tentativas[0].nota, '');
  assert.deepEqual([c.id, c.nome, c.tipo, c.inicio, c.custoDia, c.recorde, c.checkins], ['a1', 'Cigarro', 'parar', 1, 5, 3, ['2026-11-01']]);
  assert.ok(!JSON.stringify(e).includes('NOTA'));
  assert.equal(comNotas.contagens[0].deslizes.length, 1, 'o estado original não é alterado');
  assert.deepEqual(S.espelho({ versao: 2, n: 1 }), { versao: 2, n: 1 }, 'formato desconhecido passa direto');
});

test('ativar e agendar enviam o espelho, sem notas', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(comNotas);
  const putAtivar = a.chamadas.find((c) => c[0] === 'PUT' && c[1].endsWith('/estado'));
  assert.ok(!JSON.stringify(putAtivar[3]).includes('NOTA'));
  a.chamadas.length = 0;
  s.agendar(comNotas);
  await disparar(a);
  assert.equal(a.chamadas.length, 1);
  assert.ok(!JSON.stringify(a.chamadas[0][3]).includes('NOTA'));
});

test('ativar: servidor sem espaço vira o motivo servidor-cheio', async () => {
  let a = ambiente({ srv: { respostas: { 'POST ./api/dispositivos': { status: 503 } } } });
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: false, motivo: 'servidor-cheio' });
  a = ambiente({ srv: { respostas: { 'PUT ./api/dispositivos/ID/estado': { status: 507 } } } });
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: false, motivo: 'servidor-cheio' });
});

test('convite: vai só no cadastro e não é guardado em lugar nenhum', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  assert.deepEqual(await s.ativar(estado, 'meu-codigo-secreto'), { ok: true });
  const comCodigo = a.chamadas.filter((c) => c[4]);
  assert.deepEqual(comCodigo.map((c) => c[0] + ' ' + c[1]), ['POST ./api/dispositivos'], 'só o POST /dispositivos leva o código');
  assert.equal(comCodigo[0][4], 'meu-codigo-secreto');
  assert.ok(!JSON.stringify(a.guardado).includes('meu-codigo-secreto'), 'o código não vai para o localStorage');
});

test('convite: sem código o cabeçalho nem é enviado, e 403 pede o código', async () => {
  const a = ambiente({ srv: { respostas: { 'POST ./api/dispositivos': { status: 403 } } } });
  assert.deepEqual(await S.criar(a.env).ativar(estado), { ok: false, motivo: 'convite' });
  assert.equal(a.chamadas.filter((c) => c[4]).length, 0);
  assert.equal(a.guardado['contagem-de-dias:push'], undefined, 'nada foi guardado');
});

test('convite: 403 com código digitado vira convite-invalido', async () => {
  const a = ambiente({ srv: { respostas: { 'POST ./api/dispositivos': { status: 403 } } } });
  assert.deepEqual(await S.criar(a.env).ativar(estado, 'errado'), { ok: false, motivo: 'convite-invalido' });
});

test('convite: aparelho que já existe não pede nem manda código de novo', async () => {
  const a = ambiente();
  const s = S.criar(a.env);
  await s.ativar(estado, 'codigo-1');
  await s.desativar();
  a.chamadas.length = 0;
  await s.ativar(estado); // sem código: servidor aberto ou código não digitado
  assert.equal(a.chamadas.filter((c) => c[4]).length, 0);
});

test('convite: se o aparelho foi apagado no servidor (401), o recadastro reusa o código digitado', async () => {
  const a = ambiente();
  let primeira = true;
  a.srv.respostas['PUT ./api/dispositivos/ID/push'] = () => { if (primeira) { primeira = false; return { status: 401 }; } return { status: 204 }; };
  assert.deepEqual(await S.criar(a.env).ativar(estado, 'codigo-x'), { ok: true });
  const posts = a.chamadas.filter((c) => c[0] === 'POST' && c[1] === './api/dispositivos');
  assert.equal(posts.length, 2);
  assert.ok(posts.every((c) => c[4] === 'codigo-x'));
});
