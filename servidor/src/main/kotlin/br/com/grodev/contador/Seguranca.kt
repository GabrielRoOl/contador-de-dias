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
