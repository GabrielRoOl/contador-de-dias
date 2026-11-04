const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../public/logica.js');

const DIA = L.DAY;
const AGORA = new Date(2026, 10, 3, 12, 0).getTime();
// "N dias atrás" pelo relógio de parede, para os testes valerem em qualquer fuso
const atras = (dias, horas = 0, min = 0) => {
  const a = new Date(AGORA);
  return new Date(a.getFullYear(), a.getMonth(), a.getDate() - dias, a.getHours() - horas, a.getMinutes() - min).getTime();
};

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
  test('horário de verão não altera a contagem (mesma hora, 7 dias depois)', () => {
    const i = new Date(2026, 9, 28, 9, 0).getTime();
    const f = new Date(2026, 10, 4, 9, 0).getTime();
    const r = L.calcular(i, f);
    assert.deepEqual([r.dias, r.horas, r.minutos], [7, 0, 0]);
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

test.describe('marcos: semana, mês e ano', () => {
  const ini = new Date(2026, 0, 10, 8, 30).getTime(); // 2026 -> 2027 -> 2028 (bissexto)
  const marco = (d, i = ini) => L.marcoDoDia(i, d);

  test('semana a cada 7 dias', () => {
    assert.deepEqual(marco(7), { tipo: 'semana', n: 1 });
    assert.deepEqual(marco(14), { tipo: 'semana', n: 2 });
    assert.deepEqual(marco(28), { tipo: 'semana', n: 4 });
  });
  test('mês a cada 30 dias', () => {
    assert.deepEqual(marco(30), { tipo: 'mes', n: 1 });
    assert.deepEqual(marco(60), { tipo: 'mes', n: 2 });
    assert.deepEqual(marco(300), { tipo: 'mes', n: 10 });
  });
  test('vale o maior: mês vence semana (dia 210 é múltiplo de 7 e de 30)', () => {
    assert.deepEqual(marco(210), { tipo: 'mes', n: 7 });
  });
  test('50 e 100 não são mais marcos por si', () => {
    assert.equal(marco(50), null);
    assert.equal(marco(100), null);
  });
  test('dias comuns, zero e inválidos não são marco', () => {
    [0, 1, 6, 8, 29, 31, 99, -7, 3.5, NaN].forEach((n) => assert.equal(marco(n), null, String(n)));
  });
  test('ano completa no aniversário do calendário: 365 dias num ano comum', () => {
    assert.equal(L.diasAteAniversario(ini, 1), 365);
    assert.deepEqual(marco(365), { tipo: 'ano', n: 1 });
    assert.equal(marco(366), null);
  });
  test('ano com 29/02 dentro: 366 dias, e o dia 365 não é o ano', () => {
    const i = new Date(2027, 5, 1, 9, 0).getTime(); // 01/06/2027 -> 01/06/2028 cruza 29/02/2028
    assert.equal(L.diasAteAniversario(i, 1), 366);
    assert.equal(marco(365, i), null);
    assert.deepEqual(marco(366, i), { tipo: 'ano', n: 1 });
  });
  test('2º ano soma os dias reais de cada ano', () => {
    const i = new Date(2027, 5, 1, 9, 0).getTime(); // 366 + 365
    assert.equal(L.diasAteAniversario(i, 2), 731);
    assert.deepEqual(marco(731, i), { tipo: 'ano', n: 2 });
    assert.equal(marco(730, i), null);
  });
  test('ano vence mês e semana quando coincidem', () => {
    const a = new Date(2026, 0, 1).getTime();
    const dias = L.diasAteAniversario(a, 1);
    assert.equal(marco(dias, a).tipo, 'ano');
  });
  test('início em 29/02 faz aniversário em 28/02 nos anos sem bissexto', () => {
    const i = new Date(2024, 1, 29, 10, 0).getTime();
    assert.equal(L.dataLocal(L.adicionarAnos(i, 1)), '2025-02-28');
    assert.equal(L.dataLocal(L.adicionarAnos(i, 4)), '2028-02-29');
    assert.equal(L.diasAteAniversario(i, 1), 365);
    assert.equal(L.diasAteAniversario(i, 4), 1461);
    assert.deepEqual(marco(1461, i), { tipo: 'ano', n: 4 });
  });
  test('anos completos respeita o instante do aniversário', () => {
    const i = new Date(2026, 0, 10, 8, 30).getTime();
    assert.equal(L.anosCompletos(i, new Date(2027, 0, 10, 8, 29).getTime()), 0);
    assert.equal(L.anosCompletos(i, new Date(2027, 0, 10, 8, 30).getTime()), 1);
    assert.equal(L.anosCompletos(i, new Date(2030, 5, 1).getTime()), 4);
  });
  test('todo aniversário em 10 anos é marco de ano, com os dias reais de cada ano', () => {
    const i = new Date(2020, 6, 15, 12, 0).getTime();
    for (let n = 1; n <= 10; n++) {
      const d = L.diasAteAniversario(i, n);
      assert.equal(marco(d, i).tipo, 'ano', `ano ${n}`);
      assert.equal(marco(d, i).n, n);
    }
  });

  test('próximo marco', () => {
    assert.deepEqual(L.proximoMarco(ini, 0), { dia: 7, tipo: 'semana', n: 1, faltam: 7 });
    assert.deepEqual(L.proximoMarco(ini, 7), { dia: 14, tipo: 'semana', n: 2, faltam: 7 });
    assert.deepEqual(L.proximoMarco(ini, 28), { dia: 30, tipo: 'mes', n: 1, faltam: 2 });
    assert.deepEqual(L.proximoMarco(ini, 364), { dia: 365, tipo: 'ano', n: 1, faltam: 1 });
  });
  test('próximo marco com dias fracionados', () => {
    const r = L.proximoMarco(ini, 6.5);
    assert.equal(r.dia, 7);
    assert.equal(r.faltam, 0.5);
  });
  test('próximo marco nunca está a mais de 7 dias', () => {
    for (let d = 0; d < 800; d++) assert.ok(L.proximoMarco(ini, d).faltam <= 7, String(d));
  });

  test('progresso dos ciclos', () => {
    const agora = ini + (10 * DIA + 12 * 36e5);
    const p = L.progressoCiclos(ini, agora);
    assert.equal(p.semana.dia, 3);
    assert.equal(p.semana.de, 7);
    assert.ok(Math.abs(p.semana.fracao - 3.5 / 7) < 1e-9);
    assert.equal(p.mes.dia, 10);
    assert.ok(Math.abs(p.mes.fracao - 10.5 / 30) < 1e-9);
    assert.equal(p.ano.anos, 0);
    assert.equal(p.ano.de, 365);
    assert.equal(p.ano.dia, 10);
  });
  test('progresso do ano usa o tamanho real do ano em curso', () => {
    const i = new Date(2027, 5, 1, 9, 0).getTime();
    const p = L.progressoCiclos(i, new Date(2028, 5, 1, 8, 59).getTime());
    assert.equal(p.ano.anos, 0);
    assert.equal(p.ano.de, 366);
    assert.equal(p.ano.dia, 365);
    assert.ok(p.ano.fracao < 1 && p.ano.fracao > 0.99);
    const depois = L.progressoCiclos(i, new Date(2028, 5, 1, 9, 0).getTime());
    assert.equal(depois.ano.anos, 1);
    assert.equal(depois.ano.dia, 0);
    assert.equal(depois.ano.de, 365); // 01/06/2028 -> 01/06/2029
  });
  test('início hoje: tudo zerado', () => {
    const p = L.progressoCiclos(ini, ini);
    assert.deepEqual([p.semana.fracao, p.mes.fracao, p.ano.fracao, p.ano.anos], [0, 0, 0, 0]);
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
    assert.deepEqual(v2.preferencias, { horaResumo: '09:00', fuso: 'America/Sao_Paulo', visual: 'futurista' });
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

test.describe('ciclo do tipo manter', () => {
  test('sem check-ins: zerado e sem "quebrou"', () => {
    assert.deepEqual(L.cicloManter([], '2026-11-03'), { dias: 0, feitoHoje: false, inicio: null, referencia: null, quebrou: false });
  });
  test('check-in hoje: intervalo vai da meia-noite do 1º dia até a meia-noite depois de hoje', () => {
    const c = L.cicloManter(['2026-11-01', '2026-11-02', '2026-11-03'], '2026-11-03');
    assert.equal(c.dias, 3);
    assert.equal(c.feitoHoje, true);
    assert.equal(c.inicio, new Date(2026, 10, 1).getTime());
    assert.equal(c.referencia, new Date(2026, 10, 4).getTime());
    assert.equal(L.calcular(c.inicio, c.referencia).dias, 3);
  });
  test('sem check-in hoje: sequência de ontem continua e referencia termina hoje', () => {
    const c = L.cicloManter(['2026-11-01', '2026-11-02'], '2026-11-03');
    assert.equal(c.dias, 2);
    assert.equal(c.feitoHoje, false);
    assert.equal(c.referencia, new Date(2026, 10, 3).getTime());
    assert.equal(L.calcular(c.inicio, c.referencia).dias, 2);
  });
  test('sequência perdida: zero dias e quebrou = true', () => {
    const c = L.cicloManter(['2026-10-20', '2026-10-21'], '2026-11-03');
    assert.equal(c.dias, 0);
    assert.equal(c.quebrou, true);
  });
  test('alimenta marcos: 7 dias seguidos é marco de semana', () => {
    const dias = ['2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'];
    const c = L.cicloManter(dias, '2026-11-03');
    assert.deepEqual(L.marcoDoDia(c.inicio, c.dias), { tipo: 'semana', n: 1 });
    const p = L.progressoCiclos(c.inicio, c.referencia);
    assert.equal(p.semana.fracao, 0);
    assert.equal(p.mes.dia, 7);
  });
  test('atravessa virada de mês e ano', () => {
    const c = L.cicloManter(['2026-12-31', '2027-01-01'], '2027-01-01');
    assert.equal(c.dias, 2);
    assert.equal(c.inicio, new Date(2026, 11, 31).getTime());
  });
  test('desfazer check-in remove só o dia', () => {
    const c = { checkins: ['2026-11-02', '2026-11-03'] };
    assert.deepEqual(L.desfazerCheckin(c, '2026-11-03').checkins, ['2026-11-02']);
    assert.deepEqual(c.checkins.length, 2);
  });
});

test.describe('atualizarContagem', () => {
  const c = L.criarContagem({ nome: 'Café', tipo: 'parar', inicio: atras(5), custoDia: 3 }, AGORA, 'k1');
  test('muda nome, início e custo; mantém histórico e tipo', () => {
    const r = L.atualizarContagem({ ...c, recorde: 9 }, { nome: ' Café puro ', inicio: atras(8), custoDia: 0 }, AGORA);
    assert.equal(r.nome, 'Café puro');
    assert.equal(r.inicio, atras(8));
    assert.equal(r.custoDia, null);
    assert.equal(r.recorde, 9);
    assert.equal(r.tipo, 'parar');
    assert.equal(r.id, 'k1');
  });
  test('campos ausentes ficam como estavam', () => {
    const r = L.atualizarContagem(c, { nome: 'Outro' }, AGORA);
    assert.equal(r.inicio, c.inicio);
    assert.equal(r.custoDia, 3);
  });
  test('valida como na criação', () => {
    assert.throws(() => L.atualizarContagem(c, { nome: '' }, AGORA), /nome/);
    assert.throws(() => L.atualizarContagem(c, { nome: 'x', inicio: AGORA + 1 }, AGORA), /futuro/);
  });
  test('manter nunca ganha custo', () => {
    const m = L.criarContagem({ nome: 'Inglês', tipo: 'manter', inicio: atras(1) }, AGORA, 'm1');
    assert.equal(L.atualizarContagem(m, { nome: 'Inglês', custoDia: 9 }, AGORA).custoDia, null);
  });
});

test.describe('preferências e visual', () => {
  test('o padrão é futurista, 09:00', () => {
    assert.deepEqual(L.preferenciasPadrao('UTC'), { horaResumo: '09:00', fuso: 'UTC', visual: 'futurista' });
    assert.deepEqual(L.VISUAIS, ['futurista', 'classico']);
  });
  test('completa preferências de dados antigos sem o campo visual', () => {
    assert.deepEqual(L.normalizarPreferencias({ horaResumo: '07:30', fuso: 'America/Recife' }, 'UTC'),
      { horaResumo: '07:30', fuso: 'America/Recife', visual: 'futurista' });
  });
  test('visual e horário inválidos voltam ao padrão', () => {
    const p = L.normalizarPreferencias({ visual: 'neon', horaResumo: '7h30' }, 'UTC');
    assert.equal(p.visual, 'futurista');
    assert.equal(p.horaResumo, '09:00');
  });
  test('mantém o visual clássico', () => {
    assert.equal(L.normalizarPreferencias({ visual: 'classico' }).visual, 'classico');
  });
  test('preferências ausentes ou de tipo errado viram o padrão', () => {
    assert.deepEqual(L.normalizarPreferencias(null, 'UTC'), L.preferenciasPadrao('UTC'));
    assert.deepEqual(L.normalizarPreferencias('x', 'UTC'), L.preferenciasPadrao('UTC'));
  });
  test('carregar uma v2 sem visual preenche o padrão e preserva o resto', () => {
    const v2 = { versao: 2, preferencias: { horaResumo: '06:00', fuso: 'UTC' }, contagens: [], atualizadoEm: 1 };
    const s = armazenamentoFalso({ [L.CHAVE_V2]: JSON.stringify(v2) });
    const r = L.carregarOuMigrar(s, AGORA, 'UTC');
    assert.deepEqual(r.estado.preferencias, { horaResumo: '06:00', fuso: 'UTC', visual: 'futurista' });
  });
  test('carregar uma v2 com visual clássico o mantém', () => {
    const v2 = { versao: 2, preferencias: { horaResumo: '09:00', fuso: 'UTC', visual: 'classico' }, contagens: [], atualizadoEm: 1 };
    const s = armazenamentoFalso({ [L.CHAVE_V2]: JSON.stringify(v2) });
    assert.equal(L.carregarOuMigrar(s, AGORA).estado.preferencias.visual, 'classico');
  });
});
