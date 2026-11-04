const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/logica.js');

const DIA = L.DAY;
const AGORA = new Date(2026, 10, 3, 12, 0).getTime();
const atras = (dias, horas = 0, min = 0) => AGORA - (dias * DIA + horas * 36e5 + min * 6e4);

function armazenamentoFalso(inicial = {}) {
  const dados = { ...inicial };
  return {
    dados,
    getItem: (k) => (k in dados ? dados[k] : null),
    setItem: (k, v) => { dados[k] = String(v); }
  };
}

test.describe('calcular', () => {
  test('divide em dias, horas e minutos', () => {
    const r = L.calcular(atras(12, 5, 18), AGORA);
    assert.deepEqual([r.dias, r.horas, r.minutos], [12, 5, 18]);
  });
  test('início no futuro vira zero', () => {
    const r = L.calcular(AGORA + DIA, AGORA);
    assert.deepEqual([r.dias, r.horas, r.minutos], [0, 0, 0]);
  });
  test('23h59 ainda é dia 0', () => {
    assert.equal(L.calcular(atras(0, 23, 59), AGORA).dias, 0);
  });
});

test.describe('dataLocal e ordinal', () => {
  test('formata a data local com zeros', () => {
    assert.equal(L.dataLocal(new Date(2026, 0, 5, 23, 59).getTime()), '2026-01-05');
  });
  test('ordinais consecutivos atravessam mês e ano', () => {
    assert.equal(L.ordinal('2027-01-01') - L.ordinal('2026-12-31'), 1);
    assert.equal(L.ordinal('2026-03-01') - L.ordinal('2026-02-28'), 1);
    assert.equal(L.ordinal('2028-03-01') - L.ordinal('2028-02-28'), 2);
  });
});

test.describe('marcos', () => {
  test('múltiplos de 7, 30, 50 e 100', () => {
    assert.equal(L.marcoDoDia(7), 7);
    assert.equal(L.marcoDoDia(14), 7);
    assert.equal(L.marcoDoDia(30), 30);
    assert.equal(L.marcoDoDia(50), 50);
    assert.equal(L.marcoDoDia(100), 100);
  });
  test('vale o maior quando o dia cai em mais de um', () => {
    assert.equal(L.marcoDoDia(210), 30); // 7 e 30
    assert.equal(L.marcoDoDia(350), 50); // 7 e 50
    assert.equal(L.marcoDoDia(150), 50); // 30 e 50
    assert.equal(L.marcoDoDia(300), 100); // 30, 50 e 100
    assert.equal(L.marcoDoDia(700), 100); // 7 e 100
  });
  test('dias comuns, zero e inválidos não são marco', () => {
    [0, 1, 6, 8, 29, 31, 99, -7, 3.5, NaN].forEach((n) => assert.equal(L.marcoDoDia(n), null, String(n)));
  });
  test('recorrente: todo múltiplo de 7 até 1000 é marco', () => {
    for (let n = 7; n <= 1000; n += 7) assert.ok(L.marcoDoDia(n), String(n));
  });
  test('próximo marco', () => {
    assert.deepEqual(L.proximoMarco(0), { dia: 7, intervalo: 7, faltam: 7 });
    assert.deepEqual(L.proximoMarco(7), { dia: 14, intervalo: 7, faltam: 7 });
    assert.deepEqual(L.proximoMarco(28), { dia: 30, intervalo: 30, faltam: 2 });
    assert.deepEqual(L.proximoMarco(98), { dia: 100, intervalo: 100, faltam: 2 });
  });
  test('próximo marco com dias fracionados', () => {
    const r = L.proximoMarco(6.5);
    assert.equal(r.dia, 7);
    assert.equal(r.faltam, 0.5);
  });
});

test.describe('economia', () => {
  test('dias completos vezes o custo por dia', () => {
    assert.equal(L.economia(26, 2), 52);
  });
  test('arredonda para centavos', () => {
    assert.equal(L.economia(3, 0.1), 0.3);
    assert.equal(L.economia(7, 4.55), 31.85);
  });
  test('sem custo ou custo inválido não há economia', () => {
    [null, undefined, 0, -3, '5', NaN].forEach((c) => assert.equal(L.economia(10, c), null, String(c)));
  });
  test('zero dias economiza zero', () => {
    assert.equal(L.economia(0, 5), 0);
  });
  test('formata em reais', () => {
    assert.equal(L.formatarReais(52).replace(/\s/g, ' '), 'R$ 52,00');
    assert.equal(L.formatarReais(1234.5).replace(/\s/g, ' '), 'R$ 1.234,50');
  });
});

