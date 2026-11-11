const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../public/cronograma.js');

const T0 = new Date(2026, 10, 11, 7, 0, 0).getTime();
const treino = { nome: 'Treino rápido', passos: [{ nome: 'Prancha', seg: 120 }, { nome: 'Agachamento', seg: 300 }, { nome: 'Flexão', seg: 300 }] };
const comTreino = () => C.criarRotina(C.novo(), treino, 'r1');
const rodando = (t = T0) => C.iniciar(C.abrir(comTreino(), 'r1'), t);

test('criar rotina valida nome, passos e tempos, e limpa espaços', () => {
  const e = C.criarRotina(C.novo(), { nome: '  Treino  ', passos: [{ nome: ' Prancha ', seg: 120.4 }] }, 'a');
  assert.deepEqual(e.rotinas[0], { id: 'a', nome: 'Treino', passos: [{ nome: 'Prancha', seg: 120 }], intervalo: 0, feitas: 0, ultima: null });
  const ruim = (d, msg) => assert.throws(() => C.criarRotina(C.novo(), d, 'x'), msg);
  ruim({ nome: '', passos: [{ nome: 'a', seg: 60 }] }, /nome ao cronograma/);
  ruim({ nome: 'x'.repeat(41), passos: [{ nome: 'a', seg: 60 }] }, /até 40/);
  ruim({ nome: 'x', passos: [] }, /pelo menos um passo/);
  ruim({ nome: 'x', passos: new Array(21).fill({ nome: 'a', seg: 60 }) }, /No máximo 20/);
  ruim({ nome: 'x', passos: [{ nome: '', seg: 60 }] }, /passo 1 precisa de um nome/);
  ruim({ nome: 'x', passos: [{ nome: 'a', seg: 4 }] }, /pelo menos 5 segundos/);
  ruim({ nome: 'x', passos: [{ nome: 'a', seg: 7201 }] }, /no máximo 120 minutos/);
  ruim({ nome: 'x', passos: [{ nome: 'a', seg: 'abc' }] }, /pelo menos 5 segundos/);
});

test('limite de rotinas salvas', () => {
  let e = C.novo();
  for (let i = 0; i < C.LIMITES.rotinas; i++) e = C.criarRotina(e, treino, 'r' + i);
  assert.throws(() => C.criarRotina(e, treino, 'mais'), /No máximo 30/);
});

test('abrir deixa tudo zerado e esperando Iniciar', () => {
  const e = C.abrir(comTreino(), 'r1');
  assert.equal(C.status(e), 'pronto');
  assert.equal(C.restante(e, T0), 120000);
  assert.equal(e.sessao.passo, 0);
  assert.equal(C.status(C.abrir(comTreino(), 'nao-existe')), null);
  assert.equal(C.totalSeg(e.rotinas[0]), 720);
});

test('iniciar, pausar e continuar mantêm o tempo que resta', () => {
  let e = rodando();
  assert.equal(C.status(e), 'rodando');
  e = C.pausar(e, T0 + 50000);
  assert.equal(C.status(e), 'pausado'); assert.equal(C.restante(e, T0 + 999999), 70000);
  e = C.iniciar(e, T0 + 100000);
  assert.equal(e.sessao.fimEm, T0 + 170000);
  assert.equal(C.iniciar(e, T0 + 120000), e, 'iniciar de novo não muda nada');
  const pronto = C.abrir(comTreino(), 'r1');
  assert.deepEqual(C.pausar(pronto, T0), pronto, 'pausar sem estar rodando não muda nada');
});

test('os passos seguem sozinhos e os horários se encadeiam sem acumular atraso', () => {
  let e = rodando();
  let r = C.avancar(e, T0 + 119999);
  assert.equal(r.concluiu, null);
  r = C.avancar(e, T0 + 125000); // 5 s depois do fim da prancha
  assert.deepEqual(r.concluiu.passos.map((p) => p.nome), ['Prancha']);
  assert.equal(r.concluiu.terminou, false);
  assert.equal(r.estado.sessao.passo, 1);
  assert.equal(r.estado.sessao.fimEm, T0 + 120000 + 300000, 'o agachamento termina 5 min depois do fim da prancha, não 5 min depois do atraso');
  assert.equal(C.status(r.estado), 'rodando');
});

test('app fechado por muito tempo: fecha todos os passos que passaram e para no certo', () => {
  const r = C.avancar(rodando(), T0 + 120000 + 300000 + 10000); // prancha e agachamento acabaram, flexão em andamento
  assert.deepEqual(r.concluiu.passos.map((p) => p.nome), ['Prancha', 'Agachamento']);
  assert.equal(r.estado.sessao.passo, 2);
  assert.equal(C.restante(r.estado, T0 + 120000 + 300000 + 10000), 290000);
});

