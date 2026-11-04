/* Lógica pura do Contador de Dias (modelo v2). Sem acesso ao DOM, para rodar no navegador e no Node.
   No navegador vira window.Logica; no Node, module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logica = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var DAY = 864e5;
  var CHAVE_V1 = 'contagem-de-dias:v1';
  var CHAVE_V2 = 'contagem-de-dias:v2';
  var INTERVALOS_MARCO = [100, 50, 30, 7];
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
  /* Dia N é marco se for múltiplo de 7, 30, 50 ou 100. Vale o maior intervalo. Devolve o intervalo ou null. */
  function marcoDoDia(dia) {
    if (!(dia >= 1) || Math.floor(dia) !== dia) return null;
    for (var i = 0; i < INTERVALOS_MARCO.length; i++) {
      if (dia % INTERVALOS_MARCO[i] === 0) return INTERVALOS_MARCO[i];
    }
    return null;
  }

  function proximoMarco(dias) {
    for (var n = Math.floor(dias) + 1; ; n++) {
      var intervalo = marcoDoDia(n);
      if (intervalo) return { dia: n, intervalo: intervalo, faltam: n - dias };
    }
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
    marcoDoDia: marcoDoDia, proximoMarco: proximoMarco,
    economia: economia, formatarReais: formatarReais,
    sequenciaCheckins: sequenciaCheckins, maiorSequencia: maiorSequencia, registrarCheckin: registrarCheckin,
    criarContagem: criarContagem, registrarDeslize: registrarDeslize, recomecar: recomecar, estatisticasParar: estatisticasParar,
    preferenciasPadrao: preferenciasPadrao, estadoVazio: estadoVazio, migrarV1: migrarV1,
    carregarOuMigrar: carregarOuMigrar, salvar: salvar
  };
});
