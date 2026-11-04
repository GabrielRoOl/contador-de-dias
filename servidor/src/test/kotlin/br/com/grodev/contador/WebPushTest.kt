package br.com.grodev.contador

import java.net.ServerSocket
import java.security.Signature
import java.security.interfaces.ECPublicKey
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class WebPushTest {
    @Test fun `ida e volta com chaves novas, inclusive texto com acento e emoji`() {
        val nav = NavegadorFalso()
        listOf("", "oi", "7 dias sem refrigerante. Uma semana inteira! 💪", "ç".repeat(1000)).forEach {
            val corpo = CriptoWebPush.cifrar(it.toByteArray(), nav.publica, nav.auth)
            assertEquals(it, String(nav.decifrar(corpo)))
        }
    }

    @Test fun `cada mensagem usa chave e sal diferentes`() {
        val nav = NavegadorFalso()
        val a = CriptoWebPush.cifrar("x".toByteArray(), nav.publica, nav.auth)
        val b = CriptoWebPush.cifrar("x".toByteArray(), nav.publica, nav.auth)
        assertFalse(a.contentEquals(b))
    }

    @Test fun `mensagem adulterada não é decifrada`() {
        val nav = NavegadorFalso()
        val corpo = CriptoWebPush.cifrar("segredo".toByteArray(), nav.publica, nav.auth)
        corpo[corpo.size - 3] = (corpo[corpo.size - 3].toInt() xor 1).toByte()
        assertFailsWith<Exception> { nav.decifrar(corpo) }
    }

    @Test fun `limite de tamanho da mensagem`() {
        val nav = NavegadorFalso()
        val maximo = ByteArray(CriptoWebPush.MAX_PAYLOAD) { 'a'.code.toByte() }
        assertEquals(4096, CriptoWebPush.cifrar(maximo, nav.publica, nav.auth).size)
        assertContentEquals(maximo, nav.decifrar(CriptoWebPush.cifrar(maximo, nav.publica, nav.auth)))
        assertFailsWith<IllegalArgumentException> { CriptoWebPush.cifrar(ByteArray(CriptoWebPush.MAX_PAYLOAD + 1), nav.publica, nav.auth) }
    }

    @Test fun `chave do navegador inválida é recusada`() {
        val nav = NavegadorFalso()
        assertFailsWith<IllegalArgumentException> { CriptoWebPush.cifrar("x".toByteArray(), ByteArray(65), nav.auth) }
        assertFailsWith<IllegalArgumentException> { CriptoWebPush.cifrar("x".toByteArray(), nav.publica.copyOf(64), nav.auth) }
        val fora = nav.publica.copyOf().also { it[64] = (it[64].toInt() xor 1).toByte() } // fora da curva
        assertFailsWith<IllegalArgumentException> { CriptoWebPush.cifrar("x".toByteArray(), fora, nav.auth) }
        assertFailsWith<IllegalArgumentException> { CriptoWebPush.cifrar("x".toByteArray(), nav.publica, ByteArray(15)) }
    }

    // ---------------------------------------------------------------- VAPID

    @Test fun `chaves VAPID geradas têm o formato esperado e funcionam depois de salvas em texto`() {
        val (pub, priv) = ChavesVapid.gerar()
        assertEquals(65, base64UrlDecodificar(pub).size)
        assertEquals(32, base64UrlDecodificar(priv).size)
        ChavesVapid.deBase64(pub, priv)
        assertFailsWith<IllegalArgumentException> { ChavesVapid.deBase64(pub, "curta") }
        assertFailsWith<Exception> { ChavesVapid.deBase64("curta", priv) }
    }

    @Test fun `o JWT VAPID é válido, assinado e tem as alegações certas`() {
        val (pub, priv) = ChavesVapid.gerar()
        val chaves = ChavesVapid.deBase64(pub, priv)
        val jwt = Vapid.jwt("https://fcm.googleapis.com/fcm/send/abc123", "https://grodev.com.br/contador", 1_900_000_000, chaves)
        val (cab, corpo, ass) = jwt.split(".")
        assertEquals("""{"typ":"JWT","alg":"ES256"}""", String(base64UrlDecodificar(cab)))
        assertEquals("""{"aud":"https://fcm.googleapis.com","exp":1900000000,"sub":"https://grodev.com.br/contador"}""", String(base64UrlDecodificar(corpo)))
        val verificado = Signature.getInstance("SHA256withECDSAinP1363Format").run {
            initVerify(chavePublicaDeBytes(base64UrlDecodificar(pub))); update("$cab.$corpo".toByteArray()); verify(base64UrlDecodificar(ass))
        }
        assertTrue(verificado)
        assertEquals(64, base64UrlDecodificar(ass).size)
        assertEquals("vapid t=$jwt, k=$pub", Vapid.cabecalho(jwt, chaves))
    }

    @Test fun `aud inclui a porta quando o endpoint tem porta`() {
        val (pub, priv) = ChavesVapid.gerar()
        val jwt = Vapid.jwt("http://127.0.0.1:8765/x", "mailto:a@b.c", 1, ChavesVapid.deBase64(pub, priv))
        assertTrue("\"aud\":\"http://127.0.0.1:8765\"" in String(base64UrlDecodificar(jwt.split(".")[1])))
    }

    // ---------------------------------------------------------------- destinos permitidos (SSRF)

    @Test fun `aceita os serviços de push conhecidos`() {
        listOf(
            "https://fcm.googleapis.com/fcm/send/abc",
            "https://updates.push.services.mozilla.com/wpush/v2/xyz",
            "https://updates-autopush.stage.mozaws.net/x".takeIf { false } ?: "https://abc.push.services.mozilla.com/x",
            "https://web.push.apple.com/QGx",
            "https://api.push.apple.com/3/device/x",
            "https://wns2-par02p.notify.windows.com/w/?token=abc",
        ).forEach { assertTrue(EndpointPush.valido(it), it) }
    }

    @Test fun `recusa tudo que não é serviço de push`() {
        listOf(
            "http://fcm.googleapis.com/fcm/send/abc", // sem https
            "https://127.0.0.1/x", "https://10.0.0.5/x", "https://[::1]/x", "https://localhost/x", "https://169.254.169.254/latest",
            "https://exemplo.com/x", "https://fcm.googleapis.com.exemplo.com/x", "https://exemplofcm.googleapis.com/x",
            "https://user:senha@fcm.googleapis.com/x", "https://fcm.googleapis.com:8443/x", "https://fcm.googleapis.com/x#frag",
            "https://.push.apple.com/x", "ftp://fcm.googleapis.com/x", "fcm.googleapis.com/x", "", " ", "https://fcm.googleapis.com/ x",
            "https://fcm.googleapis.com/" + "a".repeat(2100),
        ).forEach { assertFalse(EndpointPush.valido(it), it) }
    }

    @Test fun `confere o formato das chaves da inscrição`() {
        val nav = NavegadorFalso()
        assertTrue(EndpointPush.chavesValidas(base64Url(nav.publica), base64Url(nav.auth)))
        assertFalse(EndpointPush.chavesValidas("abc", base64Url(nav.auth)))
        assertFalse(EndpointPush.chavesValidas(base64Url(nav.publica), "abc"))
        assertFalse(EndpointPush.chavesValidas(base64Url(ByteArray(65)), base64Url(nav.auth)))
        assertFalse(EndpointPush.chavesValidas("###", "###"))
    }

    // ---------------------------------------------------------------- envio HTTP

    private fun enviador(): EnviadorWebPush {
        val (pub, priv) = ChavesVapid.gerar()
        return EnviadorWebPush(ChavesVapid.deBase64(pub, priv), "https://grodev.com.br/contador", { 1_762_000_000_000L })
    }

    @Test fun `envia a mensagem cifrada com os cabeçalhos certos`() = ServicoPushFalso(201).use { srv ->
        val nav = NavegadorFalso()
        val r = enviador().enviar(nav.inscricao(srv.url()), """{"titulo":"oi"}""".toByteArray(), 10_800, "resumo-diario")
        assertEquals(ResultadoEnvio.Sucesso, r)
        val c = srv.chamadas.single()
        assertEquals("/push/abc", c.caminho)
        assertEquals("aes128gcm", c.cabecalhos["content-encoding"])
        assertEquals("10800", c.cabecalhos["ttl"])
        assertEquals("resumo-diario", c.cabecalhos["topic"])
        assertEquals("normal", c.cabecalhos["urgency"])
        assertTrue(c.cabecalhos["authorization"]!!.startsWith("vapid t="), c.cabecalhos["authorization"])
        assertEquals("""{"titulo":"oi"}""", String(nav.decifrar(c.corpo)))
    }

    @Test fun `sem tópico, o cabeçalho Topic não é enviado`() = ServicoPushFalso(201).use { srv ->
        enviador().enviar(NavegadorFalso().inscricao(srv.url()), "x".toByteArray(), 60, null)
        assertFalse("topic" in srv.chamadas.single().cabecalhos)
    }

    @Test fun `404 e 410 significam inscrição expirada`() {
        listOf(404, 410).forEach { s ->
            ServicoPushFalso(s).use { srv ->
                assertEquals(ResultadoEnvio.Expirada, enviador().enviar(NavegadorFalso().inscricao(srv.url()), "x".toByteArray(), 60, null), "status $s")
            }
        }
    }

    @Test fun `outros status são falhas temporárias com o código`() {
        listOf(400, 401, 403, 413, 429, 500, 502, 503).forEach { s ->
            ServicoPushFalso(s).use { srv ->
                val r = assertIs<ResultadoEnvio.Falha>(enviador().enviar(NavegadorFalso().inscricao(srv.url()), "x".toByteArray(), 60, null), "status $s")
                assertEquals(s, r.status)
            }
        }
    }

    @Test fun `200 e 202 também são sucesso`() {
        listOf(200, 202).forEach { s ->
            ServicoPushFalso(s).use { srv -> assertEquals(ResultadoEnvio.Sucesso, enviador().enviar(NavegadorFalso().inscricao(srv.url()), "x".toByteArray(), 60, null)) }
        }
    }

    @Test fun `redirecionamento não é seguido`() = ServicoPushFalso(302).use { srv ->
        srv.cabecalhoLocation = "http://127.0.0.1:${srv.porta}/interno"
        val r = assertIs<ResultadoEnvio.Falha>(enviador().enviar(NavegadorFalso().inscricao(srv.url()), "x".toByteArray(), 60, null))
        assertEquals(302, r.status)
        assertEquals(listOf("/push/abc"), srv.chamadas.map { it.caminho })
    }

    @Test fun `servidor fora do ar vira falha de rede, não exceção`() {
        val porta = ServerSocket(0).use { it.localPort } // porta livre e sem ninguém escutando
        val r = enviador().enviar(NavegadorFalso().inscricao("http://127.0.0.1:$porta/x"), "x".toByteArray(), 60, null)
        assertIs<ResultadoEnvio.Falha>(r)
    }

    @Test fun `inscrição com chave inválida vira falha, não exceção`() = ServicoPushFalso(201).use { srv ->
        val r = enviador().enviar(Inscricao(srv.url(), base64Url(ByteArray(65)), base64Url(ByteArray(16))), "x".toByteArray(), 60, null)
        assertIs<ResultadoEnvio.Falha>(r)
        assertTrue(srv.chamadas.isEmpty())
    }
}
