// Mude o número da versão sempre que alterar algum arquivo do app.
const CACHE = 'contagem-de-dias-v6';
const ARQUIVOS = [
  './', './index.html', './app.css', './logica.js', './textos.js', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png',
  './fonts/big-shoulders-display-700.woff2', './fonts/big-shoulders-display-800.woff2',
  './fonts/instrument-sans-400.woff2', './fonts/instrument-sans-600.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ARQUIVOS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((chaves) => Promise.all(chaves.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const guardado = await cache.match(e.request, { ignoreSearch: true });
      const rede = fetch(e.request)
        .then((resp) => {
          if (resp && resp.ok && new URL(e.request.url).origin === location.origin) cache.put(e.request, resp.clone());
          return resp;
        })
        .catch(() => null);
      if (guardado) { e.waitUntil(rede); return guardado; }
      return (await rede) || (await cache.match('./index.html'));
    })
  );
});