test('ao acabar o último passo: concluído, uma vez feita, com a data em que terminou', () => {
  const fim = T0 + 720000;
  const r = C.avancar(rodando(), fim + 3 * 3600000);
  assert.equal(r.concluiu.terminou, true); assert.equal(r.concluiu.passos.length, 3); assert.equal(r.concluiu.em, fim);
  assert.equal(C.status(r.estado), 'concluido');
  assert.equal(r.estado.rotinas[0].feitas, 1); assert.equal(r.estado.rotinas[0].ultima, C.dataLocal(fim));
  assert.equal(C.avancar(r.estado, fim + 9999999).concluiu, null, 'não conta duas vezes');
  assert.equal(C.restante(r.estado, fim), 0);
});

test('refazer: iniciar depois de concluído recomeça do zero, e a contagem de feitas sobe só ao terminar de novo', () => {
  let e = C.avancar(rodando(), T0 + 720000).estado;
  e = C.iniciar(e, T0 + 800000);
  assert.equal(C.status(e), 'rodando'); assert.equal(e.sessao.passo, 0); assert.equal(e.rotinas[0].feitas, 1);
  e = C.avancar(e, T0 + 800000 + 720000).estado;
  assert.equal(e.rotinas[0].feitas, 2);
});

test('parar volta ao começo sem contar; pular avança (e no último encerra sem contar)', () => {
  let e = C.parar(C.avancar(rodando(), T0 + 130000).estado);
  assert.equal(C.status(e), 'pronto'); assert.equal(e.sessao.passo, 0); assert.equal(e.rotinas[0].feitas, 0);
  e = rodando();
  e = C.pular(e, T0 + 10000);
  assert.equal(e.sessao.passo, 1); assert.equal(e.sessao.fimEm, T0 + 10000 + 300000);
  e = C.pular(C.pausar(e, T0 + 12000), T0 + 13000);
  assert.equal(e.sessao.passo, 2); assert.equal(e.sessao.rodando, false); assert.equal(C.restante(e, T0 + 99999), 300000, 'pulou pausado: o próximo passo começa inteiro e parado');
  e = C.pular(e, T0 + 30000);
  assert.equal(C.status(e), 'concluido'); assert.equal(e.rotinas[0].feitas, 0, 'pular o último não conta como feito');
  assert.equal(C.pular(C.abrir(comTreino(), 'r1'), T0).sessao.passo, 0, 'pronto não pula');
});

test('relógio que voltou para trás não deixa o passo maior que o previsto', () => {
  const r = C.avancar(rodando(T0 + 99999999), T0);
  assert.equal(r.estado.sessao.fimEm, T0 + 120000);
});

test('alarmes do servidor: um por fim de passo, encadeados, só enquanto roda', () => {
  const a = C.alarmesDe(rodando());
  assert.deepEqual(a.map((x) => x.em), [T0 + 120000, T0 + 420000, T0 + 720000]);
  assert.deepEqual(a[0], { em: T0 + 120000, titulo: 'Passo concluído', corpo: 'Prancha. Agora: Agachamento · 5 min' });
  assert.deepEqual(a[2], { em: T0 + 720000, titulo: 'Cronograma concluído', corpo: 'Treino rápido' });
  assert.equal(C.alarmesDe(C.pausar(rodando(), T0 + 1000)).length, 0);
  assert.equal(C.alarmesDe(C.abrir(comTreino(), 'r1')).length, 0);
  const meio = C.alarmesDe(C.avancar(rodando(), T0 + 130000).estado);
  assert.deepEqual(meio.map((x) => x.em), [T0 + 420000, T0 + 720000], 'só o que falta');
});

test('mexer ou apagar a rotina encerra a sessão dela', () => {
  const e = rodando();
  assert.equal(C.atualizarRotina(e, 'r1', { nome: 'Novo', passos: [{ nome: 'a', seg: 30 }] }).sessao, null);
  assert.equal(C.excluirRotina(e, 'r1').sessao, null);
  assert.equal(C.excluirRotina(e, 'r1').rotinas.length, 0);
});

test('formatar duração e tempo', () => {
  assert.equal(C.formatarDuracao(120), '2 min'); assert.equal(C.formatarDuracao(90), '1 min 30 s');
  assert.equal(C.formatarDuracao(45), '45 s'); assert.equal(C.formatarDuracao(3720), '1 h 2 min');
  assert.equal(C.formatarTempo(65000), '01:05'); assert.equal(C.formatarTempo(0), '00:00');
});

