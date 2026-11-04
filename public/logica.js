/* Lógica pura do Contador de Dias (modelo v2). Sem acesso ao DOM, para rodar no navegador e no Node.
   No navegador vira window.Logica; no Node, module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logica = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DAY = 864e5;
  var CHAVE_V1 = 'contagem-de-dias:v1';
  var CHAVE_V2 = 'contagem-de-dias:v2';
  var TIPOS = ['parar', 'manter'];

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function plural(n, a, b) { return n === 1 ? a : b; }

  /* ---------- tempo ---------- */
  function calcular(inicio, agora) {
    var ms = Math.max(0, agora - inicio);
    return { decorrido: ms / DAY, dias: Math.floor(ms / DAY), horas: Math.floor((ms % DAY) / 36e5), minutos: Math.floor((ms % 36e5) / 6e4) };
  }

  /* Data local do aparelho como YYYY-MM-DD. */
  function dataLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* Número do dia (inteiro) de uma data YYYY-MM-DD. Usa UTC para o horário de verão não atrapalhar a subtração. */
  function ordinal(data) {
    var p = data.split('-');
    return Date.UTC(+p[0], +p[1] - 1, +p[2]) / DAY;
  }

  /* ---------- marcos ---------- */
  /* Semana a cada 7 dias, mês a cada 30 e ano no aniversário do calendário (365 ou 366 dias).
     Quando um dia cai em mais de um, vale o maior: ano > mês > semana. */

  /* Mesmo dia e hora, n anos depois. 29/02 num ano sem bissexto vira 28/02. */
  function adicionarAnos(ms, n) {
    var d = new Date(ms);
    var ano = d.getFullYear() + n;
    var ultimo = new Date(ano, d.getMonth() + 1, 0).getDate();
    return new Date(ano, d.getMonth(), Math.min(d.getDate(), ultimo), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime();
  }

  /* Dias de calendário entre o início e o n-ésimo aniversário (365 ou 366). */
  function diasAteAniversario(inicio, n) {
    return ordinal(dataLocal(adicionarAnos(inicio, n))) - ordinal(dataLocal(inicio));
  }

  function anosCompletos(inicio, agora) {
    var n = 0;
    while (adicionarAnos(inicio, n + 1) <= agora) n++;
    return n;
  }

  /* `dias` é a contagem de dias completos. Devolve { tipo: 'ano'|'mes'|'semana', n } ou null.
     n é o número do ano, do mês (30 dias) ou da semana (7 dias). */
  function marcoDoDia(inicio, dias) {
    if (!(dias >= 1) || Math.floor(dias) !== dias) return null;
    var estimativa = Math.floor(dias / 365);
    for (var a = Math.max(1, estimativa - 1); a <= estimativa + 1; a++) {
      if (diasAteAniversario(inicio, a) === dias) return { tipo: 'ano', n: a };
    }
    if (dias % 30 === 0) return { tipo: 'mes', n: dias / 30 };
    if (dias % 7 === 0) return { tipo: 'semana', n: dias / 7 };
    return null;
  }

  /* Próximo dia de marco depois de `dias` (que pode ser fracionado). */
  function proximoMarco(inicio, dias) {
    for (var n = Math.floor(dias) + 1; ; n++) {
      var marco = marcoDoDia(inicio, n);
      if (marco) return { dia: n, tipo: marco.tipo, n: marco.n, faltam: n - dias };
    }
  }

  /* Progresso de cada ciclo para as três barras do cartão. `fracao` vai de 0 a 1. */
  function progressoCiclos(inicio, agora) {
    var decorrido = calcular(inicio, agora).decorrido;
    var anos = anosCompletos(inicio, agora);
    var ini = adicionarAnos(inicio, anos);
    var fim = adicionarAnos(inicio, anos + 1);
    var deAno = ordinal(dataLocal(fim)) - ordinal(dataLocal(ini));
    var fracaoAno = Math.min(1, Math.max(0, (agora - ini) / (fim - ini)));
    return {
      semana: { dia: Math.floor(decorrido % 7), de: 7, fracao: (decorrido % 7) / 7 },
      mes: { dia: Math.floor(decorrido % 30), de: 30, fracao: (decorrido % 30) / 30 },
      ano: { anos: anos, dia: Math.min(deAno - 1, Math.floor((agora - ini) / DAY)), de: deAno, fracao: fracaoAno }
    };
  }

  /* ---------- economia ---------- */
  /* Só existe com custo por dia informado. Arredonda para centavos. */
  function economia(diasCompletos, custoDia) {
    if (typeof custoDia !== 'number' || !(custoDia > 0)) return null;
    return Math.round(diasCompletos * custoDia * 100) / 100;
  }

  function formatarReais(valor) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(valor);
  }

  /* ---------- check-in (tipo manter) ---------- */
  function conjunto(checkins) {
    var set = {};
    (checkins || []).forEach(function (d) { set[ordinal(d)] = true; });
    return set;
  }

  /* Dias consecutivos terminando hoje. Se hoje ainda não foi marcado, a sequência de ontem segue viva até o fim do dia. */
  function sequenciaCheckins(checkins, hoje) {
    var set = conjunto(checkins);
    var h = ordinal(hoje);
    var feitoHoje = !!set[h];
    var fim = feitoHoje ? h : (set[h - 1] ? h - 1 : null);
    if (fim === null) return { dias: 0, feitoHoje: false };
    var n = 0;
    while (set[fim - n]) n++;
    return { dias: n, feitoHoje: feitoHoje };
  }

  function maiorSequencia(checkins) {
    var dias = Object.keys(conjunto(checkins)).map(Number).sort(function (a, b) { return a - b; });
    var maior = 0, atual = 0;
    dias.forEach(function (d, i) {
      atual = i > 0 && d === dias[i - 1] + 1 ? atual + 1 : 1;
      if (atual > maior) maior = atual;
    });
    return maior;
  }

  /* Idempotente e ordenado. Não altera o original. */
  function registrarCheckin(contagem, hoje) {
    var lista = contagem.checkins.indexOf(hoje) === -1 ? contagem.checkins.concat(hoje).sort() : contagem.checkins.slice();
    return Object.assign({}, contagem, { checkins: lista });
  }

  /* ---------- contagens ---------- */
  function criarContagem(dados, agora, id) {
    var nome = String(dados.nome || '').trim();
    if (!nome) throw new Error('O nome não pode ficar vazio.');
    if (nome.length > 60) throw new Error('O nome pode ter no máximo 60 caracteres.');
    if (TIPOS.indexOf(dados.tipo) === -1) throw new Error('Tipo inválido.');
    if (typeof dados.inicio !== 'number' || !isFinite(dados.inicio)) throw new Error('Data ou hora inválida.');
    if (dados.inicio > agora) throw new Error('A data de início não pode estar no futuro.');
    var custo = dados.tipo === 'parar' && typeof dados.custoDia === 'number' && dados.custoDia > 0 ? dados.custoDia : null;
    return { id: id, nome: nome, tipo: dados.tipo, inicio: dados.inicio, custoDia: custo, recorde: 0, deslizes: [], tentativas: [], checkins: [] };
  }

  /* Deslize não zera a sequência: só registra. */
  function registrarDeslize(contagem, agora, nota) {
    var d = { em: agora, nota: String(nota || '').trim().slice(0, 200) };
    return Object.assign({}, contagem, { deslizes: contagem.deslizes.concat(d) });
  }

  /* Encerra a tentativa atual, guarda no histórico e começa outra em `em` (padrão: agora). */
  function recomecar(contagem, agora, opcoes) {
    opcoes = opcoes || {};
    var em = opcoes.em === undefined ? agora : opcoes.em;
    if (typeof em !== 'number' || !isFinite(em)) throw new Error('Data ou hora inválida.');
    if (em > agora) throw new Error('O recomeço não pode estar no futuro.');
    if (em < contagem.inicio) throw new Error('O recomeço não pode ser antes do início da contagem.');
    var dias = Math.floor((em - contagem.inicio) / DAY);
    var tentativa = { inicio: contagem.inicio, fim: em, dias: dias, nota: String(opcoes.nota || '').trim().slice(0, 200) };
    return Object.assign({}, contagem, {
      inicio: em,
      recorde: Math.max(contagem.recorde || 0, dias),
      tentativas: contagem.tentativas.concat(tentativa)
    });
  }

  function estatisticasParar(contagem, agora) {
    var atual = calcular(contagem.inicio, agora).dias;
    var anteriores = contagem.tentativas.reduce(function (soma, t) { return soma + t.dias; }, 0);
    return {
      sequenciaAtual: atual,
      recorde: Math.max(contagem.recorde || 0, atual),
      totalDias: anteriores + atual,
      deslizes: contagem.deslizes.length,
      tentativas: contagem.tentativas.length + 1
    };
  }

  /* ---------- estado, migração e armazenamento ---------- */
  function preferenciasPadrao(fuso) {
    return { horaResumo: '09:00', fuso: fuso || 'America/Sao_Paulo' };
  }

  function estadoVazio(agora, fuso) {
    return { versao: 2, preferencias: preferenciasPadrao(fuso), contagens: [], atualizadoEm: agora };
  }

  /* v1: { counters: [{ id, name, start, best }], updatedAt }. Não perde nenhuma data. */
  function migrarV1(v1, agora, fuso) {
    if (!v1 || !Array.isArray(v1.counters)) throw new Error('Dados v1 inválidos.');
    var contagens = v1.counters.map(function (c) {
      if (!c || typeof c.start !== 'number' || !isFinite(c.start) || !c.id) throw new Error('Contagem v1 inválida: ' + JSON.stringify(c));
      return { id: c.id, nome: c.name, tipo: 'parar', inicio: c.start, custoDia: null, recorde: c.best || 0, deslizes: [], tentativas: [], checkins: [] };
    });
    return { versao: 2, preferencias: preferenciasPadrao(fuso), contagens: contagens, atualizadoEm: v1.updatedAt || agora };
  }

  /* `armazenamento` tem getItem/setItem (localStorage ou um falso nos testes).
     Prioridade: v2; senão migra a v1 e confirma a gravação lendo de volta; senão estado vazio.
     A chave v1 nunca é apagada aqui. */
  function carregarOuMigrar(armazenamento, agora, fuso) {
    var raw2 = armazenamento.getItem(CHAVE_V2);
    if (raw2 !== null && raw2 !== undefined) {
      var d;
      try { d = JSON.parse(raw2); } catch (e) { throw new Error('Dados v2 corrompidos.'); }
      if (!d || d.versao !== 2 || !Array.isArray(d.contagens)) throw new Error('Dados v2 corrompidos.');
      return { estado: d, origem: 'v2' };
    }
    var raw1 = armazenamento.getItem(CHAVE_V1);
    if (raw1 === null || raw1 === undefined) return { estado: estadoVazio(agora, fuso), origem: 'novo' };
    var v1;
    try { v1 = JSON.parse(raw1); } catch (e) { throw new Error('Dados v1 corrompidos.'); }
    var estado = migrarV1(v1, agora, fuso);
    var texto = JSON.stringify(estado);
    armazenamento.setItem(CHAVE_V2, texto);
    if (armazenamento.getItem(CHAVE_V2) !== texto) throw new Error('Não foi possível gravar os dados v2.');
    return { estado: estado, origem: 'migrado' };
  }

  function salvar(armazenamento, estado, agora) {
    var novo = Object.assign({}, estado, { atualizadoEm: agora });
    armazenamento.setItem(CHAVE_V2, JSON.stringify(novo));
    return novo;
  }

  return {
    DAY: DAY, CHAVE_V1: CHAVE_V1, CHAVE_V2: CHAVE_V2, plural: plural,
    calcular: calcular, dataLocal: dataLocal, ordinal: ordinal,
    adicionarAnos: adicionarAnos, diasAteAniversario: diasAteAniversario, anosCompletos: anosCompletos,
    marcoDoDia: marcoDoDia, proximoMarco: proximoMarco, progressoCiclos: progressoCiclos,
    economia: economia, formatarReais: formatarReais,
    sequenciaCheckins: sequenciaCheckins, maiorSequencia: maiorSequencia, registrarCheckin: registrarCheckin,
    criarContagem: criarContagem, registrarDeslize: registrarDeslize, recomecar: recomecar, estatisticasParar: estatisticasParar,
    preferenciasPadrao: preferenciasPadrao, estadoVazio: estadoVazio, migrarV1: migrarV1,
    carregarOuMigrar: carregarOuMigrar, salvar: salvar
  };
});
