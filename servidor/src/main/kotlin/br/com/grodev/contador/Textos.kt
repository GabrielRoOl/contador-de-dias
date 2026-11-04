package br.com.grodev.contador

/**
 * Textos do aviso diário. É a versão em Kotlin de `public/textos.js`: as frases e a escolha por semente
 * precisam ser idênticas. Os testes comparam com casos gerados pelo próprio textos.js.
 */
object Textos {
    data class MarcoCtx(
        val tipoContagem: String,
        val nome: String,
        val dias: Int,
        val marco: Logica.Marco,
        val seed: String,
    )

    data class RetomadaCtx(val tipoContagem: String, val recorde: Int, val seed: String)

    fun plural(n: Int, a: String, b: String) = if (n == 1) a else b

    fun dias(n: Int) = "$n ${plural(n, "dia", "dias")}"

    /** Mesmo hash do JS: h = (h * 31 + charCode) >>> 0, sobre as unidades UTF-16. */
    fun hash(texto: String): Long {
        var h = 0L
        for (ch in texto) h = (h * 31 + ch.code) and 0xFFFFFFFFL
        return h
    }

    fun escolher(lista: List<String>, seed: String): String = lista[(hash(seed) % lista.size).toInt()]

    fun marco(c: MarcoCtx): String {
        val parar = c.tipoContagem == "parar"
        val qtd = when (c.marco.tipo) {
            "ano" -> "${c.marco.n} ${plural(c.marco.n, "ano", "anos")}"
            "mes" -> "${c.marco.n} ${plural(c.marco.n, "mês", "meses")}"
            else -> dias(c.dias)
        }
        val base = qtd + (if (parar) " sem " else " seguidos ") + c.nome
        val primeiro = c.marco.n == 1
        val fecho = when (c.marco.tipo) {
            "ano" -> if (primeiro) {
                listOf("Um ano inteiro!", "Um ano! Isso é muita constância.", "Um ano completo. Marco enorme.")
            } else {
                listOf("Mais um ano completo!", "Outro ano inteiro. Impressionante.")
            }
            "mes" -> if (primeiro) {
                listOf("Um mês!", "Um mês inteiro.", "Um mês de constância.")
            } else {
                listOf("Mais um mês!", "Mais um ciclo de 30 dias completo.", "Mês fechado.")
            }
            else -> if (primeiro) {
                listOf("Uma semana inteira!", "Uma semana completa.", "Sete dias seguidos de constância.")
            } else {
                listOf("Mais uma semana!", "Semana fechada.", "Mais uma semana na conta.")
            }
        }
        return "$base. " + escolher(fecho, c.seed + ":" + c.marco.tipo + c.marco.n)
    }

    fun retomada(c: RetomadaCtx): String {
        if (c.tipoContagem == "parar") {
            return escolher(
                listOf(
                    "Hoje é o dia 1 de novo. Da última vez você chegou a ${dias(c.recorde)}.",
                    "Recomeçar faz parte. Seu recorde é de ${dias(c.recorde)}, e você já sabe o caminho.",
                    "Novo começo hoje. Você já chegou a ${dias(c.recorde)} antes.",
                ),
                c.seed,
            )
        }
        return escolher(
            listOf(
                "Recomeçar faz parte. Sua melhor sequência foi de ${dias(c.recorde)}.",
                "Hoje começa uma nova sequência. A melhor até agora foi de ${dias(c.recorde)}.",
            ),
            c.seed,
        )
    }

    fun economia(valorFormatado: String) = "Você já economizou $valorFormatado."
}
