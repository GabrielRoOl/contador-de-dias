package br.com.grodev.contador

import java.math.BigInteger
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.ByteBuffer
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec
import java.time.Duration
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Web Push com a JVM pura: mensagem cifrada (RFC 8291, aes128gcm) e identificação do servidor por VAPID (RFC 8292).
 * Feito sem bibliotecas de terceiros para manter o jar pequeno no celular; conferido nos testes com o vetor de teste
 * da própria RFC e contra uma implementação conhecida.
 */

private val b64 = Base64.getUrlEncoder().withoutPadding()
private val b64dec = Base64.getUrlDecoder()

fun base64Url(bytes: ByteArray): String = b64.encodeToString(bytes)
fun base64UrlDecodificar(texto: String): ByteArray = b64dec.decode(texto)

private val curvaP256: ECParameterSpec by lazy {
    AlgorithmParameters.getInstance("EC").apply { init(ECGenParameterSpec("secp256r1")) }.getParameterSpec(ECParameterSpec::class.java)
}

private fun inteiro32(v: BigInteger): ByteArray {
    val b = v.toByteArray()
    return when {
        b.size == 32 -> b
        b.size > 32 -> b.copyOfRange(b.size - 32, b.size) // tira o byte de sinal
        else -> ByteArray(32 - b.size) + b
    }
}

/** Chave pública P-256 em formato "ponto não comprimido" (65 bytes, começa com 0x04). */
fun chavePublicaDeBytes(bytes: ByteArray): ECPublicKey {
    require(bytes.size == 65 && bytes[0] == 0x04.toByte()) { "chave pública deve ter 65 bytes no formato não comprimido" }
    val x = BigInteger(1, bytes.copyOfRange(1, 33))
    val y = BigInteger(1, bytes.copyOfRange(33, 65))
    val p = (curvaP256.curve.field as java.security.spec.ECFieldFp).p
    require(x < p && y < p) { "ponto fora do corpo" }
    // o ponto precisa estar na curva: y^2 = x^3 + ax + b (mod p)
    val esq = y.multiply(y).mod(p)
    val dir = x.pow(3).add(curvaP256.curve.a.multiply(x)).add(curvaP256.curve.b).mod(p)
    require(esq == dir) { "ponto não está na curva P-256" }
    return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), curvaP256)) as ECPublicKey
}

fun chavePublicaParaBytes(k: ECPublicKey): ByteArray = byteArrayOf(0x04) + inteiro32(k.w.affineX) + inteiro32(k.w.affineY)

fun chavePrivadaDeBytes(bytes: ByteArray): ECPrivateKey {
    require(bytes.size == 32) { "chave privada deve ter 32 bytes" }
    return KeyFactory.getInstance("EC").generatePrivate(ECPrivateKeySpec(BigInteger(1, bytes), curvaP256)) as ECPrivateKey
}

fun chavePrivadaParaBytes(k: ECPrivateKey): ByteArray = inteiro32(k.s)

fun gerarParDeChaves(): KeyPair =
    KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()

/** Chaves VAPID do servidor, no formato base64url usado por todo o ecossistema Web Push. */
class ChavesVapid private constructor(val publicaB64: String, internal val privada: ECPrivateKey) {
    companion object {
        fun deBase64(publica: String, privada: String): ChavesVapid {
            val pub = base64UrlDecodificar(publica)
            val priv = chavePrivadaDeBytes(base64UrlDecodificar(privada))
            chavePublicaDeBytes(pub) // valida
            return ChavesVapid(publica, priv)
        }

        /** Devolve (pública, privada) em base64url, para colocar no .env. */
        fun gerar(): Pair<String, String> {
            val par = gerarParDeChaves()
            return base64Url(chavePublicaParaBytes(par.public as ECPublicKey)) to base64Url(chavePrivadaParaBytes(par.private as ECPrivateKey))
        }
    }
}

