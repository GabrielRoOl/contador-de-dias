(function () {
  var L = window.Logica;
  var T = window.Textos;
  var DAY = L.DAY;

  var estado = L.estadoVazio(Date.now());
  var ui = { formAberto: false, ajustesAbertos: false, painel: null, historico: {}, dia: '', erro: '' };
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

  /* ---------- armazenamento ---------- */
  function carregar() {
    try {
      var r = L.carregarOuMigrar(localStorage, Date.now(), fusoLocal());
      estado = r.estado;
    } catch (e) {
      somenteLeitura = true;
      ui.erro = 'Não consegui ler seus dados salvos (' + e.message + '). Nada foi apagado nem será sobrescrito.';
    }
    if (!somenteLeitura && estado.preferencias.fuso !== fusoLocal()) {
      estado.preferencias.fuso = fusoLocal();
      persist();
    }
  }
  function persist() {
    if (somenteLeitura) return;
    try { estado = L.salvar(localStorage, estado, Date.now()); ui.erro = ''; }
    catch (e) { ui.erro = 'Não foi possível salvar neste aparelho. Libere espaço ou verifique as permissões do navegador.'; }
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

  function statHTML(rotulo, valor) { return '<div><dt>' + rotulo + '</dt><dd>' + valor + '</dd></div>'; }

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
    return '<form class="editform" data-form="deslize" data-id="' + c.id + '" novalidate>' +
      '<p class="hint">Um deslize não zera a sua contagem. Só fica registrado.</p>' +
      '<div class="field"><label for="ds-' + c.id + '">O que aconteceu? (opcional)</label><input id="ds-' + c.id + '" type="text" maxlength="200" autocomplete="off"></div>' +
      '<div class="actions"><button class="btn small primary" type="submit">Registrar</button>' +
      '<button class="btn small" type="button" data-act="fechar">Cancelar</button></div></form>';
  }

  function formRecomeco(c) {
    var agora = Date.now();
    var dias = L.calcular(c.inicio, agora).dias;
    var recorde = Math.max(c.recorde || 0, dias);
    return '<form class="editform" data-form="recomeco" data-id="' + c.id + '" novalidate>' +
      '<p class="hint">Recomeçar faz parte. ' + esc(T.avisoRecomeco(dias, c.recorde || 0)) + '</p>' +
      '<fieldset class="radios"><legend class="sr">Quando você recomeçou</legend>' +
      '<label><input type="radio" name="rq-' + c.id + '" value="agora" checked><span>Agora</span></label>' +
      '<label><input type="radio" name="rq-' + c.id + '" value="ontem"><span>Ontem</span></label>' +
      '<label><input type="radio" name="rq-' + c.id + '" value="outro"><span>Outro momento</span></label></fieldset>' +
      '<div class="row2" data-outro hidden><div class="field"><label for="rd-' + c.id + '">Data</label><input id="rd-' + c.id + '" type="date" max="' + hoje() + '" value="' + hoje() + '"></div>' +
      '<div class="field"><label for="rh-' + c.id + '">Hora</label><input id="rh-' + c.id + '" type="time" value="' + toTimeInput(agora) + '"></div></div>' +
      '<div class="field"><label for="rn-' + c.id + '">O que pesou? (opcional)</label><input id="rn-' + c.id + '" type="text" maxlength="200" autocomplete="off"></div>' +
      '<p class="error" id="re-' + c.id + '" role="alert"></p>' +
      '<div class="actions"><button class="btn small primary" type="submit">Recomeçar</button>' +
      '<button class="btn small" type="button" data-act="fechar">Cancelar</button></div></form>';
  }

  function formEditar(c) {
    var parar = c.tipo === 'parar';
    return '<form class="editform" data-form="editar" data-id="' + c.id + '" novalidate>' +
      '<div class="field"><label for="en-' + c.id + '">Nome</label><input id="en-' + c.id + '" type="text" maxlength="60" value="' + esc(c.nome) + '"></div>' +
      (parar ? '<div class="row2"><div class="field"><label for="ed-' + c.id + '">Data de início</label><input id="ed-' + c.id + '" type="date" max="' + hoje() + '" value="' + L.dataLocal(c.inicio) + '"></div>' +
        '<div class="field"><label for="et-' + c.id + '">Hora</label><input id="et-' + c.id + '" type="time" value="' + toTimeInput(c.inicio) + '"></div></div>' +
        '<div class="field"><label for="ec-' + c.id + '">Custo por dia (opcional)</label><input id="ec-' + c.id + '" type="text" inputmode="decimal" value="' + (c.custoDia ? String(c.custoDia).replace('.', ',') : '') + '"></div>' : '') +
      '<p class="error" id="ee-' + c.id + '" role="alert"></p>' +
      '<div class="actions"><button class="btn small primary" type="submit">Salvar</button>' +
      '<button class="btn small" type="button" data-act="fechar">Cancelar</button></div></form>';
  }

  function confirmarExcluir(c) {
    return '<div class="confirm"><p>Excluir &ldquo;' + esc(c.nome) + '&rdquo;? Isso não pode ser desfeito.</p>' +
      '<div class="actions"><button class="btn small danger" type="button" data-act="do-delete" data-id="' + c.id + '">Excluir</button>' +
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
        ? '<div class="confirm"><p class="checkin-feito">Feito hoje.</p><div class="actions"><button class="btn small" type="button" data-act="desfazer-checkin" data-id="' + c.id + '">Desfazer</button></div></div>'
        : '<button class="btn primary big" type="button" data-act="checkin" data-id="' + c.id + '">Hoje eu fiz</button>';
      return html + '<div class="actions"><button class="btn small" type="button" data-act="painel" data-tipo="editar" data-id="' + c.id + '">Editar</button>' +
        '<button class="btn small danger" type="button" data-act="painel" data-tipo="excluir" data-id="' + c.id + '">Excluir</button></div>';
    }
    return '<div class="actions">' +
      '<button class="btn small" type="button" data-act="painel" data-tipo="deslize" data-id="' + c.id + '">Deslize</button>' +
      '<button class="btn small" type="button" data-act="painel" data-tipo="recomeco" data-id="' + c.id + '">Recomecei</button>' +
      '<button class="btn small" type="button" data-act="historico" data-id="' + c.id + '" aria-expanded="' + (ui.historico[c.id] ? 'true' : 'false') + '">Histórico</button>' +
      '<button class="btn small" type="button" data-act="painel" data-tipo="editar" data-id="' + c.id + '">Editar</button>' +
      '<button class="btn small danger" type="button" data-act="painel" data-tipo="excluir" data-id="' + c.id + '">Excluir</button></div>';
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
    var corpo = '<div class="live"' + (exemplo ? ' data-exemplo="1"' : ' data-id="' + c.id + '"') + '>' + liveHTML(c, Date.now()) + '</div>';
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
    var form = document.getElementById('new-form');
    var ajustes = document.getElementById('ajustes');
    var toggle = document.getElementById('toggle-form');
    var toggleAj = document.getElementById('toggle-ajustes');
    form.hidden = !ui.formAberto;
    ajustes.hidden = !ui.ajustesAbertos;
    toggle.textContent = ui.formAberto ? 'Fechar' : 'Nova contagem';
    toggle.setAttribute('aria-expanded', ui.formAberto ? 'true' : 'false');
    toggleAj.setAttribute('aria-expanded', ui.ajustesAbertos ? 'true' : 'false');
    ui.dia = hoje();

    var aviso = ui.erro ? '<p class="error" role="alert">' + esc(ui.erro) + '</p>' : '';
    if (!estado.contagens.length) {
      lista.innerHTML = aviso + '<p class="empty">Nenhuma contagem ainda. Escolha a data em que você começou, mesmo que já tenha passado, e o tempo é calculado a partir dela. Veja como fica:</p>' + cardHTML(exemplo(), true);
      return;
    }
    var ordenadas = estado.contagens.slice().sort(function (a, b) { return a.inicio - b.inicio; });
    lista.innerHTML = aviso + ordenadas.map(function (c) { return cardHTML(c, false); }).join('');
  }

  function tick() {
    if (ui.dia !== hoje() && !ui.painel && !ui.formAberto) { render(); return; }
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

  document.getElementById('toggle-form').addEventListener('click', function () {
    ui.formAberto = !ui.formAberto;
    if (ui.formAberto) prepararFormulario();
    render();
    if (ui.formAberto) document.getElementById('f-name').focus();
  });

  document.getElementById('toggle-ajustes').addEventListener('click', function () {
    ui.ajustesAbertos = !ui.ajustesAbertos;
    if (ui.ajustesAbertos) {
      document.getElementById('a-hora').value = estado.preferencias.horaResumo;
      document.getElementById('a-fuso').textContent = 'Fuso do aparelho: ' + estado.preferencias.fuso + '.';
    }
    render();
  });

  document.getElementById('a-hora').addEventListener('change', function (e) {
    if (/^\d{2}:\d{2}$/.test(e.target.value)) { estado.preferencias.horaResumo = e.target.value; persist(); }
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
    ui.formAberto = false;
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

  /* ---------- início ---------- */
  carregar();
  ui.formAberto = estado.contagens.length === 0 && !somenteLeitura;
  if (ui.formAberto) prepararFormulario();
  render();
  setInterval(tick, 15000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });

  /* Pede ao Chrome para não apagar os dados do app e registra o modo offline */
  if (navigator.storage && navigator.storage.persist) { navigator.storage.persist().catch(function () {}); }
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }
})();
