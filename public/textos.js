/* Textos do app (pt-BR, tom acolhedor, sem culpa). Todas as frases ficam aqui.
   Cada situação tem variações; `seed` escolhe sempre a mesma para a mesma contagem e dia, sem piscar a cada atualização. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Textos = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function plural(n, a, b) { return n === 1 ? a : b; }
  function dias(n) { return n + ' ' + plural(n, 'dia', 'dias'); }

  function hash(texto) {
    var h = 0;
    for (var i = 0; i < texto.length; i++) h = (h * 31 + texto.charCodeAt(i)) >>> 0;
    return h;
  }
  function escolher(lista, seed) { return lista[hash(String(seed)) % lista.length]; }

  /* Frase de marco. `contexto`: { tipoContagem: 'parar'|'manter', nome, dias, marco: { tipo, n }, seed } */
  function marco(c) {
    var parar = c.tipoContagem === 'parar';
    var qtd = c.marco.tipo === 'ano' ? c.marco.n + ' ' + plural(c.marco.n, 'ano', 'anos')
      : c.marco.tipo === 'mes' ? c.marco.n + ' ' + plural(c.marco.n, 'mês', 'meses')
      : dias(c.dias);
    var base = qtd + (parar ? ' sem ' : ' seguidos ') + c.nome;
    var fecho;
    if (c.marco.tipo === 'ano') {
      fecho = c.marco.n === 1
        ? ['Um ano inteiro!', 'Um ano! Isso é muita constância.', 'Um ano completo. Marco enorme.']
        : ['Mais um ano completo!', 'Outro ano inteiro. Impressionante.'];
    } else if (c.marco.tipo === 'mes') {
      fecho = c.marco.n === 1
        ? ['Um mês!', 'Um mês inteiro.', 'Um mês de constância.']
        : ['Mais um mês!', 'Mais um ciclo de 30 dias completo.', 'Mês fechado.'];
    } else {
      fecho = c.marco.n === 1
        ? ['Uma semana inteira!', 'Uma semana completa.', 'Sete dias seguidos de constância.']
        : ['Mais uma semana!', 'Semana fechada.', 'Mais uma semana na conta.'];
    }
    return base + '. ' + escolher(fecho, c.seed + ':' + c.marco.tipo + c.marco.n);
  }

  /* Dia seguinte a um recomeço (ou sequência perdida no manter): nunca "0 dias" seco. */
  function retomada(c) {
    if (c.tipoContagem === 'parar') {
      return escolher([
        'Hoje é o dia 1 de novo. Da última vez você chegou a ' + dias(c.recorde) + '.',
        'Recomeçar faz parte. Seu recorde é de ' + dias(c.recorde) + ', e você já sabe o caminho.',
        'Novo começo hoje. Você já chegou a ' + dias(c.recorde) + ' antes.'
      ], c.seed);
    }
    return escolher([
      'Recomeçar faz parte. Sua melhor sequência foi de ' + dias(c.recorde) + '.',
      'Hoje começa uma nova sequência. A melhor até agora foi de ' + dias(c.recorde) + '.'
    ], c.seed);
  }

  function proxima(m, faltam) {
    var rotulo = m.tipo === 'ano' ? (m.n === 1 ? 'Um ano' : m.n + ' anos')
      : m.tipo === 'mes' ? (m.n === 1 ? 'Um mês' : m.n + ' meses')
      : (m.n === 1 ? 'Uma semana' : m.n + ' semanas');
    var horas = Math.ceil(faltam * 24);
    var restam = faltam < 1 ? (horas === 1 ? 'falta 1 h' : 'faltam ' + horas + ' h')
      : (Math.ceil(faltam) === 1 ? 'falta 1 dia' : 'faltam ' + Math.ceil(faltam) + ' dias');
    return 'Próxima marca: ' + rotulo + ' · ' + restam;
  }

  function economia(valorFormatado) { return 'Você já economizou ' + valorFormatado + '.'; }

  function avisoRecomeco(diasAtuais, recorde) {
    if (diasAtuais > recorde) return 'Os ' + dias(diasAtuais) + ' atuais viram seu recorde. Tudo fica no histórico.';
    return 'Seu recorde de ' + dias(recorde) + ' continua salvo, e tudo fica no histórico.';
  }

  return { marco: marco, retomada: retomada, proxima: proxima, economia: economia, avisoRecomeco: avisoRecomeco, dias: dias, escolher: escolher };
});
