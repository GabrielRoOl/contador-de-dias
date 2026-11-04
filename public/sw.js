// Mude o número da versão sempre que alterar algum arquivo do app.
const CACHE = 'contagem-de-dias-v15';
const ARQUIVOS = [
  './', './index.html', './app.css', './logica.js', './textos.js', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './fonts/big-shoulders-display-700.woff2', './fonts/big-shoulders-display-800.woff2',
  './fonts/instrument-sans-400.woff2', './fonts/instrument-sans-600.woff2'
];
// Com a rede lenta demais, responde do cache em vez de travar o app.
const ESPERA_REDE_MS = 4000;

self.addEventListener('install', (e) => {
  // 'reload' ignora o cache HTTP do navegador, para o pré-cache nunca guardar arquivos velhos.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.all(ARQUIVOS.map((url) =>
        fetch(new Request(url, { cache: 'reload' })).then((resp) => {
          if (!resp.ok) throw new Error('Falha ao baixar ' + url);
          return c.put(url, resp);
        })
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Rede primeiro: online, todos os arquivos vêm da mesma versão, sem misturar HTML novo com JS antigo.
// Offline (ou rede lenta), responde do cache.
function daRede(req) {
  return fetch(req, { cache: 'no-cache' }).then(async (resp) => {
    if (resp && resp.ok && new URL(req.url).origin === location.origin) {
      const cache = await caches.open(CACHE);
      cache.put(req, resp.clone());
    }
    return resp;
  });
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    const tentativa = daRede(e.request);
    const limite = new Promise((_, rej) => setTimeout(() => rej(new Error('lento')), ESPERA_REDE_MS));
    try {
      return await Promise.race([tentativa, limite]);
    } catch (erro) {
      const cache = await caches.open(CACHE);
      // Primeiro a cópia exata (com o ?v= da versão), só depois qualquer uma do mesmo arquivo.
      const guardado = (await cache.match(e.request)) || (await cache.match(e.request, { ignoreSearch: true }));
      if (guardado) { e.waitUntil(tentativa.catch(() => {})); return guardado; }
      try { return await tentativa; } catch (e2) { return (await cache.match('./index.html')) || Response.error(); }
    }
  })());
});