test('normalizar descarta lixo, repetidos e sessões inválidas, e mantém o resto', () => {
  assert.deepEqual(C.normalizar(null), C.novo());
  assert.deepEqual(C.normalizar({ versao: 2, rotinas: [] }), C.novo());
  const bom = rodando();
  const volta = C.normalizar(JSON.parse(JSON.stringify(bom)));
  assert.equal(volta.sessao.rodando, true); assert.equal(volta.rotinas[0].passos.length, 3);
  const sujo = { versao: 1, rotinas: [bom.rotinas[0], bom.rotinas[0], { id: 'x', nome: '', passos: [] }, { id: 5 }, null, { id: 'y', nome: 'ok', passos: [{ nome: 'a', seg: 1 }] }], sessao: { rotinaId: 'zzz' } };
  const n = C.normalizar(sujo);
  assert.equal(n.rotinas.length, 1, 'repetido, vazio, id errado e passo de 1 s caem'); assert.equal(n.sessao, null);
  assert.equal(C.normalizar({ ...bom, sessao: { ...bom.sessao, passo: 99 } }).sessao, null);
  assert.equal(C.normalizar({ ...bom, sessao: { ...bom.sessao, passo: 3 } }).sessao.passo, 3, 'passo = total é concluído');
  assert.equal(C.status(C.normalizar({ ...bom, sessao: { ...bom.sessao, passo: 3 } })), 'concluido');
  assert.equal(C.normalizar({ ...bom, rotinas: [{ ...bom.rotinas[0], feitas: -3, ultima: 'ontem' }] }).rotinas[0].feitas, 0);
  assert.equal(C.normalizar({ ...bom, sessao: { ...bom.sessao, rodando: true, fimEm: 'x' } }).sessao.rodando, false);
});

test('carregar e salvar passam pelo armazenamento, e armazenamento quebrado não derruba', () => {
  const m = {}; const arm = { getItem: (k) => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = v; } };
  assert.deepEqual(C.carregar(arm), C.novo());
  assert.equal(C.salvar(arm, rodando()), true);
  assert.equal(C.carregar(arm).rotinas[0].nome, 'Treino rápido');
  assert.equal(C.salvar({ setItem() { throw new Error('cheio'); } }, rodando()), false);
  assert.deepEqual(C.carregar({ getItem() { throw new Error('x'); } }), C.novo());
});

/* ---------- intervalo (descanso) entre os passos ---------- */
const comIntervalo = (iv = 30) => C.criarRotina(C.novo(), Object.assign({}, treino, { intervalo: iv }), 'r1');
const rodandoIv = (iv = 30, t = T0) => C.iniciar(C.abrir(comIntervalo(iv), 'r1'), t);

test('intervalo: só aceita 15, 30, 45 ou 60 s; qualquer outra coisa vira sem intervalo', () => {
  assert.deepEqual(C.INTERVALOS, [0, 15, 30, 45, 60]);
  for (const iv of [15, 30, 45, 60]) assert.equal(comIntervalo(iv).rotinas[0].intervalo, iv);
  for (const iv of [undefined, null, 'abc', 20, -5, 90]) assert.equal(C.criarRotina(C.novo(), Object.assign({}, treino, { intervalo: iv }), 'x').rotinas[0].intervalo, 0);
});

test('intervalo: o total soma os descansos entre os passos, nunca depois do último', () => {
  assert.equal(C.totalSeg(comTreino().rotinas[0]), 720);
  assert.equal(C.totalSeg(comIntervalo(30).rotinas[0]), 720 + 2 * 30);
  const um = C.criarRotina(C.novo(), { nome: 'x', passos: [{ nome: 'a', seg: 60 }], intervalo: 60 }, 'u');
  assert.equal(C.totalSeg(um.rotinas[0]), 60);
});

test('intervalo: depois de cada passo entra um descanso, e o último passo não tem descanso depois', () => {
  let e = rodandoIv(30);
  let r = C.avancar(e, T0 + 120000);
  assert.deepEqual(r.concluiu.passos, [{ indice: 0, nome: 'Prancha', descanso: false }]);
  assert.equal(r.estado.sessao.passo, 1); assert.equal(r.estado.sessao.descanso, true);
  assert.equal(C.duracaoFase(r.estado), 30000); assert.equal(C.restante(r.estado, T0 + 120000), 30000);
  r = C.avancar(r.estado, T0 + 150000);
  assert.equal(r.estado.sessao.passo, 1); assert.equal(r.estado.sessao.descanso, false);
  assert.equal(C.duracaoFase(r.estado), 300000);
  r = C.avancar(r.estado, T0 + 450000 + 30000 + 300000);
  assert.equal(r.concluiu.terminou, true); assert.equal(r.estado.rotinas[0].feitas, 1);
  assert.equal(C.status(r.estado), 'concluido');
  assert.equal(r.concluiu.passos.filter((f) => f.descanso).length, 1);
  assert.equal(r.concluiu.em, T0 + 120000 + 30000 + 300000 + 30000 + 300000);
});

