// Sobe a versão do app: troca o número do cache em sw.js e o ?v= dos arquivos no index.html.
// O HTML é sempre revalidado, então um ?v= novo força o navegador a baixar CSS e JS novos (sem versão mista).
// Uso: node scripts/versao.js [pasta=public] [versão]   (sem versão, soma 1)
const fs = require('fs');
const path = require('path');

const pasta = path.resolve(process.argv[2] || path.join(__dirname, '..', 'public'));
const arquivoSw = path.join(pasta, 'sw.js');
const arquivoHtml = path.join(pasta, 'index.html');

const sw = fs.readFileSync(arquivoSw, 'utf8');
const atual = Number(/contagem-de-dias-v(\d+)/.exec(sw)[1]);
const nova = process.argv[3] ? Number(process.argv[3]) : atual + 1;

fs.writeFileSync(arquivoSw, sw.replace(/contagem-de-dias-v\d+/, 'contagem-de-dias-v' + nova));
const html = fs.readFileSync(arquivoHtml, 'utf8');
fs.writeFileSync(arquivoHtml, html.replace(/(href|src)="(app\.css|logica\.js|textos\.js|app\.js)(\?v=\d+)?"/g, '$1="$2?v=' + nova + '"'));
console.log('versão ' + atual + ' -> ' + nova);
