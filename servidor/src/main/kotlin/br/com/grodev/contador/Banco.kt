package br.com.grodev.contador

import java.sql.Connection
import java.sql.DriverManager
import java.sql.ResultSet

/** Convite individual de uso único. O código em si nunca é guardado, só o hash. */
class Convite(val id: String, val nome: String, val criadoEm: Long, val expiraEm: Long, val usadoEm: Long?, val usadoPor: String?, val revogado: Boolean) {
    fun estado(agora: Long) = when {
        revogado -> "revogado"
        usadoEm != null -> "usado"
        agora >= expiraEm -> "expirado"
        else -> "pendente"
    }
}

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
    val tamanho: Long = 0,
    val admin: Boolean = false,
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
                // Sem isto o SQLite só marca o espaço como livre e o texto apagado continua legível no arquivo.
                it.execute("PRAGMA secure_delete = ON")
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
        if (versao < 2) {
            // Bancos criados antes do secure_delete podem ter restos de dados apagados: o VACUUM reescreve o arquivo sem eles.
            c.createStatement().use { it.execute("VACUUM"); it.execute("PRAGMA user_version = 2") }
        }
        if (versao < 3) {
            c.createStatement().use {
                it.execute("ALTER TABLE dispositivos ADD COLUMN tamanho INTEGER NOT NULL DEFAULT 0") // bytes do estado: a cota total soma isto sem ler os estados
                it.execute("UPDATE dispositivos SET tamanho = length(CAST(estado_json AS BLOB))")
                it.execute("PRAGMA user_version = 3")
            }
        }
        if (versao < 4) {
            c.createStatement().use {
                it.execute("ALTER TABLE dispositivos ADD COLUMN admin INTEGER NOT NULL DEFAULT 0")
                it.execute(
                    """CREATE TABLE convites (
                        id TEXT PRIMARY KEY,
                        hash BLOB NOT NULL UNIQUE,
                        nome TEXT NOT NULL,
                        criado_em INTEGER NOT NULL,
                        expira_em INTEGER NOT NULL,
                        usado_em INTEGER,
                        usado_por TEXT,
                        revogado INTEGER NOT NULL DEFAULT 0
                    )""",
                )
                it.execute("PRAGMA user_version = 4")
            }
        }
    }

    /** Esvazia o WAL, onde ainda ficam as versões antigas das páginas, depois de apagar dados pessoais. */
    private fun Connection.limparWal() = createStatement().use { it.execute("PRAGMA wal_checkpoint(TRUNCATE)") }

    private fun ResultSet.dispositivo() = Dispositivo(
        id = getString("id"), segredoHash = getBytes("segredo_hash"), criadoEm = getLong("criado_em"), atualizadoEm = getLong("atualizado_em"),
        fuso = getString("fuso"), horaResumo = getString("hora_resumo"), estadoJson = getString("estado_json"),
        pushEndpoint = getString("push_endpoint"), pushP256dh = getString("push_p256dh"), pushAuth = getString("push_auth"),
        ultimoEnvio = getString("ultimo_envio"), tentativaData = getString("tentativa_data"), tentativas = getInt("tentativas"),
        proximaTentativa = getLong("proxima_tentativa"), tamanho = getLong("tamanho"), admin = getInt("admin") == 1,
    )

    fun contarDispositivos(): Int = usar { c ->
        c.createStatement().use { s -> s.executeQuery("SELECT COUNT(*) FROM dispositivos").use { it.getInt(1) } }
    }

    /** Soma dos bytes dos estados guardados (para a cota do servidor). */
    fun bytesTotais(): Long = usar { c ->
        c.createStatement().use { s -> s.executeQuery("SELECT COALESCE(SUM(tamanho), 0) FROM dispositivos").use { it.getLong(1) } }
    }

    fun criarDispositivo(id: String, segredoHash: ByteArray, agora: Long, estadoJson: String, fuso: String, horaResumo: String, admin: Boolean = false) = usar { c ->
        c.prepareStatement(
            "INSERT INTO dispositivos (id, segredo_hash, criado_em, atualizado_em, fuso, hora_resumo, estado_json, tamanho, admin) VALUES (?,?,?,?,?,?,?,?,?)",
        ).use {
            it.setString(1, id); it.setBytes(2, segredoHash); it.setLong(3, agora); it.setLong(4, agora)
            it.setString(5, fuso); it.setString(6, horaResumo); it.setString(7, estadoJson); it.setLong(8, estadoJson.toByteArray().size.toLong()); it.setInt(9, if (admin) 1 else 0)
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
        c.prepareStatement("UPDATE dispositivos SET estado_json = ?, fuso = ?, hora_resumo = ?, atualizado_em = ?, tamanho = ? WHERE id = ?").use {
            it.setString(1, estadoJson); it.setString(2, fuso); it.setString(3, horaResumo); it.setLong(4, agora); it.setLong(5, estadoJson.toByteArray().size.toLong()); it.setString(6, id)
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
            .also { c.limparWal() }
    }

    /**
     * Quem tem inscrição de push, SEM o estado (`estadoJson` vem vazio): o agendador passa por todos a cada minuto e
     * carregar centenas de KB por dispositivo esgotaria a memória. O estado de quem vai receber sai de [estadoJson].
     */
    fun comInscricao(): List<Dispositivo> = usar { c ->
        c.createStatement().use { s ->
            s.executeQuery(
                "SELECT id, segredo_hash, criado_em, atualizado_em, fuso, hora_resumo, '' AS estado_json, push_endpoint, push_p256dh, push_auth, " +
                    "ultimo_envio, tentativa_data, tentativas, proxima_tentativa, tamanho, admin FROM dispositivos WHERE push_endpoint IS NOT NULL",
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
        c.prepareStatement("DELETE FROM dispositivos WHERE admin = 0 AND atualizado_em < ?").use { it.setLong(1, limiteAtualizacao); it.executeUpdate() }
            .also { c.limparWal() }
    }

    /**
     * Apaga o que não serve para nada no servidor: dispositivos que nunca chegaram a ter estado ou inscrição depois de
     * `nuncaUsadoAntes`, e os sem inscrição de push que não sincronizam desde `paradoAntes`. Sem inscrição o servidor não
     * tem como avisar, e quem só ocupa espaço não deve poder encher o cadastro.
     */
    fun limparSemInscricao(nuncaUsadoAntes: Long, paradoAntes: Long): Int = usar { c ->
        c.prepareStatement(
            "DELETE FROM dispositivos WHERE admin = 0 AND push_endpoint IS NULL AND ((atualizado_em = criado_em AND criado_em < ?) OR atualizado_em < ?)",
        ).use { it.setLong(1, nuncaUsadoAntes); it.setLong(2, paradoAntes); it.executeUpdate() }.also { c.limparWal() }
    }

    // ---------------------------------------------------------------- convites

    fun criarConvite(id: String, hash: ByteArray, nome: String, agora: Long, expiraEm: Long) = usar { c ->
        c.prepareStatement("INSERT INTO convites (id, hash, nome, criado_em, expira_em) VALUES (?,?,?,?,?)").use {
            it.setString(1, id); it.setBytes(2, hash); it.setString(3, nome); it.setLong(4, agora); it.setLong(5, expiraEm); it.executeUpdate()
        }
    }

    fun convitesPendentes(agora: Long): Int = usar { c ->
        c.prepareStatement("SELECT COUNT(*) FROM convites WHERE usado_em IS NULL AND revogado = 0 AND expira_em > ?").use {
            it.setLong(1, agora); it.executeQuery().use { rs -> rs.getInt(1) }
        }
    }

    fun listarConvites(limite: Int = 100): List<Convite> = usar { c ->
        c.prepareStatement("SELECT id, nome, criado_em, expira_em, usado_em, usado_por, revogado FROM convites ORDER BY criado_em DESC, rowid DESC LIMIT ?").use { ps ->
            ps.setInt(1, limite)
            ps.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) add(Convite(rs.getString(1), rs.getString(2), rs.getLong(3), rs.getLong(4), rs.getLong(5).takeUnless { rs.wasNull() }, rs.getString(6), rs.getInt(7) == 1))
                }
            }
        }
    }

    /**
     * Usa o convite e cria o dispositivo numa transação só: o convite vale para um único cadastro mesmo com pedidos
     * simultâneos, e só é gasto se o dispositivo for mesmo criado. Devolve false se o convite não existe, já foi usado,
     * foi revogado ou expirou.
     */
    fun cadastrarComConvite(hash: ByteArray, agora: Long, id: String, segredoHash: ByteArray, estadoJson: String, fuso: String, horaResumo: String): Boolean = usar { c ->
        c.autoCommit = false
        try {
            val usado = c.prepareStatement("UPDATE convites SET usado_em = ?, usado_por = ? WHERE hash = ? AND usado_em IS NULL AND revogado = 0 AND expira_em > ?").use {
                it.setLong(1, agora); it.setString(2, id); it.setBytes(3, hash); it.setLong(4, agora); it.executeUpdate() == 1
            }
            if (usado) {
                c.prepareStatement(
                    "INSERT INTO dispositivos (id, segredo_hash, criado_em, atualizado_em, fuso, hora_resumo, estado_json, tamanho) VALUES (?,?,?,?,?,?,?,?)",
                ).use {
                    it.setString(1, id); it.setBytes(2, segredoHash); it.setLong(3, agora); it.setLong(4, agora)
                    it.setString(5, fuso); it.setString(6, horaResumo); it.setString(7, estadoJson); it.setLong(8, estadoJson.toByteArray().size.toLong())
                    it.executeUpdate()
                }
            }
            c.commit()
            usado
        } catch (e: Exception) {
            c.rollback(); throw e
        }
    }

    enum class ResultadoRevogacao { NAO_ENCONTRADO, REVOGADO, APARELHO_APAGADO }

    /** Convite pendente: é revogado. Convite já usado: apaga o aparelho que o usou (nunca um administrador). */
    fun revogarConvite(id: String): ResultadoRevogacao = usar { c ->
        c.autoCommit = false
        try {
            val usadoPor = c.prepareStatement("SELECT usado_por FROM convites WHERE id = ?").use { ps ->
                ps.setString(1, id)
                ps.executeQuery().use { rs -> if (rs.next()) rs.getString(1) to true else null to false }
            }
            if (!usadoPor.second) { c.rollback(); return@usar ResultadoRevogacao.NAO_ENCONTRADO }
            c.prepareStatement("UPDATE convites SET revogado = 1 WHERE id = ?").use { it.setString(1, id); it.executeUpdate() }
            val apagou = usadoPor.first?.let { dispositivo ->
                c.prepareStatement("DELETE FROM dispositivos WHERE id = ? AND admin = 0").use { it.setString(1, dispositivo); it.executeUpdate() == 1 }
            } ?: false
            c.commit()
            if (apagou) c.limparWal()
            if (apagou) ResultadoRevogacao.APARELHO_APAGADO else ResultadoRevogacao.REVOGADO
        } catch (e: Exception) {
            c.rollback(); throw e
        }
    }

    /** Convites que ninguém usou e já expiraram há muito tempo não servem nem de registro. */
    fun limparConvitesVelhos(antes: Long): Int = usar { c ->
        c.prepareStatement("DELETE FROM convites WHERE usado_em IS NULL AND expira_em < ?").use { it.setLong(1, antes); it.executeUpdate() }
    }
}
