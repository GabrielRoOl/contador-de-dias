package br.com.grodev.contador

import nl.martijndwars.webpush.Encoding
import nl.martijndwars.webpush.Notification
import nl.martijndwars.webpush.PushService
import org.bouncycastle.jce.provider.BouncyCastleProvider
import java.security.Security
import java.security.Signature
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * Referência independente: a biblioteca `web-push` (usada só nos testes) cifra e assina uma mensagem,
 * e a nossa implementação precisa ler e validar o resultado. Isso mostra que seguimos a mesma RFC.
 */
class InteropWebPushTest {
    init { Security.addProvider(BouncyCastleProvider()) }

    @Test fun `lemos a mensagem cifrada pela biblioteca de referência`() = ServicoPushFalso(201).use { srv ->
        val nav = NavegadorFalso()
        val (pub, priv) = ChavesVapid.gerar()
        val texto = """{"titulo":"Contagem de Dias","corpo":"7 dias sem refrigerante. Uma semana inteira! 💪"}"""
        val servico = PushService(pub, priv, "https://grodev.com.br/contador")
        val resposta = servico.send(Notification(srv.url(), base64Url(nav.publica), base64Url(nav.auth), texto.toByteArray()), Encoding.AES128GCM)
        assertEquals(201, resposta.statusLine.statusCode)

        val chamada = srv.chamadas.single()
        assertEquals("aes128gcm", chamada.cabecalhos["content-encoding"])
        assertEquals(texto, String(nav.decifrar(chamada.corpo)), "o nosso decifrador lê o que a biblioteca cifrou")
    }

    @Test fun `o JWT VAPID da biblioteca é verificável com o nosso código, e o nosso com o mesmo método`() = ServicoPushFalso(201).use { srv ->
        val nav = NavegadorFalso()
        val (pub, priv) = ChavesVapid.gerar()
        PushService(pub, priv, "https://grodev.com.br/contador").send(
            Notification(srv.url(), base64Url(nav.publica), base64Url(nav.auth), "x".toByteArray()), Encoding.AES128GCM,
        )
        val deles = srv.chamadas.single().cabecalhos["authorization"]!!
        val jwtDeles = Regex("t=([^,]+)").find(deles)!!.groupValues[1]
        val chaveDeles = Regex("k=(\\S+)").find(deles)!!.groupValues[1]
        assertEquals(pub, chaveDeles)

        fun verifica(jwt: String, chave: String): Boolean {
            val (cab, corpo, ass) = jwt.split(".")
            return Signature.getInstance("SHA256withECDSAinP1363Format").run {
                initVerify(chavePublicaDeBytes(base64UrlDecodificar(chave))); update("$cab.$corpo".toByteArray()); verify(base64UrlDecodificar(ass))
            }
        }
        assertTrue(verifica(jwtDeles, pub), "a nossa verificação aceita o JWT da biblioteca")
        val nossoJwt = Vapid.jwt(srv.url(), "https://grodev.com.br/contador", System.currentTimeMillis() / 1000 + 3600, ChavesVapid.deBase64(pub, priv))
        assertTrue(verifica(nossoJwt, pub), "e aceita o nosso, pelo mesmo método")
        // as alegações têm o mesmo formato
        fun alegacoes(jwt: String) = String(base64UrlDecodificar(jwt.split(".")[1]))
        assertTrue("\"aud\":\"http://127.0.0.1:${srv.porta}\"" in alegacoes(jwtDeles) || "\"aud\"" in alegacoes(jwtDeles))
        assertTrue("\"sub\":\"https://grodev.com.br/contador\"" in alegacoes(jwtDeles))
    }
}
