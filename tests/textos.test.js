const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../public/textos.js');

const m = (extra) => ({ tipoContagem: 'parar', nome: 'refrigerante', dias: 7, marco: { tipo: 'semana', n: 1 }, seed: 'a1:7', ...extra });

test.describe('textos de marco', () => {
  test('parar: semana, mês e ano', () => {
    assert.match(T.marco(m()), /^7 dias sem refrigerante\. /);
    assert.match(T.marco(m({ dias: 30, marco: { tipo: 'mes', n: 1 } })), /^1 mês sem refrigerante\. /);
    assert.match(T.marco(m({ dias: 365, marco: { tipo: 'ano', n: 1 } })), /^1 ano sem refrigerante\. /);
  });
  test('plural de meses e anos', () => {
    assert.match(T.marco(m({ dias: 90, marco: { tipo: 'mes', n: 3 } })), /^3 meses sem /);
    assert.match(T.marco(m({ dias: 731, marco: { tipo: 'ano', n: 2 } })), /^2 anos sem /);
  });
  test('manter usa "seguidos"', () => {
    const t = T.marco(m({ tipoContagem: 'manter', nome: 'estudando inglês', dias: 14, marco: { tipo: 'semana', n: 2 } }));
    assert.match(t, /^14 dias seguidos estudando inglês\. /);
  });
  test('mesma semente, mesma frase', () => {
    assert.equal(T.marco(m()), T.marco(m()));
  });
  test('há variação entre sementes', () => {
    const frases = new Set();
    for (let i = 0; i < 40; i++) frases.add(T.marco(m({ seed: 'x' + i })));
    assert.ok(frases.size > 1);
  });
  test('o ano tem frase própria, diferente da semana', () => {
    for (let i = 0; i < 20; i++) assert.doesNotMatch(T.marco(m({ dias: 365, marco: { tipo: 'ano', n: 1 }, seed: 's' + i })), /semana/i);
  });
});

test.describe('outros textos', () => {
  test('retomada cita o recorde e nunca "0 dias"', () => {
    for (let i = 0; i < 20; i++) {
      const t = T.retomada({ tipoContagem: 'parar', recorde: 12, seed: 's' + i });
      assert.match(t, /12 dias/);
      assert.doesNotMatch(t, /\b0 dias/);
    }
    assert.match(T.retomada({ tipoContagem: 'manter', recorde: 1, seed: 'z' }), /1 dia\b/);
  });
  test('próxima marca em dias e horas', () => {
    assert.equal(T.proxima({ tipo: 'semana', n: 1 }, 4), 'Próxima marca: Uma semana · faltam 4 dias');
    assert.equal(T.proxima({ tipo: 'mes', n: 2 }, 0.5), 'Próxima marca: 2 meses · faltam 12 h');
    assert.equal(T.proxima({ tipo: 'ano', n: 1 }, 0.9), 'Próxima marca: Um ano · faltam 22 h');
    assert.equal(T.proxima({ tipo: 'semana', n: 3 }, 1), 'Próxima marca: 3 semanas · falta 1 dia');
  });
  test('aviso de recomeço', () => {
    assert.match(T.avisoRecomeco(20, 10), /viram seu recorde/);
    assert.match(T.avisoRecomeco(5, 10), /recorde de 10 dias continua salvo/);
  });
  test('economia', () => {
    assert.equal(T.economia('R$ 52,00'), 'Você já economizou R$ 52,00.');
  });
});
