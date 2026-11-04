package br.com.grodev.contador

import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class MensagensTest {
    private val sp = ZoneId.of("America/Sao_Paulo")
    private val hoje = LocalDate.of(2026, 11, 3)
    private val agora = ZonedDateTime.of(2026, 11, 3, 9, 0, 0, 0, sp).toInstant().toEpochMilli()

    /** Início `d` dias antes de hoje, à meia-noite local. */
    private fun inicioHa(d: Int) = hoje.minusDays(d.toLong()).atStartOfDay(sp).toInstant().toEpochMilli()

    private fun parar(id: String, nome: String, dias: Int, custo: Double? = null, tentativas: List<Tentativa> = emptyList(), recorde: Int = 0) =
        Contagem(id, nome, "parar", inicioHa(dias), custo, recorde, emptyList(), tentativas, emptyList())

    private fun manter(id: String, nome: String, checkins: List<String>) =
        Contagem(id, nome, "manter", inicioHa(30), null, 0, emptyList(), emptyList(), checkins)

    private fun datas(vararg atras: Int) = atras.map { hoje.minusDays(it.toLong()).toString() }

    private fun aviso(vararg c: Contagem) = Mensagens.compor(Estado(contagens = c.toList()), agora, sp)

    @Test fun `sem contagens não há aviso`() = assertNull(aviso())

    @Test fun `uma contagem de parar fala direto do número de dias`() {
        val a = assertNotNull(aviso(parar("a", "refrigerante", 10)))
        assertEquals(Mensagens.TITULO, a.titulo)
        assertEquals("resumo-diario", a.tag)
        assertFalse(a.temMarco)
        assertTrue("10 dias" in a.corpo && "refrigerante" in a.corpo, a.corpo)
        assertFalse("seco" in a.corpo)
    }

    @Test fun `no dia 7 o texto é de marco e o título também`() {
        val a = assertNotNull(aviso(parar("a", "refrigerante", 7)))
        assertEquals(Mensagens.TITULO_MARCO, a.titulo)
        assertTrue(a.temMarco)
        assertTrue(a.corpo.startsWith("7 dias sem refrigerante. "), a.corpo)
    }

    @Test fun `marcos de mês e de ano`() {
        assertTrue(assertNotNull(aviso(parar("a", "x", 30))).corpo.startsWith("1 mês sem x. "))
        val ano = Contagem("a", "x", "parar", ZonedDateTime.of(2025, 11, 3, 8, 0, 0, 0, sp).toInstant().toEpochMilli(), null, 0, emptyList(), emptyList(), emptyList())
        assertTrue(assertNotNull(Mensagens.compor(Estado(contagens = listOf(ano)), agora, sp)).corpo.startsWith("1 ano sem x. "))
    }

    @Test fun `depois de um recomeço o texto é de retomada e nunca cita zero dias`() {
        val t = listOf(Tentativa(inicioHa(20), inicioHa(0), 20))
        listOf(0, 1).forEach { d ->
            val a = assertNotNull(aviso(parar("a", "refri", d, tentativas = t, recorde = 12)))
            assertTrue("12 dias" in a.corpo, a.corpo)
            assertFalse(Regex("\\b0 dias").containsMatchIn(a.corpo), a.corpo)
        }
    }

    @Test fun `primeiro dia de uma contagem nova não diz zero dias`() {
        val a = assertNotNull(aviso(parar("a", "refri", 0)))
        assertFalse(Regex("\\b0 dias").containsMatchIn(a.corpo), a.corpo)
        assertTrue(a.corpo.startsWith("Primeiro dia sem refri"), a.corpo)
    }

    @Test fun `economia entra no texto quando há custo por dia`() {
        val a = assertNotNull(aviso(parar("a", "refri", 10, custo = 5.2)))
        assertTrue(a.corpo.endsWith("Você já economizou R$ 52,00."), a.corpo)
        assertFalse("economizou" in assertNotNull(aviso(parar("a", "refri", 10))).corpo)
    }

    @Test fun `hábito sem check-in hoje termina com a pergunta`() {
        val a = assertNotNull(aviso(manter("m", "estudando inglês", datas(10, 9, 8, 7, 6, 5, 4, 3, 2, 1))))
        assertTrue(a.corpo.startsWith("10 dias seguidos estudando inglês."), a.corpo)
        assertTrue(a.corpo.endsWith("?"), a.corpo)
        assertFalse(a.temMarco)
    }

    @Test fun `hábito já marcado hoje não pergunta`() {
        val a = assertNotNull(aviso(manter("m", "inglês", datas(2, 1, 0))))
        assertEquals("3 dias seguidos inglês.", a.corpo)
    }

    @Test fun `hábito que fecha 7 dias com o check-in de hoje é marco`() {
        val a = assertNotNull(aviso(manter("m", "inglês", datas(6, 5, 4, 3, 2, 1, 0))))
        assertTrue(a.temMarco)
        assertTrue(a.corpo.startsWith("7 dias seguidos inglês. "), a.corpo)
    }

    @Test fun `hábito com sequência perdida usa a retomada com a melhor sequência`() {
        val a = assertNotNull(aviso(manter("m", "inglês", datas(20, 19, 18, 17))))
        assertTrue("4 dias" in a.corpo, a.corpo)
        assertFalse(a.temMarco)
    }

    @Test fun `hábito sem nenhum check-in convida a começar`() {
        assertEquals("Marque o primeiro dia de inglês quando quiser.", assertNotNull(aviso(manter("m", "inglês", emptyList()))).corpo)
    }

    @Test fun `várias contagens viram um resumo só`() {
        val a = assertNotNull(aviso(parar("a", "refrigerante", 10), manter("m", "estudando inglês", datas(4, 3, 2, 1))))
        val linhas = a.corpo.split("\n")
        assertEquals("10 dias sem refrigerante · 4 dias estudando inglês", linhas[0])
        assertTrue(linhas.last().endsWith("?"), "lembrete do hábito: ${a.corpo}")
        assertEquals(Mensagens.TITULO, a.titulo)
    }

    @Test fun `no resumo o marco tem prioridade e vai primeiro`() {
        val a = assertNotNull(aviso(parar("a", "refrigerante", 10), parar("b", "cigarro", 30), parar("c", "doces", 14)))
        assertEquals(Mensagens.TITULO_MARCO, a.titulo)
        val primeira = a.corpo.split("\n")[0]
        assertTrue(primeira.startsWith("1 mês sem cigarro. "), a.corpo)
        assertTrue(primeira.contains("2 semanas") || primeira.contains("14 dias sem doces"), a.corpo)
    }

    @Test fun `o marco maior vem antes no resumo`() {
        val a = assertNotNull(aviso(parar("a", "doces", 7), parar("b", "cigarro", 30)))
        assertTrue(a.corpo.split("\n")[0].startsWith("1 mês sem cigarro. "), a.corpo)
    }

    @Test fun `economia total aparece no resumo`() {
        val a = assertNotNull(aviso(parar("a", "x", 10, custo = 2.0), parar("b", "y", 5, custo = 4.0)))
        assertTrue(a.corpo.contains("Você já economizou R$ 40,00."), a.corpo)
    }

    @Test fun `muitas contagens são abreviadas e o texto fica pequeno`() {
        val muitas = (1..30).map { parar("c$it", "contagem número $it", it + 1) }
        val a = assertNotNull(aviso(*muitas.toTypedArray()))
        assertTrue("e mais 22" in a.corpo, a.corpo)
        assertTrue(a.corpo.toByteArray().size < 1500, "${a.corpo.toByteArray().size} bytes")
    }

    @Test fun `o mesmo estado no mesmo dia gera sempre o mesmo texto`() {
        val c = parar("a", "refri", 10)
        assertEquals(aviso(c), aviso(c))
    }

    @Test fun `o fuso do dispositivo decide qual é o dia de hoje`() {
        // 02:00 UTC do dia 4 ainda é dia 3 em São Paulo
        val c = manter("m", "inglês", listOf("2026-11-02", "2026-11-03"))
        val utc = ZonedDateTime.of(2026, 11, 4, 2, 0, 0, 0, ZoneId.of("UTC")).toInstant().toEpochMilli()
        val emSp = assertNotNull(Mensagens.compor(Estado(contagens = listOf(c)), utc, sp)).corpo
        val emUtc = assertNotNull(Mensagens.compor(Estado(contagens = listOf(c)), utc, ZoneId.of("UTC"))).corpo
        assertEquals("2 dias seguidos inglês.", emSp, "em São Paulo ainda é dia 3 e o check-in de hoje já foi feito")
        assertTrue(emUtc.startsWith("2 dias seguidos inglês.") && emUtc.endsWith("?"), "em UTC já é dia 4 e falta marcar: $emUtc")
    }

    @Test fun `o estado reduzido do servidor dá exatamente o mesmo aviso que o completo`() {
        val tent = listOf(Tentativa(inicioHa(40), inicioHa(2), 38, "nota longa"), Tentativa(inicioHa(80), inicioHa(41), 39, "outra"))
        val desl = listOf(Deslize(inicioHa(5), "escorreguei"), Deslize(inicioHa(3), ""))
        val seq = datas(0, 1, 2, 3, 6, 7, 8, 9, 10, 11) + datas(3)
        val cheio = Estado(
            preferencias = Preferencias(visual = "classico", modo = "escuro"),
            contagens = listOf(
                parar("a", "refrigerante", 1, custo = 6.5, tentativas = tent, recorde = 39).copy(deslizes = desl),
                parar("b", "cigarro", 30, custo = 12.0, tentativas = tent, recorde = 5).copy(deslizes = desl),
                parar("c", "doce", 7),
                manter("d", "inglês", seq),
                manter("e", "leitura", datas(1, 2, 3)),
            ),
        )
        val reduzido = cheio.paraServidor()
        assertEquals(Mensagens.compor(cheio, agora, sp), Mensagens.compor(reduzido, agora, sp))
        assertTrue(reduzido.contagens.all { it.deslizes.isEmpty() && it.tentativas.all { t -> t.nota.isEmpty() } && it.tentativas.size <= 1 })
        assertEquals(cheio.contagens.map { it.checkins.toSet() }, reduzido.contagens.map { it.checkins.toSet() })
    }
}
