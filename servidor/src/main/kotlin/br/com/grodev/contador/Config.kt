package br.com.grodev.contador

import java.io.File

/** Configuração por variáveis de ambiente (e, se existir, por um arquivo `.env` que nunca vai para o git). */
data class Config(
    val porta: Int = 8090,
    val endereco: String = "127.0.0.1",
    val caminhoBanco: String = "contador.db",
    val pastaEstatica: File? = null,
    val vapidPublica: String? = null,
    val vapidPrivada: String? = null,
    val assuntoVapid: String = "https://grodev.com.br/contador",
    val maxDispositivos: Int = 10_000,
) {
    companion object {
        /** Lê KEY=VALOR, ignora linhas vazias e comentários. As variáveis de ambiente de verdade têm prioridade. */
        fun lerEnv(arquivo: File): Map<String, String> {
            if (!arquivo.isFile) return emptyMap()
            return arquivo.readLines().map { it.trim() }.filter { it.isNotEmpty() && !it.startsWith("#") && '=' in it }
                .associate { linha ->
                    val i = linha.indexOf('=')
                    linha.substring(0, i).trim() to linha.substring(i + 1).trim().removeSurrounding("\"").removeSurrounding("'")
                }
        }

        fun deAmbiente(env: Map<String, String> = System.getenv(), arquivoEnv: File = File(".env")): Config {
            val e = lerEnv(arquivoEnv) + env
            fun inteiro(chave: String, padrao: Int): Int {
                val v = e[chave]?.takeIf { it.isNotBlank() } ?: return padrao
                return v.toIntOrNull() ?: error("$chave deve ser um número inteiro")
            }
            val estatica = (e["STATIC_DIR"]?.takeIf { it.isNotBlank() } ?: "../public").let(::File).takeIf { it.isDirectory }
            return Config(
                porta = inteiro("PORT", 8090),
                endereco = e["BIND"]?.takeIf { it.isNotBlank() } ?: "127.0.0.1",
                caminhoBanco = e["DB_PATH"]?.takeIf { it.isNotBlank() } ?: "contador.db",
                pastaEstatica = estatica,
                vapidPublica = e["VAPID_PUBLIC"]?.takeIf { it.isNotBlank() },
                vapidPrivada = e["VAPID_PRIVATE"]?.takeIf { it.isNotBlank() },
                assuntoVapid = e["VAPID_SUBJECT"]?.takeIf { it.isNotBlank() } ?: "https://grodev.com.br/contador",
                maxDispositivos = inteiro("MAX_DISPOSITIVOS", 10_000),
            )
        }
    }

    /** As duas chaves VAPID, se estiverem configuradas e forem válidas. */
    fun chavesVapid(): ChavesVapid? {
        if (vapidPublica == null || vapidPrivada == null) return null
        return ChavesVapid.deBase64(vapidPublica, vapidPrivada)
    }
}
