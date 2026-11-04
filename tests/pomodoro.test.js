const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../public/pomodoro.js');

const MIN = 60000;
const T0 = new Date(2026, 10, 4, 10, 0, 0).getTime();
const dia0 = P.dataLocal(T0);

/* Roda um foco inteiro e devolve o estado já encerrado (esperando o toque na fase seguinte). */
function focoCompleto(e, t) {
  e = P.iniciar(e, t);
  return P.avancar(e, t + 25 * MIN).estado;
}

test('estado inicial: foco de 25 min, pronto, sem pomodoros', () => {
  const e = P.novo();
  assert.equal(e.fase, 'foco'); assert.equal(e.ciclo, 1);
  assert.equal(P.status(e), 'pronto');
  assert.equal(P.restante(e, T0), 25 * MIN);
  assert.equal(P.total(e), 0);
});

test('iniciar marca o fim 25 min à frente e o relógio desce', () => {
  const e = P.iniciar(P.novo(), T0);
  assert.equal(P.status(e), 'rodando');
  assert.equal(e.fimEm, T0 + 25 * MIN);
  assert.equal(P.restante(e, T0 + 10 * MIN), 15 * MIN);
  assert.equal(P.iniciar(e, T0 + MIN), e, 'iniciar de novo não muda nada');
});

test('pausar guarda o que falta e continuar recalcula o fim', () => {
  let e = P.iniciar(P.novo(), T0);
  e = P.pausar(e, T0 + 10 * MIN);
  assert.equal(P.status(e), 'pausado');
  assert.equal(P.restante(e, T0 + 99 * MIN), 15 * MIN, 'parado: o tempo não anda');
  e = P.iniciar(e, T0 + 30 * MIN);
  assert.equal(e.fimEm, T0 + 45 * MIN);
  assert.equal(P.avancar(e, T0 + 44 * MIN).concluiu, null);
  assert.ok(P.avancar(e, T0 + 45 * MIN).concluiu);
});

test('foco concluído conta um pomodoro no dia em que terminou e deixa a pausa esperando', () => {
  const e = P.iniciar(P.novo(), T0);
  const r = P.avancar(e, T0 + 25 * MIN);
  assert.deepEqual({ ...r.concluiu }, { fase: 'foco', proxima: 'pausa', contou: true, em: T0 + 25 * MIN, dia: dia0, contagemId: null });
  assert.equal(r.estado.fase, 'pausa');
  assert.equal(P.status(r.estado), 'pronto', 'a pausa não começa sozinha');
  assert.equal(P.restante(r.estado, T0), 5 * MIN);
  assert.equal(P.pomodorosDoDia(r.estado, dia0), 1);
});

test('antes da hora nada acontece', () => {
  const e = P.iniciar(P.novo(), T0);
  const r = P.avancar(e, T0 + 25 * MIN - 1);
  assert.equal(r.concluiu, null); assert.equal(r.estado, e);
  assert.equal(P.avancar(P.novo(), T0 + 99 * MIN).concluiu, null, 'parado não conclui');
});

test('ciclo completo: 4 focos, 3 pausas curtas e 1 longa, e volta ao início', () => {
  let e = P.novo(), t = T0;
  const fases = [];
  for (let i = 0; i < 8; i++) {
    fases.push(e.fase + e.ciclo);
    e = P.iniciar(e, t);
    t += P.restante(e, t);
    e = P.avancar(e, t).estado;
  }
  assert.deepEqual(fases, ['foco1', 'pausa1', 'foco2', 'pausa2', 'foco3', 'pausa3', 'foco4', 'longa4']);
  assert.equal(e.fase, 'foco'); assert.equal(e.ciclo, 1);
  assert.equal(P.pomodorosDoDia(e, dia0), 4);
  assert.equal(P.DURACAO.longa, 15 * MIN);
});

test('pausas não contam pomodoro', () => {
  let e = focoCompleto(P.novo(), T0);
  const antes = P.total(e);
  e = P.iniciar(e, T0 + 30 * MIN);
  const r = P.avancar(e, T0 + 35 * MIN);
  assert.equal(r.concluiu.contou, false);
  assert.equal(P.total(r.estado), antes);
});

test('pular um foco não conta e leva à pausa; pular a pausa leva ao próximo foco', () => {
  let e = P.iniciar(P.novo(), T0);
  e = P.pular(e);
  assert.equal(e.fase, 'pausa'); assert.equal(P.status(e), 'pronto'); assert.equal(P.total(e), 0);
  e = P.pular(e);
  assert.equal(e.fase, 'foco'); assert.equal(e.ciclo, 2);
});

test('parar cancela a sessão, não conta e volta ao primeiro foco; os pomodoros do dia ficam', () => {
  let e = focoCompleto(P.novo(), T0);
  e = P.pular(e);            // foco 2
  e = P.iniciar(e, T0 + 40 * MIN);
  e = P.parar(e);
  assert.equal(e.fase, 'foco'); assert.equal(e.ciclo, 1); assert.equal(P.status(e), 'pronto');
  assert.equal(P.pomodorosDoDia(e, dia0), 1);
});

