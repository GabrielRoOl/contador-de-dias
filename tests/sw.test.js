const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const codigo = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');
const SCOPE = 'https://grodev.com.br/contador/';

/* Executa o sw.js com um "self" falso e devolve os ouvintes registrados e o que ele chamou. */
function carregar(janelas = []) {
  const ouvintes = {};
  const mostradas = [];
  const abertas = [];
  const sw = {
    registration: { scope: SCOPE, showNotification: (t, o) => { mostradas.push({ titulo: t, ...o }); return Promise.resolve(); } },
    addEventListener: (nome, f) => { ouvintes[nome] = f; },
    skipWaiting() {}, clients: { claim() {} }
  };
  const ctx = {
    self: sw, location: new URL(SCOPE + 'sw.js'), URL, Promise, setTimeout, clearTimeout, Response, Request, fetch: () => Promise.reject(new Error('sem rede')),
    caches: { open: () => Promise.resolve({ put() {}, match: () => Promise.resolve(undefined) }), keys: () => Promise.resolve([]) },
    clients: { matchAll: () => Promise.resolve(janelas), openWindow: (u) => { abertas.push(u); return Promise.resolve({}); } }
  };
  vm.runInNewContext(codigo, ctx);
  return { ouvintes, mostradas, abertas };
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
