const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const SCOPE = 'https://grodev.com.br/contador/';

const lerPublico = (nome) => fs.readFileSync(path.join(__dirname, '..', 'public', nome.replace('./', '')), 'utf8');

/* Executa o sw.js com um "self" falso e devolve os ouvintes registrados e o que ele chamou.
   `extra.guardado` é o conteúdo inicial do armazém (IndexedDB falso); `extra.fetch` troca o fetch. */
function carregar(janelas = [], extra = {}) {
  const ouvintes = {};
  const mostradas = [];
  const abertas = [];
  const pedidos = [];
  const mensagens = [];
  const guardado = new Map(Object.entries(extra.guardado || {}));
  const sw = {
    registration: { scope: SCOPE, showNotification: (t, o) => { mostradas.push({ titulo: t, ...o }); return Promise.resolve(); } },
    addEventListener: (nome, f) => { ouvintes[nome] = f; },
    skipWaiting() {}, clients: { claim() {} }
  };
  const ctx = {
    self: sw, location: new URL(SCOPE + 'sw.js'), URL, Promise, setTimeout, clearTimeout, Response, Request, AbortController, Date,
    fetch: extra.fetch || ((u, i) => { pedidos.push({ url: String(u), ...i }); return Promise.reject(new Error('sem rede')); }),
    caches: { open: () => Promise.resolve({ put() {}, match: () => Promise.resolve(undefined) }), keys: () => Promise.resolve([]) },
    clients: { matchAll: () => Promise.resolve(janelas), openWindow: (u) => { abertas.push(u); return Promise.resolve({}); } },
    importScripts: (...nomes) => nomes.forEach((n) => vm.runInContext(lerPublico(n), ctx))
  };
  janelas.forEach((j) => { if (!j.postMessage) j.postMessage = (m) => mensagens.push(m); });
  vm.runInNewContext(codigo, ctx);
  sw.Armazem = { ler: (k) => Promise.resolve(guardado.has(k) ? JSON.parse(JSON.stringify(guardado.get(k))) : null), gravar: (k, v) => { if (v === null) guardado.delete(k); else guardado.set(k, v); return Promise.resolve(true); } };
  return { ouvintes, mostradas, abertas, pedidos, mensagens, guardado, Pomodoro: sw.Pomodoro };
}

/* Evento de push com um corpo qualquer (null = sem corpo). */
async function push(corpo, janelas) {
  const sw = carregar(janelas);
  let espera = Promise.resolve();
  const data = corpo === null ? null : {
    json: () => JSON.parse(corpo),
    text: () => corpo
  };
  sw.ouvintes.push({ data, waitUntil: (p) => { espera = p; } });
  await espera;
  return sw.mostradas;
}

test('push com o JSON do servidor mostra título, texto, tag e ícones', async () => {
  const [n] = await push(JSON.stringify({ titulo: 'Contagem de Dias', corpo: '10 dias sem refrigerante.', tag: 'resumo-diario', url: './', marco: true }));
  assert.equal(n.titulo, 'Contagem de Dias');
  assert.equal(n.body, '10 dias sem refrigerante.');
  assert.equal(n.tag, 'resumo-diario');
  assert.equal(n.renotify, true);
  assert.equal(n.icon, './icon-192.png');
  assert.equal(n.badge, './icon-badge.png');
  assert.deepEqual({ ...n.data }, { url: SCOPE, marco: true });
});

test('push vazio, ilegível ou de tipo estranho ainda mostra uma notificação', async () => {
  for (const corpo of [null, 'isso não é json', 'null', '[1,2]', '42', '{}']) {
    const lista = await push(corpo);
    assert.equal(lista.length, 1, 'corpo: ' + corpo);
    assert.ok(lista[0].titulo && lista[0].body && lista[0].tag === 'resumo-diario', 'corpo: ' + corpo);
  }
  const [n] = await push('texto puro');
  assert.equal(n.body, 'texto puro');
});

