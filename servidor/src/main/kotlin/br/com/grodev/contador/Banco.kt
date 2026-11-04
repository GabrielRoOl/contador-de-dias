package br.com.grodev.contador

import java.sql.Connection
import java.sql.DriverManager
import java.sql.ResultSet

class Dispositivo(
    val id: String,
    val segredoHash: ByteArray,
    val criadoEm: Long,
    val atualizadoEm: Long,
    val fuso: String,
    val horaResumo: String,
    val estadoJson: String,
    val pushEndpoint: String?,
    val pushP256dh: String?,
    val pushAuth: String?,
    val ultimoEnvio: String?,
    val tentativaData: String?,
    val tentativas: Int,
    val proximaTentativa: Long,
) {
    val temInscricao get() = pushEndpoint != null && pushP256dh != null && pushAuth != null
}

/** SQLite em modo WAL. Cada operação abre a sua conexão: é barato no SQLite e evita estado compartilhado entre threads. */
class Banco(private val caminho: String) {
    init {
        Class.forName("org.sqlite.JDBC")
        migrar()
    }

    private fun <T> usar(bloco: (Connection) -> T): T =
        DriverManager.getConnection("jdbc:sqlite:$caminho").use { c ->
            c.createStatement().use {
                it.execute("PRAGMA busy_timeout = 5000")
                it.execute("PRAGMA foreign_keys = ON")
                it.execute("PRAGMA synchronous = NORMAL")
            }
            bloco(c)
        }

    private fun migrar() = usar { c ->
        c.createStatement().use { it.execute("PRAGMA journal_mode = WAL") }
        val versao = c.createStatement().use { s -> s.executeQuery("PRAGMA user_version").use { it.getInt(1) } }
        if (versao < 1) {
            c.createStatement().use {
                it.execute(
                    """CREATE TABLE dispositivos (
                        id TEXT PRIMARY KEY,
                        segredo_hash BLOB NOT NULL,
                        criado_em INTEGER NOT NULL,
                        atualizado_em INTEGER NOT NULL,
                        fuso TEXT NOT NULL,
                        hora_resumo TEXT NOT NULL,
                        estado_json TEXT NOT NULL,
                        push_endpoint TEXT,
                        push_p256dh TEXT,
                        push_auth TEXT,
                        ultimo_envio TEXT,
                        tentativa_data TEXT,
                        tentativas INTEGER NOT NULL DEFAULT 0,
                        proxima_tentativa INTEGER NOT NULL DEFAULT 0
                    )""",
                )
                it.execute("CREATE UNIQUE INDEX idx_push_endpoint ON dispositivos(push_endpoint) WHERE push_endpoint IS NOT NULL")
                it.execute("CREATE INDEX idx_atualizado ON dispositivos(atualizado_em)")
                it.execute("PRAGMA user_version = 1")
            }
        }
    }

    private fun ResultSet.dispositivo() = Dispositivo(
        id = getString("id"), segredoHash = getBytes("segredo_hash"), criadoEm = getLong("criado_em"), atualizadoEm = getLong("atualizado_em"),
        fuso = getString("fuso"), horaResumo = getString("hora_resumo"), estadoJson = getString("estado_json"),
        pushEndpoint = getString("push_endpoint"), pushP256dh = getString("push_p256dh"), pushAuth = getString("push_auth"),
        ultimoEnvio = getString("ultimo_envio"), tentativaData = getString("tentativa_data"), tentativas = getInt("tentativas"),
        proximaTentativa = getLong("proxima_tentativa"),
    )

    fun contarDispositivos(): Int = usar { c ->
        c.createStatement().use { s -> s.executeQuery("SELECT COUNT(*) FROM dispositivos").use { it.getInt(1) } }
    }

    fun criarDispositivo(id: String, segredoHash: ByteArray, agora: Long, estadoJson: String, fuso: String, horaResumo: String) = usar { c ->
        c.prepareStatement(
            "INSERT INTO dispositivos (id, segredo_hash, criado_em, atualizado_em, fuso, hora_resumo, estado_json) VALUES (?,?,?,?,?,?,?)",
        ).use {
            it.setString(1, id); it.setBytes(2, segredoHash); it.setLong(3, agora); it.setLong(4, agora)
            it.setString(5, fuso); it.setString(6, horaResumo); it.setString(7, estadoJson)
            it.executeUpdate()
        }
    }

    fun obter(id: String): Dispositivo? = usar { c ->
        c.prepareStatement("SELECT * FROM dispositivos WHERE id = ?").use {
            it.setString(1, id)
            it.executeQuery().use { rs -> if (rs.next()) rs.dispositivo() else null }
        }
    }

