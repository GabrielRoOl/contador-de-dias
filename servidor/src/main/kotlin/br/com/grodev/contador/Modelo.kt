package br.com.grodev.contador

import kotlinx.serialization.Serializable

/** Modelo v2 do app (o mesmo JSON que o front guarda em `contagem-de-dias:v2`). */

@Serializable
data class Preferencias(
    val horaResumo: String = "09:00",
    val fuso: String = "America/Sao_Paulo",
    val visual: String = "futurista",
    val modo: String = "auto",
)

@Serializable
data class Deslize(val em: Long, val nota: String = "")

@Serializable
data class Tentativa(val inicio: Long, val fim: Long, val dias: Int, val nota: String = "")

@Serializable
data class Contagem(
    val id: String,
    val nome: String,
    val tipo: String,
    val inicio: Long,
    val custoDia: Double? = null,
    val recorde: Int = 0,
    val deslizes: List<Deslize> = emptyList(),
    val tentativas: List<Tentativa> = emptyList(),
    val checkins: List<String> = emptyList(),
)

@Serializable
data class Estado(
    val versao: Int = 2,
    val preferencias: Preferencias = Preferencias(),
    val contagens: List<Contagem> = emptyList(),
    val atualizadoEm: Long = 0,
)

/**
 * O que o servidor precisa para montar o aviso diário. Notas, deslizes e o detalhe do histórico nunca são lidos aqui,
 * então nem são guardados: menos dados pessoais no servidor e linhas pequenas no banco.
 * `Mensagens.compor` dá o mesmo resultado com o estado completo e com o reduzido (conferido em MensagensTest).
 */
fun Estado.paraServidor(): Estado = copy(
    preferencias = preferencias.copy(visual = Preferencias().visual, modo = Preferencias().modo),
    contagens = contagens.map { c ->
        c.copy(
            deslizes = emptyList(),
            tentativas = c.tentativas.take(1).map { it.copy(nota = "") }, // só importa se existe alguma
            checkins = c.checkins.distinct().sorted(),
        )
    },
)