test('push: tag inválida, textos enormes e url de outro site são contidos', async () => {
  const [n] = await push(JSON.stringify({ titulo: 'T'.repeat(500), corpo: 'c'.repeat(2000), tag: 'tag com espaço', url: 'https://malicioso.example/x' }));
  assert.equal(n.titulo.length, 100);
  assert.equal(n.body.length, 300);
  assert.equal(n.tag, 'resumo-diario');
  assert.equal(n.data.url, SCOPE);
  const [m] = await push(JSON.stringify({ titulo: 'a', corpo: 'b', url: '../fora' }));
  assert.equal(m.data.url, SCOPE);
  const [k] = await push(JSON.stringify({ titulo: 'a', corpo: 'b', tag: 'pomodoro', url: './#pomodoro' }));
  assert.equal(k.tag, 'pomodoro');
  assert.equal(k.data.url, SCOPE + '#pomodoro');
});

async function clicar(janelas, url = SCOPE) {
  const sw = carregar(janelas);
  let fechou = false, espera = Promise.resolve();
  sw.ouvintes.notificationclick({ notification: { close: () => { fechou = true; }, data: { url } }, waitUntil: (p) => { espera = p; } });
  await espera;
  return { fechou, abertas: sw.abertas };
}

test('clique foca o app que já está aberto', async () => {
  let focou = 0;
  const r = await clicar([{ url: 'https://outro.example/', focus: () => { focou += 100; } }, { url: SCOPE + 'index.html', focus: () => { focou++; } }]);
  assert.equal(focou, 1);
  assert.ok(r.fechou);
  assert.deepEqual(r.abertas, []);
});

test('clique em aviso com tela própria (#pomodoro) leva o app aberto até ela, sem recarregar', async () => {
  const navegou = [];
  const janela = { url: SCOPE + 'index.html', focus: () => Promise.resolve(), navigate: (u) => { navegou.push(u); return Promise.resolve(); } };
  await clicar([janela], SCOPE + '#pomodoro');
  assert.deepEqual(navegou, [SCOPE + '#pomodoro']);
  navegou.length = 0;
  await clicar([{ ...janela, url: SCOPE + '#pomodoro' }], SCOPE + '#pomodoro');
  assert.deepEqual(navegou, [], 'já está lá');
  await clicar([janela], SCOPE);
  assert.deepEqual(navegou, [], 'o resumo diário (sem âncora) não navega a janela aberta');
  const semNavegar = { url: SCOPE, focus: () => Promise.resolve() };
  await clicar([semNavegar], SCOPE + '#pomodoro'); // navegador sem WindowClient.navigate: só foca
  const quebrada = { url: SCOPE, focus: () => Promise.resolve(), navigate: () => Promise.reject(new Error('x')) };
  await clicar([quebrada], SCOPE + '#pomodoro'); // navegação recusada não derruba o clique
});

test('clique abre o app quando ele está fechado', async () => {
  const r = await clicar([{ url: 'https://outro.example/', focus: () => { throw new Error('não deveria'); } }]);
  assert.deepEqual(r.abertas, [SCOPE]);
  assert.ok(r.fechou);
});

test('clique sem dados na notificação abre o app', async () => {
  const sw = carregar([]);
  let espera;
  sw.ouvintes.notificationclick({ notification: { close() {}, data: null }, waitUntil: (p) => { espera = p; } });
  await espera;
  assert.deepEqual(sw.abertas, [SCOPE]);
});

test('a API do servidor não passa pelo cache do service worker', () => {
  const sw = carregar();
  let respondeu = false;
  sw.ouvintes.fetch({ request: { method: 'GET', url: SCOPE + 'api/chave-publica' }, respondWith: () => { respondeu = true; } });
  assert.equal(respondeu, false);
  sw.ouvintes.fetch({ request: { method: 'GET', url: SCOPE + 'app.js?v=1' }, respondWith: () => { respondeu = true; } });
  assert.equal(respondeu, true);
});

