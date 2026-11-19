package br.com.grodev.contador

import java.text.DecimalFormat
import java.text.DecimalFormatSymbols
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Locale
import kotlin.math.floor
import kotlin.math.max

/**
 * Lógica pura do app, a versão em Kotlin de `public/logica.js`. Os resultados precisam ser idênticos:
 * os testes comparam com casos gerados pelo próprio logica.js, em vários fusos (inclusive com horário de verão).
 * O fuso entra sempre como parâmetro, já que o servidor atende dispositivos de fusos diferentes.
 */
object Logica {
    const val DIA_MS = 86_400_000L

    data class Tempo(val decorrido: Double, val dias: Int, val horas: Int, val minutos: Int)
    data class Marco(val tipo: String, val n: Int)
    data class ProximoMarco(val dia: Int, val tipo: String, val n: Int, val faltam: Double)
    data class Sequencia(val dias: Int, val feitoHoje: Boolean)
    /** `dias` são as vezes feitas seguidas; `span`, os dias do calendário entre o primeiro e o último "Fiz" (com frequência 1 são iguais). */
    data class CicloManter(
        val dias: Int, val feitoHoje: Boolean, val inicio: Long?, val referencia: Long?, val quebrou: Boolean,
        val span: Int = 0, val descanso: Boolean = false, val proximoEm: Long? = null,
    )
    data class EstatisticasParar(val sequenciaAtual: Int, val recorde: Int, val totalDias: Int, val deslizes: Int, val tentativas: Int)

    fun dataLocal(ms: Long, zona: ZoneId): LocalDate = Instant.ofEpochMilli(ms).atZone(zona).toLocalDate()

    private fun msDoDia(ms: Long, zona: ZoneId): Long {
        val t = Instant.ofEpochMilli(ms).atZone(zona).toLocalTime()
        return ((t.hour * 60L + t.minute) * 60 + t.second) * 1000 + t.nano / 1_000_000
    }

    /** Tempo decorrido pelo relógio de parede: 7 dias depois, no mesmo horário, são sempre 7 dias. */
    fun calcular(inicio: Long, agora: Long, zona: ZoneId): Tempo {
        val parede = ChronoUnit.DAYS.between(dataLocal(inicio, zona), dataLocal(agora, zona)) * DIA_MS +
            msDoDia(agora, zona) - msDoDia(inicio, zona)
        val ms = max(0L, parede)
        return Tempo(ms.toDouble() / DIA_MS, (ms / DIA_MS).toInt(), ((ms % DIA_MS) / 3_600_000).toInt(), ((ms % 3_600_000) / 60_000).toInt())
    }

    /** Mesmo dia e hora, n anos depois. 29/02 num ano sem bissexto vira 28/02. */
    fun adicionarAnos(ms: Long, n: Int, zona: ZoneId): Long =
        Instant.ofEpochMilli(ms).atZone(zona).toLocalDateTime().plusYears(n.toLong()).atZone(zona).toInstant().toEpochMilli()

    fun diasAteAniversario(inicio: Long, n: Int, zona: ZoneId): Int =
        ChronoUnit.DAYS.between(dataLocal(inicio, zona), dataLocal(adicionarAnos(inicio, n, zona), zona)).toInt()

    fun anosCompletos(inicio: Long, agora: Long, zona: ZoneId): Int {
        var n = 0
        while (adicionarAnos(inicio, n + 1, zona) <= agora) n++
        return n
    }

    /** Semana a cada 7 dias, mês a cada 30 e ano no aniversário do calendário. Vale o maior: ano > mês > semana. */
    fun marcoDoDia(inicio: Long, dias: Int, zona: ZoneId): Marco? {
        if (dias < 1) return null
        val estimativa = dias / 365
        for (a in max(1, estimativa - 1)..estimativa + 1) {
            if (diasAteAniversario(inicio, a, zona) == dias) return Marco("ano", a)
        }
        if (dias % 30 == 0) return Marco("mes", dias / 30)
        if (dias % 7 == 0) return Marco("semana", dias / 7)
        return null
    }

    fun proximoMarco(inicio: Long, dias: Double, zona: ZoneId): ProximoMarco {
        var n = floor(dias).toInt() + 1
        while (true) {
            val m = marcoDoDia(inicio, n, zona)
            if (m != null) return ProximoMarco(n, m.tipo, m.n, n - dias)
            n++
        }
    }