test('app fechado por horas: só a fase que acabou é encerrada, sem recuperar o atraso', () => {
  const e = P.iniciar(P.novo(), T0);
  const r = P.avancar(e, T0 + 5 * 60 * MIN);
  assert.equal(r.concluiu.em, T0 + 25 * MIN);
  assert.equal(r.estado.fase, 'pausa');
  assert.equal(P.status(r.estado), 'pronto');
  assert.equal(P.total(r.estado), 1);
});

test('foco que termina depois da meia-noite conta no dia do fim', () => {
  const t = new Date(2026, 10, 4, 23, 50, 0).getTime();
  const r = P.avancar(P.iniciar(P.novo(), t), t + 25 * MIN);
  assert.equal(r.concluiu.dia, '2026-11-05');
  assert.equal(P.pomodorosDoDia(r.estado, '2026-11-05'), 1);
  assert.equal(P.pomodorosDoDia(r.estado, '2026-11-04'), 0);
});

test('relógio que voltou para trás não deixa a fase maior que a duração', () => {
  const e = P.iniciar(P.novo(), T0 + 5 * 60 * MIN); // fim em T0 + 5h25
  const r = P.avancar(e, T0);
  assert.equal(r.estado.fimEm, T0 + 25 * MIN);
});

test('o vínculo com a contagem vai no resultado da conclusão', () => {
  let e = P.vincular(P.novo(), 'abc');
  const r = P.avancar(P.iniciar(e, T0), T0 + 25 * MIN);
  assert.equal(r.concluiu.contagemId, 'abc');
  assert.equal(P.vincular(e, '').contagemId, null);
});

test('histórico: só dias com pomodoro, do mais recente ao mais antigo, e total', () => {
  const e = P.normalizar({ versao: 1, fase: 'foco', ciclo: 1, restanteMs: 25 * MIN, dias: { '2026-11-01': 2, '2026-11-03': 0, '2026-11-04': 3 } });
  assert.deepEqual(P.historico(e), [{ dia: '2026-11-04', n: 3 }, { dia: '2026-11-01', n: 2 }]);
  assert.equal(P.total(e), 5);
});

test('só os últimos 120 dias ficam guardados', () => {
  const dias = {};
  for (let i = 0; i < 130; i++) dias[P.dataLocal(new Date(2026, 0, 1 + i).getTime())] = 1;
  const e = P.normalizar({ versao: 1, fase: 'foco', ciclo: 1, restanteMs: 25 * MIN, dias });
  assert.equal(Object.keys(e.dias).length, P.MAX_DIAS);
  assert.ok(!('2026-01-01' in e.dias));
  const r = P.avancar(P.iniciar(focoCompleto(P.novo(), T0), T0 + 99 * MIN), T0 + 99 * MIN + 5 * MIN);
  assert.ok(Object.keys(r.estado.dias).length <= P.MAX_DIAS);
});

test('guardar e carregar devolve o mesmo estado, inclusive rodando e pausado', () => {
  const mem = {};
  const arm = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); } };
  let e = P.vincular(P.iniciar(P.novo(), T0), 'x1');
  assert.ok(P.salvar(arm, e));
  assert.deepEqual(P.carregar(arm), e);
  e = P.pausar(e, T0 + 7 * MIN);
  P.salvar(arm, e);
  const c = P.carregar(arm);
  assert.equal(P.status(c), 'pausado'); assert.equal(c.restanteMs, 18 * MIN); assert.equal(c.contagemId, 'x1');
});

test('dados guardados corrompidos ou estranhos voltam ao estado inicial sem quebrar', () => {
  const arm = (txt) => ({ getItem: () => txt });
  for (const lixo of [null, '', '{quebrado', '[]', '"x"', '{"versao":2}', '{"versao":1,"fase":"x"}', '{"versao":1,"fase":"foco","ciclo":9}', '{"versao":1,"fase":"foco","ciclo":1.5}']) {
    assert.deepEqual(P.carregar(arm(lixo)), P.novo(), String(lixo));
  }
  const e = P.normalizar({ versao: 1, fase: 'pausa', ciclo: 2, restanteMs: 99 * MIN, dias: { lixo: 5, '2026-11-04': -1, '2026-11-05': 2.5, '2026-11-06': 2 }, contagemId: 42 });
  assert.equal(e.restanteMs, 5 * MIN, 'tempo restante maior que a fase é descartado');
  assert.deepEqual(e.dias, { '2026-11-06': 2 });
  assert.equal(e.contagemId, null);
  assert.equal(P.salvar({ setItem() { throw new Error('cheio'); } }, e), false, 'storage cheio não lança');
});

test('formatarTempo arredonda para cima e nunca fica negativo', () => {
  assert.equal(P.formatarTempo(25 * MIN), '25:00');
  assert.equal(P.formatarTempo(25 * MIN - 1), '25:00');
  assert.equal(P.formatarTempo(59001), '01:00');
  assert.equal(P.formatarTempo(1), '00:01');
  assert.equal(P.formatarTempo(0), '00:00');
  assert.equal(P.formatarTempo(-5), '00:00');
});
