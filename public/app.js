(function () {
  var MARCOS = [1, 3, 7, 14, 30, 60, 90, 180, 365];
  var LS_KEY = 'contagem-de-dias:v1';
  var DAY = 864e5;

  var state = { counters: [], updatedAt: 0 };
  var ui = { formOpen: false, editing: null, confirming: null };
  var exampleStart = Date.now() - (12 * DAY + 5 * 36e5 + 18 * 6e4);

  var fmt = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toDateInput(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function toTimeInput(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function plural(n, a, b) { return n === 1 ? a : b; }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function calc(start, now) {
    var ms = Math.max(0, now - start);
    var elapsed = ms / DAY;
    return { elapsed: elapsed, days: Math.floor(elapsed), h: Math.floor((ms % DAY) / 36e5), m: Math.floor((ms % 36e5) / 6e4) };
  }
  function fillFraction(elapsed) {
    var last = -1;
    MARCOS.forEach(function (m, i) { if (elapsed >= m) last = i; });
    if (last === -1) return 0;
    if (last === MARCOS.length - 1) return 1;
    var a = MARCOS[last], b = MARCOS[last + 1];
    return (last + (elapsed - a) / (b - a)) / (MARCOS.length - 1);
  }

  /* ---------- storage ---------- */
  function readLocal() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      if (raw) {
        var d = JSON.parse(raw);
        if (d && Array.isArray(d.counters)) state = { counters: d.counters, updatedAt: d.updatedAt || 0 };
      }
    } catch (e) {}
  }
  function writeLocal() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function persist() {
    state.updatedAt = Date.now();
    writeLocal();
  }

  /* ---------- rendering ---------- */
  function liveHTML(start, best) {
    var t = calc(start, Date.now());
    var f = fillFraction(t.elapsed);
    var nodes = MARCOS.map(function (m) {
      return '<li class="' + (t.elapsed >= m ? 'on' : '') + '"><span class="dot"></span><span class="lbl">' + m + '</span></li>';
    }).join('');
    var next;
    var nextMark = null;
    MARCOS.some(function (m) { if (t.elapsed < m) { nextMark = m; return true; } return false; });
    if (nextMark === null) {
      next = 'Um ano ou mais. Todas as marcas foram alcançadas.';
    } else {
      var left = nextMark - t.elapsed, rem;
      if (left < 1) { var hh = Math.ceil(left * 24); rem = 'faltam ' + hh + ' h'; if (hh === 1) rem = 'falta 1 h'; }
      else { var dd = Math.ceil(left); rem = dd === 1 ? 'falta 1 dia' : 'faltam ' + dd + ' dias'; }
      next = 'Próxima marca: <strong>' + nextMark + ' ' + plural(nextMark, 'dia', 'dias') + '</strong> · ' + rem;
    }
    var rec = best > 0 ? '<p class="rec">Recorde anterior: ' + best + ' ' + plural(best, 'dia', 'dias') + '</p>' : '';
    return '<div class="count"><span class="num">' + t.days + '</span><span class="unit">' + plural(t.days, 'dia', 'dias') + '</span></div>' +
      '<p class="hm">+ ' + t.h + ' h ' + t.m + ' min</p>' +
      '<div class="track"><div class="bar"><div class="fill" style="width:calc(' + (f * 100).toFixed(3) + '%)"></div></div><ol class="marks">' + nodes + '</ol></div>' +
      '<p class="next">' + next + '</p>' + rec;
  }

  function actionsHTML(c) {
    var days = calc(c.start, Date.now()).days;
    if (ui.confirming && ui.confirming.id === c.id) {
      if (ui.confirming.type === 'reset') {
        return '<div class="confirm"><p>Zerar a contagem agora? ' + (days > (c.best || 0) ? 'Os ' + days + ' ' + plural(days, 'dia', 'dias') + ' atuais viram seu recorde.' : 'Seu recorde anterior continua salvo.') + '</p>' +
          '<div class="actions"><button class="btn small primary" type="button" data-act="do-reset" data-id="' + c.id + '">Zerar agora</button>' +
          '<button class="btn small" type="button" data-act="cancel-confirm">Cancelar</button></div></div>';
      }
      return '<div class="confirm"><p>Excluir &ldquo;' + esc(c.name) + '&rdquo;? Isso não pode ser desfeito.</p>' +
        '<div class="actions"><button class="btn small danger" type="button" data-act="do-delete" data-id="' + c.id + '">Excluir</button>' +
        '<button class="btn small" type="button" data-act="cancel-confirm">Cancelar</button></div></div>';
    }
    return '<div class="actions">' +
      '<button class="btn small" type="button" data-act="ask-reset" data-id="' + c.id + '">Recomecei</button>' +
      '<button class="btn small" type="button" data-act="edit" data-id="' + c.id + '">Editar</button>' +
      '<button class="btn small danger" type="button" data-act="ask-delete" data-id="' + c.id + '">Excluir</button></div>';
  }

  function editHTML(c) {
    return '<form class="editform" data-edit-form="' + c.id + '" novalidate>' +
      '<div class="field"><label for="en-' + c.id + '">Nome</label><input id="en-' + c.id + '" type="text" maxlength="60" value="' + esc(c.name) + '"></div>' +
      '<div class="row2"><div class="field"><label for="ed-' + c.id + '">Data de início</label><input id="ed-' + c.id + '" type="date" max="' + toDateInput(Date.now()) + '" value="' + toDateInput(c.start) + '"></div>' +
      '<div class="field"><label for="et-' + c.id + '">Hora</label><input id="et-' + c.id + '" type="time" value="' + toTimeInput(c.start) + '"></div></div>' +
      '<p class="error" id="ee-' + c.id + '" role="alert"></p>' +
      '<div class="actions"><button class="btn small primary" type="submit">Salvar</button>' +
      '<button class="btn small" type="button" data-act="cancel-edit">Cancelar</button></div></form>';
  }

  function cardHTML(c, example) {
    var body;
    if (example) {
      body = '<div class="live" data-example="1">' + liveHTML(exampleStart, 0) + '</div>';
    } else {
      body = '<div class="live" data-id="' + c.id + '">' + liveHTML(c.start, c.best || 0) + '</div>' +
        (ui.editing === c.id ? editHTML(c) : actionsHTML(c));
    }
    return '<article class="card' + (example ? ' example' : '') + '">' +
      '<div class="head"><div><h2>' + esc(c.name) + '</h2><p class="since">Desde ' + esc(fmt.format(new Date(c.start))) + '</p></div>' +
      (example ? '<span class="badge">Exemplo</span>' : '') + '</div>' + body + '</article>';
  }

  function render() {
    var list = document.getElementById('list');
    var form = document.getElementById('new-form');
    var toggle = document.getElementById('toggle-form');
    form.hidden = !ui.formOpen;
    toggle.textContent = ui.formOpen ? 'Fechar' : 'Nova contagem';
    toggle.setAttribute('aria-expanded', ui.formOpen ? 'true' : 'false');

    if (!state.counters.length) {
      list.innerHTML = '<p class="empty">Nenhuma contagem ainda. Escolha a data em que você começou, mesmo que já tenha passado, e o tempo é calculado a partir dela. Veja como fica:</p>' +
        cardHTML({ name: 'Refrigerante', start: exampleStart }, true);
      return;
    }
    var sorted = state.counters.slice().sort(function (a, b) { return a.start - b.start; });
    list.innerHTML = sorted.map(function (c) { return cardHTML(c, false); }).join('');
  }

  function tick() {
    var map = {};
    state.counters.forEach(function (c) { map[c.id] = c; });
    document.querySelectorAll('.live').forEach(function (el) {
      if (el.getAttribute('data-example')) { el.innerHTML = liveHTML(exampleStart, 0); return; }
      var c = map[el.getAttribute('data-id')];
      if (c) el.innerHTML = liveHTML(c.start, c.best || 0);
    });
  }

  /* ---------- actions ---------- */
  function find(id) { return state.counters.filter(function (c) { return c.id === id; })[0]; }

  document.getElementById('toggle-form').addEventListener('click', function () {
    ui.formOpen = !ui.formOpen;
    if (ui.formOpen) prepareForm();
    render();
    if (ui.formOpen) document.getElementById('f-name').focus();
  });

  function prepareForm() {
    var now = Date.now();
    document.getElementById('f-date').max = toDateInput(now);
    document.getElementById('f-date').value = toDateInput(now);
    document.getElementById('f-time').value = toTimeInput(now);
    document.getElementById('f-error').textContent = '';
  }

  document.getElementById('new-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var name = document.getElementById('f-name').value.trim();
    var d = document.getElementById('f-date').value;
    var t = document.getElementById('f-time').value || '00:00';
    var err = document.getElementById('f-error');
    if (!name) { err.textContent = 'Escreva o que você parou de fazer.'; return; }
    if (!d) { err.textContent = 'Escolha a data de início.'; return; }
    var start = new Date(d + 'T' + t).getTime();
    if (isNaN(start)) { err.textContent = 'Data ou hora inválida.'; return; }
    if (start > Date.now()) { err.textContent = 'A data de início não pode estar no futuro.'; return; }
    state.counters.push({ id: newId(), name: name, start: start, best: 0 });
    persist();
    document.getElementById('f-name').value = '';
    err.textContent = '';
    ui.formOpen = false;
    render();
  });

  document.getElementById('list').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-act]');
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    var id = btn.getAttribute('data-id');
    var c = id ? find(id) : null;
    if (act === 'ask-reset') { ui.confirming = { id: id, type: 'reset' }; ui.editing = null; }
    else if (act === 'ask-delete') { ui.confirming = { id: id, type: 'delete' }; ui.editing = null; }
    else if (act === 'cancel-confirm') { ui.confirming = null; }
    else if (act === 'edit') { ui.editing = id; ui.confirming = null; }
    else if (act === 'cancel-edit') { ui.editing = null; }
    else if (act === 'do-reset' && c) {
      var days = calc(c.start, Date.now()).days;
      c.best = Math.max(c.best || 0, days);
      c.start = Date.now();
      ui.confirming = null;
      persist();
    } else if (act === 'do-delete' && c) {
      state.counters = state.counters.filter(function (x) { return x.id !== id; });
      ui.confirming = null;
      persist();
    }
    render();
  });

  document.getElementById('list').addEventListener('submit', function (e) {
    var form = e.target.closest('[data-edit-form]');
    if (!form) return;
    e.preventDefault();
    var id = form.getAttribute('data-edit-form');
    var c = find(id);
    if (!c) return;
    var name = document.getElementById('en-' + id).value.trim();
    var d = document.getElementById('ed-' + id).value;
    var t = document.getElementById('et-' + id).value || '00:00';
    var err = document.getElementById('ee-' + id);
    if (!name) { err.textContent = 'O nome não pode ficar vazio.'; return; }
    if (!d) { err.textContent = 'Escolha a data de início.'; return; }
    var start = new Date(d + 'T' + t).getTime();
    if (isNaN(start)) { err.textContent = 'Data ou hora inválida.'; return; }
    if (start > Date.now()) { err.textContent = 'A data de início não pode estar no futuro.'; return; }
    c.name = name;
    c.start = start;
    ui.editing = null;
    persist();
    render();
  });

  /* ---------- start ---------- */
  readLocal();
  ui.formOpen = state.counters.length === 0;
  if (ui.formOpen) prepareForm();
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