/* ---------- Pomodoro: aviso de fim e botões da notificação ---------- */
const MIN = 60000;
const L = (x) => JSON.parse(JSON.stringify(x)); // o código do sw roda em outro contexto do vm: compara só a estrutura

test('push do alarme do Pomodoro: toca, vibra e traz o botão da próxima fase; o resumo diário não', async () => {
  const [a] = await push(JSON.stringify({ titulo: 'Foco concluído', corpo: 'Hora da pausa de 5 min.', tag: 'pomodoro', url: './#pomodoro', proxima: 'pausa' }));
  assert.equal(a.silent, false);
  assert.deepEqual(L(a.vibrate), [300, 150, 300, 150, 300]);
  assert.deepEqual(L(a.actions), [{ action: 'iniciar', title: 'Iniciar pausa' }]);
  assert.equal(a.renotify, true); assert.equal(a.data.proxima, 'pausa');
  const [b] = await push(JSON.stringify({ titulo: 'Pausa concluída', corpo: 'x', tag: 'pomodoro', proxima: 'foco' }));
  assert.equal(b.actions[0].title, 'Iniciar foco');
  const [c] = await push(JSON.stringify({ titulo: 'Foco concluído', corpo: 'x', tag: 'pomodoro', proxima: 'longa' }));
  assert.equal(c.actions[0].title, 'Iniciar pausa longa');
  const [d] = await push(JSON.stringify({ titulo: 'Foco concluído', corpo: 'x', tag: 'pomodoro', proxima: 'hackeada' }));
  assert.equal(d.actions, undefined, 'fase desconhecida não vira botão');
  const [r] = await push(JSON.stringify({ titulo: 'T', corpo: 'c', tag: 'resumo-diario' }));
  assert.equal(r.actions, undefined); assert.equal(r.vibrate, undefined); assert.equal(r.silent, undefined);
});

/* Dispara um botão da notificação com o armazém e o fetch falsos. */
async function botao(acao, estado, opc = {}) {
  const janelas = opc.janelas || [{ url: SCOPE, focus: () => Promise.resolve() }];
  const sw = carregar(janelas, {
    guardado: { ...(estado ? { pomodoro: estado } : {}), ...(opc.semCred ? {} : { cred: { id: 'dev1', segredo: 's3gr3d0' } }), ...(opc.guardado || {}) },
    fetch: opc.fetch
  });
  let fechou = false, espera = Promise.resolve();
  sw.ouvintes.notificationclick({ action: acao, notification: { close: () => { fechou = true; }, data: { url: SCOPE + '#pomodoro' } }, waitUntil: (p) => { espera = p; } });
  await espera;
  return { ...sw, fechou };
}
const rodandoFoco = (extra = {}) => { const t = Date.now(); return { ...global.__P.iniciar(global.__P.novo(), t - 5 * MIN), ...extra }; };
global.__P = require('../public/pomodoro.js');

test('botão Pausar: pausa, mostra "(pausado)" com Continuar/Parar, cancela o alarme no servidor e avisa as janelas', async () => {
  const r = await botao('pausar', rodandoFoco());
  assert.equal(r.guardado.get('pomodoro').rodando, false);
  assert.ok(Math.abs(r.guardado.get('pomodoro').restanteMs - 20 * MIN) < 5000);
  const [n] = r.mostradas;
  assert.equal(n.titulo, 'Foco 1 de 4 (pausado)'); assert.equal(n.tag, 'pomodoro'); assert.equal(n.silent, true);
  assert.deepEqual(L(n.actions.map((a) => a.action)), ['continuar', 'parar']);
  const [p] = r.pedidos;
  assert.equal(p.method, 'DELETE'); assert.equal(p.url, SCOPE + 'api/dispositivos/dev1/alarme');
  assert.equal(p.headers.Authorization, 'Bearer s3gr3d0');
  assert.deepEqual(L(r.mensagens), [{ tipo: 'pomodoro' }]);
  assert.ok(r.guardado.get('pomodoro').atualizadoEm > Date.now() - 5000, 'carimbo para o app saber que é mais novo');
  assert.deepEqual(r.abertas, [], 'não abre o app');
});

