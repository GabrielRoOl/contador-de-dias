package br.com.grodev.contador

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BancoTest {
    private val dir: File = createTempDirectory("contador-teste").toFile()
    private val banco = Banco(File(dir, "t.db").path)

    @AfterTest fun limpar() { dir.deleteRecursively() }

    private fun novo(id: String = "d1", agora: Long = 1000) =
        banco.criarDispositivo(id, Seguranca.hash("seg-$id"), agora, "{}", "America/Sao_Paulo", "09:00")

    @Test fun `cria e lê um dispositivo`() {
        novo()
        val d = assertNotNull(banco.obter("d1"))
        assertEquals("America/Sao_Paulo", d.fuso)
        assertEquals("09:00", d.horaResumo)
        assertContentEquals(Seguranca.hash("seg-d1"), d.segredoHash)
        assertFalse(d.temInscricao)
        assertNull(d.ultimoEnvio)
        assertNull(banco.obter("nao-existe"))
        assertEquals(1, banco.contarDispositivos())
    }

    @Test fun `id repetido não cria outro`() {
        novo()
        kotlin.test.assertFailsWith<java.sql.SQLException> { novo() }
    }

    @Test fun `salva estado e preferências`() {
        novo()
        assertTrue(banco.salvarEstado("d1", """{"x":1}""", "Europe/London", "07:30", 2000))
        val d = banco.obter("d1")!!
        assertEquals("""{"x":1}""", d.estadoJson); assertEquals("Europe/London", d.fuso); assertEquals("07:30", d.horaResumo); assertEquals(2000, d.atualizadoEm)
        assertFalse(banco.salvarEstado("outro", "{}", "UTC", "09:00", 1), "dispositivo inexistente")
    }

    @Test fun `guarda e remove a inscrição de push`() {
        novo()
        assertTrue(banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5))
        val d = banco.obter("d1")!!
        assertTrue(d.temInscricao); assertEquals("https://fcm.googleapis.com/x", d.pushEndpoint)
        assertEquals(listOf("d1"), banco.comInscricao().map { it.id })
        banco.removerInscricao("d1")
        assertFalse(banco.obter("d1")!!.temInscricao)
        assertTrue(banco.comInscricao().isEmpty())
    }

    @Test fun `o mesmo endpoint só fica com um dispositivo`() {
        novo("d1"); novo("d2")
        banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5)
        banco.salvarInscricao("d2", "https://fcm.googleapis.com/x", "p2", "a2", 6)
        assertFalse(banco.obter("d1")!!.temInscricao)
        assertEquals("p2", banco.obter("d2")!!.pushP256dh)
    }

    @Test fun `nova inscrição zera as tentativas`() {
        novo(); banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5)
        banco.registrarFalha("d1", "2026-11-03", 999)
        banco.salvarInscricao("d1", "https://fcm.googleapis.com/y", "p", "a", 6)
        val d = banco.obter("d1")!!
        assertEquals(0, d.tentativas); assertEquals(0, d.proximaTentativa)
    }

    @Test fun `marcar envio guarda o dia e zera as tentativas`() {
        novo(); banco.registrarFalha("d1", "2026-11-03", 500)
        banco.marcarEnvio("d1", "2026-11-03")
        val d = banco.obter("d1")!!
        assertEquals("2026-11-03", d.ultimoEnvio); assertEquals(0, d.tentativas); assertNull(d.tentativaData)
    }

    @Test fun `falhas contam no dia e recomeçam no dia seguinte`() {
        novo()
        banco.registrarFalha("d1", "2026-11-03", 100)
        banco.registrarFalha("d1", "2026-11-03", 200)
        assertEquals(2, banco.obter("d1")!!.tentativas)
        assertEquals(200, banco.obter("d1")!!.proximaTentativa)
        banco.registrarFalha("d1", "2026-11-04", 300)
        assertEquals(1, banco.obter("d1")!!.tentativas)
    }

    @Test fun `apagar remove tudo do dispositivo`() {
        novo(); assertTrue(banco.apagar("d1")); assertNull(banco.obter("d1")); assertFalse(banco.apagar("d1"))
    }

    @Test fun `limpa só os dispositivos parados há muito tempo`() {
        novo("velho", 100); novo("novo", 900)
        assertEquals(1, banco.limparInativos(500))
        assertNull(banco.obter("velho")); assertNotNull(banco.obter("novo"))
    }

    @Test fun `os dados sobrevivem a reabrir o banco`() {
        novo()
        val outro = Banco(File(dir, "t.db").path)
        assertNotNull(outro.obter("d1"))
    }

    @Test fun `texto malicioso vira dado e não SQL`() {
        novo("d1")
        assertNull(banco.obter("d1' OR '1'='1"))
        banco.salvarEstado("d1", "'); DROP TABLE dispositivos; --", "UTC", "09:00", 1)
        assertEquals(1, banco.contarDispositivos())
    }

    @Test fun `a lista do agendador não carrega o estado, só estadoJson(id) carrega`() {
        novo()
        banco.salvarEstado("d1", "x".repeat(300_000), "UTC", "09:00", 2)
        banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5)
        val leve = banco.comInscricao().single()
        assertEquals("", leve.estadoJson, "a consulta por minuto não pode trazer centenas de KB por dispositivo")
        assertEquals("UTC", leve.fuso); assertEquals("09:00", leve.horaResumo); assertTrue(leve.temInscricao)
        assertEquals(300_000, banco.estadoJson("d1")!!.length)
        assertNull(banco.estadoJson("nao-existe"))
    }
}
