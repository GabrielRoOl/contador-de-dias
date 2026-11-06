// Mude o número da versão sempre que alterar algum arquivo do app.
const CACHE = 'contagem-de-dias-v29';
const ARQUIVOS = [
  './', './index.html', './app.css', './logica.js', './textos.js', './sincronia.js', './pomodoro.js', './armazem.js', './app.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './icon-maskable-512.png', './icon-badge.png',
  './fonts/big-shoulders-display-700.woff2', './fonts/big-shoulders-display-800.woff2',
  './fonts/instrument-sans-400.woff2', './fonts/instrument-sans-600.woff2'
];
// Lógica do Pomodoro e armazém (IndexedDB) compartilhados com a página: os botões da notificação agem com o app fechado.
importScripts('./pomodoro.js', './armazem.js');

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
  // A API do servidor nunca passa pelo cache: dados velhos de lá enganariam o app.
  if (new URL(e.request.url).pathname.indexOf('/api/') !== -1) return;
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

/* ---------- notificações (Web Push) ---------- */
const TITULO_PADRAO = 'Contagem de Dias';
const CORPO_PADRAO = 'Abra o app para ver suas contagens.';

// O servidor manda JSON, mas um corpo vazio ou ilegível não pode virar erro: o Chrome exige mostrar algo a cada push.
function lerPush(data) {
  if (!data) return {};
  try {
    const d = data.json();
    return d && typeof d === 'object' ? d : {};
  } catch (erro) {
    try { return { corpo: data.text() }; } catch (e2) { return {}; }
  }
}

function texto(v, max, padrao) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : padrao;
}

// Só endereços do próprio app: um push nunca leva o usuário para outro site.
function urlDoApp(v) {
  try {
    const u = new URL(typeof v === 'string' ? v : './', self.registration.scope);
    if (u.origin === location.origin && u.href.indexOf(self.registration.scope) === 0) return u.href;
  } catch (erro) { /* cai no padrão */ }
  return self.registration.scope;
}

self.addEventListener('push', (e) => {
  const d = lerPush(e.data);
  const tag = typeof d.tag === 'string' && /^[\w-]{1,64}$/.test(d.tag) ? d.tag : 'resumo-diario';
  const opcoes = {
    body: texto(d.corpo, 300, CORPO_PADRAO),
    tag,
    renotify: true, // o resumo de hoje avisa de novo mesmo substituindo o de ontem, se ainda estiver na bandeja
    icon: './icon-192.png',
    badge: './icon-badge.png',
    data: { url: urlDoApp(d.url), marco: d.marco === true }
  };
  if (tag === 'pomodoro') {
    // Fim de fase: toca e vibra (o som é o da notificação do Android) e já traz o botão que inicia a fase seguinte.
    opcoes.silent = false;
    opcoes.vibrate = [300, 150, 300, 150, 300];
    opcoes.requireInteraction = true;
    if (FASES_POMODORO.indexOf(d.proxima) !== -1) {
      opcoes.actions = [{ action: 'iniciar', title: self.Pomodoro.rotuloIniciar(d.proxima) }];
      opcoes.data.proxima = d.proxima;
    }
  }
  e.waitUntil(self.registration.showNotification(texto(d.titulo, 100, TITULO_PADRAO), opcoes));
});

const FASES_POMODORO = ['foco', 'pausa', 'longa'];
const ACOES_POMODORO = ['pausar', 'continuar', 'iniciar', 'parar'];

// Mantém no servidor o alarme que combina com o estado (o mesmo que a página faz quando está aberta). Melhor esforço.
async function ajustarAlarme(desejado) {
  const cred = await self.Armazem.ler('cred');
  if (!cred || typeof cred.id !== 'string' || typeof cred.segredo !== 'string') return;
  const url = new URL('api/dispositivos/' + encodeURIComponent(cred.id) + '/alarme', self.registration.scope).href;
  const init = { method: desejado ? 'PUT' : 'DELETE', headers: { Authorization: 'Bearer ' + cred.segredo }, cache: 'no-store' };
  if (desejado) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(desejado); }
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const corte = setTimeout(() => { if (ctl) ctl.abort(); }, 8000);
  if (ctl) init.signal = ctl.signal;
  try { await fetch(url, init); } catch (erro) { /* sem rede: o app concilia ao abrir */ } finally { clearTimeout(corte); }
}

// Botão da notificação do Pomodoro (Pausar, Continuar, Iniciar pausa, Parar): altera o estado guardado no armazém,
// atualiza a notificação e o alarme do servidor, e avisa as janelas abertas para adotarem o novo estado.
async function acaoPomodoro(acao) {
  const bruto = await self.Armazem.ler('pomodoro');
  if (!bruto) return false; // nada espelhado ainda: o app resolve quando abrir
  const agora = Date.now();
  const r = self.Pomodoro.aplicarAcao(self.Pomodoro.normalizar(bruto), acao, agora);
  if (!r.aplicou) return false;
  await self.Armazem.gravar('pomodoro', r.estado);
  if (r.concluiu && r.concluiu.contou && r.concluiu.contagemId) {
    // o check-in da contagem vinculada é do app (ele é dono das contagens): fica na fila até ele abrir
    const fila = (await self.Armazem.ler('concluidos')) || [];
    fila.push({ contagemId: r.concluiu.contagemId, dia: r.concluiu.dia });
    await self.Armazem.gravar('concluidos', fila.slice(-20));
  }
  const n = self.Pomodoro.notificacao(r.estado, agora);
  if (n) await self.registration.showNotification(n.titulo, self.Pomodoro.opcoesNotificacao(n));
  await ajustarAlarme(self.Pomodoro.alarmeDe(r.estado));
  const janelas = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  janelas.forEach((j) => { try { j.postMessage({ tipo: 'pomodoro' }); } catch (erro) { /* janela fechando */ } });
  return true;
}

async function abrirOuFocar(url) {
  const janelas = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  const aberta = janelas.find((j) => j.url.indexOf(self.registration.scope) === 0);
  if (!aberta) return clients.openWindow(url);
  await aberta.focus();
  // Atalho para uma tela do app (./#pomodoro) leva até ela mesmo com o app aberto; mudar só a âncora não recarrega a página.
  if (new URL(url).hash && aberta.url !== url && typeof aberta.navigate === 'function') {
    try { await aberta.navigate(url); } catch (erro) { /* fica onde está */ }
  }
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = urlDoApp(e.notification.data && e.notification.data.url);
  if (ACOES_POMODORO.indexOf(e.action) !== -1) {
    e.waitUntil(acaoPomodoro(e.action).then((agiu) => (agiu ? undefined : abrirOuFocar(url))));
    return;
  }
  e.waitUntil(abrirOuFocar(url));
});
