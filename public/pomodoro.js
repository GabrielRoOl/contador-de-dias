/* Lógica pura do Pomodoro: sem DOM, para rodar no navegador e no Node. O estado é um objeto simples e cada função devolve um novo.
   O que manda é o horário de fim da fase (fimEm): o relógio é recalculado a partir dele, então a aba suspensa não atrapalha.
   No navegador vira window.Pomodoro; no Node, module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pomodoro = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var CHAVE = 'contagem-de-dias:pomodoro';
  var MIN = 60000;
  var DURACAO = { foco: 25 * MIN, pausa: 5 * MIN, longa: 15 * MIN };
  var FASES = ['foco', 'pausa', 'longa'];
  var CICLOS = 4;      // focos até a pausa longa
  var MAX_DIAS = 120;  // quantos dias de contagem ficam guardados

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function dataLocal(ms) {
    var d = new Date(ms);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function copia(e, mudancas) { return Object.assign({}, e, mudancas); }

  function novo() {
    return { versao: 1, fase: 'foco', ciclo: 1, rodando: false, fimEm: 0, restanteMs: DURACAO.foco, contagemId: null, dias: {}, atualizadoEm: 0 };
  }

  /* rodando | pausado (já começou e parou) | pronto (fase inteira, esperando o toque) */
  function status(e) {
    if (e.rodando) return 'rodando';
    return e.restanteMs < DURACAO[e.fase] ? 'pausado' : 'pronto';
  }
  function restante(e, agora) { return e.rodando ? Math.max(0, e.fimEm - agora) : e.restanteMs; }

  /* Começa a fase ou continua de onde parou. */
  function iniciar(e, agora) {
    if (e.rodando) return e;
    return copia(e, { rodando: true, fimEm: agora + e.restanteMs });
  }
  function pausar(e, agora) {
    if (!e.rodando) return e;
    return copia(e, { rodando: false, fimEm: 0, restanteMs: restante(e, agora) });
  }
  /* Cancela tudo: a sessão em andamento não conta e o próximo foco volta a ser o primeiro do bloco. */
  function parar(e) {
    return copia(e, { fase: 'foco', ciclo: 1, rodando: false, fimEm: 0, restanteMs: DURACAO.foco });
  }

  function proxima(fase, ciclo) {
    if (fase === 'foco') return { fase: ciclo < CICLOS ? 'pausa' : 'longa', ciclo: ciclo };
    if (fase === 'pausa') return { fase: 'foco', ciclo: ciclo + 1 };
    return { fase: 'foco', ciclo: 1 };
  }
  function irPara(e, p, extra) {
    return copia(e, Object.assign({ fase: p.fase, ciclo: p.ciclo, rodando: false, fimEm: 0, restanteMs: DURACAO[p.fase] }, extra));
  }
  /* Pula para a fase seguinte, que fica esperando o toque. Pular um foco não conta como pomodoro. */
  function pular(e) { return irPara(e, proxima(e.fase, e.ciclo)); }

  function podar(dias) {
    var chaves = Object.keys(dias).sort();
    var resto = {};
    chaves.slice(-MAX_DIAS).forEach(function (k) { resto[k] = dias[k]; });
    return resto;
  }

  /* Se a fase em andamento já acabou, fecha-a: foco concluído conta um pomodoro (no dia em que terminou) e a fase seguinte
     fica esperando o toque. Sem "recuperar o atraso": se o app ficou fechado por horas, só essa fase é encerrada.
     Devolve { estado, concluiu } com concluiu = null ou { fase, proxima, contou, em, dia, contagemId }. */
  function avancar(e, agora) {
    if (!e.rodando) return { estado: e, concluiu: null };
    if (e.fimEm - agora > DURACAO[e.fase]) e = copia(e, { fimEm: agora + DURACAO[e.fase] }); // relógio voltou para trás
    if (agora < e.fimEm) return { estado: e, concluiu: null };
    var contou = e.fase === 'foco';
    var dia = dataLocal(e.fimEm);
    var dias = e.dias;
    if (contou) {
      dias = Object.assign({}, dias);
      dias[dia] = (dias[dia] || 0) + 1;
      dias = podar(dias);
    }
    var p = proxima(e.fase, e.ciclo);
    return {
      estado: irPara(e, p, { dias: dias }),
      concluiu: { fase: e.fase, proxima: p.fase, contou: contou, em: e.fimEm, dia: dia, contagemId: e.contagemId }
    };
  }

  function vincular(e, id) { return copia(e, { contagemId: id || null }); }
  function pomodorosDoDia(e, dia) { return e.dias[dia] || 0; }
  /* Dias com pelo menos um pomodoro, do mais recente para o mais antigo. */
  function historico(e) {
    return Object.keys(e.dias).sort().reverse().filter(function (d) { return e.dias[d] > 0; }).map(function (d) { return { dia: d, n: e.dias[d] }; });
  }
  function total(e) { return Object.keys(e.dias).reduce(function (s, d) { return s + e.dias[d]; }, 0); }

  /* Aceita só o que faz sentido; qualquer outra coisa volta ao estado inicial em vez de quebrar o app. */
  function normalizar(o) {
    var base = novo();
    if (!o || typeof o !== 'object' || o.versao !== 1) return base;
    if (FASES.indexOf(o.fase) === -1) return base;
    var ciclo = Number(o.ciclo);
    if (!(ciclo >= 1 && ciclo <= CICLOS) || ciclo !== Math.floor(ciclo)) return base;
    var e = copia(base, { fase: o.fase, ciclo: ciclo });
    if (typeof o.atualizadoEm === 'number' && isFinite(o.atualizadoEm) && o.atualizadoEm >= 0) e.atualizadoEm = o.atualizadoEm;
    if (typeof o.contagemId === 'string' && o.contagemId.length <= 64) e.contagemId = o.contagemId;
    if (o.dias && typeof o.dias === 'object') {
      Object.keys(o.dias).forEach(function (d) {
        var n = o.dias[d];
        if (/^\d{4}-\d{2}-\d{2}$/.test(d) && typeof n === 'number' && n >= 0 && n <= 1000 && n === Math.floor(n)) e.dias[d] = n;
      });
      e.dias = podar(e.dias);
    }
    var dur = DURACAO[e.fase];
    if (o.rodando === true && typeof o.fimEm === 'number' && isFinite(o.fimEm)) {
      e.rodando = true; e.fimEm = o.fimEm; e.restanteMs = dur;
    } else if (typeof o.restanteMs === 'number' && o.restanteMs > 0 && o.restanteMs <= dur) {
      e.restanteMs = o.restanteMs;
    } else {
      e.restanteMs = dur;
    }
    return e;
  }

  function carregar(armazenamento) {
    try { return normalizar(JSON.parse(armazenamento.getItem(CHAVE))); } catch (erro) { return novo(); }
  }
  function salvar(armazenamento, e) {
    try { armazenamento.setItem(CHAVE, JSON.stringify(e)); return true; } catch (erro) { return false; }
  }

  /* "24:59" a partir de milissegundos (arredonda para cima: 0:00 só quando acabou de vez). */
  function formatarTempo(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return pad(Math.floor(s / 60)) + ':' + pad(s % 60);
  }

  /* ---------- estatísticas (sobre os dias guardados, no máximo MAX_DIAS) ---------- */

  /* "2026-11-05" menos n dias, no calendário local (meio-dia para o horário de verão não atrapalhar). */
  function diaMenos(dia, n) {
    var p = dia.split('-');
    return dataLocal(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]) - n, 12).getTime());
  }
  function diaDaSemana(dia) {
    var p = dia.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]), 12).getDay();
  }
  /* Tudo que a janela de estatísticas mostra. `hoje` é "YYYY-MM-DD". Devolve null se ainda não há nenhum pomodoro. */
  function estatisticas(e, hoje) {
    var dias = e.dias;
    var ativos = Object.keys(dias).filter(function (d) { return dias[d] > 0; }).sort();
    if (!ativos.length) return null;
    var tot = total(e);

    var ultimos7 = [], semana = 0, anterior = 0, i;
    for (i = 6; i >= 0; i--) { var d = diaMenos(hoje, i); var n = dias[d] || 0; ultimos7.push({ dia: d, n: n, semana: diaDaSemana(d) }); semana += n; }
    for (i = 7; i <= 13; i++) anterior += dias[diaMenos(hoje, i)] || 0;

    var melhor = null;
    ativos.forEach(function (d) { if (!melhor || dias[d] >= melhor.n) melhor = { dia: d, n: dias[d] }; }); // empate: o mais recente

    // sequência atual: dias seguidos com foco; se hoje ainda não teve, a de ontem continua viva (como no check-in)
    var atual = 0, cursor = dias[hoje] > 0 ? hoje : diaMenos(hoje, 1);
    while (dias[cursor] > 0) { atual++; cursor = diaMenos(cursor, 1); }
    var melhorSeq = 0, corrente = 0;
    ativos.forEach(function (d, k) {
      corrente = k > 0 && diaMenos(d, 1) === ativos[k - 1] ? corrente + 1 : 1;
      if (corrente > melhorSeq) melhorSeq = corrente;
    });

    // dia da semana mais forte: média sobre todos os dias do período (também os sem foco), só com 14 dias ou mais de histórico
    var forte = null, primeiro = ativos[0], cont = [0, 0, 0, 0, 0, 0, 0], soma = [0, 0, 0, 0, 0, 0, 0], span = 0, c = hoje;
    while (c >= primeiro && span < MAX_DIAS + 7) { var w = diaDaSemana(c); cont[w]++; soma[w] += dias[c] || 0; span++; c = diaMenos(c, 1); }
    if (span >= 14) {
      for (var w2 = 0; w2 < 7; w2++) {
        var media = cont[w2] ? soma[w2] / cont[w2] : 0;
        if (media > 0 && (!forte || media > forte.media)) forte = { semana: w2, media: media };
      }
    }
    return {
      total: tot, minutosFoco: tot * DURACAO.foco / MIN, diasComFoco: ativos.length, mediaPorDiaAtivo: tot / ativos.length,
      semana: semana, semanaAnterior: anterior, ultimos7: ultimos7, melhorDia: melhor,
      sequenciaAtual: atual, melhorSequencia: melhorSeq, diaForte: forte, diasAnalisados: span
    };
  }
  /* 150 -> "2 h 30 min"; 25 -> "25 min"; 120 -> "2 h". */
  function formatarMinutos(min) {
    min = Math.round(min);
    var h = Math.floor(min / 60), m = min % 60;
    return h === 0 ? m + ' min' : m === 0 ? h + ' h' : h + ' h ' + m + ' min';
  }

  /* ---------- notificação fixa e ações (a página e o service worker usam o mesmo código) ---------- */

  function tituloFase(e) {
    return e.fase === 'foco' ? 'Foco ' + e.ciclo + ' de ' + CICLOS : e.fase === 'pausa' ? 'Pausa' : 'Pausa longa';
  }
  /* O que a notificação fixa mostra: rodando = horário do fim (não dá contagem ao vivo com o app fechado); pausado = o que resta.
     Parado ou esperando o toque: null (sem notificação). */
  function notificacao(e, agora) {
    var st = status(e);
    if (st === 'rodando' && e.fimEm > agora) {
      var fim = new Date(e.fimEm);
      return { titulo: tituloFase(e), corpo: 'Termina às ' + pad(fim.getHours()) + ':' + pad(fim.getMinutes()),
        acoes: [{ action: 'pausar', title: 'Pausar' }, { action: 'parar', title: 'Parar' }] };
    }
    if (st === 'pausado') {
      return { titulo: tituloFase(e) + ' (pausado)', corpo: 'Restam ' + formatarTempo(e.restanteMs),
        acoes: [{ action: 'continuar', title: 'Continuar' }, { action: 'parar', title: 'Parar' }] };
    }
    return null;
  }
  /* Opções do showNotification da notificação fixa: sem som, com os botões, e a mesma tag do aviso de fim (que a substitui). */
  function opcoesNotificacao(n) {
    return { body: n.corpo, tag: 'pomodoro', silent: true, renotify: false, requireInteraction: true, actions: n.acoes,
      icon: './icon-192.png', badge: './icon-badge.png', data: { url: './#pomodoro', pomodoro: true } };
  }
  function rotuloIniciar(fase) {
    return fase === 'foco' ? 'Iniciar foco' : fase === 'pausa' ? 'Iniciar pausa' : 'Iniciar pausa longa';
  }
  /* O alarme que o servidor deve ter para este estado (null = nenhum). */
  function alarmeDe(e) { return e.rodando ? { em: e.fimEm, fase: e.fase, proxima: pular(e).fase } : null; }

  /* Ação de um botão da notificação (pausar, continuar, iniciar, parar). Primeiro fecha a fase se ela já acabou, depois aplica.
     Idempotente: tocar num botão velho só atualiza a notificação, não desfaz o que o usuário já fez no app. */
  function aplicarAcao(e, acao, agora) {
    var r = avancar(e, agora);
    var s = r.estado;
    if (acao === 'pausar') s = pausar(s, agora);
    else if (acao === 'continuar' || acao === 'iniciar') s = iniciar(s, agora);
    else if (acao === 'parar') s = parar(s);
    else return { estado: s, concluiu: r.concluiu, aplicou: false };
    return { estado: copia(s, { atualizadoEm: agora }), concluiu: r.concluiu, aplicou: true };
  }

  return {
    CHAVE: CHAVE, DURACAO: DURACAO, CICLOS: CICLOS, MAX_DIAS: MAX_DIAS,
    novo: novo, status: status, restante: restante, iniciar: iniciar, pausar: pausar, parar: parar, pular: pular, avancar: avancar,
    vincular: vincular, pomodorosDoDia: pomodorosDoDia, historico: historico, total: total,
    estatisticas: estatisticas, formatarMinutos: formatarMinutos, diaMenos: diaMenos,
    notificacao: notificacao, opcoesNotificacao: opcoesNotificacao, rotuloIniciar: rotuloIniciar, alarmeDe: alarmeDe, aplicarAcao: aplicarAcao,
    normalizar: normalizar, carregar: carregar, salvar: salvar, formatarTempo: formatarTempo, dataLocal: dataLocal
  };
});
