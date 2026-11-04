package br.com.grodev.contador

import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.security.KeyPair
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.util.concurrent.CopyOnWriteArrayList
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/** O lado do navegador: gera as chaves da inscrição e decifra a mensagem. Só existe nos testes. */
class NavegadorFalso(val par: KeyPair = gerarParDeChaves(), val auth: ByteArray = ByteArray(16).also { java.security.SecureRandom().nextBytes(it) }) {
    val publica: ByteArray = chavePublicaParaBytes(par.public as ECPublicKey)

    fun inscricao(endpoint: String) = Inscricao(endpoint, base64Url(publica), base64Url(auth))

    fun decifrar(corpo: ByteArray): ByteArray = decifrarMensagem(corpo, par.private as ECPrivateKey, publica, auth)
}

private fun hmac(k: ByteArray, d: ByteArray) = Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(k, "HmacSHA256")) }.doFinal(d)
private fun hkdf(sal: ByteArray, ikm: ByteArray, info: ByteArray, n: Int) = hmac(hmac(sal, ikm), info + 0x01).copyOf(n)

/** RFC 8291, parte do receptor. */
fun decifrarMensagem(corpo: ByteArray, privadaNavegador: ECPrivateKey, publicaNavegador: ByteArray, auth: ByteArray): ByteArray {
    val bb = ByteBuffer.wrap(corpo)
    val sal = ByteArray(16).also { bb.get(it) }
    val tamanhoRegistro = bb.int
    val idLen = bb.get().toInt() and 0xff
    val asPublica = ByteArray(idLen).also { bb.get(it) }
    val cifrado = ByteArray(bb.remaining()).also { bb.get(it) }
    require(tamanhoRegistro >= 18) { "registro pequeno demais" }

    val segredo = KeyAgreement.getInstance("ECDH").run {
        init(privadaNavegador); doPhase(chavePublicaDeBytes(asPublica), true); generateSecret()
    }
    val ikm = hkdf(auth, segredo, "WebPush: info".toByteArray() + 0x00 + publicaNavegador + asPublica, 32)
    val cek = hkdf(sal, ikm, "Content-Encoding: aes128gcm".toByteArray() + 0x00, 16)
    val nonce = hkdf(sal, ikm, "Content-Encoding: nonce".toByteArray() + 0x00, 12)
    val claro = Cipher.getInstance("AES/GCM/NoPadding").run {
        init(Cipher.DECRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce)); doFinal(cifrado)
    }
    var fim = claro.size
    while (fim > 0 && claro[fim - 1] == 0.toByte()) fim-- // padding de zeros
    require(fim > 0 && claro[fim - 1] == 0x02.toByte()) { "delimitador do último registro ausente" }
    return claro.copyOf(fim - 1)
}

/** Serviço de push de mentira: guarda o que recebe e responde com o status configurado. */
class ServicoPushFalso(var status: Int = 201, var cabecalhoLocation: String? = null) : AutoCloseable {
    class Chamada(val caminho: String, val cabecalhos: Map<String, String>, val corpo: ByteArray)

    val chamadas = CopyOnWriteArrayList<Chamada>()
    private val servidor: HttpServer = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
        createContext("/") { t ->
            val cab = t.requestHeaders.entries.associate { it.key.lowercase() to it.value.joinToString(",") }
            chamadas += Chamada(t.requestURI.path, cab, t.requestBody.readAllBytes())
            cabecalhoLocation?.let { t.responseHeaders.add("Location", it) }
            t.sendResponseHeaders(status, -1)
            t.close()
        }
        start()
    }
    val porta get() = servidor.address.port
    fun url(caminho: String = "/push/abc") = "http://127.0.0.1:$porta$caminho"
    override fun close() = servidor.stop(0)
}
