package br.com.grodev.contador

import java.time.ZoneId

/** O aviso diário: um por dispositivo, com o texto calculado no servidor a partir do estado sincronizado. */
data class Aviso(val titulo: String, val corpo: String, val tag: String = "resumo-diario", val temMarco: Boolean = false)

object Mensagens {
    const val TITULO = "Contagem de Dias"
    const val TITULO_MARCO = "Marco atingido!"
    private const val MAX_LINHAS = 8
    private const val PERGUNTA_PADRAO = "Hoje já foi?"
    private val PERGUNTAS = listOf("Hoje já foi?", "Já fez hoje?", "E hoje, já foi?")

    private class Linha(
        val completo: String,
        val curto: String,
        val marco: Logica.Marco?,
        val pendente: Boolean,
        val economia: Double,
    )

    /** Devolve null quando não há o que avisar (nenhuma contagem). */
    fun compor(estado: Estado, agora: Long, zona: ZoneId): Aviso? {
        if (estado.contagens.isEmpty()) return null
        val hoje = Logica.dataLocal(agora, zona)
        val linhas = estado.contagens.map { c -> if (c.tipo == "manter") linhaManter(c, hoje, zona) else linhaParar(c, agora, zona) }
        val temMarco = linhas.any { it.marco != null }
        val titulo = if (temMarco) TITULO_MARCO else TITULO

        if (linhas.size == 1) return Aviso(titulo, linhas[0].completo, temMarco = temMarco)

        val marcos = linhas.filter { it.marco != null }.sortedByDescending { peso(it.marco!!) }
        val visiveis = linhas.take(MAX_LINHAS)
        val resumo = visiveis.joinToString(" · ") { it.curto } + if (linhas.size > visiveis.size) " · e mais ${linhas.size - visiveis.size}" else ""
        val partes = mutableListOf<String>()
        if (marcos.isNotEmpty()) partes += marcos.take(2).joinToString(" ") { it.completo }
        partes += resumo
        val total = linhas.sumOf { it.economia }
        if (total > 0) partes += Textos.economia(Logica.formatarReais(total))
        if (linhas.any { it.pendente }) partes += PERGUNTA_PADRAO
        return Aviso(titulo, partes.joinToString("\n"), temMarco = temMarco)
    }

    private fun peso(m: Logica.Marco) = when (m.tipo) { "ano" -> 3; "mes" -> 2; else -> 1 }

    private fun linhaParar(c: Contagem, agora: Long, zona: ZoneId): Linha {
        val dias = Logica.calcular(c.inicio, agora, zona).dias
        val seed = "${c.id}:$dias"
        val marco = Logica.marcoDoDia(c.inicio, dias, zona)
        val eco = Logica.economia(dias, c.custoDia)?.takeIf { it > 0 }
        var texto = when {
            marco != null -> Textos.marco(Textos.MarcoCtx("parar", c.nome, dias, marco, seed))
            c.tentativas.isNotEmpty() && dias <= 1 -> Textos.retomada(Textos.RetomadaCtx("parar", c.recorde, seed))
            dias == 0 -> "Primeiro dia sem ${c.nome}. Um passo de cada vez."
            else -> Textos.escolher(
                listOf("Você está há ${Textos.dias(dias)} sem ${c.nome}.", "${Textos.dias(dias)} sem ${c.nome}. Siga assim.", "Mais um dia sem ${c.nome}: já são ${Textos.dias(dias)}."),
                seed,
            )
        }
        if (eco != null) texto += " " + Textos.economia(Logica.formatarReais(eco))
        val curto = if (dias == 0) "primeiro dia sem ${c.nome}" else "${Textos.dias(dias)} sem ${c.nome}"
        return Linha(texto, curto, marco, pendente = false, economia = eco ?: 0.0)
    }

    private fun linhaManter(c: Contagem, hoje: java.time.LocalDate, zona: ZoneId): Linha {
        val ciclo = Logica.cicloManter(c.checkins, hoje, zona)
        val seed = "${c.id}:${ciclo.dias}:$hoje"
        val pergunta = Textos.escolher(PERGUNTAS, seed)
        // O marco só vale quando o check-in de hoje foi o que completou o ciclo
        val marco = if (ciclo.feitoHoje && ciclo.inicio != null) Logica.marcoDoDia(ciclo.inicio, ciclo.dias, zona) else null
        val pendente = !ciclo.feitoHoje
        val texto = when {
            marco != null -> Textos.marco(Textos.MarcoCtx("manter", c.nome, ciclo.dias, marco, seed))
            ciclo.dias > 0 -> "${Textos.dias(ciclo.dias)} seguidos ${c.nome}." + if (pendente) " $pergunta" else ""
            ciclo.quebrou -> Textos.retomada(Textos.RetomadaCtx("manter", Logica.maiorSequencia(c.checkins), seed))
            else -> "Marque o primeiro dia de ${c.nome} quando quiser."
        }
        val curto = if (ciclo.dias > 0) "${Textos.dias(ciclo.dias)} ${c.nome}" else "${c.nome}: recomece hoje"
        return Linha(texto, curto, marco, pendente, economia = 0.0)
    }
}