test.describe('sequência de check-in', () => {
  test('conta dias consecutivos terminando hoje', () => {
    const r = L.sequenciaCheckins(['2026-11-01', '2026-11-02', '2026-11-03'], '2026-11-03');
    assert.deepEqual(r, { dias: 3, feitoHoje: true });
  });
  test('sem check-in hoje, a de ontem continua viva', () => {
    const r = L.sequenciaCheckins(['2026-11-01', '2026-11-02'], '2026-11-03');
    assert.deepEqual(r, { dias: 2, feitoHoje: false });
  });
  test('pular um dia quebra a sequência', () => {
    const r = L.sequenciaCheckins(['2026-10-30', '2026-11-01', '2026-11-02'], '2026-11-03');
    assert.equal(r.dias, 2);
  });
  test('último check-in anteontem: sequência zerada', () => {
    assert.deepEqual(L.sequenciaCheckins(['2026-11-01'], '2026-11-03'), { dias: 0, feitoHoje: false });
  });
  test('sem check-ins', () => {
    assert.deepEqual(L.sequenciaCheckins([], '2026-11-03'), { dias: 0, feitoHoje: false });
  });
  test('atravessa virada de mês e de ano', () => {
    assert.equal(L.sequenciaCheckins(['2026-12-30', '2026-12-31', '2027-01-01'], '2027-01-01').dias, 3);
  });
  test('ignora duplicados e desordem', () => {
    assert.equal(L.sequenciaCheckins(['2026-11-03', '2026-11-01', '2026-11-02', '2026-11-03'], '2026-11-03').dias, 3);
  });
  test('maior sequência histórica', () => {
    assert.equal(L.maiorSequencia(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-10', '2026-10-11']), 3);
    assert.equal(L.maiorSequencia([]), 0);
  });
  test('registrar check-in é idempotente, ordenado e não altera o original', () => {
    const c = { checkins: ['2026-11-02'] };
    const a = L.registrarCheckin(c, '2026-11-01');
    const b = L.registrarCheckin(a, '2026-11-01');
    assert.deepEqual(b.checkins, ['2026-11-01', '2026-11-02']);
    assert.deepEqual(c.checkins, ['2026-11-02']);
  });
});

test.describe('contagem: criar, deslize, recomeço', () => {
  const base = () => L.criarContagem({ nome: 'Refrigerante', tipo: 'parar', inicio: atras(10), custoDia: 2 }, AGORA, 'a1');

  test('cria com todos os campos do modelo v2', () => {
    assert.deepEqual(base(), {
      id: 'a1', nome: 'Refrigerante', tipo: 'parar', inicio: atras(10), custoDia: 2,
      recorde: 0, deslizes: [], tentativas: [], checkins: []
    });
  });
  test('valida nome, tipo e data', () => {
    const ok = { nome: 'x', tipo: 'parar', inicio: atras(1) };
    assert.throws(() => L.criarContagem({ ...ok, nome: '   ' }, AGORA, 'i'), /nome/);
    assert.throws(() => L.criarContagem({ ...ok, nome: 'a'.repeat(61) }, AGORA, 'i'), /60/);
    assert.throws(() => L.criarContagem({ ...ok, tipo: 'outro' }, AGORA, 'i'), /Tipo/);
    assert.throws(() => L.criarContagem({ ...ok, inicio: AGORA + 1 }, AGORA, 'i'), /futuro/);
    assert.throws(() => L.criarContagem({ ...ok, inicio: NaN }, AGORA, 'i'), /inválida/);
  });
  test('custoDia só vale para "parar" e se for positivo', () => {
    assert.equal(L.criarContagem({ nome: 'x', tipo: 'manter', inicio: atras(1), custoDia: 5 }, AGORA, 'i').custoDia, null);
    assert.equal(L.criarContagem({ nome: 'x', tipo: 'parar', inicio: atras(1), custoDia: 0 }, AGORA, 'i').custoDia, null);
  });
  test('nome é aparado', () => {
    assert.equal(L.criarContagem({ nome: '  Café  ', tipo: 'parar', inicio: atras(1) }, AGORA, 'i').nome, 'Café');
  });

  test('deslize não zera a sequência e entra no histórico', () => {
    const c = base();
    const d = L.registrarDeslize(c, AGORA, '  festa  ');
    assert.equal(d.inicio, c.inicio);
    assert.deepEqual(d.deslizes, [{ em: AGORA, nota: 'festa' }]);
    assert.deepEqual(c.deslizes, []);
    assert.equal(L.registrarDeslize(d, AGORA + 1).deslizes.length, 2);
  });
  test('deslize sem nota guarda nota vazia', () => {
    assert.equal(L.registrarDeslize(base(), AGORA).deslizes[0].nota, '');
  });

  test('recomeçar guarda a tentativa, atualiza o recorde e começa agora', () => {
    const r = L.recomecar(base(), AGORA);
    assert.equal(r.inicio, AGORA);
    assert.equal(r.recorde, 10);
    assert.deepEqual(r.tentativas, [{ inicio: atras(10), fim: AGORA, dias: 10, nota: '' }]);
  });
  test('recorde maior que a tentativa atual é mantido', () => {
    const c = { ...base(), recorde: 30 };
    assert.equal(L.recomecar(c, AGORA).recorde, 30);
  });
  test('recomeço em outro momento (ontem)', () => {
    const ontem = AGORA - DIA;
    const r = L.recomecar(base(), AGORA, { em: ontem, nota: 'estresse' });
    assert.equal(r.inicio, ontem);
    assert.deepEqual(r.tentativas[0], { inicio: atras(10), fim: ontem, dias: 9, nota: 'estresse' });
    assert.equal(r.recorde, 9);
  });
  test('recomeço inválido: futuro, antes do início, NaN', () => {
    assert.throws(() => L.recomecar(base(), AGORA, { em: AGORA + 1 }), /futuro/);
    assert.throws(() => L.recomecar(base(), AGORA, { em: atras(11) }), /antes/);
    assert.throws(() => L.recomecar(base(), AGORA, { em: NaN }), /inválida/);
  });
  test('não altera a contagem original', () => {
    const c = base();
    L.recomecar(c, AGORA);
    assert.equal(c.tentativas.length, 0);
    assert.equal(c.recorde, 0);
  });

  test('estatísticas somam todas as tentativas', () => {
    let c = base();
    c = L.recomecar(c, AGORA);                       // 10 dias, recomeça agora
    c = { ...c, inicio: atras(4) };                  // tentativa atual com 4 dias
    c = L.registrarDeslize(c, atras(2), '');
    c = L.registrarDeslize(c, atras(1), '');
    assert.deepEqual(L.estatisticasParar(c, AGORA), {
      sequenciaAtual: 4, recorde: 10, totalDias: 14, deslizes: 2, tentativas: 2
    });
  });
  test('recorde exibido acompanha a sequência atual quando a supera', () => {
    const c = { ...base(), recorde: 5 };
    assert.equal(L.estatisticasParar(c, AGORA).recorde, 10);
  });
});

test.describe('migração v1 -> v2', () => {
  const v1 = {
    counters: [
      { id: 'x1', name: 'Refrigerante', start: 1761000000000, best: 12 },
      { id: 'x2', name: 'Cigarro', start: 1750000000123, best: 0 }
    ],
    updatedAt: 1762000000000
  };

  test('converte cada contagem sem perder datas', () => {
    const v2 = L.migrarV1(v1, AGORA, 'America/Sao_Paulo');
    assert.equal(v2.versao, 2);
    assert.deepEqual(v2.contagens[0], {
      id: 'x1', nome: 'Refrigerante', tipo: 'parar', inicio: 1761000000000, custoDia: null,
      recorde: 12, deslizes: [], tentativas: [], checkins: []
    });
    assert.deepEqual(v2.contagens.map((c) => c.inicio), [1761000000000, 1750000000123]);
    assert.equal(v2.atualizadoEm, 1762000000000);
    assert.deepEqual(v2.preferencias, { horaResumo: '09:00', fuso: 'America/Sao_Paulo' });
  });
  test('recorde ausente vira zero', () => {
    const v2 = L.migrarV1({ counters: [{ id: 'a', name: 'n', start: 1 }] }, AGORA);
    assert.equal(v2.contagens[0].recorde, 0);
    assert.equal(v2.atualizadoEm, AGORA);
  });
  test('rejeita dados inválidos em vez de descartar contagens', () => {
    assert.throws(() => L.migrarV1(null, AGORA), /inválidos/);
    assert.throws(() => L.migrarV1({ counters: 'x' }, AGORA), /inválidos/);
    assert.throws(() => L.migrarV1({ counters: [{ id: 'a', name: 'n', start: 'ontem' }] }, AGORA), /inválida/);
    assert.throws(() => L.migrarV1({ counters: [{ name: 'n', start: 1 }] }, AGORA), /inválida/);
  });
});

test.describe('carregarOuMigrar', () => {
  const v1 = JSON.stringify({ counters: [{ id: 'x1', name: 'Café', start: 1761000000000, best: 3 }], updatedAt: 5 });

  test('sem nada guardado: estado vazio, nada gravado', () => {
    const s = armazenamentoFalso();
    const r = L.carregarOuMigrar(s, AGORA);
    assert.equal(r.origem, 'novo');
    assert.deepEqual(r.estado.contagens, []);
    assert.deepEqual(s.dados, {});
  });
  test('migra a v1, grava a v2 e mantém a chave antiga', () => {
    const s = armazenamentoFalso({ [L.CHAVE_V1]: v1 });
    const r = L.carregarOuMigrar(s, AGORA);
    assert.equal(r.origem, 'migrado');
    assert.equal(r.estado.contagens[0].inicio, 1761000000000);
    assert.equal(s.dados[L.CHAVE_V1], v1);
    assert.deepEqual(JSON.parse(s.dados[L.CHAVE_V2]), r.estado);
  });
  test('segunda carga lê a v2 sem migrar de novo', () => {
    const s = armazenamentoFalso({ [L.CHAVE_V1]: v1 });
    const primeira = L.carregarOuMigrar(s, AGORA);
    s.dados[L.CHAVE_V1] = JSON.stringify({ counters: [] });
    const segunda = L.carregarOuMigrar(s, AGORA + 1);
    assert.equal(segunda.origem, 'v2');
    assert.deepEqual(segunda.estado, primeira.estado);
  });
  test('se a gravação da v2 falhar, não confirma a migração', () => {
    const s = armazenamentoFalso({ [L.CHAVE_V1]: v1 });
    s.setItem = () => {}; // gravação silenciosamente perdida
    assert.throws(() => L.carregarOuMigrar(s, AGORA), /gravar/);
    assert.equal(s.dados[L.CHAVE_V1], v1);
  });
  test('v2 corrompida não é sobrescrita pela v1', () => {
    const s = armazenamentoFalso({ [L.CHAVE_V1]: v1, [L.CHAVE_V2]: '{quebrado' });
    assert.throws(() => L.carregarOuMigrar(s, AGORA), /corrompidos/);
    assert.equal(s.dados[L.CHAVE_V2], '{quebrado');
  });
  test('v2 com versão errada é recusada', () => {
    const s = armazenamentoFalso({ [L.CHAVE_V2]: JSON.stringify({ versao: 1, contagens: [] }) });
    assert.throws(() => L.carregarOuMigrar(s, AGORA), /corrompidos/);
  });
  test('v1 corrompida falha sem apagar nada', () => {
    const s = armazenamentoFalso({ [L.CHAVE_V1]: 'oi' });
    assert.throws(() => L.carregarOuMigrar(s, AGORA), /v1 corrompidos/);
    assert.equal(s.dados[L.CHAVE_V1], 'oi');
  });
  test('salvar atualiza atualizadoEm e grava na chave v2', () => {
    const s = armazenamentoFalso();
    const novo = L.salvar(s, L.estadoVazio(1), AGORA);
    assert.equal(novo.atualizadoEm, AGORA);
    assert.equal(JSON.parse(s.dados[L.CHAVE_V2]).atualizadoEm, AGORA);
  });
});
