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
    /** Soma dos estados guardados; passou disso, novos dispositivos e estados maiores são recusados. */
    val maxBytes: Long = 200L * 1024 * 1024,
    /** Código que `POST /dispositivos` exige no cabeçalho X-Convite. null = cadastro aberto a qualquer um. */
    val convite: String? = null,
) {
    companion object {
        const val TAMANHO_MINIMO_CONVITE = 16

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
                maxBytes = inteiro("MAX_BYTES_MB", 200) * 1024L * 1024L,
                convite = e["CONVITE"]?.takeIf { it.isNotBlank() }?.also {
                    if (it.length < TAMANHO_MINIMO_CONVITE) error("CONVITE deve ter pelo menos $TAMANHO_MINIMO_CONVITE caracteres (gere um com: java -jar contador.jar gerar-convite)")
                },
            )
        }
    }

    /** As duas chaves VAPID, se estiverem configuradas e forem válidas. */
    fun chavesVapid(): ChavesVapid? {
        if (vapidPublica == null || vapidPrivada == null) return null
        return ChavesVapid.deBase64(vapidPublica, vapidPrivada)
    }
}
