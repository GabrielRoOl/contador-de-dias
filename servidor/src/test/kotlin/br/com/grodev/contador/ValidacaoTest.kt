package br.com.grodev.contador

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ValidacaoTest {
    private val agora = 1_762_000_000_000L

    private fun contagem(
        id: String = "a1", nome: String = "Refrigerante", tipo: String = "parar", inicio: Long = agora - 86_400_000L * 7,
        custoDia: Double? = null, checkins: List<String> = emptyList(),
    ) = Contagem(id = id, nome = nome, tipo = tipo, inicio = inicio, custoDia = custoDia, checkins = checkins)

    private fun estado(vararg c: Contagem, prefs: Preferencias = Preferencias()) = Estado(preferencias = prefs, contagens = c.toList())

    private fun erros(e: Estado) = Validacao.erros(e, agora)

    @Test fun `estado vazio e padrão é válido`() = assertEquals(emptyList(), erros(Estado()))

    @Test fun `contagem comum é válida`() = assertEquals(emptyList(), erros(estado(contagem(custoDia = 6.5))))

    @Test fun `versão diferente de 2 é recusada`() = assertTrue(erros(Estado(versao = 1)).any { "versao" in it })

    @Test fun `hora do resumo precisa ser HH MM válida`() {
        listOf("9:00", "24:00", "09:60", "ab:cd", "", "09:00:00").forEach {
            assertTrue(erros(Estado(preferencias = Preferencias(horaResumo = it))).any { m -> "horaResumo" in m }, it)
        }
        listOf("00:00", "09:00", "23:59").forEach { assertEquals(emptyList(), erros(Estado(preferencias = Preferencias(horaResumo = it))), it) }
    }

    @Test fun `fuso precisa existir`() {
        assertTrue(erros(Estado(preferencias = Preferencias(fuso = "Marte/Olympus"))).any { "fuso" in it })
        assertTrue(erros(Estado(preferencias = Preferencias(fuso = ""))).any { "fuso" in it })
        assertEquals(emptyList(), erros(Estado(preferencias = Preferencias(fuso = "America/Sao_Paulo"))))
        assertEquals(emptyList(), erros(Estado(preferencias = Preferencias(fuso = "Australia/Lord_Howe"))))
    }

    @Test fun `visual e modo precisam ser conhecidos`() {
        assertTrue(erros(Estado(preferencias = Preferencias(visual = "neon"))).any { "visual" in it })
        assertTrue(erros(Estado(preferencias = Preferencias(modo = "sepia"))).any { "modo" in it })
    }

    @Test fun `id inválido ou repetido é recusado`() {
        listOf("", "a b", "a/b", "../x", "x".repeat(65), "á").forEach {
            assertTrue(erros(estado(contagem(id = it))).any { m -> "id" in m }, "id=[$it]")
        }
        assertTrue(erros(estado(contagem(id = "x"), contagem(id = "x"))).any { "repetido" in it })
    }

    @Test fun `nome vazio ou longo demais é recusado`() {
        assertTrue(erros(estado(contagem(nome = "   "))).any { "nome" in it })
        assertTrue(erros(estado(contagem(nome = "a".repeat(61)))).any { "nome" in it })
        assertEquals(emptyList(), erros(estado(contagem(nome = "a".repeat(60)))))
    }

    @Test fun `tipo desconhecido é recusado`() = assertTrue(erros(estado(contagem(tipo = "outro"))).any { "tipo" in it })

    @Test fun `início no futuro distante é recusado, mas há tolerância de um dia`() {
        assertTrue(erros(estado(contagem(inicio = agora + 2 * 86_400_000L))).any { "inicio" in it })
        assertEquals(emptyList(), erros(estado(contagem(inicio = agora + 3_600_000L))))
        assertTrue(erros(estado(contagem(inicio = -1))).any { "inicio" in it })
    }

    @Test fun `custo precisa ser positivo e finito, e só vale em parar`() {
        listOf(0.0, -1.0, Double.NaN, Double.POSITIVE_INFINITY, 2_000_000.0).forEach {
            assertTrue(erros(estado(contagem(custoDia = it))).any { m -> "custoDia" in m }, it.toString())
        }
        assertTrue(erros(estado(contagem(tipo = "manter", custoDia = 5.0))).any { "custoDia" in it })
    }

    @Test fun `check-ins precisam ser datas reais`() {
        listOf("2026-13-01", "2026-02-30", "2026-1-1", "hoje", "2026-11-03T10:00").forEach {
            assertTrue(erros(estado(contagem(tipo = "manter", checkins = listOf(it)))).any { m -> "checkins" in m }, it)
        }
        assertEquals(emptyList(), erros(estado(contagem(tipo = "manter", checkins = listOf("2026-11-03", "2024-02-29")))))
    }

    @Test fun `notas longas demais são recusadas`() {
        val c = contagem().copy(deslizes = listOf(Deslize(agora, "x".repeat(201))))
        assertTrue(erros(estado(c)).any { "nota" in it })
    }

    @Test fun `tentativa com fim antes do início é recusada`() {
        val c = contagem().copy(tentativas = listOf(Tentativa(inicio = agora, fim = agora - 1, dias = 0)))
        assertTrue(erros(estado(c)).any { "tentativas" in it })
    }

    @Test fun `limites de quantidade`() {
        val muitas = (1..201).map { contagem(id = "c$it") }
        assertTrue(erros(Estado(contagens = muitas)).any { "no máximo" in it })
        val checkins = (0 until Validacao.MAX_CHECKINS + 1).map { java.time.LocalDate.of(1990, 1, 1).plusDays(it.toLong()).toString() }
        assertTrue(erros(estado(contagem(tipo = "manter", checkins = checkins))).any { "checkins demais" in it })
    }

    @Test fun `a lista de erros é limitada`() {
        val ruins = (1..100).map { contagem(id = "!$it", nome = "") }
        assertTrue(erros(Estado(contagens = ruins.take(Validacao.MAX_CONTAGENS))).size <= 20)
    }

    @Test fun `fusoValido e idValido`() {
        assertTrue(Validacao.fusoValido("Europe/London"))
        assertTrue(!Validacao.fusoValido("Nao/Existe"))
        assertTrue(Validacao.idValido("abc_DEF-123"))
        assertTrue(!Validacao.idValido("a b"))
    }
}
