/* Lógica pura do Cronograma: rotinas de passos com tempo (ex.: prancha 2 min, agachamento 5 min), sem DOM, para rodar no
   navegador e no Node. Cada função devolve um novo estado. O que manda é o horário de fim do passo (fimEm): o relógio é
   recalculado dele, então aba suspensa ou app fechado não bagunçam o tempo. Os passos seguem sozinhos, um após o outro.
   No navegador vira window.Cronograma; no Node, module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Cronograma = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var CHAVE = 'contagem-de-dias:cronograma';
  var LIMITES = { rotinas: 30, passos: 20, nome: 40, minSeg: 5, maxSeg: 7200 };

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function copia(e, mudancas) { return Object.assign({}, e, mudancas); }
  function dataLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function novo() { return { versao: 1, rotinas: [], sessao: null }; }

  /* ---------- rotinas ---------- */

  /* Valida e limpa os dados de uma rotina vindos do formulário. Lança Error com a mensagem para o usuário. */
  function validarRotina(dados) {
    var nome = String((dados && dados.nome) || '').trim();
    if (!nome) throw new Error('Dê um nome ao cronograma.');
    if (nome.length > LIMITES.nome) throw new Error('O nome do cronograma pode ter até ' + LIMITES.nome + ' letras.');
    var brutos = (dados && dados.passos) || [];
    if (!brutos.length) throw new Error('Adicione pelo menos um passo.');
    if (brutos.length > LIMITES.passos) throw new Error('No máximo ' + LIMITES.passos + ' passos por cronograma.');
    var passos = brutos.map(function (p, i) {
      var n = String((p && p.nome) || '').trim();
      var seg = Math.round(Number(p && p.seg));
      if (!n) throw new Error('O passo ' + (i + 1) + ' precisa de um nome.');
      if (n.length > LIMITES.nome) throw new Error('O nome do passo ' + (i + 1) + ' pode ter até ' + LIMITES.nome + ' letras.');
      if (!(seg >= LIMITES.minSeg)) throw new Error('O passo "' + n + '" precisa de pelo menos ' + LIMITES.minSeg + ' segundos.');
      if (seg > LIMITES.maxSeg) throw new Error('O passo "' + n + '" pode ter no máximo ' + LIMITES.maxSeg / 60 + ' minutos.');
      return { nome: n, seg: seg };
    });
    return { nome: nome, passos: passos };
  }

  function achar(e, id) {
    for (var i = 0; i < e.rotinas.length; i++) if (e.rotinas[i].id === id) return e.rotinas[i];
    return null;
  }
  function criarRotina(e, dados, id) {
    if (e.rotinas.length >= LIMITES.rotinas) throw new Error('No máximo ' + LIMITES.rotinas + ' cronogramas salvos.');
    var v = validarRotina(dados);
    return copia(e, { rotinas: e.rotinas.concat([{ id: id, nome: v.nome, passos: v.passos, feitas: 0, ultima: null }]) });
  }
  function atualizarRotina(e, id, dados) {
    var v = validarRotina(dados);
    var sessao = e.sessao && e.sessao.rotinaId === id ? null : e.sessao; // mexer na rotina encerra a sessão dela
    return copia(e, { sessao: sessao, rotinas: e.rotinas.map(function (r) { return r.id === id ? copia(r, { nome: v.nome, passos: v.passos }) : r; }) });
  }
  function excluirRotina(e, id) {
    return copia(e, { sessao: e.sessao && e.sessao.rotinaId === id ? null : e.sessao, rotinas: e.rotinas.filter(function (r) { return r.id !== id; }) });
  }
  function totalSeg(r) { return r.passos.reduce(function (s, p) { return s + p.seg; }, 0); }

  /* ---------- sessão (uma rotina em execução) ---------- */

  function duracao(r, i) { return r.passos[i].seg * 1000; }
  function sessaoNova(r) { return { rotinaId: r.id, passo: 0, rodando: false, fimEm: 0, restanteMs: duracao(r, 0), atualizadoEm: 0 }; }

  /* Abre a rotina pronta para começar: tudo zerado, esperando o toque em Iniciar. */
  function abrir(e, id) {
    var r = achar(e, id);
    return r ? copia(e, { sessao: sessaoNova(r) }) : e;
  }
  function fechar(e) { return copia(e, { sessao: null }); }
  function rotinaDaSessao(e) { return e.sessao ? achar(e, e.sessao.rotinaId) : null; }

  /* null (sem sessão) | pronto | rodando | pausado | concluido */
  function status(e) {
    var s = e.sessao, r = rotinaDaSessao(e);
    if (!s || !r) return null;
    if (s.passo >= r.passos.length) return 'concluido';
    if (s.rodando) return 'rodando';
    return s.passo === 0 && s.restanteMs >= duracao(r, 0) ? 'pronto' : 'pausado';
  }
  function restante(e, agora) {
    var s = e.sessao, r = rotinaDaSessao(e);
    if (!s || !r || s.passo >= r.passos.length) return 0;
    return s.rodando ? Math.max(0, s.fimEm - agora) : s.restanteMs;
  }
  function comSessao(e, mudancas, agora) { return copia(e, { sessao: copia(e.sessao, Object.assign({ atualizadoEm: agora }, mudancas)) }); }

  function iniciar(e, agora) {
    var st = status(e);
    if (st === 'concluido') return iniciar(abrir(e, e.sessao.rotinaId), agora); // refazer
    if (st !== 'pronto' && st !== 'pausado') return e;
    return comSessao(e, { rodando: true, fimEm: agora + e.sessao.restanteMs }, agora);
  }
  function pausar(e, agora) {
    if (status(e) !== 'rodando') return e;
    return comSessao(e, { rodando: false, fimEm: 0, restanteMs: restante(e, agora) }, agora);
  }
  /* Volta ao começo, pronto de novo, sem contar como feito. */
  function parar(e) {
    var r = rotinaDaSessao(e);
    return r ? copia(e, { sessao: sessaoNova(r) }) : e;
  }
  /* Pula para o próximo passo (se for o último, encerra sem contar como feito). */
  function pular(e, agora) {
    var s = e.sessao, r = rotinaDaSessao(e), st = status(e);
    if (st !== 'rodando' && st !== 'pausado') return e;
    if (s.passo + 1 >= r.passos.length) return comSessao(e, { passo: r.passos.length, rodando: false, fimEm: 0, restanteMs: 0 }, agora);
    var prox = duracao(r, s.passo + 1);
    return comSessao(e, { passo: s.passo + 1, restanteMs: prox, fimEm: s.rodando ? agora + prox : 0 }, agora);
  }

  /* Fecha os passos que já acabaram (pode ser mais de um, se o app ficou fechado) e segue para o próximo, encadeando os
     horários a partir do fim do anterior (sem acumular atraso). Ao acabar o último, conta uma vez feita.
     Devolve { estado, concluiu } com concluiu = null ou { passos: [{indice, nome}], terminou, em }. */
  function avancar(e, agora) {
    var s = e.sessao, r = rotinaDaSessao(e);
    if (!s || !r || !s.rodando) return { estado: e, concluiu: null };
    if (s.fimEm - agora > duracao(r, s.passo)) s = copia(s, { fimEm: agora + duracao(r, s.passo) }); // relógio voltou para trás
    var feitos = [], passo = s.passo, fim = s.fimEm;
    while (agora >= fim && passo < r.passos.length) {
      feitos.push({ indice: passo, nome: r.passos[passo].nome });
      passo++;
      if (passo < r.passos.length) fim += duracao(r, passo);
    }
    if (!feitos.length) return { estado: copia(e, { sessao: s }), concluiu: null };
    var terminou = passo >= r.passos.length;
    var emUltimo = terminou ? fim : fim - duracao(r, passo);
    var sessao = terminou
      ? copia(s, { passo: passo, rodando: false, fimEm: 0, restanteMs: 0, atualizadoEm: agora })
      : copia(s, { passo: passo, fimEm: fim, atualizadoEm: agora });
    var rotinas = e.rotinas;
    if (terminou) rotinas = rotinas.map(function (x) { return x.id === r.id ? copia(x, { feitas: x.feitas + 1, ultima: dataLocal(emUltimo) }) : x; });
    return { estado: copia(e, { sessao: sessao, rotinas: rotinas }), concluiu: { passos: feitos, terminou: terminou, em: emUltimo } };
  }

  /* Os avisos que o servidor deve mandar com o app fechado: um por fim de passo, a partir do passo atual.
     Só existem enquanto a sessão roda; pausar ou parar cancela tudo. */
  function alarmesDe(e) {
    var s = e.sessao, r = rotinaDaSessao(e);
    if (!s || !r || !s.rodando) return [];
    var lista = [], fim = s.fimEm;
    for (var i = s.passo; i < r.passos.length; i++) {
      var ultimo = i === r.passos.length - 1;
      lista.push({
        em: fim,
        titulo: ultimo ? 'Cronograma concluído' : 'Passo concluído',
        corpo: ultimo ? r.nome : r.passos[i].nome + '. Agora: ' + r.passos[i + 1].nome + ' · ' + formatarDuracao(r.passos[i + 1].seg)
      });
      if (!ultimo) fim += duracao(r, i + 1);
    }
    return lista;
  }

  /* ---------- formatação ---------- */
  function formatarTempo(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }
  /* 120 -> "2 min"; 90 -> "1 min 30 s"; 45 -> "45 s"; 3720 -> "1 h 2 min". */
  function formatarDuracao(seg) {
    var h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60, partes = [];
    if (h) partes.push(h + ' h');
    if (m) partes.push(m + ' min');
    if (s) partes.push(s + ' s');
    return partes.join(' ') || '0 s';
  }

  /* ---------- armazenamento ---------- */

  /* Aceita só o que faz sentido; o resto volta ao padrão em vez de quebrar o app. */
  function normalizar(o) {
    var base = novo();
    if (!o || typeof o !== 'object' || o.versao !== 1 || !Array.isArray(o.rotinas)) return base;
    var vistos = {};
    o.rotinas.slice(0, LIMITES.rotinas).forEach(function (x) {
      if (!x || typeof x.id !== 'string' || !x.id || x.id.length > 64 || vistos[x.id]) return;
      var v;
      try { v = validarRotina(x); } catch (erro) { return; }
      vistos[x.id] = true;
      base.rotinas.push({ id: x.id, nome: v.nome, passos: v.passos,
        feitas: typeof x.feitas === 'number' && x.feitas >= 0 && x.feitas === Math.floor(x.feitas) && x.feitas < 1e6 ? x.feitas : 0,
        ultima: typeof x.ultima === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.ultima) ? x.ultima : null });
    });
    var s = o.sessao, r = s && typeof s === 'object' ? achar(base, s.rotinaId) : null;
    if (r && Number.isInteger(s.passo) && s.passo >= 0 && s.passo <= r.passos.length) {
      var concluida = s.passo === r.passos.length;
      var dur = concluida ? 0 : duracao(r, s.passo);
      var sessao = { rotinaId: r.id, passo: s.passo, rodando: false, fimEm: 0, restanteMs: dur, atualizadoEm: typeof s.atualizadoEm === 'number' && s.atualizadoEm >= 0 ? s.atualizadoEm : 0 };
      if (!concluida && s.rodando === true && typeof s.fimEm === 'number' && isFinite(s.fimEm)) { sessao.rodando = true; sessao.fimEm = s.fimEm; }
      else if (!concluida && typeof s.restanteMs === 'number' && s.restanteMs > 0 && s.restanteMs <= dur) sessao.restanteMs = s.restanteMs;
      base.sessao = sessao;
    }
    return base;
  }
  function carregar(armazenamento) {
    try { return normalizar(JSON.parse(armazenamento.getItem(CHAVE))); } catch (erro) { return novo(); }
  }
  function salvar(armazenamento, e) {
    try { armazenamento.setItem(CHAVE, JSON.stringify(e)); return true; } catch (erro) { return false; }
  }

  return {
    CHAVE: CHAVE, LIMITES: LIMITES,
    novo: novo, validarRotina: validarRotina, achar: achar, criarRotina: criarRotina, atualizarRotina: atualizarRotina, excluirRotina: excluirRotina, totalSeg: totalSeg,
    abrir: abrir, fechar: fechar, rotinaDaSessao: rotinaDaSessao, status: status, restante: restante,
    iniciar: iniciar, pausar: pausar, parar: parar, pular: pular, avancar: avancar, alarmesDe: alarmesDe,
    formatarTempo: formatarTempo, formatarDuracao: formatarDuracao, normalizar: normalizar, carregar: carregar, salvar: salvar, dataLocal: dataLocal
  };
});