object Vapid {
    /** JWT ES256 para o serviço de push de `endpoint` (aud = origem do endpoint, exp curto). */
    fun jwt(endpoint: String, assunto: String, expiraEmSegundos: Long, chaves: ChavesVapid): String {
        val uri = URI(endpoint)
        val origem = "${uri.scheme}://${uri.host}" + (if (uri.port != -1) ":${uri.port}" else "")
        val cabecalho = base64Url("""{"typ":"JWT","alg":"ES256"}""".toByteArray())
        val corpo = base64Url("""{"aud":"${origem}","exp":$expiraEmSegundos,"sub":"${assunto.replace("\"", "")}"}""".toByteArray())
        val assinatura = Signature.getInstance("SHA256withECDSAinP1363Format").run {
            initSign(chaves.privada)
            update("$cabecalho.$corpo".toByteArray())
            sign()
        }
        return "$cabecalho.$corpo.${base64Url(assinatura)}"
    }

    fun cabecalho(jwt: String, chaves: ChavesVapid) = "vapid t=$jwt, k=${chaves.publicaB64}"
}

/** Cifragem do corpo da mensagem (RFC 8291 + RFC 8188, um único registro). */
object CriptoWebPush {
    const val TAMANHO_REGISTRO = 4096
    const val MAX_PAYLOAD = TAMANHO_REGISTRO - 86 - 16 - 1 // cabeçalho (86) + tag GCM (16) + delimitador (1)

    private fun hmac(chave: ByteArray, dados: ByteArray): ByteArray =
        Mac.getInstance("HmacSHA256").apply { init(SecretKeySpec(chave, "HmacSHA256")) }.doFinal(dados)

    /** HKDF com um único bloco (suficiente: precisamos de no máximo 32 bytes). */
    private fun hkdf(sal: ByteArray, ikm: ByteArray, info: ByteArray, tamanho: Int): ByteArray {
        val prk = hmac(sal, ikm)
        return hmac(prk, info + 0x01).copyOf(tamanho)
    }

    fun cifrar(
        payload: ByteArray,
        chavePublicaNavegador: ByteArray,
        segredoAuth: ByteArray,
        parServidor: KeyPair = gerarParDeChaves(),
        sal: ByteArray = ByteArray(16).also { SecureRandom().nextBytes(it) },
    ): ByteArray {
        require(payload.size <= MAX_PAYLOAD) { "mensagem grande demais (${payload.size} bytes)" }
        require(segredoAuth.size == 16) { "segredo auth deve ter 16 bytes" }
        require(sal.size == 16) { "sal deve ter 16 bytes" }
        val uaPublica = chavePublicaDeBytes(chavePublicaNavegador)
        val asPublicaBytes = chavePublicaParaBytes(parServidor.public as ECPublicKey)

        val segredoEcdh = KeyAgreement.getInstance("ECDH").run {
            init(parServidor.private); doPhase(uaPublica, true); generateSecret()
        }
        val infoChave = "WebPush: info".toByteArray() + 0x00 + chavePublicaNavegador + asPublicaBytes
        val ikm = hkdf(segredoAuth, segredoEcdh, infoChave, 32)
        val cek = hkdf(sal, ikm, "Content-Encoding: aes128gcm".toByteArray() + 0x00, 16)
        val nonce = hkdf(sal, ikm, "Content-Encoding: nonce".toByteArray() + 0x00, 12)

        val cifrado = Cipher.getInstance("AES/GCM/NoPadding").run {
            init(Cipher.ENCRYPT_MODE, SecretKeySpec(cek, "AES"), GCMParameterSpec(128, nonce))
            doFinal(payload + 0x02) // 0x02 marca o último (e único) registro
        }
        val cabecalho = ByteBuffer.allocate(16 + 4 + 1 + 65)
            .put(sal).putInt(TAMANHO_REGISTRO).put(65.toByte()).put(asPublicaBytes).array()
        return cabecalho + cifrado
    }
}

data class Inscricao(val endpoint: String, val p256dh: String, val auth: String)