test('intervalo: com o app fechado, vários passos e descansos de uma vez, sem acumular atraso', () => {
  const r = C.avancar(rodandoIv(15), T0 + 120000 + 15000 + 300000 + 5000); // passou prancha, descanso, agachamento; no 2º descanso
  assert.equal(r.estado.sessao.passo, 2); assert.equal(r.estado.sessao.descanso, true);
  assert.equal(r.estado.sessao.fimEm, T0 + 120000 + 15000 + 300000 + 15000);
  assert.equal(r.concluiu.terminou, false);
});

test('intervalo: pular no passo vai ao descanso; pular o descanso vai ao passo; pular o último encerra', () => {
  let e = C.pular(rodandoIv(30), T0 + 1000);
  assert.equal(e.sessao.passo, 1); assert.equal(e.sessao.descanso, true); assert.equal(e.sessao.fimEm, T0 + 1000 + 30000);
  e = C.pular(e, T0 + 2000);
  assert.equal(e.sessao.passo, 1); assert.equal(e.sessao.descanso, false); assert.equal(e.sessao.fimEm, T0 + 2000 + 300000);
  e = C.pular(C.pular(e, T0 + 3000), T0 + 4000); // passo 2 -> descanso -> passo 3
  assert.equal(e.sessao.passo, 2); assert.equal(e.sessao.descanso, false);
  e = C.pular(e, T0 + 5000);
  assert.equal(C.status(e), 'concluido'); assert.equal(e.rotinas[0].feitas, 0);
});

test('intervalo: pausar durante o descanso guarda o que faltava e continuar volta ao descanso', () => {
  let e = C.avancar(rodandoIv(30), T0 + 120000).estado;
  e = C.pausar(e, T0 + 120000 + 12000);
  assert.equal(C.status(e), 'pausado'); assert.equal(e.sessao.descanso, true); assert.equal(e.sessao.restanteMs, 18000);
  e = C.iniciar(e, T0 + 200000);
  assert.equal(e.sessao.fimEm, T0 + 200000 + 18000);
});

test('intervalo: avisos de servidor para cada fim de passo e de descanso', () => {
  const l = C.alarmesDe(rodandoIv(30));
  assert.equal(l.length, 5);
  assert.deepEqual(l.map((a) => a.em), [T0 + 120000, T0 + 150000, T0 + 450000, T0 + 480000, T0 + 780000]);
  assert.deepEqual(l[0], { em: T0 + 120000, titulo: 'Passo concluído', corpo: 'Prancha. Descanse 30 s. Próximo: Agachamento' });
  assert.deepEqual(l[1], { em: T0 + 150000, titulo: 'Descanso acabou', corpo: 'Agora: Agachamento · 5 min' });
  assert.equal(l[4].titulo, 'Cronograma concluído');
  // durante o descanso, só o que ainda falta
  const d = C.alarmesDe(C.avancar(rodandoIv(30), T0 + 121000).estado);
  assert.equal(d.length, 4); assert.equal(d[0].titulo, 'Descanso acabou');
  // sem intervalo, igual a antes
  assert.equal(C.alarmesDe(rodando()).length, 3);
});

test('intervalo: sessão e rotina salvas voltam do armazenamento; rotina antiga fica sem intervalo', () => {
  const guardado = new Map(); const arm = { getItem: (k) => guardado.get(k) ?? null, setItem: (k, v) => guardado.set(k, v) };
  const e = C.avancar(rodandoIv(45), T0 + 120000).estado;
  C.salvar(arm, e);
  const volta = C.carregar(arm);
  assert.equal(volta.rotinas[0].intervalo, 45); assert.equal(volta.sessao.descanso, true); assert.equal(volta.sessao.fimEm, e.sessao.fimEm);
  const antigo = C.normalizar({ versao: 1, rotinas: [{ id: 'a', nome: 'x', passos: [{ nome: 'p', seg: 60 }], feitas: 0, ultima: null }], sessao: null });
  assert.equal(antigo.rotinas[0].intervalo, 0);
  // descanso na sessão de uma rotina sem intervalo é descartado
  const ruim = C.normalizar({ versao: 1, rotinas: [{ id: 'a', nome: 'x', passos: [{ nome: 'p', seg: 60 }, { nome: 'q', seg: 60 }], feitas: 0, ultima: null }], sessao: { rotinaId: 'a', passo: 1, descanso: true, rodando: false } });
  assert.equal(ruim.sessao.descanso, false);
});
