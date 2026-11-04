package br.com.grodev.contador

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import java.util.concurrent.ConcurrentHashMap

/** Identidade anônima por dispositivo: id público e segredo aleatório; o servidor guarda só o hash do segredo. */
object Seguranca {
    private val aleatorio = SecureRandom()
    private val base64Url = Base64.getUrlEncoder().withoutPadding()

    private fun bytes(n: Int): String = ByteArray(n).also { aleatorio.nextBytes(it) }.let { base64Url.encodeToString(it) }

    fun novoId(): String = bytes(16)
    fun novoSegredo(): String = bytes(32)

    fun hash(segredo: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(segredo.toByteArray(Charsets.UTF_8))

    /** Comparação em tempo constante. */
    fun confere(segredo: String, hashEsperado: ByteArray): Boolean = MessageDigest.isEqual(hash(segredo), hashEsperado)

    /** Extrai o segredo de `Authorization: Bearer <segredo>`. */
    fun segredoDoCabecalho(cabecalho: String?): String? {
        if (cabecalho == null || !cabecalho.startsWith("Bearer ")) return null
        return cabecalho.substring(7).trim().takeIf { it.isNotEmpty() && it.length <= 200 }
    }
}

/** Normaliza o endereço do cliente para a chave dos limitadores. */
object Rede {
    private val IPV4 = Regex("^(25[0-5]|2[0-4]\\d|1?\\d?\\d)(\\.(25[0-5]|2[0-4]\\d|1?\\d?\\d)){3}$")
    private val CARACTERES_IPV6 = Regex("^[0-9A-Fa-f:.]{2,45}$")

    /**
     * IPv4 fica como está; IPv6 vira o bloco /64 (quem recebe um IPv6 recebe o /64 inteiro, então trocar o final do
     * endereço não pode valer como "outro cliente"); IPv4 embutido em IPv6 volta a ser IPv4. Devolve null se não for um IP.
     */
    fun chave(ip: String): String? {
        val t = ip.trim()
        if (IPV4.matches(t)) return t
        if (':' !in t || !CARACTERES_IPV6.matches(t)) return null
        val bytes = try { java.net.InetAddress.getByName(t).address } catch (_: Exception) { return null } // literal: não consulta DNS
        if (bytes.size == 4) return bytes.joinToString(".") { (it.toInt() and 0xff).toString() }
        return "v6:" + (0 until 4).joinToString(":") { i -> "%02x%02x".format(bytes[2 * i].toInt() and 0xff, bytes[2 * i + 1].toInt() and 0xff) }
    }
}

/** Limitador simples por janela fixa (em memória). Suficiente para um servidor pequeno atrás do túnel. */
class LimitadorTaxa(private val maximo: Int, private val janelaMs: Long, private val relogio: () -> Long = System::currentTimeMillis) {
    private class Janela(var inicio: Long, var contagem: Int)

    private val janelas = ConcurrentHashMap<String, Janela>()
    @Volatile private var ultimaLimpeza = 0L

    fun permitir(chave: String): Boolean {
        val agora = relogio()
        limparSeNecessario(agora)
        val j = janelas.computeIfAbsent(chave) { Janela(agora, 0) }
        synchronized(j) {
            if (agora - j.inicio >= janelaMs) { j.inicio = agora; j.contagem = 0 }
            if (j.contagem >= maximo) return false
            j.contagem++
            return true
        }
    }

    private fun limparSeNecessario(agora: Long) {
        if (agora - ultimaLimpeza < janelaMs) return
        ultimaLimpeza = agora
        janelas.entries.removeIf { agora - it.value.inicio >= janelaMs * 2 }
    }
}
