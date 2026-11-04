package br.com.grodev.contador

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AlarmesTest {
    private val dir: File = createTempDirectory("alarmes-teste").toFile()
    private val banco = Banco(File(dir, "t.db").path)
    private var agora = 1_762_000_000_000L

    private class Enviado(val endpoint: String, val carga: CargaAviso, val ttl: Int, val topico: String?)

    private class EnviadorFalso : EnviadorPush {
        val enviados = java.util.concurrent.CopyOnWriteArrayList<Enviado>()
        @Volatile var resposta: () -> ResultadoEnvio = { ResultadoEnvio.Sucesso }
        override fun enviar(inscricao: Inscricao, payload: ByteArray, ttlSegundos: Int, topico: String?): ResultadoEnvio {
            enviados += Enviado(inscricao.endpoint, Json.decodeFromString<CargaAviso>(String(payload, Charsets.UTF_8)), ttlSegundos, topico)
            return resposta()
        }
    }

    private val enviador = EnviadorFalso()
    private val agendador = AgendadorAlarmes(banco, enviador, { agora }, despachante = Dispatchers.Unconfined)

    @AfterTest fun limpar() { dir.deleteRecursively() }

    private fun criar(id: String, inscrito: Boolean = true) {
        banco.criarDispositivo(id, Seguranca.hash("s"), 1, """{"versao":2}""", "America/Sao_Paulo", "09:00")
        if (inscrito) banco.salvarInscricao(id, "https://fcm.googleapis.com/fcm/send/$id", "p", "a", 1)
    }

    private fun rodada() = runBlocking { agendador.executarRodada() }

    @Test fun `não envia antes da hora e envia quando vence, uma vez só`() {
        criar("d1"); banco.definirAlarme("d1", agora + 60_000, "foco", "pausa")
        assertEquals(0, rodada().enviados)
        agora += 60_000
        assertEquals(1, rodada().enviados)
        assertEquals(0, rodada().enviados, "alarme enviado some")
        assertNull(banco.alarmeDe("d1"))
        assertEquals(1, enviador.enviados.size)
    }

    @Test fun `o push sai com tag, destino e TTL curtos, sem nome de contagem`() {
        criar("d1"); banco.definirAlarme("d1", agora, "foco", "pausa")
        rodada()
        val e = enviador.enviados.single()
        assertEquals("pomodoro", e.carga.tag); assertEquals("pomodoro", e.topico)
        assertEquals("./#pomodoro", e.carga.url)
        assertEquals(120, e.ttl)
        assertEquals("Foco concluído", e.carga.titulo)
        assertEquals("Hora da pausa de 5 min.", e.carga.corpo)
        assertTrue(e.endpoint.endsWith("/d1"))
    }

    @Test fun `os textos de cada fase`() {
        val casos = listOf(
            Triple("foco", "pausa", "Foco concluído" to "Hora da pausa de 5 min."),
            Triple("foco", "longa", "Foco concluído" to "Quatro focos! Pausa longa de 15 min."),
            Triple("pausa", "foco", "Pausa concluída" to "Pronto para o próximo foco?"),
            Triple("longa", "foco", "Pausa concluída" to "Pronto para o próximo foco?"),
        )
        casos.forEach { (fase, proxima, esperado) ->
            val a = MensagensPomodoro.compor(fase, proxima)
            assertEquals(esperado, a.titulo to a.corpo, "$fase -> $proxima")
        }
    }

    @Test fun `alarme vencido há mais que o TTL é descartado sem enviar`() {
        criar("d1"); banco.definirAlarme("d1", agora, "foco", "pausa")
        agora += 121_000
        val r = rodada()
        assertEquals(0, r.enviados); assertEquals(1, r.descartados)
        assertTrue(enviador.enviados.isEmpty()); assertNull(banco.alarmeDe("d1"))
    }

    @Test fun `alarme cancelado não envia`() {
        criar("d1"); banco.definirAlarme("d1", agora + 1000, "foco", "pausa")
        banco.cancelarAlarme("d1")
        agora += 5000
        assertEquals(0, rodada().enviados)
    }

    @Test fun `inscrição expirada (410) é removida e o alarme some junto`() {
        criar("d1"); banco.definirAlarme("d1", agora, "foco", "pausa")
        enviador.resposta = { ResultadoEnvio.Expirada }
        assertEquals(1, rodada().expirados)
        assertNull(banco.obter("d1")!!.pushEndpoint); assertNull(banco.alarmeDe("d1"))
    }

    @Test fun `falha tenta de novo nas próximas rodadas e desiste no limite`() {
        criar("d1"); banco.definirAlarme("d1", agora, "foco", "pausa")
        enviador.resposta = { ResultadoEnvio.Falha("rede") }
        repeat(3) { assertEquals(1, rodada().falhas); agora += 15_000 }
        assertEquals(3, enviador.enviados.size)
        assertNull(banco.alarmeDe("d1"), "depois de 3 falhas desiste")
        assertEquals(0, rodada().falhas)
    }

    @Test fun `falha passageira e depois sucesso envia uma vez com sucesso`() {
        criar("d1"); banco.definirAlarme("d1", agora, "foco", "pausa")
        enviador.resposta = { ResultadoEnvio.Falha("rede") }
        rodada()
        enviador.resposta = { ResultadoEnvio.Sucesso }
        agora += 15_000
        assertEquals(1, rodada().enviados)
        assertNull(banco.alarmeDe("d1"))
    }

    @Test fun `um dispositivo com falha não impede os outros`() {
        criar("d1"); criar("d2")
        banco.definirAlarme("d1", agora, "foco", "pausa"); banco.definirAlarme("d2", agora, "pausa", "foco")
        enviador.resposta = { if (enviador.enviados.last().endpoint.endsWith("d1")) ResultadoEnvio.Falha("x") else ResultadoEnvio.Sucesso }
        val r = rodada()
        assertEquals(1, r.enviados); assertEquals(1, r.falhas)
        assertNotNull(banco.alarmeDe("d1")); assertNull(banco.alarmeDe("d2"))
    }

    @Test fun `exceção do enviador conta como falha e não derruba a rodada`() {
        criar("d1"); banco.definirAlarme("d1", agora, "foco", "pausa")
        enviador.resposta = { throw IllegalStateException("boom") }
        assertEquals(1, rodada().falhas)
    }

    @Test fun `alarme de quem perdeu a inscrição não envia e é limpo depois do TTL`() {
        criar("d1", inscrito = false); banco.definirAlarme("d1", agora, "foco", "pausa")
        assertEquals(0, rodada().enviados)
        assertNotNull(banco.alarmeDe("d1"))
        agora += 121_000; rodada()
        assertNull(banco.alarmeDe("d1"))
    }

    @Test fun `o alarme não interfere no aviso diário`() {
        criar("d1"); banco.definirAlarme("d1", agora, "foco", "pausa")
        banco.marcarEnvio("d1", "2026-11-03")
        rodada()
        assertEquals("2026-11-03", banco.obter("d1")!!.ultimoEnvio)
    }
}
