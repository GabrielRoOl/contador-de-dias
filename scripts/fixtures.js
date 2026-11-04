// Gera casos de teste a partir de public/logica.js e public/textos.js para o servidor em Kotlin conferir
// que dá exatamente os mesmos resultados. Uso: node scripts/fixtures.js
// (a saída vai para servidor/src/test/resources/fixtures-js.json; rode de novo se mudar logica.js ou textos.js)
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ZONAS = ['America/Sao_Paulo', 'America/Los_Angeles', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Auckland', 'America/St_Johns', 'UTC'];
const SAIDA = path.join(__dirname, '..', 'servidor', 'src', 'test', 'resources', 'fixtures-js.json');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gerarZona() {
  const L = require('../public/logica.js');
  const rnd = mulberry32(20261103);
  const inteiro = (a, b) => a + Math.floor(rnd() * (b - a + 1));
  const ini2019 = new Date(2019, 0, 1).getTime();
  const fim2030 = new Date(2030, 11, 31).getTime();
  const instante = () => ini2019 + Math.floor(rnd() * (fim2030 - ini2019));
  // datas especiais: bissexto, viradas de ano e proximidade das trocas de horário de verão
  const especiais = [
    new Date(2024, 1, 29, 10, 0).getTime(), new Date(2020, 1, 29, 0, 0).getTime(), new Date(2027, 5, 1, 9, 0).getTime(),
    new Date(2026, 9, 28, 9, 0).getTime(), new Date(2026, 2, 7, 23, 30).getTime(), new Date(2026, 2, 8, 2, 30).getTime(),
    new Date(2026, 9, 31, 23, 59).getTime(), new Date(2026, 10, 1, 1, 30).getTime(), new Date(2026, 3, 4, 2, 15).getTime(),
    new Date(2025, 11, 31, 23, 59).getTime(), new Date(2026, 0, 1, 0, 0).getTime(),
  ];
  const inicios = especiais.concat(Array.from({ length: 22 }, instante));

  const calcular = [];
  inicios.forEach((inicio) => {
    for (let i = 0; i < 2; i++) {
      const agora = inicio + Math.floor(Math.floor(rnd() * 900 * 864e5) * (rnd() < 0.5 ? 1 : 0.1)) + inteiro(0, 86400000);
      const r = L.calcular(inicio, agora);
      calcular.push({ inicio, agora, decorrido: r.decorrido, dias: r.dias, horas: r.horas, minutos: r.minutos });
    }
    // mesmo horário de parede, k dias depois (atravessa trocas de horário de verão)
    const d = new Date(inicio);
    [7, 30, 100, 180, 365, 366].forEach((k) => {
      const agora = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, d.getHours(), d.getMinutes(), d.getSeconds()).getTime();
      const r = L.calcular(inicio, agora);
      calcular.push({ inicio, agora, decorrido: r.decorrido, dias: r.dias, horas: r.horas, minutos: r.minutos });
    });
  });

  const aniversarios = [];
  inicios.forEach((inicio) => {
    for (let n = 1; n <= 6; n++) aniversarios.push({ inicio, n, ms: L.adicionarAnos(inicio, n), dias: L.diasAteAniversario(inicio, n) });
  });

  const anosCompletos = [];
  inicios.forEach((inicio) => {
    for (let i = 0; i < 2; i++) {
      const agora = inicio + Math.floor(rnd() * 2600 * 864e5);
      anosCompletos.push({ inicio, agora, anos: L.anosCompletos(inicio, agora) });
    }
    [1, 2, 3].forEach((n) => {
      const a = L.adicionarAnos(inicio, n);
      anosCompletos.push({ inicio, agora: a - 1, anos: L.anosCompletos(inicio, a - 1) });
      anosCompletos.push({ inicio, agora: a, anos: L.anosCompletos(inicio, a) });
    });
  });

  const marcos = [];
  inicios.slice(0, 14).forEach((inicio) => {
    const datas = new Set([1, 6, 7, 14, 29, 30, 60, 90, 210, 364, 365, 366, 367, 730, 731, 732, 1095, 1096, 1460, 1461, 1462, 1825, 1826]);
    for (let n = 1; n <= 6; n++) { const a = L.diasAteAniversario(inicio, n); datas.add(a - 1); datas.add(a); datas.add(a + 1); }
    datas.forEach((dias) => marcos.push({ inicio, dias, marco: L.marcoDoDia(inicio, dias) }));
    [0, 0.5, 6.5, 28, 364.2, 365.9, 1000.5].forEach((dias) => {
      const p = L.proximoMarco(inicio, dias);
      marcos.push({ inicio, proximo: dias, resultado: p });
    });
  });

  const ciclos = [];
  for (let i = 0; i < 40; i++) {
    const hoje = L.dataLocal(instante());
    const base = new Date(hoje + 'T12:00:00').getTime();
    const lista = [];
    const comeco = inteiro(0, 3);
    const tam = inteiro(0, 12);
    for (let k = 0; k < tam; k++) {
      if (rnd() < 0.85) lista.push(L.dataLocal(new Date(new Date(base).getFullYear(), new Date(base).getMonth(), new Date(base).getDate() - comeco - k).getTime()));
    }
    if (rnd() < 0.5) lista.push(L.dataLocal(new Date(new Date(base).getFullYear(), new Date(base).getMonth(), new Date(base).getDate() - inteiro(20, 90)).getTime()));
    const c = L.cicloManter(lista, hoje);
    ciclos.push({ checkins: lista, hoje, sequencia: L.sequenciaCheckins(lista, hoje), maior: L.maiorSequencia(lista), ciclo: c });
  }

  return { calcular, aniversarios, anosCompletos, marcos, ciclos };
}