    fun salvarEstado(id: String, estadoJson: String, fuso: String, horaResumo: String, agora: Long): Boolean = usar { c ->
        c.prepareStatement("UPDATE dispositivos SET estado_json = ?, fuso = ?, hora_resumo = ?, atualizado_em = ? WHERE id = ?").use {
            it.setString(1, estadoJson); it.setString(2, fuso); it.setString(3, horaResumo); it.setLong(4, agora); it.setString(5, id)
            it.executeUpdate() == 1
        }
    }

    /** Uma inscrição pertence a um único dispositivo: se outro já usava o mesmo endpoint, ele a perde. */
    fun salvarInscricao(id: String, endpoint: String, p256dh: String, auth: String, agora: Long): Boolean = usar { c ->
        c.autoCommit = false
        try {
            c.prepareStatement("UPDATE dispositivos SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE push_endpoint = ? AND id <> ?").use {
                it.setString(1, endpoint); it.setString(2, id); it.executeUpdate()
            }
            val ok = c.prepareStatement(
                "UPDATE dispositivos SET push_endpoint = ?, push_p256dh = ?, push_auth = ?, atualizado_em = ?, tentativas = 0, tentativa_data = NULL, proxima_tentativa = 0 WHERE id = ?",
            ).use {
                it.setString(1, endpoint); it.setString(2, p256dh); it.setString(3, auth); it.setLong(4, agora); it.setString(5, id)
                it.executeUpdate() == 1
            }
            c.commit()
            ok
        } catch (e: Exception) {
            c.rollback(); throw e
        }
    }

    fun removerInscricao(id: String) = usar { c ->
        c.prepareStatement("UPDATE dispositivos SET push_endpoint = NULL, push_p256dh = NULL, push_auth = NULL WHERE id = ?").use {
            it.setString(1, id); it.executeUpdate()
        }
    }

    fun apagar(id: String): Boolean = usar { c ->
        c.prepareStatement("DELETE FROM dispositivos WHERE id = ?").use { it.setString(1, id); it.executeUpdate() == 1 }
    }

    /**
     * Quem tem inscrição de push, SEM o estado (`estadoJson` vem vazio): o agendador passa por todos a cada minuto e
     * carregar centenas de KB por dispositivo esgotaria a memória. O estado de quem vai receber sai de [estadoJson].
     */
    fun comInscricao(): List<Dispositivo> = usar { c ->
        c.createStatement().use { s ->
            s.executeQuery(
                "SELECT id, segredo_hash, criado_em, atualizado_em, fuso, hora_resumo, '' AS estado_json, push_endpoint, push_p256dh, push_auth, " +
                    "ultimo_envio, tentativa_data, tentativas, proxima_tentativa FROM dispositivos WHERE push_endpoint IS NOT NULL",
            ).use { rs -> buildList { while (rs.next()) add(rs.dispositivo()) } }
        }
    }

    fun estadoJson(id: String): String? = usar { c ->
        c.prepareStatement("SELECT estado_json FROM dispositivos WHERE id = ?").use {
            it.setString(1, id)
            it.executeQuery().use { rs -> if (rs.next()) rs.getString(1) else null }
        }
    }

    fun marcarEnvio(id: String, dataLocal: String) = usar { c ->
        c.prepareStatement("UPDATE dispositivos SET ultimo_envio = ?, tentativas = 0, tentativa_data = NULL, proxima_tentativa = 0 WHERE id = ?").use {
            it.setString(1, dataLocal); it.setString(2, id); it.executeUpdate()
        }
    }

    /** Conta mais uma tentativa que falhou no dia (o contador recomeça a cada dia) e agenda a próxima. */
    fun registrarFalha(id: String, dataLocal: String, proxima: Long) = usar { c ->
        c.prepareStatement(
            "UPDATE dispositivos SET tentativas = CASE WHEN tentativa_data = ? THEN tentativas + 1 ELSE 1 END, tentativa_data = ?, proxima_tentativa = ? WHERE id = ?",
        ).use {
            it.setString(1, dataLocal); it.setString(2, dataLocal); it.setLong(3, proxima); it.setString(4, id); it.executeUpdate()
        }
    }

    /** Apaga quem não sincroniza há muito tempo (LGPD: não guardar dados parados). Devolve quantos foram apagados. */
    fun limparInativos(limiteAtualizacao: Long): Int = usar { c ->
        c.prepareStatement("DELETE FROM dispositivos WHERE atualizado_em < ?").use { it.setLong(1, limiteAtualizacao); it.executeUpdate() }
    }
}
