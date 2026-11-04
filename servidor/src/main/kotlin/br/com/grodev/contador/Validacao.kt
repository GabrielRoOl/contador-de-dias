package br.com.grodev.contador

import java.time.DateTimeException
import java.time.LocalDate
import java.time.ZoneId

/** Validação do estado enviado pelo app. Nada que vem da rede é confiado: tudo é conferido antes de ir ao banco. */
object Validacao {
    const val MAX_CONTAGENS = 200
    const val MAX_DESLIZES = 5_000
    const val MAX_TENTATIVAS = 5_000
    const val MAX_CHECKINS = 20_000
    const val MAX_NOTA = 200
    const val MAX_NOME = 60
    private const val DIA_MS = 86_400_000L

    private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")
    private val DATA = Regex("^\\d{4}-\\d{2}-\\d{2}$")
    private val HORA = Regex("^([01]\\d|2[0-3]):[0-5]\\d$")
    private val VISUAIS = setOf("futurista", "classico")
    private val MODOS = setOf("auto", "claro", "escuro")
    private val ZONAS: Set<String> = ZoneId.getAvailableZoneIds()

    fun fusoValido(fuso: String) = fuso in ZONAS && !fuso.startsWith("SystemV/")

    fun idValido(id: String) = ID.matches(id)

    /** Lista de problemas encontrados (vazia = válido). `agora` serve para recusar datas muito no futuro. */
    fun erros(e: Estado, agora: Long): List<String> {
        val erros = mutableListOf<String>()
        fun erro(msg: String) { if (erros.size < 20) erros += msg }

        if (e.versao != 2) erro("versao deve ser 2")
        if (!HORA.matches(e.preferencias.horaResumo)) erro("horaResumo deve ser HH:MM")
        if (!fusoValido(e.preferencias.fuso)) erro("fuso inválido")
        if (e.preferencias.visual !in VISUAIS) erro("visual inválido")
        if (e.preferencias.modo !in MODOS) erro("modo inválido")
        if (e.contagens.size > MAX_CONTAGENS) erro("no máximo $MAX_CONTAGENS contagens")

        val limiteFuturo = agora + DIA_MS
        val vistos = HashSet<String>()
        e.contagens.take(MAX_CONTAGENS).forEachIndexed { i, c ->
            val onde = "contagens[$i]"
            if (!ID.matches(c.id)) erro("$onde.id inválido")
            if (!vistos.add(c.id)) erro("$onde.id repetido")
            val nome = c.nome.trim()
            if (nome.isEmpty() || nome.length > MAX_NOME) erro("$onde.nome deve ter de 1 a $MAX_NOME caracteres")
            if (c.tipo != "parar" && c.tipo != "manter") erro("$onde.tipo inválido")
            if (c.inicio < 0 || c.inicio > limiteFuturo) erro("$onde.inicio fora do intervalo")
            if (c.custoDia != null && (!c.custoDia.isFinite() || c.custoDia <= 0 || c.custoDia > 1_000_000)) erro("$onde.custoDia inválido")
            if (c.tipo == "manter" && c.custoDia != null) erro("$onde.custoDia só vale para o tipo parar")
            if (c.recorde < 0 || c.recorde > 100_000) erro("$onde.recorde fora do intervalo")
            if (c.deslizes.size > MAX_DESLIZES) erro("$onde.deslizes demais")
            if (c.tentativas.size > MAX_TENTATIVAS) erro("$onde.tentativas demais")
            if (c.checkins.size > MAX_CHECKINS) erro("$onde.checkins demais")
            c.deslizes.take(MAX_DESLIZES).forEach {
                if (it.em < 0 || it.em > limiteFuturo) erro("$onde.deslizes[].em fora do intervalo")
                if (it.nota.length > MAX_NOTA) erro("$onde.deslizes[].nota longa demais")
            }
            c.tentativas.take(MAX_TENTATIVAS).forEach {
                if (it.inicio < 0 || it.fim < it.inicio || it.fim > limiteFuturo) erro("$onde.tentativas[] com datas inválidas")
                if (it.dias < 0 || it.dias > 100_000) erro("$onde.tentativas[].dias fora do intervalo")
                if (it.nota.length > MAX_NOTA) erro("$onde.tentativas[].nota longa demais")
            }
            c.checkins.take(MAX_CHECKINS).forEach { if (!dataValida(it)) erro("$onde.checkins[] deve ser YYYY-MM-DD") }
        }
        return erros
    }

    private fun dataValida(s: String): Boolean {
        if (!DATA.matches(s)) return false
        return try { LocalDate.parse(s); true } catch (_: DateTimeException) { false }
    }
}