function gerarTextos() {
  const T = require('../public/textos.js');
  const L = require('../public/logica.js');
  const rnd = mulberry32(777);
  const nomes = ['refrigerante', 'estudando inglês', 'cigarro', 'redes sociais', 'treino 💪', 'açúcar', 'a'.repeat(40)];
  const marcoCasos = [];
  const tipos = [['semana', [1, 2, 5, 52]], ['mes', [1, 2, 12]], ['ano', [1, 2, 10]]];
  for (let i = 0; i < 120; i++) {
    const [tipo, ns] = tipos[i % 3];
    const n = ns[Math.floor(rnd() * ns.length)];
    const dias = tipo === 'ano' ? 365 * n : tipo === 'mes' ? 30 * n : 7 * n;
    const ctx = { tipoContagem: i % 2 ? 'manter' : 'parar', nome: nomes[Math.floor(rnd() * nomes.length)], dias, marco: { tipo, n }, seed: 'id' + Math.floor(rnd() * 1e6) + ':' + dias };
    marcoCasos.push({ ctx, texto: T.marco(ctx) });
  }
  const retomadas = [];
  for (let i = 0; i < 50; i++) {
    const ctx = { tipoContagem: i % 2 ? 'manter' : 'parar', recorde: Math.floor(rnd() * 400), seed: 'r' + Math.floor(rnd() * 1e6) };
    retomadas.push({ ctx, texto: T.retomada(ctx) });
  }
  const hashes = ['', 'a', 'refrigerante', 'ação:30', 'id123:7', '💪x', 'ÁÉÍÓÚ-çã'].map((s) => ({ texto: s, hash: (() => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; })() }));
  const economias = [];
  [[0, 5], [1, 0.1], [3, 0.1], [7, 4.55], [26, 2], [10, 6.5], [100, 12.34], [365, 19.99], [1000, 7.77], [5, 0], [5, null], [9, 0.285], [2, 1234.5]].forEach(([dias, custo]) => {
    const v = L.economia(dias, custo);
    economias.push({ dias, custo, valor: v, formatado: v === null ? null : L.formatarReais(v).replace(/\s/g, ' ') });
  });
  return { marcoCasos, retomadas, hashes, economias };
}

if (process.argv[2] === '--zona') {
  process.stdout.write(JSON.stringify(gerarZona()));
} else {
  const zonas = {};
  ZONAS.forEach((z) => {
    zonas[z] = JSON.parse(execFileSync(process.execPath, [__filename, '--zona'], { env: { ...process.env, TZ: z }, maxBuffer: 1 << 28 }).toString());
  });
  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  fs.writeFileSync(SAIDA, JSON.stringify({ zonas, textos: gerarTextos() }));
  const tot = Object.values(zonas).reduce((s, z) => s + Object.values(z).reduce((a, l) => a + l.length, 0), 0);
  console.log('fixtures: ' + ZONAS.length + ' fusos, ' + tot + ' casos em ' + path.relative(process.cwd(), SAIDA));
}
