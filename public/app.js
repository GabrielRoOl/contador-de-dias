(function () {
  var L = window.Logica;
  var T = window.Textos;
  var PM = window.Pomodoro;
  var DAY = L.DAY;

  var estado = L.estadoVazio(Date.now());
  var ui = { painel: null, historico: {}, dia: '', erro: '' };
  var somenteLeitura = false;
  var exemploInicio = Date.now() - (12 * DAY + 5 * 36e5 + 18 * 6e4);

  var fmtDataHora = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  var fmtData = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric' });

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toTimeInput(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function plural(n, a, b) { return n === 1 ? a : b; }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function hoje() { return L.dataLocal(Date.now()); }
  function fusoLocal() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Sao_Paulo'; } catch (e) { return 'America/Sao_Paulo'; }
  }
  function parseValor(txt) {
    var t = String(txt || '').trim().replace(',', '.');
    if (!t) return null;
    var n = Number(t);
    if (!isFinite(n) || n < 0) throw new Error('Valor inválido. Use algo como 6,50.');
    return n;
  }
  function dataHoraInput(data, hora) { return new Date(data + 'T' + (hora || '00:00')).getTime(); }
  function ontemAgora(agora) {
    var a = new Date(agora);
    return new Date(a.getFullYear(), a.getMonth(), a.getDate() - 1, a.getHours(), a.getMinutes()).getTime();
  }

  /* ---------- notificações e espelho no servidor ---------- */
  var sync = window.Sincronia.criar({
    storage: window.localStorage,
    navigator: navigator,
    Notification: window.Notification,
    PushManager: window.PushManager,
    fetch: function (u, i) { return window.fetch(u, i); },
    setTimeout: function (f, ms) { return window.setTimeout(f, ms); },
    clearTimeout: function (t) { window.clearTimeout(t); }
  });

  /* ---------- armazenamento ---------- */
  function carregar() {
    try {
      var r = L.carregarOuMigrar(localStorage, Date.now(), fusoLocal());
      estado = r.estado;
    } catch (e) {
      somenteLeitura = true;
      ui.erro = 'Não consegui ler seus dados salvos (' + e.message + '). Nada foi apagado nem será sobrescrito.';
    }
    aplicarModo(estado.preferencias.modo);
    aplicarVisual(estado.preferencias.visual);
    if (!somenteLeitura && estado.preferencias.fuso !== fusoLocal()) {
      estado.preferencias.fuso = fusoLocal();
      persist();
    }
  }
  function persist() {
    if (somenteLeitura) return;
    try { estado = L.salvar(localStorage, estado, Date.now()); ui.erro = ''; }
    catch (e) { ui.erro = 'Não foi possível salvar neste aparelho. Libere espaço ou verifique as permissões do navegador.'; return; }
    sync.agendar(estado);
  }
  var metasTema = Array.prototype.slice.call(document.querySelectorAll('meta[name="theme-color"]'));
  /* A barra do navegador acompanha a cor de fundo realmente em uso, seja qual for o visual e o modo. */
  function sincronizarCorBarra() {
    var cor = getComputedStyle(document.body).backgroundColor;
    metasTema.forEach(function (m) { m.setAttribute('content', cor); });
  }
  function aplicarVisual(v) { document.documentElement.setAttribute('data-visual', v); sincronizarCorBarra(); }
  function aplicarModo(m) {
    var raiz = document.documentElement;
    if (m === 'claro') raiz.setAttribute('data-theme', 'light');
    else if (m === 'escuro') raiz.setAttribute('data-theme', 'dark');
    else raiz.removeAttribute('data-theme');
    sincronizarCorBarra();
  }
  function marcarOpcao(nome, valor) {
    var r = document.querySelector('input[name="' + nome + '"][value="' + valor + '"]');
    if (r) r.checked = true;
  }
  function achar(id) { return estado.contagens.filter(function (c) { return c.id === id; })[0]; }
  function substituir(nova) {
    estado.contagens = estado.contagens.map(function (c) { return c.id === nova.id ? nova : c; });
  }

  /* ---------- visão de cada contagem ---------- */
  /* Três anéis concêntricos em volta do número: ano (fora), mês (meio) e semana (dentro). */
  function aneisHTML(p, centro) {
    function anel(r, fracao, cls) {
      var f = Math.min(1, Math.max(0, fracao));
      return '<circle class="trilho" cx="140" cy="140" r="' + r + '"/>' +
        (f > 0 ? '<circle class="arco ' + cls + '" cx="140" cy="140" r="' + r + '" pathLength="100" stroke-dasharray="' + (Math.round(f * 1000) / 10) + ' 100" transform="rotate(-90 140 140)"/>' : '');
    }
    return '<div class="aneis"><svg viewBox="0 0 280 280" aria-hidden="true">' +
      '<circle class="marcas" cx="140" cy="140" r="133" pathLength="100"/>' +
      anel(119, p.ano.fracao, 'r-ano') + anel(104, p.mes.fracao, 'r-mes') + anel(89, p.semana.fracao, 'r-semana') +
      '</svg><div class="centro">' + centro + '</div></div>';
  }

  function legendaHTML(p) {
    function item(cls, nome, dia, de) {
      return '<li><span class="lg-nome"><span class="sw ' + cls + '"></span>' + nome + '</span><span class="lg-val">' + dia + '/' + de + '</span></li>';
    }
    return '<ul class="legenda" aria-label="Progresso dos ciclos">' +
      item('r-semana', 'Semana', p.semana.dia, p.semana.de) + item('r-mes', 'Mês', p.mes.dia, p.mes.de) +
      item('r-ano', p.ano.anos > 0 ? 'Ano ' + (p.ano.anos + 1) : 'Ano', p.ano.dia, p.ano.de) + '</ul>';
  }

  function numHTML(n) {
    var d = String(n).length;
    return '<span class="num' + (d >= 4 ? ' d4' : d === 3 ? ' d3' : '') + '">' + n + '</span>';
  }

  function statHTML(rotulo, valor) { return '<div><dt>' + rotulo + '</dt><dd>' + esc(valor) + '</dd></div>'; }

  function liveParar(c, agora) {
    var t = L.calcular(c.inicio, agora);
    var p = L.progressoCiclos(c.inicio, agora);
    var est = L.estatisticasParar(c, agora);
    var m = L.marcoDoDia(c.inicio, t.dias);
    var prox = L.proximoMarco(c.inicio, t.decorrido);
    var html = aneisHTML(p, numHTML(t.dias) + '<span class="unit">' + plural(t.dias, 'dia', 'dias') + '</span>' +
      '<span class="hm">+ ' + t.horas + ' h ' + t.minutos + ' min</span>') + legendaHTML(p);
    if (m) html += '<p class="marco ' + m.tipo + '">' + esc(T.marco({ tipoContagem: 'parar', nome: c.nome, dias: t.dias, marco: m, seed: c.id + ':' + t.dias })) + '</p>';
    else if (c.tentativas.length && t.dias <= 1) html += '<p class="retomada">' + esc(T.retomada({ tipoContagem: 'parar', recorde: c.recorde, seed: c.id + ':' + t.dias })) + '</p>';
    html += '<p class="next">' + T.proxima(prox, prox.faltam) + '</p>';
    var eco = L.economia(t.dias, c.custoDia);
    if (eco !== null) html += '<p class="economia">' + T.economia(L.formatarReais(eco)) + '</p>';
    html += '<dl class="stats">' + statHTML('Recorde', T.dias(est.recorde)) + statHTML('Total acumulado', T.dias(est.totalDias)) +
      statHTML('Deslizes', est.deslizes) + statHTML('Tentativas', est.tentativas) + '</dl>';
    return html;
  }

  function liveManter(c, agora) {
    var h = hoje();
    var ciclo = L.cicloManter(c.checkins, h);
    var base = ciclo.dias > 0 ? ciclo : { inicio: L.ordinalParaMs(L.ordinal(h)), referencia: L.ordinalParaMs(L.ordinal(h)) };
    var p = L.progressoCiclos(base.inicio, base.referencia);
    var recorde = Math.max(L.maiorSequencia(c.checkins), ciclo.dias);
    var html = aneisHTML(p, numHTML(ciclo.dias) + '<span class="unit">' + plural(ciclo.dias, 'dia seguido', 'dias seguidos') + '</span>') + legendaHTML(p);
    if (!ciclo.feitoHoje) html += '<p class="hm-fora">' + (ciclo.dias > 0 ? 'Falta marcar hoje.' : 'Marque o primeiro dia quando quiser.') + '</p>';
    var m = ciclo.feitoHoje ? L.marcoDoDia(base.inicio, ciclo.dias) : null;
    if (m) html += '<p class="marco ' + m.tipo + '">' + esc(T.marco({ tipoContagem: 'manter', nome: c.nome, dias: ciclo.dias, marco: m, seed: c.id + ':' + ciclo.dias })) + '</p>';
    else if (ciclo.quebrou) html += '<p class="retomada">' + esc(T.retomada({ tipoContagem: 'manter', recorde: recorde, seed: c.id + ':' + h })) + '</p>';
    if (ciclo.dias > 0) {
      var prox = L.proximoMarco(base.inicio, ciclo.dias);
      html += '<p class="next">' + T.proxima(prox, prox.faltam) + '</p>';
    }
    html += '<dl class="stats">' + statHTML('Recorde', T.dias(recorde)) + statHTML('Check-ins', c.checkins.length) + '</dl>';
    return html;
  }

  function liveHTML(c, agora) { return c.tipo === 'manter' ? liveManter(c, agora) : liveParar(c, agora); }

  /* ---------- ações e formulários de cada cartão ---------- */
  function painelAtivo(c, tipo) { return ui.painel && ui.painel.id === c.id && ui.painel.tipo === tipo; }

  function formDeslize(c) {
    return '<form class="editform" data-form="deslize" data-id="' + esc(c.id) + '" novalidate>' +
      '<p class="hint">Um deslize não zera a sua contagem. Só fica registrado.</p>' +
      '<div class="field"><label for="ds-' + esc(c.id) + '">O que aconteceu? (opcional)</label><input id="ds-' + esc(c.id) + '" type="text" maxlength="200" autocomplete="off"></div>' +
      '<div class="actions"><button class="btn small primary" type="submit">Registrar</button>' +
      '<button class="btn small" type="button" data-act="fechar">Cancelar</button></div></form>';
  }

  function formRecomeco(c) {
    var agora = Date.now();
    var dias = L.calcular(c.inicio, agora).dias;
    var recorde = Math.max(c.recorde || 0, dias);
    return '<form class="editform" data-form="recomeco" data-id="' + esc(c.id) + '" novalidate>' +
      '<p class="hint">Recomeçar faz parte. ' + esc(T.avisoRecomeco(dias, c.recorde || 0)) + '</p>' +
      '<fieldset class="radios"><legend class="sr">Quando você recomeçou</legend>' +
      '<label><input type="radio" name="rq-' + esc(c.id) + '" value="agora" checked><span>Agora</span></label>' +
      '<label><input type="radio" name="rq-' + esc(c.id) + '" value="ontem"><span>Ontem</span></label>' +
      '<label><input type="radio" name="rq-' + esc(c.id) + '" value="outro"><span>Outro momento</span></label></fieldset>' +
      '<div class="row2" data-outro hidden><div class="field"><label for="rd-' + esc(c.id) + '">Data</label><input id="rd-' + esc(c.id) + '" type="date" max="' + hoje() + '" value="' + hoje() + '"></div>' +
      '<div class="field"><label for="rh-' + esc(c.id) + '">Hora</label><input id="rh-' + esc(c.id) + '" type="time" value="' + toTimeInput(agora) + '"></div></div>' +
      '<div class="field"><label for="rn-' + esc(c.id) + '">O que pesou? (opcional)</label><input id="rn-' + esc(c.id) + '" type="text" maxlength="200" autocomplete="off"></div>' +
      '<p class="error" id="re-' + esc(c.id) + '" role="alert"></p>' +
      '<div class="actions"><button class="btn small primary" type="submit">Recomeçar</button>' +
      '<button class="btn small" type="button" data-act="fechar">Cancelar</button></div></form>';
  }

  function formEditar(c) {
    var parar = c.tipo === 'parar';
    return '<form class="editform" data-form="editar" data-id="' + esc(c.id) + '" novalidate>' +
      '<div class="field"><label for="en-' + esc(c.id) + '">Nome</label><input id="en-' + esc(c.id) + '" type="text" maxlength="60" value="' + esc(c.nome) + '"></div>' +
      (parar ? '<div class="row2"><div class="field"><label for="ed-' + esc(c.id) + '">Data de início</label><input id="ed-' + esc(c.id) + '" type="date" max="' + hoje() + '" value="' + L.dataLocal(c.inicio) + '"></div>' +
        '<div class="field"><label for="et-' + esc(c.id) + '">Hora</label><input id="et-' + esc(c.id) + '" type="time" value="' + toTimeInput(c.inicio) + '"></div></div>' +
        '<div class="field"><label for="ec-' + esc(c.id) + '">Custo por dia (opcional)</label><input id="ec-' + esc(c.id) + '" type="text" inputmode="decimal" value="' + (c.custoDia ? String(c.custoDia).replace('.', ',') : '') + '"></div>' : '') +
      '<p class="error" id="ee-' + esc(c.id) + '" role="alert"></p>' +
      '<div class="actions"><button class="btn small primary" type="submit">Salvar</button>' +
      '<button class="btn small" type="button" data-act="fechar">Cancelar</button></div></form>';
  }

  function confirmarExcluir(c) {
    return '<div class="confirm"><p>Excluir &ldquo;' + esc(c.nome) + '&rdquo;? Isso não pode ser desfeito.</p>' +
      '<div class="actions"><button class="btn small danger" type="button" data-act="do-delete" data-id="' + esc(c.id) + '">Excluir</button>' +
      '<button class="btn small" type="button" data-act="fechar">Cancelar</button></div></div>';
  }

  function acoesHTML(c) {
    var a = ui.painel && ui.painel.id === c.id ? ui.painel.tipo : null;
    if (a === 'deslize') return formDeslize(c);
    if (a === 'recomeco') return formRecomeco(c);
    if (a === 'editar') return formEditar(c);
    if (a === 'excluir') return confirmarExcluir(c);
    var html = '';
    if (c.tipo === 'manter') {
      var feito = c.checkins.indexOf(hoje()) !== -1;
      html += feito
        ? '<div class="confirm"><p class="checkin-feito">Feito hoje.</p><div class="actions"><button class="btn small" type="button" data-act="desfazer-checkin" data-id="' + esc(c.id) + '">Desfazer</button></div></div>'
        : '<button class="btn primary big" type="button" data-act="checkin" data-id="' + esc(c.id) + '">Hoje eu fiz</button>';
      return html + '<div class="actions"><button class="btn small" type="button" data-act="painel" data-tipo="editar" data-id="' + esc(c.id) + '">Editar</button>' +
        '<button class="btn small danger" type="button" data-act="painel" data-tipo="excluir" data-id="' + esc(c.id) + '">Excluir</button></div>';
    }
    return '<div class="actions">' +
      '<button class="btn small" type="button" data-act="painel" data-tipo="deslize" data-id="' + esc(c.id) + '">Deslize</button>' +
      '<button class="btn small" type="button" data-act="painel" data-tipo="recomeco" data-id="' + esc(c.id) + '">Recomecei</button>' +
      '<button class="btn small" type="button" data-act="historico" data-id="' + esc(c.id) + '" aria-expanded="' + (ui.historico[c.id] ? 'true' : 'false') + '">Histórico</button>' +
      '<button class="btn small" type="button" data-act="painel" data-tipo="editar" data-id="' + esc(c.id) + '">Editar</button>' +
      '<button class="btn small danger" type="button" data-act="painel" data-tipo="excluir" data-id="' + esc(c.id) + '">Excluir</button></div>';
  }

  function historicoHTML(c) {
    var itens = c.tentativas.map(function (t) {
      return { quando: t.fim, titulo: 'Tentativa de ' + T.dias(t.dias), detalhe: fmtData.format(new Date(t.inicio)) + ' a ' + fmtData.format(new Date(t.fim)), nota: t.nota };
    }).concat(c.deslizes.map(function (d) {
      return { quando: d.em, titulo: 'Deslize', detalhe: fmtDataHora.format(new Date(d.em)), nota: d.nota };
    })).sort(function (a, b) { return b.quando - a.quando; });
    if (!itens.length) return '<p class="hint">Nada registrado ainda. Deslizes e recomeços aparecem aqui.</p>';
    return '<ul class="historico">' + itens.map(function (i) {
      return '<li><span>' + esc(i.titulo) + '</span><span class="quando">' + esc(i.detalhe) + '</span>' + (i.nota ? '<span class="nota">' + esc(i.nota) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function cardHTML(c, exemplo) {
    var desde = c.tipo === 'manter' ? 'Desde ' + fmtData.format(new Date(c.inicio)) : 'Desde ' + fmtDataHora.format(new Date(c.inicio));
    var corpo = '<div class="live"' + (exemplo ? ' data-exemplo="1"' : ' data-id="' + esc(c.id) + '"') + '>' + liveHTML(c, Date.now()) + '</div>';
    if (!exemplo) {
      corpo += acoesHTML(c);
      if (c.tipo === 'parar' && ui.historico[c.id]) corpo += historicoHTML(c);
    }
    return '<article class="card' + (exemplo ? ' example' : '') + '">' +
      '<div class="head"><div><h2>' + esc(c.nome) + '</h2><p class="since">' + esc(desde) + '</p></div>' +
      (exemplo ? '<span class="badge">Exemplo</span>' : '<span class="badge">' + (c.tipo === 'manter' ? 'Hábito' : 'Parei') + '</span>') + '</div>' + corpo + '</article>';
  }

  function exemplo() {
    return { id: 'exemplo', nome: 'Refrigerante', tipo: 'parar', inicio: exemploInicio, custoDia: 6.5, recorde: 0, deslizes: [], tentativas: [], checkins: [] };
  }

  function render() {
    var lista = document.getElementById('list');
    ui.dia = hoje();

    var aviso = ui.erro ? '<p class="error" role="alert">' + esc(ui.erro) + '</p>' : '';
    if (!estado.contagens.length) {
      lista.innerHTML = aviso + '<p class="empty">Nenhuma contagem ainda. Toque em Nova contagem e escolha a data em que você começou, mesmo que já tenha passado: o tempo é calculado a partir dela. Veja como fica:</p>' + cardHTML(exemplo(), true);
      return;
    }
    var ordenadas = estado.contagens.slice().sort(function (a, b) { return a.inicio - b.inicio; });
    lista.innerHTML = aviso + ordenadas.map(function (c) { return cardHTML(c, false); }).join('');
  }

  function tick() {
    if (ui.dia !== hoje() && !ui.painel) { render(); return; }
    var mapa = {};
    estado.contagens.forEach(function (c) { mapa[c.id] = c; });
    document.querySelectorAll('.live').forEach(function (el) {
      if (el.getAttribute('data-exemplo')) { el.innerHTML = liveHTML(exemplo(), Date.now()); return; }
      var c = mapa[el.getAttribute('data-id')];
      if (c) el.innerHTML = liveHTML(c, Date.now());
    });
  }

  /* ---------- formulário de nova contagem e ajustes ---------- */
  function tipoSelecionado() { return document.querySelector('input[name="f-tipo"]:checked').value; }

  function ajustarFormulario() {
    var parar = tipoSelecionado() === 'parar';
    document.querySelectorAll('[data-so]').forEach(function (el) { el.hidden = el.getAttribute('data-so') !== (parar ? 'parar' : 'manter'); });
    document.getElementById('f-name-label').textContent = parar ? 'O que você parou de fazer' : 'O que você mantém';
    document.getElementById('f-name').placeholder = parar ? 'Ex.: refrigerante, cigarro, redes sociais' : 'Ex.: estudando inglês, treinando, lendo';
  }

  function prepararFormulario() {
    var agora = Date.now();
    document.getElementById('f-date').max = L.dataLocal(agora);
    document.getElementById('f-date').value = L.dataLocal(agora);
    document.getElementById('f-time').value = toTimeInput(agora);
    document.getElementById('f-custo').value = '';
    document.getElementById('f-error').textContent = '';
    ajustarFormulario();
  }

  var dialogoNova = document.getElementById('nova');
  document.getElementById('toggle-form').addEventListener('click', function () {
    prepararFormulario();
    dialogoNova.showModal();
    document.getElementById('f-name').focus();
  });

  var notif = { ocupado: false, erro: '', pedeConvite: false };
  var MSG_NOTIF = {
    'nao-suportado': 'Este navegador não mostra notificações do app. No Chrome do Android, instale o app na tela inicial.',
    bloqueado: 'As notificações estão bloqueadas para este site. Libere nas configurações do navegador para ativar.',
    desligado: 'Receba um resumo por dia no horário escolhido acima.'
  };
  var ERRO_ATIVAR = {
    dispensado: 'Sem a permissão o app não consegue avisar. Você pode tentar de novo quando quiser.',
    rede: 'Sem conexão com o servidor agora. Suas contagens continuam salvas aqui; tente de novo mais tarde.',
    limite: 'Muitas tentativas deste endereço. Tente de novo mais tarde.',
    'servidor-cheio': 'O servidor está sem espaço agora e não aceita este aparelho. Tente de novo mais tarde.',
    'servidor-sem-push': 'O servidor não está com as notificações configuradas.',
    inscricao: 'Não consegui registrar este aparelho para as notificações. Tente de novo.',
    servidor: 'O servidor não respondeu como esperado. Tente de novo mais tarde.',
    convite: 'Este servidor pede um código de convite. Digite o código e toque de novo.',
    'convite-invalido': 'Código de convite inválido.'
  };
  var ERRO_DESATIVAR = {
    rede: 'Sem conexão: não consegui apagar a cópia do servidor. Tente de novo com internet.',
    servidor: 'O servidor não respondeu como esperado. Tente de novo mais tarde.'
  };
  function renderNotif() {
    var st = sync.status();
    var texto = document.getElementById('a-notif-texto');
    var botao = document.getElementById('a-notif-botao');
    var semBotao = st === 'nao-suportado' || st === 'bloqueado';
    if (notif.ocupado) texto.textContent = 'Aguarde…';
    else if (st === 'ativo') texto.textContent = 'Ativas. Você recebe um resumo por dia às ' + estado.preferencias.horaResumo + '.';
    else texto.textContent = MSG_NOTIF[st];
    document.getElementById('a-notif-erro').textContent = semBotao ? '' : notif.erro;
    document.getElementById('a-notif-nota').hidden = semBotao;
    document.getElementById('a-convite').hidden = semBotao || st === 'ativo' || !notif.pedeConvite;
    botao.hidden = semBotao;
    botao.disabled = notif.ocupado;
    botao.textContent = st === 'ativo' ? 'Desativar' : (notif.erro ? 'Tentar de novo' : 'Ativar notificações');
  }
  /* Só roda por um toque no botão: é aqui que o navegador pergunta a permissão, nunca ao abrir o app. */
  document.getElementById('a-notif-botao').addEventListener('click', function () {
    if (notif.ocupado) return;
    var desativando = sync.status() === 'ativo';
    notif.ocupado = true; notif.erro = '';
    renderNotif();
    var campoConvite = document.getElementById('a-convite-campo');
    var codigo = campoConvite.value.trim();
    (desativando ? sync.desativar() : sync.ativar(estado, codigo || undefined)).then(function (r) {
      notif.ocupado = false;
      if (!r.ok) notif.erro = (desativando ? ERRO_DESATIVAR : ERRO_ATIVAR)[r.motivo] || ERRO_ATIVAR.servidor;
      var pede = !r.ok && (r.motivo === 'convite' || r.motivo === 'convite-invalido');
      if (r.ok) campoConvite.value = '';
      notif.pedeConvite = pede; // o campo só aparece quando o servidor pede (e some ao ativar)
      renderNotif();
      atualizarConvites();
      if (pede) campoConvite.focus();
    });
  });
  sync.ouvir(renderNotif);

  /* ---------- convite recebido por link: um toque ativa os avisos ---------- */
  var cartaoConvite = document.getElementById('convite-cartao');
  var conviteUi = { erro: '', ocupado: false };
  function renderConvite() {
    var st = sync.status();
    if (st === 'ativo') { sync.descartarConvite(); conviteUi.erro = ''; }
    var tem = st !== 'ativo' && st !== 'nao-suportado' && !!sync.convitePendente();
    cartaoConvite.hidden = !(tem || conviteUi.erro);
    if (cartaoConvite.hidden) return;
    var botao = document.getElementById('convite-ativar');
    document.getElementById('convite-texto').textContent = !tem ? ''
      : st === 'bloqueado' ? 'As notificações estão bloqueadas para este site. Libere nas configurações do navegador e abra o link de novo.'
      : 'Toque para receber um aviso por dia com suas contagens. O app pede a sua permissão.';
    document.getElementById('convite-erro').textContent = conviteUi.erro;
    botao.hidden = !tem || st === 'bloqueado';
    botao.disabled = conviteUi.ocupado;
    botao.textContent = conviteUi.ocupado ? 'Aguarde…' : conviteUi.erro ? 'Tentar de novo' : 'Ativar os avisos';
  }
  document.getElementById('convite-ativar').addEventListener('click', function () {
    var codigo = sync.convitePendente();
    if (!codigo || conviteUi.ocupado) return;
    conviteUi.ocupado = true; conviteUi.erro = '';
    renderConvite();
    sync.ativar(estado, codigo).then(function (r) {
      conviteUi.ocupado = false;
      if (!r.ok) conviteUi.erro = r.motivo === 'convite-invalido' ? 'Este convite não vale mais: já foi usado, venceu ou foi revogado. Peça outro a quem enviou.' : (ERRO_ATIVAR[r.motivo] || ERRO_ATIVAR.servidor);
      renderConvite();
      renderNotif();
      atualizarConvites();
    });
  });
  sync.ouvir(renderConvite);

  /* ---------- convites (só aparece no aparelho administrador) ---------- */
  var painelConvites = document.getElementById('a-convites');
  var ERRO_CONVITE = {
    pendentes: 'Já há 10 convites pendentes. Revogue algum ou espere vencer.',
    nome: 'Escreva o nome de quem vai receber (até 40 letras).',
    limite: 'Muitos convites seguidos. Tente de novo mais tarde.',
    rede: 'Sem conexão com o servidor agora.',
    servidor: 'O servidor não respondeu como esperado.',
    inativo: 'Ative as notificações neste aparelho para gerenciar convites.'
  };
  var codigoAtual = '';
  var fmtDia = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short' });
  function esconderCodigo() {
    codigoAtual = '';
    document.getElementById('a-convite-codigo').textContent = '';
    document.getElementById('a-convite-novo').hidden = true;
  }
  function textoConvite(c) {
    if (c.estado === 'pendente') return 'Pendente, vence ' + fmtDia.format(new Date(c.expiraEm));
    if (c.estado === 'usado') return 'Usado em ' + fmtDia.format(new Date(c.usadoEm));
    if (c.estado === 'expirado') return 'Expirado';
    return 'Revogado';
  }
  function desenharConvites(lista) {
    var ul = document.getElementById('a-convites-lista');
    ul.textContent = '';
    lista.forEach(function (c) {
      var li = document.createElement('li');
      var info = document.createElement('span'); info.className = 'info';
      var nome = document.createElement('span'); nome.textContent = c.nome;
      var estado = document.createElement('span'); estado.className = 'quando'; estado.textContent = textoConvite(c);
      info.appendChild(nome); info.appendChild(estado); li.appendChild(info);
      if (c.estado === 'pendente' || c.estado === 'usado') {
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'btn small danger';
        var rotulo = c.estado === 'usado' ? 'Remover aparelho' : 'Revogar';
        b.textContent = rotulo;
        var armado = null;
        b.addEventListener('click', function () {
          if (!armado) { // segundo toque confirma, sem janela de confirmação
            b.textContent = 'Confirmar?';
            armado = setTimeout(function () { armado = null; b.textContent = rotulo; }, 4000);
            return;
          }
          clearTimeout(armado); b.disabled = true;
          sync.revogarConvite(c.id).then(function (r) {
            if (!r.ok) document.getElementById('a-convites-erro').textContent = ERRO_CONVITE[r.motivo] || ERRO_CONVITE.servidor;
            atualizarConvites();
          });
        });
        li.appendChild(b);
      }
      ul.appendChild(li);
    });
  }
  /* Pergunta ao servidor se este aparelho é administrador; o painel só aparece se for. */
  function atualizarConvites() {
    if (sync.status() !== 'ativo') { painelConvites.hidden = true; esconderCodigo(); return Promise.resolve(); }
    return sync.convites().then(function (r) {
      painelConvites.hidden = !(r.ok && r.admin);
      if (r.ok && r.admin) desenharConvites(r.lista); else esconderCodigo();
    });
  }
  document.getElementById('a-convite-gerar').addEventListener('click', function () {
    var campo = document.getElementById('a-convite-nome');
    var erro = document.getElementById('a-convites-erro');
    var botao = document.getElementById('a-convite-gerar');
    erro.textContent = '';
    botao.disabled = true;
    sync.criarConvite(campo.value.trim()).then(function (r) {
      botao.disabled = false;
      if (!r.ok) { erro.textContent = ERRO_CONVITE[r.motivo] || ERRO_CONVITE.servidor; return; }
      campo.value = '';
      codigoAtual = r.convite.codigo; // só na memória desta tela: fecha os Ajustes e some
      document.getElementById('a-convite-codigo').textContent = codigoAtual;
      document.getElementById('a-convite-novo').hidden = false;
      atualizarConvites();
    });
  });
  /* O convite vai dentro do link, depois do #: o servidor nem os registros do túnel chegam a vê-lo. */
  function linkDoConvite() { return window.Sincronia.linkConvite(location.origin + location.pathname.replace(/[^\/]*$/, ''), codigoAtual); }
  function mensagemConvite() {
    return 'Convite para o Contador de Dias. Abra o link e toque em "Ativar os avisos":\n' + linkDoConvite() + '\nVale 7 dias e só pode ser usado uma vez.';
  }
  document.getElementById('a-convite-compartilhar').addEventListener('click', function () {
    if (!codigoAtual) return;
    if (navigator.share) { navigator.share({ title: 'Convite para o Contador de Dias', text: mensagemConvite() }).catch(function () {}); return; }
    if (navigator.clipboard) navigator.clipboard.writeText(mensagemConvite()).catch(function () {});
  });
  document.getElementById('a-convite-copiar').addEventListener('click', function () {
    if (codigoAtual && navigator.clipboard) navigator.clipboard.writeText(linkDoConvite()).catch(function () {});
  });

  var dialogo = document.getElementById('ajustes');
  document.getElementById('toggle-ajustes').addEventListener('click', function () {
    document.getElementById('a-hora').value = estado.preferencias.horaResumo;
    marcarOpcao('a-modo', estado.preferencias.modo);
    marcarOpcao('a-visual', estado.preferencias.visual);
    document.getElementById('a-fuso').textContent = 'Fuso do aparelho: ' + estado.preferencias.fuso + '.';
    notif.erro = '';
    renderNotif();
    atualizarConvites();
    dialogo.showModal();
  });
  dialogo.addEventListener('close', function () { document.getElementById('a-convite-campo').value = ''; esconderCodigo(); document.getElementById('a-convites-erro').textContent = ''; });
  [dialogoNova, dialogo, document.getElementById('pomo-historico')].forEach(function (d) {
    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.closest('[data-fechar-dialogo]')) d.close();
    });
  });

  document.querySelectorAll('input[name="a-modo"]').forEach(function (r) {
    r.addEventListener('change', function (e) {
      if (L.MODOS.indexOf(e.target.value) === -1) return;
      estado.preferencias.modo = e.target.value;
      aplicarModo(e.target.value);
      persist();
    });
  });

  document.querySelectorAll('input[name="a-visual"]').forEach(function (r) {
    r.addEventListener('change', function (e) {
      if (L.VISUAIS.indexOf(e.target.value) === -1) return;
      estado.preferencias.visual = e.target.value;
      aplicarVisual(e.target.value);
      persist();
    });
  });

  document.getElementById('a-hora').addEventListener('change', function (e) {
    if (/^\d{2}:\d{2}$/.test(e.target.value)) { estado.preferencias.horaResumo = e.target.value; persist(); renderNotif(); }
  });

  document.querySelectorAll('input[name="f-tipo"]').forEach(function (r) { r.addEventListener('change', ajustarFormulario); });

  document.getElementById('new-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var err = document.getElementById('f-error');
    var agora = Date.now();
    var tipo = tipoSelecionado();
    var nome = document.getElementById('f-name').value;
    try {
      if (somenteLeitura) throw new Error('Os dados salvos não puderam ser lidos. Nada será gravado.');
      var dados = { nome: nome, tipo: tipo, inicio: agora };
      if (tipo === 'parar') {
        var d = document.getElementById('f-date').value;
        if (!d) throw new Error('Escolha a data de início.');
        dados.inicio = dataHoraInput(d, document.getElementById('f-time').value);
        dados.custoDia = parseValor(document.getElementById('f-custo').value);
      }
      estado.contagens.push(L.criarContagem(dados, agora, newId()));
    } catch (ex) { err.textContent = ex.message; return; }
    persist();
    document.getElementById('f-name').value = '';
    err.textContent = '';
    dialogoNova.close();
    render();
  });

  /* ---------- eventos da lista ---------- */
  var listaEl = document.getElementById('list');

  listaEl.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id') || (ui.painel && ui.painel.id);
    var c = id ? achar(id) : null;
    if (act === 'painel') ui.painel = { id: id, tipo: btn.getAttribute('data-tipo') };
    else if (act === 'fechar') ui.painel = null;
    else if (act === 'historico') ui.historico[id] = !ui.historico[id];
    else if (act === 'checkin' && c) { substituir(L.registrarCheckin(c, hoje())); persist(); }
    else if (act === 'desfazer-checkin' && c) { substituir(L.desfazerCheckin(c, hoje())); persist(); }
    else if (act === 'do-delete' && c) {
      estado.contagens = estado.contagens.filter(function (x) { return x.id !== id; });
      ui.painel = null;
      persist();
    }
    render();
  });

  listaEl.addEventListener('change', function (e) {
    var radio = e.target.closest('input[type="radio"]');
    if (!radio) return;
    var form = radio.closest('[data-form="recomeco"]');
    if (form) form.querySelector('[data-outro]').hidden = radio.value !== 'outro';
  });

  listaEl.addEventListener('submit', function (e) {
    var form = e.target.closest('[data-form]');
    if (!form) return;
    e.preventDefault();
    var tipo = form.getAttribute('data-form');
    var id = form.getAttribute('data-id');
    var c = achar(id);
    if (!c) return;
    var agora = Date.now();
    var msg = null;
    try {
      if (somenteLeitura) throw new Error('Os dados salvos não puderam ser lidos. Nada será gravado.');
      if (tipo === 'deslize') {
        substituir(L.registrarDeslize(c, agora, document.getElementById('ds-' + id).value));
      } else if (tipo === 'recomeco') {
        msg = document.getElementById('re-' + id);
        var quando = form.querySelector('input[type="radio"]:checked').value;
        var em = agora;
        if (quando === 'ontem') em = ontemAgora(agora);
        else if (quando === 'outro') {
          var d = document.getElementById('rd-' + id).value;
          if (!d) throw new Error('Escolha a data do recomeço.');
          em = dataHoraInput(d, document.getElementById('rh-' + id).value);
        }
        substituir(L.recomecar(c, agora, { em: em, nota: document.getElementById('rn-' + id).value }));
      } else if (tipo === 'editar') {
        msg = document.getElementById('ee-' + id);
        var dados = { nome: document.getElementById('en-' + id).value };
        if (c.tipo === 'parar') {
          var dd = document.getElementById('ed-' + id).value;
          if (!dd) throw new Error('Escolha a data de início.');
          dados.inicio = dataHoraInput(dd, document.getElementById('et-' + id).value);
          dados.custoDia = parseValor(document.getElementById('ec-' + id).value);
        }
        substituir(L.atualizarContagem(c, dados, agora));
      }
    } catch (ex) {
      if (msg) msg.textContent = ex.message; else { ui.erro = ex.message; render(); }
      return;
    }
    ui.painel = null;
    persist();
    render();
  });

  /* ---------- Pomodoro ---------- */
  var pomo = PM.novo();
  var pomoUi = { msg: '', armado: false };
  var pomoFim = null;      // setTimeout que acorda no fim da fase, mesmo fora da tela do Pomodoro
  var audioCtx = null;
  var tituloOriginal = document.title;
  var NOME_FASE = { foco: 'Foco', pausa: 'Pausa', longa: 'Pausa longa' };

  /* O service worker também altera o estado (botões da notificação), então ele é espelhado no armazém, com carimbo de hora:
     quem escreveu por último vale. O carimbo só muda aqui, nas alterações feitas nesta página. */
  function pomoSalvar() {
    pomo.atualizadoEm = Date.now();
    PM.salvar(localStorage, pomo);
    window.Armazem.gravar('pomodoro', pomo);
  }
  function espelharCred() { window.Armazem.gravar('cred', sync.credencial()); }

  /* Traz para esta página o que o service worker fez com a página fechada (Pausar, Parar, Iniciar pausa na notificação):
     o estado mais novo e os check-ins dos focos que ele concluiu. */
  function pomoAdotar() {
    return Promise.all([window.Armazem.ler('pomodoro'), window.Armazem.ler('concluidos')]).then(function (r) {
      var de = r[0] ? PM.normalizar(r[0]) : null, fila = r[1];
      var mudou = false;
      if (de && de.atualizadoEm > pomo.atualizadoEm) { pomo = de; PM.salvar(localStorage, pomo); mudou = true; }
      else if (!de || de.atualizadoEm < pomo.atualizadoEm) window.Armazem.gravar('pomodoro', pomo);
      if (Array.isArray(fila) && fila.length) {
        var checkins = false;
        fila.forEach(function (c) {
          var alvo = c && typeof c.dia === 'string' ? achar(c.contagemId) : null;
          if (alvo && alvo.tipo === 'manter' && !somenteLeitura) { substituir(L.registrarCheckin(alvo, c.dia)); checkins = true; }
        });
        window.Armazem.gravar('concluidos', null);
        if (checkins) { persist(); render(); }
      }
      if (mudou) { pomoUi.msg = ''; pomoAgendar(); pomoRender(); }
    });
  }

  /* Notificação fixa do Pomodoro (com Pausar/Parar) enquanto uma sessão roda ou está pausada. Só com a permissão já dada. */
  var pomoAvisoChave = null;
  function pomoNotificar() {
    if (!('Notification' in window) || Notification.permission !== 'granted' || !navigator.serviceWorker) return;
    var n = PM.notificacao(pomo, Date.now());
    var chave = n ? n.titulo + '|' + n.corpo : '';
    if (chave === pomoAvisoChave) return;
    pomoAvisoChave = chave;
    navigator.serviceWorker.ready.then(function (reg) {
      if (n) return reg.showNotification(n.titulo, PM.opcoesNotificacao(n));
      return reg.getNotifications({ tag: 'pomodoro' }).then(function (lista) { lista.forEach(function (x) { x.close(); }); });
    }).catch(function () { /* sem notificação: o relógio da tela continua igual */ });
  }

  /* Silêncio total é falha comum em PWA: o navegador só libera áudio depois de um toque, então prepara aqui. */
  function prepararAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      audioCtx = audioCtx || new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { audioCtx = null; }
  }
  /* Depois de recarregar ou reabrir o app com o foco rodando, o som só volta a funcionar após o próximo toque em qualquer lugar. */
  document.addEventListener('pointerdown', function () { if (pomo.rodando && !audioCtx) prepararAudio(); }, { passive: true });
  function bipe() {
    if (!audioCtx) return;
    try {
      [0, 0.28, 0.56].forEach(function (t) {
        var ini = audioCtx.currentTime + t, o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = 880;
        g.gain.setValueAtTime(0.0001, ini);
        g.gain.exponentialRampToValueAtTime(0.25, ini + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ini + 0.2);
        o.connect(g); g.connect(audioCtx.destination);
        o.start(ini); o.stop(ini + 0.22);
      });
    } catch (e) { /* sem som, o resto do aviso continua */ }
  }
  function alertarFim(texto) {
    bipe();
    if (navigator.vibrate) { try { navigator.vibrate([200, 100, 200, 100, 200]); } catch (e) { /* sem vibração */ } }
    if (document.hidden) document.title = texto + ' · ' + tituloOriginal;
  }

  function textoConclusao(c, vinculada) {
    if (c.fase !== 'foco') return 'A pausa acabou. Pronto para o próximo foco?';
    var base = c.proxima === 'longa' ? 'Foco concluído. Quatro focos! Pausa longa de 15 min.' : 'Foco concluído. Hora da pausa de 5 min.';
    return vinculada ? base + ' "' + vinculada + '" marcada.' : base;
  }

  /* Fecha a fase que acabou (se acabou), marca o check-in da contagem vinculada e avisa se aconteceu agora. */
  function pomoVerificar() {
    var agora = Date.now();
    var r = PM.avancar(pomo, agora);
    if (!r.concluiu) { pomoAgendar(); return; }
    pomo = r.estado;
    var c = r.concluiu, vinculada = '';
    if (c.contou && c.contagemId) {
      var alvo = achar(c.contagemId);
      if (alvo && alvo.tipo === 'manter' && !somenteLeitura) {
        substituir(L.registrarCheckin(alvo, c.dia));
        persist();
        render();
        vinculada = alvo.nome;
      }
    }
    pomoSalvar();
    pomoUi.msg = textoConclusao(c, vinculada);
    pomoUi.armado = false;
    if (agora - c.em < 8000) alertarFim(c.fase === 'foco' ? 'Foco concluído' : 'Pausa concluída');
    pomoAgendar();
    pomoRender();
  }
  function pomoAgendar() {
    if (pomoFim) { clearTimeout(pomoFim); pomoFim = null; }
    if (pomo.rodando) pomoFim = setTimeout(pomoVerificar, Math.max(0, pomo.fimEm - Date.now()) + 30);
    // com o app fechado quem avisa é o servidor; ao pausar, pular, parar ou concluir o alarme é cancelado
    sync.alarme(PM.alarmeDe(pomo));
    pomoNotificar();
  }

  var elPomo = {
    fase: document.getElementById('pomo-fase'), tempo: document.getElementById('pomo-tempo'), arco: document.getElementById('pomo-arco'),
    ciclo: document.getElementById('pomo-ciclo'), msg: document.getElementById('pomo-msg'), principal: document.getElementById('pomo-principal'),
    pular: document.getElementById('pomo-pular'), parar: document.getElementById('pomo-parar'), vinculo: document.getElementById('pomo-vinculo'),
    hoje: document.getElementById('pomo-hoje'), aviso: document.getElementById('pomo-aviso')
  };
  var telaPomo = document.getElementById('tela-pomodoro');
  var telaContagens = document.getElementById('tela-contagens');
  var dialogoHistorico = document.getElementById('pomo-historico');

  /* Só o relógio e o anel: roda a cada segundo sem mexer no resto da tela. */
  function pomoRelogio() {
    var rest = PM.restante(pomo, Date.now());
    var dur = PM.DURACAO[pomo.fase];
    var txt = PM.formatarTempo(rest);
    if (elPomo.tempo.textContent !== txt) elPomo.tempo.textContent = txt;
    elPomo.arco.setAttribute('stroke-dasharray', (Math.round((1 - rest / dur) * 1000) / 10) + ' 100');
  }

  function pomoOpcoesVinculo() {
    var manter = estado.contagens.filter(function (c) { return c.tipo === 'manter'; });
    if (pomo.contagemId && !manter.some(function (c) { return c.id === pomo.contagemId; })) { pomo = PM.vincular(pomo, null); pomoSalvar(); }
    elPomo.vinculo.innerHTML = '<option value="">Nenhuma</option>' + manter.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.nome) + '</option>';
    }).join('');
    elPomo.vinculo.value = pomo.contagemId || '';
  }

  function pomoRender() {
    if (telaPomo.hidden) return;
    var st = PM.status(pomo);
    var feitos = pomo.fase === 'foco' ? pomo.ciclo - 1 : pomo.fase === 'pausa' ? pomo.ciclo : PM.CICLOS;
    elPomo.arco.setAttribute('class', 'arco ' + (pomo.fase === 'foco' ? 'r-ano' : pomo.fase === 'pausa' ? 'r-semana' : 'r-mes'));
    elPomo.fase.textContent = pomo.fase === 'foco' ? 'Foco ' + pomo.ciclo + ' de ' + PM.CICLOS : NOME_FASE[pomo.fase];
    Array.prototype.forEach.call(elPomo.ciclo.children, function (li, i) {
      li.className = i < feitos ? 'feito' : (i === feitos && pomo.fase === 'foco' ? 'atual' : '');
    });
    elPomo.principal.textContent = st === 'rodando' ? 'Pausar' : st === 'pausado' ? 'Continuar'
      : pomo.fase === 'foco' ? 'Iniciar foco' : pomo.fase === 'pausa' ? 'Iniciar pausa' : 'Iniciar pausa longa';
    var nada = st === 'pronto' && pomo.fase === 'foco' && pomo.ciclo === 1;
    elPomo.pular.disabled = nada;
    elPomo.parar.disabled = nada;
    elPomo.parar.textContent = pomoUi.armado ? 'Confirmar parar' : 'Parar';
    elPomo.msg.textContent = pomoUi.armado ? 'Parar cancela esta sessão e ela não conta.' : (pomoUi.msg || (st === 'pausado' ? 'Pausado. Continue quando quiser.' : ''));
    var n = PM.pomodorosDoDia(pomo, PM.dataLocal(Date.now()));
    elPomo.hoje.textContent = n === 0 ? 'Nenhum pomodoro hoje ainda.' : 'Hoje: ' + n + ' ' + plural(n, 'pomodoro', 'pomodoros') + '.';
    elPomo.aviso.hidden = sync.status() !== 'desligado';
    pomoOpcoesVinculo();
    pomoRelogio();
  }

  // ativar ou desativar as notificações muda se o servidor pode avisar: concilia o alarme e a dica da tela
  sync.ouvir(function () { espelharCred(); pomoAgendar(); pomoRender(); });
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', function (e) { if (e.data && e.data.tipo === 'pomodoro') pomoAdotar(); });

  var armadoTimer = null;
  function desarmarParar() { pomoUi.armado = false; if (armadoTimer) { clearTimeout(armadoTimer); armadoTimer = null; } }

  elPomo.principal.addEventListener('click', function () {
    prepararAudio();
    pomoUi.msg = ''; desarmarParar();
    var agora = Date.now();
    pomo = PM.status(pomo) === 'rodando' ? PM.pausar(pomo, agora) : PM.iniciar(pomo, agora);
    pomoSalvar(); pomoAgendar(); pomoRender();
  });
  elPomo.pular.addEventListener('click', function () {
    pomoUi.msg = ''; desarmarParar();
    pomo = PM.pular(pomo);
    pomoSalvar(); pomoAgendar(); pomoRender();
  });
  elPomo.parar.addEventListener('click', function () {
    // com a sessão em andamento (ou pausada) pede um segundo toque; esperando começar, para direto
    if (PM.status(pomo) !== 'pronto' && !pomoUi.armado) {
      pomoUi.armado = true;
      armadoTimer = setTimeout(function () { armadoTimer = null; pomoUi.armado = false; pomoRender(); }, 4000);
      pomoRender();
      return;
    }
    desarmarParar();
    pomoUi.msg = '';
    pomo = PM.parar(pomo);
    pomoSalvar(); pomoAgendar(); pomoRender();
  });
  elPomo.vinculo.addEventListener('change', function () {
    pomo = PM.vincular(pomo, elPomo.vinculo.value);
    pomoSalvar();
  });

  var fmtDiaHist = new Intl.DateTimeFormat('pt-BR', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  document.getElementById('pomo-historico-abrir').addEventListener('click', function () {
    var h = PM.historico(pomo);
    document.getElementById('pomo-historico-total').textContent = h.length === 0
      ? 'Nenhum pomodoro registrado ainda. Cada foco de 25 minutos concluído aparece aqui.'
      : 'Total: ' + PM.total(pomo) + ' ' + plural(PM.total(pomo), 'pomodoro', 'pomodoros') + ' nos últimos ' + PM.MAX_DIAS + ' dias.';
    document.getElementById('pomo-historico-lista').innerHTML = h.map(function (d) {
      var p = d.dia.split('-');
      return '<li><span>' + esc(fmtDiaHist.format(new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])))) + '</span><span>' + d.n + '</span></li>';
    }).join('');
    dialogoHistorico.showModal();
  });

  /* Uma tela de cada vez, pelo endereço (#pomodoro): o botão Voltar do celular volta para as contagens. */
  function aplicarTela() {
    var noPomo = location.hash === '#pomodoro';
    telaContagens.hidden = noPomo;
    telaPomo.hidden = !noPomo;
    if (noPomo) { pomoVerificar(); pomoRender(); }
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', aplicarTela);
  document.getElementById('toggle-pomodoro').addEventListener('click', function () { location.hash = '#pomodoro'; });
  document.getElementById('pomo-voltar').addEventListener('click', function () { location.hash = ''; });
  setInterval(function () { if (!telaPomo.hidden) { pomoVerificar(); pomoRelogio(); } }, 1000);

  /* ---------- início ---------- */
  carregar();
  // um convite no endereço (#convite=...) fica guardado até ser usado, e o endereço volta a ficar limpo
  if (/^#convite/.test(location.hash)) {
    var conviteLink = window.Sincronia.conviteDoHash(location.hash);
    if (conviteLink) sync.guardarConvite(conviteLink);
    history.replaceState(null, '', location.pathname + location.search);
  }
  renderConvite();
  pomo = PM.carregar(localStorage);
  aplicarTela();
  pomoVerificar();
  espelharCred();
  pomoAdotar();
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sincronizarCorBarra);
  render();
  setInterval(tick, 15000);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) sync.descarregar();
    else { tick(); sync.retomar(estado); document.title = tituloOriginal; pomoAdotar().then(pomoVerificar); }
  });
  window.addEventListener('online', function () { sync.retomar(estado); pomoAgendar(); });
  sync.retomar(estado);
  sync.verificar();

  /* Pede ao Chrome para não apagar os dados do app e registra o modo offline */
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () {}); }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }
})();
