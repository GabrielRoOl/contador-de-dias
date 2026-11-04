const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const versaoSw = Number(/contagem-de-dias-v(\d+)/.exec(sw)[1]);

test('CSS e JS do index.html têm ?v= igual à versão do cache do sw.js', () => {
  const arquivos = ['app.css', 'logica.js', 'textos.js', 'app.js'];
  arquivos.forEach((a) => {
    const m = new RegExp('(?:href|src)="' + a.replace('.', '\\.') + '\\?v=(\\d+)"').exec(html);
    assert.ok(m, a + ' sem ?v= no index.html (rode: node scripts/versao.js)');
    assert.equal(Number(m[1]), versaoSw, a + ' com versão diferente do sw.js');
  });
});

test('todo arquivo carregado pelo index.html está no pré-cache do sw.js', () => {
  const usados = [...html.matchAll(/(?:href|src)="([^"?]+)(?:\?v=\d+)?"/g)].map((m) => m[1]).filter((u) => !u.startsWith('http'));
  usados.forEach((u) => assert.ok(sw.includes("'./" + u + "'"), u + ' fora da lista ARQUIVOS do sw.js'));
});

test('as fontes referenciadas no CSS estão no pré-cache', () => {
  const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
  [...css.matchAll(/url\((fonts\/[^)]+)\)/g)].forEach((m) => assert.ok(sw.includes("'./" + m[1] + "'"), m[1] + ' fora do pré-cache'));
});