/** Quais serviços de push aceitamos como destino. Sem isso, quem se inscreve poderia fazer o servidor chamar qualquer URL (SSRF). */
object EndpointPush {
    private val HOSTS_EXATOS = setOf("fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com")
    private val SUFIXOS = listOf(".push.services.mozilla.com", ".push.apple.com", ".notify.windows.com")
    private const val MAX_TAMANHO = 2048

    fun valido(endpoint: String): Boolean {
        if (endpoint.length > MAX_TAMANHO || endpoint.any { it.isISOControl() || it == ' ' }) return false
        val uri = try { URI(endpoint) } catch (_: Exception) { return false }
        if (uri.scheme != "https" || uri.userInfo != null || uri.fragment != null) return false
        if (uri.port != -1 && uri.port != 443) return false
        val host = uri.host?.lowercase() ?: return false
        if (host.all { it.isDigit() || it == '.' } || host.contains(':')) return false // endereço IP
        return host in HOSTS_EXATOS || SUFIXOS.any { host.endsWith(it) && host.length > it.length }
    }

    /** Confere o formato das chaves da inscrição: p256dh (65 bytes, na curva) e auth (16 bytes). */
    fun chavesValidas(p256dh: String, auth: String): Boolean = try {
        chavePublicaDeBytes(base64UrlDecodificar(p256dh))
        base64UrlDecodificar(auth).size == 16
    } catch (_: Exception) {
        false
    }
}

sealed interface ResultadoEnvio {
    data object Sucesso : ResultadoEnvio
    /** 404 ou 410: o navegador cancelou a inscrição; deve ser apagada. */
    data object Expirada : ResultadoEnvio
    data class Falha(val motivo: String, val status: Int? = null) : ResultadoEnvio
}

fun interface EnviadorPush {
    fun enviar(inscricao: Inscricao, payload: ByteArray, ttlSegundos: Int, topico: String?): ResultadoEnvio
}

class EnviadorWebPush(
    private val chaves: ChavesVapid,
    private val assunto: String,
    private val relogio: () -> Long = System::currentTimeMillis,
    private val http: HttpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(10))
        .followRedirects(HttpClient.Redirect.NEVER) // um redirecionamento poderia levar a um endereço interno
        .build(),
) : EnviadorPush {
    override fun enviar(inscricao: Inscricao, payload: ByteArray, ttlSegundos: Int, topico: String?): ResultadoEnvio {
        val corpo = try {
            CriptoWebPush.cifrar(payload, base64UrlDecodificar(inscricao.p256dh), base64UrlDecodificar(inscricao.auth))
        } catch (e: IllegalArgumentException) {
            return ResultadoEnvio.Falha("inscrição inválida: ${e.message}")
        }
        val expira = relogio() / 1000 + 12 * 3600
        val jwt = Vapid.jwt(inscricao.endpoint, assunto, expira, chaves)
        val req = HttpRequest.newBuilder(URI(inscricao.endpoint))
            .timeout(Duration.ofSeconds(15))
            .header("Authorization", Vapid.cabecalho(jwt, chaves))
            .header("Content-Encoding", "aes128gcm")
            .header("Content-Type", "application/octet-stream")
            .header("TTL", ttlSegundos.toString())
            .header("Urgency", "normal")
            .apply { if (topico != null) header("Topic", topico) }
            .POST(HttpRequest.BodyPublishers.ofByteArray(corpo))
            .build()
        return try {
            val r = http.send(req, HttpResponse.BodyHandlers.discarding())
            when (r.statusCode()) {
                200, 201, 202 -> ResultadoEnvio.Sucesso
                404, 410 -> ResultadoEnvio.Expirada
                else -> ResultadoEnvio.Falha("status ${r.statusCode()}", r.statusCode())
            }
        } catch (e: java.io.IOException) {
            ResultadoEnvio.Falha("rede: ${e.javaClass.simpleName}")
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt(); ResultadoEnvio.Falha("interrompido")
        }
    }
}
