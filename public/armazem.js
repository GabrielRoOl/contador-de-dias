/* Pequeno armazém no IndexedDB, compartilhado entre a página e o service worker (que não enxerga o localStorage).
   Guarda só o que o service worker precisa para agir com o app fechado: o estado do Pomodoro e a credencial do aparelho.
   Tudo é "melhor esforço": se o IndexedDB falhar, o app segue e só perde os botões da notificação.
   No navegador e no service worker vira Armazem; no Node, module.exports (com o IndexedDB passado por parâmetro, para testar). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.Armazem = factory(root.indexedDB);
})(typeof self !== 'undefined' ? self : this, function (idb) {
  var BANCO = 'contador-sw';
  var LOJA = 'kv';
  var aberto = null;

  function abrir() {
    if (aberto) return aberto;
    aberto = new Promise(function (resolve, reject) {
      if (!idb) { reject(new Error('sem IndexedDB')); return; }
      var req = idb.open(BANCO, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(LOJA); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    aberto.catch(function () { aberto = null; }); // uma falha não trava para sempre: tenta abrir de novo na próxima
    return aberto;
  }

  function transacao(modo, usar) {
    return abrir().then(function (db) {
      return new Promise(function (resolve, reject) {
        var t = db.transaction(LOJA, modo);
        var saida;
        t.oncomplete = function () { resolve(saida); };
        t.onerror = function () { reject(t.error); };
        t.onabort = function () { reject(t.error); };
        saida = usar(t.objectStore(LOJA), function (v) { saida = v; });
      });
    });
  }

  /* Valor guardado, ou null (também se der erro). */
  function ler(chave) {
    return transacao('readonly', function (loja, dar) {
      var r = loja.get(chave);
      r.onsuccess = function () { dar(r.result === undefined ? null : r.result); };
    }).then(function (v) { return v === undefined ? null : v; }, function () { return null; });
  }
  /* true se gravou. Valor null apaga a chave. */
  function gravar(chave, valor) {
    return transacao('readwrite', function (loja) {
      if (valor === null || valor === undefined) loja.delete(chave); else loja.put(valor, chave);
    }).then(function () { return true; }, function () { return false; });
  }

  return { ler: ler, gravar: gravar };
});
