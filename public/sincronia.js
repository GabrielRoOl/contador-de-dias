/* Notificações e espelho do estado no servidor. O app funciona igual sem isto: toda falha de rede é tratada aqui
   e nunca chega a quebrar a tela. O ambiente (fetch, storage, navigator...) entra por parâmetro, para testar no Node.
   No navegador vira window.Sincronia; no Node, module.exports. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sincronia = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var CHAVE = 'contagem-de-dias:push';
  var BASE = './api/'; // relativa à página: no servidor vira /contador/api/
  var ESPERA_ENVIO_MS = 2000;
  var LIMITE_REDE_MS = 10000;
  var LIMITE_SW_MS = 8000;
  var LIMITE_KEEPALIVE = 60000; // o navegador recusa corpos maiores que ~64 KB com keepalive

  /* ---------- helpers puros ---------- */
  function base64UrlParaBytes(txt) {
    var b64 = String(txt).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesParaBase64Url(buf) {
    var b = new Uint8Array(buf), s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function mesmosBytes(a, b) {
    if (!a || !b) return false;
    var x = new Uint8Array(a), y = new Uint8Array(b);
    if (x.length !== y.length) return false;
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  /* Formato que o servidor espera em PUT /push. */
  function corpoInscricao(sub) {
    var j = typeof sub.toJSON === 'function' ? sub.toJSON() : {};
    var k = j.keys || {};
    if (!j.endpoint || !k.p256dh || !k.auth) throw new Error('inscrição incompleta');
    return { endpoint: j.endpoint, keys: { p256dh: k.p256dh, auth: k.auth } };
  }

  /* O que vai para o servidor: só o que o aviso diário usa. Notas e deslizes ficam só neste aparelho. */
  function espelho(estado) {
    if (!estado || !Array.isArray(estado.contagens)) return estado;
    return Object.assign({}, estado, {
      contagens: estado.contagens.map(function (c) {
        var tent = Array.isArray(c.tentativas) ? c.tentativas.slice(0, 1).map(function (t) { return Object.assign({}, t, { nota: '' }); }) : [];
        return Object.assign({}, c, { deslizes: [], tentativas: tent });
      })
    });
  }

  function criar(amb) {
    var cred = null; // {id, segredo, ativo, pendente, endpoint}
    var ouvintes = [];
    var timer = null;
    var voando = false;
    var versao = 0;      // sobe a cada mudança; o envio só limpa "pendente" se nada mudou durante ele
    var estadoAtual = null;

    /* ---------- credenciais ---------- */
    function ler() {
      try {
        var c = JSON.parse(amb.storage.getItem(CHAVE));
        if (c && typeof c.id === 'string' && typeof c.segredo === 'string') return c;
      } catch (e) { /* sem credenciais */ }
      return null;
    }
    function gravar() {
      try {
        if (cred) amb.storage.setItem(CHAVE, JSON.stringify(cred));
        else amb.storage.removeItem(CHAVE);
      } catch (e) { /* o app segue; só não lembra do dispositivo */ }
    }
    function mudou() { ouvintes.slice().forEach(function (f) { try { f(); } catch (e) { /* ouvinte não derruba a sincronia */ } }); }
    function esquecer() { cred = null; gravar(); mudou(); }
    cred = ler();

    /* ---------- estado exibido ---------- */
    function suportado() {
      return !!(amb.navigator && amb.navigator.serviceWorker && amb.PushManager && amb.Notification);
    }
    function permissao() { return suportado() ? amb.Notification.permission : 'denied'; }
    /* nao-suportado | bloqueado | desligado | ativo */
    function status() {
      if (!suportado()) return 'nao-suportado';
      if (permissao() === 'denied') return 'bloqueado';
      return cred && cred.ativo ? 'ativo' : 'desligado';
    }

    /* ---------- rede ---------- */
    /* Resolve com {status, json}; só rejeita (Error 'rede') quando não houve resposta nenhuma. */
    function pedir(metodo, caminho, corpo, opcoes) {
      opcoes = opcoes || {};
      var cab = {};
      if (corpo !== undefined) cab['Content-Type'] = 'application/json';
      if (opcoes.auth && cred) cab.Authorization = 'Bearer ' + cred.segredo;
      if (opcoes.convite) cab['X-Convite'] = opcoes.convite; // só no cadastro; nunca é guardado
      var ctl = typeof AbortController === 'function' ? new AbortController() : null;
      var corte = amb.setTimeout(function () { if (ctl) ctl.abort(); }, LIMITE_REDE_MS);
      var init = { method: metodo, headers: cab, cache: 'no-store' };
      if (corpo !== undefined) init.body = JSON.stringify(corpo);
      if (ctl) init.signal = ctl.signal;
      if (opcoes.keepalive) init.keepalive = true;
      return amb.fetch(BASE + caminho, init).then(function (r) {
        amb.clearTimeout(corte);
        return r.text().then(function (t) {
          var json = null;
          try { json = t ? JSON.parse(t) : null; } catch (e) { /* corpo não é JSON */ }
          return { status: r.status, json: json };
        });
      }, function () {
        amb.clearTimeout(corte);
        throw new Error('rede');
      });
    }
    function caminhoDispositivo(sufixo) { return 'dispositivos/' + encodeURIComponent(cred.id) + (sufixo || ''); }
    function ehRede(e) { return e && e.message === 'rede'; }

    /* ---------- ativar ---------- */
    function esperarSw() {
      return Promise.race([
        amb.navigator.serviceWorker.ready,
        new Promise(function (_, rej) { amb.setTimeout(function () { rej(new Error('sw')); }, LIMITE_SW_MS); })
      ]);
    }
    function falha(motivo) { return { ok: false, motivo: motivo }; }

    /* Devolve {ok:true} ou {ok:false, motivo}. Motivos: nao-suportado, bloqueado, dispensado, rede, limite,
       servidor-sem-push, servidor-cheio, convite (o servidor pede um código), convite-invalido, inscricao. Só deve ser chamada a partir de um toque do usuário (pede a permissão). */
    function ativar(estado, convite, jaRecriou) {
      if (!suportado()) return Promise.resolve(falha('nao-suportado'));
      var reg;
      return Promise.resolve(amb.Notification.requestPermission()).then(function (perm) {
        if (perm === 'denied') throw falha('bloqueado');
        if (perm !== 'granted') throw falha('dispensado');
        return esperarSw().catch(function () { throw falha('inscricao'); });
      }).then(function (r) {
        reg = r;
        if (cred) return null;
        return pedir('POST', 'dispositivos', undefined, { convite: convite }).then(function (resp) {
          if (resp.status === 403) throw falha(convite ? 'convite-invalido' : 'convite');
          if (resp.status === 429) throw falha('limite');
          if (resp.status === 503) throw falha('servidor-cheio');
          if (resp.status !== 201 || !resp.json || !resp.json.id || !resp.json.segredo) throw falha('rede');
          cred = { id: resp.json.id, segredo: resp.json.segredo, ativo: false };
          gravar();
        });
      }).then(function () {
        return pedir('GET', 'chave-publica');
      }).then(function (resp) {
        if (resp.status === 503) throw falha('servidor-sem-push');
        if (resp.status !== 200 || !resp.json || !resp.json.chave) throw falha('rede');
        var chave = base64UrlParaBytes(resp.json.chave);
        return reg.pushManager.getSubscription().then(function (sub) {
          if (sub && sub.options && mesmosBytes(sub.options.applicationServerKey, chave)) return sub;
          // inscrição de outra chave (servidor novo): precisa trocar, o navegador não aceita as duas
          return (sub ? sub.unsubscribe() : Promise.resolve()).then(function () {
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chave });
          });
        });
      }).catch(function (e) {
        if (e && e.ok === false) throw e;
        if (ehRede(e)) throw falha('rede');
        throw falha('inscricao');
      }).then(function (sub) {
        var corpo;
        try { corpo = corpoInscricao(sub); } catch (e) { throw falha('inscricao'); }
        return pedir('PUT', caminhoDispositivo('/push'), corpo, { auth: true }).then(function (resp) {
          if (resp.status === 401) throw { recriar: true };
          if (resp.status === 503) throw falha('servidor-sem-push');
          if (resp.status !== 204) throw falha('inscricao');
          cred.endpoint = corpo.endpoint;
          return pedir('PUT', caminhoDispositivo('/estado'), espelho(estado), { auth: true });
        });
      }).then(function (resp) {
        if (resp.status === 401) throw { recriar: true };
        if (resp.status === 507) throw falha('servidor-cheio');
        if (resp.status !== 204) throw falha('rede');
        cred.ativo = true;
        cred.pendente = false;
        gravar();
        mudou();
        return { ok: true };
      }).catch(function (e) {
        // dispositivo apagado no servidor (ex.: ficou 1 ano sem sincronizar): começa de novo uma vez só
        if (e && e.recriar && !jaRecriou) { cred = null; gravar(); return ativar(estado, convite, true); }
        if (e && e.ok === false) return e;
        return falha(ehRede(e) ? 'rede' : 'servidor');
      });
    }

    /* ---------- desativar ---------- */
    /* Apaga primeiro no servidor; sem rede, continua ativo e avisa (senão a cópia ficaria lá sem você saber). */
    function desativar() {
      var apagar = cred ? pedir('DELETE', caminhoDispositivo(), undefined, { auth: true }) : Promise.resolve({ status: 204 });
      return apagar.then(function (resp) {
        if (resp.status !== 204 && resp.status !== 401 && resp.status !== 404) return falha('servidor');
        return soltarInscricao().then(function () {
          if (timer) { amb.clearTimeout(timer); timer = null; }
          esquecer();
          return { ok: true };
        });
      }, function () { return falha('rede'); });
    }
    function soltarInscricao() {
      if (!suportado()) return Promise.resolve();
      return amb.navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg ? reg.pushManager.getSubscription() : null;
      }).then(function (sub) { return sub ? sub.unsubscribe() : null; }).catch(function () { /* melhor esforço */ });
    }

    /* ---------- espelho do estado ---------- */
    function agendar(estado) {
      if (!cred || !cred.ativo) return;
      estadoAtual = estado;
      versao++;
      if (!cred.pendente) { cred.pendente = true; gravar(); }
      if (timer) amb.clearTimeout(timer);
      timer = amb.setTimeout(enviar, ESPERA_ENVIO_MS);
    }
    function enviar() {
      timer = null;
      if (!cred || !cred.ativo || !estadoAtual) return Promise.resolve();
      if (voando) return Promise.resolve(); // a rodada em andamento vê a versão nova e repete
      voando = true;
      var minha = versao;
      var texto = JSON.stringify(espelho(estadoAtual));
      return pedir('PUT', caminhoDispositivo('/estado'), JSON.parse(texto), { auth: true, keepalive: texto.length < LIMITE_KEEPALIVE })
        .then(function (resp) {
          if (resp.status === 401) { esquecer(); return; }
          if (resp.status === 204 && cred) {
            if (versao === minha) { cred.pendente = false; gravar(); }
          }
        }, function () { /* sem rede: continua pendente, tenta de novo em retomar() */ })
        .then(function () {
          voando = false;
          if (cred && cred.ativo && cred.pendente && versao !== minha) return enviar();
        });
    }
    /* Chamar ao abrir o app, ao voltar a rede e ao voltar para a aba: reenvia o que ficou pendente. */
    function retomar(estado) {
      if (!cred || !cred.ativo || !cred.pendente) return Promise.resolve();
      estadoAtual = estado;
      return enviar();
    }
    /* Ao esconder a aba: não espera o debounce. */
    function descarregar() {
      if (timer) { amb.clearTimeout(timer); return enviar(); }
      return Promise.resolve();
    }

    /* Ao abrir o app: se a inscrição do navegador sumiu ou mudou, ajusta. Nunca pede permissão. */
    function verificar() {
      if (!suportado() || !cred || !cred.ativo) return Promise.resolve();
      if (permissao() === 'denied') return Promise.resolve();
      return amb.navigator.serviceWorker.getRegistration().then(function (reg) {
        return reg ? reg.pushManager.getSubscription() : null;
      }).then(function (sub) {
        if (!sub) { cred.ativo = false; gravar(); mudou(); return; } // o navegador perdeu a inscrição: volta a "desligado"
        var corpo = corpoInscricao(sub);
        if (corpo.endpoint === cred.endpoint) return;
        return pedir('PUT', caminhoDispositivo('/push'), corpo, { auth: true }).then(function (resp) {
          if (resp.status === 401) esquecer();
          else if (resp.status === 204) { cred.endpoint = corpo.endpoint; gravar(); }
        });
      }).catch(function () { /* sem rede agora: confere na próxima abertura */ });
    }

    /* ---------- convites (só o aparelho administrador) ---------- */
    function motivoDe(resp) { return resp.status === 429 ? 'limite' : 'servidor'; }
    function comoAdministrador(metodo, sufixo, corpo, tratar) {
      if (!cred || !cred.ativo) return Promise.resolve({ ok: false, motivo: 'inativo' });
      return pedir(metodo, caminhoDispositivo(sufixo), corpo, { auth: true }).then(function (resp) {
        if (resp.status === 401) { esquecer(); return { ok: false, motivo: 'inativo' }; }
        return tratar(resp);
      }, function () { return { ok: false, motivo: 'rede' }; });
    }
    /* {ok:true, admin:false} para aparelho comum (403); {ok:true, admin:true, lista:[...]} para o administrador. */
    function convites() {
      return comoAdministrador('GET', '/convites', undefined, function (resp) {
        if (resp.status === 403) return { ok: true, admin: false };
        if (resp.status !== 200 || !Array.isArray(resp.json)) return { ok: false, motivo: motivoDe(resp) };
        return { ok: true, admin: true, lista: resp.json };
      });
    }
    /* Devolve {ok:true, convite:{id, codigo, expiraEm}}. O código só existe nesta resposta: não é guardado. */
    function criarConvite(nome) {
      return comoAdministrador('POST', '/convites', { nome: nome }, function (resp) {
        if (resp.status === 201 && resp.json && resp.json.codigo) return { ok: true, convite: resp.json };
        if (resp.status === 409) return { ok: false, motivo: 'pendentes' };
        if (resp.status === 400) return { ok: false, motivo: 'nome' };
        return { ok: false, motivo: motivoDe(resp) };
      });
    }
    function revogarConvite(id) {
      return comoAdministrador('DELETE', '/convites/' + encodeURIComponent(id), undefined, function (resp) {
        return resp.status === 204 || resp.status === 404 ? { ok: true } : { ok: false, motivo: motivoDe(resp) };
      });
    }

    return {
      convites: convites, criarConvite: criarConvite, revogarConvite: revogarConvite,
      status: status, ativar: ativar, desativar: desativar, agendar: agendar, retomar: retomar,
      descarregar: descarregar, verificar: verificar,
      ouvir: function (f) { ouvintes.push(f); },
      temDispositivo: function () { return !!cred; }
    };
  }

  return { criar: criar, espelho: espelho, base64UrlParaBytes: base64UrlParaBytes, bytesParaBase64Url: bytesParaBase64Url, mesmosBytes: mesmosBytes, corpoInscricao: corpoInscricao };
});