    // ---------- check-in (tipo manter) ----------

    private fun conjunto(checkins: List<String>): Set<Long> =
        checkins.mapNotNull { runCatching { LocalDate.parse(it).toEpochDay() }.getOrNull() }.toSet()

    const val FREQ_MAX = 7

    /** A cada quantos dias o hábito é feito: 1 (todo dia) a 7. Qualquer outra coisa vale 1. */
    fun normFreq(f: Int): Int = if (f in 1..FREQ_MAX) f else 1

    private class Cadeia(val n: Int, val primeiro: Long, val ultimo: Long, val feitoHoje: Boolean)

    /**
     * A sequência continua enquanto dois "Fiz" seguidos estiverem a no máximo `freq` dias um do outro. Está viva até `freq`
     * dias depois do último "Fiz"; passou disso, quebrou. Conta as vezes feitas. Igual ao `cadeiaAtual` do logica.js.
     */
    private fun cadeiaAtual(checkins: List<String>, hoje: LocalDate, freq: Int): Cadeia? {
        val f = normFreq(freq)
        val h = hoje.toEpochDay()
        val dias = conjunto(checkins).filter { it <= h }.sorted()
        if (dias.isEmpty()) return null
        val ultimo = dias.last()
        if (h - ultimo > f) return null
        var i = dias.size - 1
        while (i > 0 && dias[i] - dias[i - 1] <= f) i--
        return Cadeia(dias.size - i, dias[i], ultimo, ultimo == h)
    }

    /** Vezes seguidas até hoje. Com freq 1: dias consecutivos terminando hoje (ontem ainda vale até o fim do dia). */
    fun sequenciaCheckins(checkins: List<String>, hoje: LocalDate, freq: Int = 1): Sequencia {
        val c = cadeiaAtual(checkins, hoje, freq) ?: return Sequencia(0, false)
        return Sequencia(c.n, c.feitoHoje)
    }

    fun maiorSequencia(checkins: List<String>, freq: Int = 1): Int {
        val f = normFreq(freq)
        val dias = conjunto(checkins).sorted()
        var maior = 0
        var atual = 0
        dias.forEachIndexed { i, d ->
            atual = if (i > 0 && d - dias[i - 1] <= f) atual + 1 else 1
            if (atual > maior) maior = atual
        }
        return maior
    }

    private fun meiaNoite(epochDay: Long, zona: ZoneId): Long =
        LocalDate.ofEpochDay(epochDay).atStartOfDay(zona).toInstant().toEpochMilli()

    fun cicloManter(checkins: List<String>, hoje: LocalDate, zona: ZoneId, freq: Int = 1): CicloManter {
        val f = normFreq(freq)
        val c = cadeiaAtual(checkins, hoje, f) ?: return CicloManter(0, false, null, null, checkins.isNotEmpty())
        return CicloManter(
            dias = c.n, feitoHoje = c.feitoHoje, inicio = meiaNoite(c.primeiro, zona), referencia = meiaNoite(c.ultimo + 1, zona), quebrou = false,
            span = (c.ultimo - c.primeiro + 1).toInt(), descanso = !c.feitoHoje && hoje.toEpochDay() - c.ultimo < f, proximoEm = c.ultimo + f,
        )
    }

    // ---------- parar ----------

    fun estatisticasParar(c: Contagem, agora: Long, zona: ZoneId): EstatisticasParar {
        val atual = calcular(c.inicio, agora, zona).dias
        return EstatisticasParar(atual, max(c.recorde, atual), c.tentativas.sumOf { it.dias } + atual, c.deslizes.size, c.tentativas.size + 1)
    }

    // ---------- economia ----------

    /** Só existe com custo por dia informado. Arredonda para centavos, "meio para cima" como o Math.round do JS. */
    fun economia(diasCompletos: Int, custoDia: Double?): Double? {
        if (custoDia == null || !(custoDia > 0)) return null
        val x = diasCompletos * custoDia * 100
        val piso = floor(x)
        return (if (x - piso >= 0.5) piso + 1 else piso) / 100
    }

    private val formatoReal = ThreadLocal.withInitial {
        DecimalFormat("#,##0.00", DecimalFormatSymbols(Locale.forLanguageTag("pt-BR")))
    }

    /** "R$ 1.234,50", com espaço sem quebra depois do R$, como o Intl do navegador. */
    fun formatarReais(valor: Double): String = "R$ " + formatoReal.get().format(valor)
}
