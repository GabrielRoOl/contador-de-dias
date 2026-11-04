package br.com.grodev.contador

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import java.io.File
import java.time.Duration
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class AgendadorTest {
    private val dir: File = createTempDirectory("agendador-teste").toFile()
    private val banco = Banco(File(dir, "t.db").path)
    private val sp = ZoneId.of("America/Sao_Paulo")
    private var agora = ms(2026, 11, 3, 8, 0)

    private class Enviado(val dispositivoEndpoint: String, val carga: CargaAviso, val ttl: Int, val topico: String?)

    private class EnviadorFalso : EnviadorPush {
        val enviados = java.util.concurrent.CopyOnWriteArrayList<Enviado>()
        @Volatile var resposta: () -> ResultadoEnvio = { ResultadoEnvio.Sucesso }
        override fun enviar(inscricao: Inscricao, payload: ByteArray, ttlSegundos: Int, topico: String?): ResultadoEnvio {
            enviados += Enviado(inscricao.endpoint, Json.decodeFromString<CargaAviso>(String(payload, Charsets.UTF_8)), ttlSegundos, topico)
            return resposta()
        }
    }

    private val enviador = EnviadorFalso()
    private val agendador = Agendador(banco, enviador, { agora }, despachante = Dispatchers.Unconfined)

    @AfterTest fun limpar() { dir.deleteRecursively() }

    private fun ms(a: Int, m: Int, d: Int, h: Int, min: Int, zona: ZoneId = sp, seg: Int = 0) =
        ZonedDateTime.of(a, m, d, h, min, seg, 0, zona).toInstant().toEpochMilli()

    private fun estadoComUmaContagem(nome: String = "refrigerante", diasAtras: Int = 10): Estado {
        val inicio = LocalDate.of(2026, 11, 3).minusDays(diasAtras.toLong()).atStartOfDay(sp).toInstant().toEpochMilli()
        return Estado(contagens = listOf(Contagem("c1", nome, "parar", inicio, null, 0, emptyList(), emptyList(), emptyList())))
    }

    private fun criar(id: String, fuso: String = "America/Sao_Paulo", hora: String = "09:00", estado: Estado = estadoComUmaContagem(), inscrito: Boolean = true, estadoJson: String? = null) {
        val e = estado.copy(preferencias = Preferencias(horaResumo = hora, fuso = fuso))
        banco.criarDispositivo(id, Seguranca.hash("s"), 1, estadoJson ?: Json.encodeToString(Estado.serializer(), e), fuso, hora)
        if (inscrito) banco.salvarInscricao(id, "https://fcm.googleapis.com/fcm/send/$id", "p", "a", 1)
    }

    private fun rodar() = runBlocking { agendador.executarMinuto() }

    @Test fun `não envia antes da hora do resumo e envia quando chega`() {
        criar("d1")
        agora = ms(2026, 11, 3, 8, 59, seg = 59); rodar()
        assertTrue(enviador.enviados.isEmpty())
        agora = ms(2026, 11, 3, 9, 0); val r = rodar()
        assertEquals(1, r.enviados); assertEquals(1, enviador.enviados.size)
        assertEquals("2026-11-03", banco.obter("d1")!!.ultimoEnvio)
    }

    @Test fun `envia uma vez por dia, mesmo rodando todo minuto`() {
        criar("d1")
        for (min in 0..120) { agora = ms(2026, 11, 3, 9, 0) + min * 60_000L; rodar() }
        assertEquals(1, enviador.enviados.size)
    }

    @Test fun `no dia seguinte envia de novo`() {
        criar("d1")
        agora = ms(2026, 11, 3, 9, 0); rodar()
        agora = ms(2026, 11, 4, 9, 0); rodar()
        assertEquals(2, enviador.enviados.size)
        assertEquals("2026-11-04", banco.obter("d1")!!.ultimoEnvio)
    }

    @Test fun `se o servidor volta atrasado mas dentro da janela, o aviso ainda sai`() {
        criar("d1")
        agora = ms(2026, 11, 3, 11, 59); rodar()
        assertEquals(1, enviador.enviados.size)
    }

    @Test fun `depois da janela o aviso do dia é descartado`() {
        criar("d1")
        agora = ms(2026, 11, 3, 12, 0); rodar()
        assertTrue(enviador.enviados.isEmpty())
        agora = ms(2026, 11, 3, 18, 0); rodar()
        assertTrue(enviador.enviados.isEmpty())
    }

    @Test fun `o envio usa TTL de 3 horas e o tópico resumo-diario`() {
        criar("d1"); agora = ms(2026, 11, 3, 9, 0); rodar()
        val e = enviador.enviados.single()
        assertEquals(3 * 3600, e.ttl); assertEquals("resumo-diario", e.topico)
        assertEquals("https://fcm.googleapis.com/fcm/send/d1", e.dispositivoEndpoint)
    }

    @Test fun `a carga tem título, corpo, tag e url`() {
        criar("d1"); agora = ms(2026, 11, 3, 9, 0); rodar()
        val c = enviador.enviados.single().carga
        assertEquals("Contagem de Dias", c.titulo); assertEquals("resumo-diario", c.tag); assertEquals("./", c.url)
        assertTrue("10 dias" in c.corpo && "refrigerante" in c.corpo, c.corpo)
    }

    @Test fun `quem não tem inscrição não recebe`() {
        criar("d1", inscrito = false); agora = ms(2026, 11, 3, 9, 0); rodar()
        assertTrue(enviador.enviados.isEmpty())
    }

    @Test fun `inscrição expirada (404 ou 410) é removida e não se tenta de novo`() {
        criar("d1")
        enviador.resposta = { ResultadoEnvio.Expirada }
        agora = ms(2026, 11, 3, 9, 0); val r = rodar()
        assertEquals(1, r.expiradas)
        assertFalse(banco.obter("d1")!!.temInscricao)
        agora = ms(2026, 11, 3, 9, 10); rodar()
        assertEquals(1, enviador.enviados.size)
    }

    @Test fun `falha passageira, tenta de novo só depois de 5 minutos e marca o dia no sucesso`() {
        criar("d1")
        var chamadas = 0
        enviador.resposta = { chamadas++; if (chamadas < 3) ResultadoEnvio.Falha("status 503", 503) else ResultadoEnvio.Sucesso }
        agora = ms(2026, 11, 3, 9, 0); assertEquals(1, rodar().falhas)
        agora = ms(2026, 11, 3, 9, 4); rodar(); assertEquals(1, enviador.enviados.size, "ainda não passaram 5 minutos")
        agora = ms(2026, 11, 3, 9, 5); assertEquals(1, rodar().falhas)
        assertEquals(2, enviador.enviados.size)
        agora = ms(2026, 11, 3, 9, 10); assertEquals(1, rodar().enviados)
        assertEquals("2026-11-03", banco.obter("d1")!!.ultimoEnvio)
        agora = ms(2026, 11, 3, 9, 30); rodar()
        assertEquals(3, enviador.enviados.size)
    }

    @Test fun `depois de 5 falhas desiste do dia, e no dia seguinte tenta de novo`() {
        criar("d1")
        enviador.resposta = { ResultadoEnvio.Falha("status 500", 500) }
        for (i in 0 until 10) { agora = ms(2026, 11, 3, 9, 0) + i * 5 * 60_000L; rodar() }
        assertEquals(5, enviador.enviados.size)
        assertNull(banco.obter("d1")!!.ultimoEnvio)
        enviador.resposta = { ResultadoEnvio.Sucesso }
        agora = ms(2026, 11, 4, 9, 0); rodar()
        assertEquals(6, enviador.enviados.size)
        assertEquals("2026-11-04", banco.obter("d1")!!.ultimoEnvio)
    }

    @Test fun `exceção do enviador conta como falha e não derruba a rodada`() {
        criar("d1"); criar("d2")
        var n = 0
        enviador.resposta = { if (n++ == 0) throw IllegalStateException("boom") else ResultadoEnvio.Sucesso }
        agora = ms(2026, 11, 3, 9, 0); val r = rodar()
        assertEquals(1, r.falhas); assertEquals(1, r.enviados)
    }

    @Test fun `cada dispositivo usa o próprio fuso`() {
        criar("sp", fuso = "America/Sao_Paulo"); criar("utc", fuso = "UTC"); criar("lon", fuso = "Europe/London")
        agora = ms(2026, 11, 3, 9, 0, ZoneId.of("UTC")) // 06:00 em SP
        rodar()
        assertEquals(setOf("utc", "lon"), enviador.enviados.map { it.dispositivoEndpoint.substringAfterLast('/') }.toSet())
        assertNull(banco.obter("sp")!!.ultimoEnvio)
        agora = ms(2026, 11, 3, 9, 0, sp); rodar()
        assertEquals("2026-11-03", banco.obter("sp")!!.ultimoEnvio)
    }

    @Test fun `a janela que atravessa a meia-noite ainda envia depois das 00h`() {
        criar("d1", hora = "23:30", estado = estadoComUmaContagem())
        agora = ms(2026, 11, 3, 23, 45); rodar()
        assertEquals(1, enviador.enviados.size)
        assertEquals("2026-11-03", banco.obter("d1")!!.ultimoEnvio)
        agora = ms(2026, 11, 4, 0, 30); rodar()
        assertEquals(1, enviador.enviados.size, "não reenvia o mesmo dia")
    }

    @Test fun `servidor reiniciado depois da meia-noite ainda envia o aviso de ontem`() {
        criar("d1", hora = "23:30")
        agora = ms(2026, 11, 4, 0, 10); rodar()
        assertEquals(1, enviador.enviados.size)
        assertEquals("2026-11-03", banco.obter("d1")!!.ultimoEnvio)
    }

    @Test fun `hora que não existe no horário de verão não quebra`() {
        // Londres, 29/03/2026: 01:00 vira 02:00, então 01:30 não existe
        criar("d1", fuso = "Europe/London", hora = "01:30")
        val londres = ZoneId.of("Europe/London")
        agora = ms(2026, 3, 29, 3, 0, londres); rodar()
        assertEquals(1, enviador.enviados.size)
    }

    @Test fun `estado ilegível é ignorado sem afetar os outros`() {
        criar("ruim", estadoJson = "{isto não é json")
        criar("bom")
        agora = ms(2026, 11, 3, 9, 0); val r = rodar()
        assertEquals(1, r.enviados); assertEquals(1, r.ignorados)
        assertEquals(1, enviador.enviados.size)
    }

    @Test fun `sem contagens não envia, mas o dia fica resolvido`() {
        criar("d1", estado = Estado())
        agora = ms(2026, 11, 3, 9, 0); rodar()
        assertTrue(enviador.enviados.isEmpty())
        assertEquals("2026-11-03", banco.obter("d1")!!.ultimoEnvio)
    }

    @Test fun `fuso ou hora inválidos no banco usam o padrão em vez de quebrar`() {
        criar("d1")
        // força valores ruins direto no banco
        banco.salvarEstado("d1", Json.encodeToString(Estado.serializer(), estadoComUmaContagem()), "Marte/Olympus", "lixo", 1)
        agora = ms(2026, 11, 3, 9, 0); rodar()
        assertEquals(1, enviador.enviados.size)
    }

    @Test fun `muitos dispositivos de uma vez`() {
        (1..40).forEach { criar("d$it") }
        agora = ms(2026, 11, 3, 9, 0); val r = rodar()
        assertEquals(40, r.enviados)
        assertEquals(40, enviador.enviados.map { it.dispositivoEndpoint }.toSet().size)
    }

    @Test fun `marco do dia vira título de marco`() {
        criar("d1", estado = estadoComUmaContagem(diasAtras = 30))
        agora = ms(2026, 11, 3, 9, 0); rodar()
        val c = enviador.enviados.single().carga
        assertEquals("Marco atingido!", c.titulo); assertTrue(c.marco)
        assertTrue(c.corpo.startsWith("1 mês sem refrigerante. "), c.corpo)
    }

    @Test fun `limpeza remove só dispositivos parados há mais de um ano`() {
        criar("velho"); criar("novo")
        val dia = Duration.ofDays(1).toMillis()
        agora = ms(2026, 11, 3, 9, 0)
        banco.salvarEstado("velho", "{}", "UTC", "09:00", agora - 400 * dia)
        banco.salvarEstado("novo", "{}", "UTC", "09:00", agora - 100 * dia)
        assertEquals(1, agendador.limparInativos())
        assertNull(banco.obter("velho")); assertNotNull(banco.obter("novo"))
    }

    @Test fun `um erro grave numa rodada não mata o laço do agendador`() {
        criar("d1")
        agora = ms(2026, 11, 3, 9, 0)
        banco.salvarEstado("d1", Json.encodeToString(Estado.serializer(), estadoComUmaContagem()), "America/Sao_Paulo", "09:00", agora) // recente: a limpeza de inativos não o apaga
        var chamadas = 0
        val enviadorQueFalha = EnviadorPush { _, _, _, _ ->
            if (++chamadas == 1) throw OutOfMemoryError("simulado") else ResultadoEnvio.Sucesso
        }
        val ag = Agendador(banco, enviadorQueFalha, { agora }, despachante = Dispatchers.Unconfined, intervaloRodada = 20, esperaMinima = 5)
        runBlocking {
            val laco = kotlinx.coroutines.GlobalScope.launch { ag.rodar() }
            val limite = System.currentTimeMillis() + 5_000
            while (banco.obter("d1")!!.ultimoEnvio == null && System.currentTimeMillis() < limite) kotlinx.coroutines.delay(20)
            laco.cancel()
        }
        assertTrue(chamadas >= 2, "depois do OutOfMemoryError a rodada seguinte ainda aconteceu (chamadas=$chamadas)")
        assertEquals("2026-11-03", banco.obter("d1")!!.ultimoEnvio)
    }

    @Test fun `a limpeza também apaga dispositivos sem inscrição que ninguém usa`() {
        val dia = Duration.ofDays(1).toMillis()
        agora = ms(2026, 11, 3, 9, 0)
        criar("orfao", inscrito = false); criar("ativo")
        banco.salvarEstado("orfao", "{}", "UTC", "09:00", agora - 20 * dia)
        banco.salvarEstado("ativo", "{}", "UTC", "09:00", agora - 20 * dia)
        assertEquals(1, agendador.limparInativos())
        assertNull(banco.obter("orfao")); assertNotNull(banco.obter("ativo"))
    }
}