test('botão Continuar: volta a rodar, mostra o horário do fim e cria o alarme com a fase seguinte', async () => {
  const pausado = global.__P.pausar(rodandoFoco(), Date.now());
  const r = await botao('continuar', pausado);
  const e = r.guardado.get('pomodoro');
  assert.equal(e.rodando, true);
  const [n] = r.mostradas;
  assert.match(n.body, /^Termina às \d\d:\d\d$/);
  assert.deepEqual(L(n.actions.map((a) => a.action)), ['pausar', 'parar']);
  const [p] = r.pedidos;
  assert.equal(p.method, 'PUT'); assert.equal(p.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(p.body), { em: e.fimEm, fase: 'foco', proxima: 'pausa' });
});

test('botão Parar: zera, não deixa notificação e cancela o alarme', async () => {
  const r = await botao('parar', rodandoFoco({ ciclo: 3 }));
  const e = r.guardado.get('pomodoro');
  assert.deepEqual([e.fase, e.ciclo, e.rodando], ['foco', 1, false]);
  assert.equal(r.mostradas.length, 0); assert.ok(r.fechou);
  assert.equal(r.pedidos[0].method, 'DELETE');
});

test('botão Iniciar pausa (aviso de fim): conta o pomodoro, começa a pausa, guarda o check-in para o app e agenda o alarme da pausa', async () => {
  const fim = global.__P.vincular(global.__P.iniciar(global.__P.novo(), Date.now() - 26 * MIN), 'ingles'); // o foco acabou há 1 min
  const r = await botao('iniciar', fim);
  const e = r.guardado.get('pomodoro');
  assert.equal(e.fase, 'pausa'); assert.equal(e.rodando, true);
  assert.equal(global.__P.total(e), 1);
  assert.deepEqual(L(r.guardado.get('concluidos')).map((c) => c.contagemId), ['ingles']);
  assert.equal(r.mostradas[0].titulo, 'Pausa');
  assert.deepEqual(JSON.parse(r.pedidos[0].body), { em: e.fimEm, fase: 'pausa', proxima: 'foco' });
});

test('botão Iniciar toque duas vezes ou depois de o app já ter iniciado: não duplica pomodoro nem check-in', async () => {
  const fim = global.__P.vincular(global.__P.iniciar(global.__P.novo(), Date.now() - 26 * MIN), 'ingles');
  const a = await botao('iniciar', fim);
  const b = await botao('iniciar', a.guardado.get('pomodoro'), { guardado: { concluidos: a.guardado.get('concluidos') } });
  assert.equal(global.__P.total(b.guardado.get('pomodoro')), 1);
  assert.equal(b.guardado.get('concluidos').length, 1);
});

test('botão sem estado espelhado abre o app; sem credencial não chama o servidor; servidor fora não derruba a ação', async () => {
  const sem = await botao('pausar', null, { janelas: [] });
  assert.deepEqual(sem.abertas, [SCOPE + '#pomodoro']); assert.equal(sem.mostradas.length, 0);
  const semCred = await botao('pausar', rodandoFoco(), { semCred: true });
  assert.equal(semCred.pedidos.length, 0); assert.equal(semCred.guardado.get('pomodoro').rodando, false);
  const fora = await botao('pausar', rodandoFoco()); // o fetch falso rejeita
  assert.equal(fora.guardado.get('pomodoro').rodando, false);
  const lixo = await botao('dançar', rodandoFoco());
  assert.equal(lixo.guardado.get('pomodoro').rodando, true, 'ação desconhecida não muda nada');
});

test('o corpo da notificação (sem botão) continua abrindo o app na tela do Pomodoro', async () => {
  const r = await botao(undefined, rodandoFoco(), { janelas: [] });
  assert.deepEqual(r.abertas, [SCOPE + '#pomodoro']);
  assert.equal(r.guardado.get('pomodoro').rodando, true, 'tocar na notificação não pausa nada');
});
