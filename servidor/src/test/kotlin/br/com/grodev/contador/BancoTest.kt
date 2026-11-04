package br.com.grodev.contador

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class BancoTest {
    private val dir: File = createTempDirectory("contador-teste").toFile()
    private val banco = Banco(File(dir, "t.db").path)

    @AfterTest fun limpar() { dir.deleteRecursively() }

    private fun novo(id: String = "d1", agora: Long = 1000) =
        banco.criarDispositivo(id, Seguranca.hash("seg-$id"), agora, "{}", "America/Sao_Paulo", "09:00")

    @Test fun `cria e lê um dispositivo`() {
        novo()
        val d = assertNotNull(banco.obter("d1"))
        assertEquals("America/Sao_Paulo", d.fuso)
        assertEquals("09:00", d.horaResumo)
        assertContentEquals(Seguranca.hash("seg-d1"), d.segredoHash)
        assertFalse(d.temInscricao)
        assertNull(d.ultimoEnvio)
        assertNull(banco.obter("nao-existe"))
        assertEquals(1, banco.contarDispositivos())
    }

    @Test fun `id repetido não cria outro`() {
        novo()
        kotlin.test.assertFailsWith<java.sql.SQLException> { novo() }
    }

    @Test fun `salva estado e preferências`() {
        novo()
        assertTrue(banco.salvarEstado("d1", """{"x":1}""", "Europe/London", "07:30", 2000))
        val d = banco.obter("d1")!!
        assertEquals("""{"x":1}""", d.estadoJson); assertEquals("Europe/London", d.fuso); assertEquals("07:30", d.horaResumo); assertEquals(2000, d.atualizadoEm)
        assertFalse(banco.salvarEstado("outro", "{}", "UTC", "09:00", 1), "dispositivo inexistente")
    }

    @Test fun `guarda e remove a inscrição de push`() {
        novo()
        assertTrue(banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5))
        val d = banco.obter("d1")!!
        assertTrue(d.temInscricao); assertEquals("https://fcm.googleapis.com/x", d.pushEndpoint)
        assertEquals(listOf("d1"), banco.comInscricao().map { it.id })
        banco.removerInscricao("d1")
        assertFalse(banco.obter("d1")!!.temInscricao)
        assertTrue(banco.comInscricao().isEmpty())
    }

    @Test fun `o mesmo endpoint só fica com um dispositivo`() {
        novo("d1"); novo("d2")
        banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5)
        banco.salvarInscricao("d2", "https://fcm.googleapis.com/x", "p2", "a2", 6)
        assertFalse(banco.obter("d1")!!.temInscricao)
        assertEquals("p2", banco.obter("d2")!!.pushP256dh)
    }

    @Test fun `nova inscrição zera as tentativas`() {
        novo(); banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5)
        banco.registrarFalha("d1", "2026-11-03", 999)
        banco.salvarInscricao("d1", "https://fcm.googleapis.com/y", "p", "a", 6)
        val d = banco.obter("d1")!!
        assertEquals(0, d.tentativas); assertEquals(0, d.proximaTentativa)
    }

    @Test fun `marcar envio guarda o dia e zera as tentativas`() {
        novo(); banco.registrarFalha("d1", "2026-11-03", 500)
        banco.marcarEnvio("d1", "2026-11-03")
        val d = banco.obter("d1")!!
        assertEquals("2026-11-03", d.ultimoEnvio); assertEquals(0, d.tentativas); assertNull(d.tentativaData)
    }

    @Test fun `falhas contam no dia e recomeçam no dia seguinte`() {
        novo()
        banco.registrarFalha("d1", "2026-11-03", 100)
        banco.registrarFalha("d1", "2026-11-03", 200)
        assertEquals(2, banco.obter("d1")!!.tentativas)
        assertEquals(200, banco.obter("d1")!!.proximaTentativa)
        banco.registrarFalha("d1", "2026-11-04", 300)
        assertEquals(1, banco.obter("d1")!!.tentativas)
    }

    @Test fun `apagar remove tudo do dispositivo`() {
        novo(); assertTrue(banco.apagar("d1")); assertNull(banco.obter("d1")); assertFalse(banco.apagar("d1"))
    }

    @Test fun `limpa só os dispositivos parados há muito tempo`() {
        novo("velho", 100); novo("novo", 900)
        assertEquals(1, banco.limparInativos(500))
        assertNull(banco.obter("velho")); assertNotNull(banco.obter("novo"))
    }

    @Test fun `os dados sobrevivem a reabrir o banco`() {
        novo()
        val outro = Banco(File(dir, "t.db").path)
        assertNotNull(outro.obter("d1"))
    }

    @Test fun `texto malicioso vira dado e não SQL`() {
        novo("d1")
        assertNull(banco.obter("d1' OR '1'='1"))
        banco.salvarEstado("d1", "'); DROP TABLE dispositivos; --", "UTC", "09:00", 1)
        assertEquals(1, banco.contarDispositivos())
    }

    @Test fun `a lista do agendador não carrega o estado, só estadoJson(id) carrega`() {
        novo()
        banco.salvarEstado("d1", "x".repeat(300_000), "UTC", "09:00", 2)
        banco.salvarInscricao("d1", "https://fcm.googleapis.com/x", "p", "a", 5)
        val leve = banco.comInscricao().single()
        assertEquals("", leve.estadoJson, "a consulta por minuto não pode trazer centenas de KB por dispositivo")
        assertEquals("UTC", leve.fuso); assertEquals("09:00", leve.horaResumo); assertTrue(leve.temInscricao)
        assertEquals(300_000, banco.estadoJson("d1")!!.length)
        assertNull(banco.estadoJson("nao-existe"))
    }

    private fun bytesDoBanco(): ByteArray = dir.listFiles { f -> f.name.startsWith("t.db") }!!.map { it.readBytes() }.fold(ByteArray(0)) { a, b -> a + b }
    private fun ocorrencias(onde: ByteArray, texto: String) = String(onde, Charsets.ISO_8859_1).windowed(texto.length).count { it == texto }

    @Test fun `apagar um dispositivo não deixa o texto no arquivo do banco`() {
        novo()
        banco.salvarEstado("d1", """{"nome":"MARCADOR_PEQUENO_123"}""", "UTC", "09:00", 2)
        banco.salvarEstado("d1", "MARCADOR_GRANDE_456" + "y".repeat(20_000), "UTC", "09:00", 3) // passa de uma página: vai para páginas de overflow
        assertTrue(banco.apagar("d1"))
        val bytes = bytesDoBanco()
        assertEquals(0, ocorrencias(bytes, "MARCADOR_PEQUENO_123"), "restos do estado antigo no banco ou no WAL")
        assertEquals(0, ocorrencias(bytes, "MARCADOR_GRANDE_456"), "restos do estado apagado no banco ou no WAL")
    }

    @Test fun `a limpeza de inativos também apaga de verdade`() {
        novo("velho", 100)
        banco.salvarEstado("velho", "MARCADOR_VELHO_789", "UTC", "09:00", 100)
        assertEquals(1, banco.limparInativos(500))
        assertEquals(0, ocorrencias(bytesDoBanco(), "MARCADOR_VELHO_789"))
    }

    @Test fun `abrir um banco antigo limpa os restos que ele já tinha`() {
        val arquivo = File(dir, "antigo.db").path
        java.sql.DriverManager.getConnection("jdbc:sqlite:$arquivo").use { c ->
            c.createStatement().use {
                it.execute("PRAGMA journal_mode = WAL")
                it.execute("CREATE TABLE dispositivos (id TEXT PRIMARY KEY, segredo_hash BLOB NOT NULL, criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL, fuso TEXT NOT NULL, hora_resumo TEXT NOT NULL, estado_json TEXT NOT NULL, push_endpoint TEXT, push_p256dh TEXT, push_auth TEXT, ultimo_envio TEXT, tentativa_data TEXT, tentativas INTEGER NOT NULL DEFAULT 0, proxima_tentativa INTEGER NOT NULL DEFAULT 0)")
                it.execute("PRAGMA user_version = 1")
                it.execute("INSERT INTO dispositivos (id, segredo_hash, criado_em, atualizado_em, fuso, hora_resumo, estado_json) VALUES ('x', x'00', 1, 1, 'UTC', '09:00', 'MARCADOR_ANTIGO_321')")
                it.execute("DELETE FROM dispositivos") // sem secure_delete: o texto fica no arquivo
            }
        }
        Banco(arquivo) // migra
        val bytes = dir.listFiles { f -> f.name.startsWith("antigo.db") }!!.map { it.readBytes() }.fold(ByteArray(0)) { a, b -> a + b }
        assertEquals(0, ocorrencias(bytes, "MARCADOR_ANTIGO_321"))
    }

    @Test fun `a cota soma os bytes dos estados e acompanha as mudanças`() {
        assertEquals(0, banco.bytesTotais())
        novo("d1"); novo("d2") // "{}" = 2 bytes cada
        assertEquals(4, banco.bytesTotais())
        banco.salvarEstado("d1", "ação".repeat(10), "UTC", "09:00", 2) // acentos: conta bytes, não caracteres
        assertEquals(10 * 6 + 2, banco.bytesTotais())
        assertEquals(60L, banco.obter("d1")!!.tamanho)
        banco.apagar("d1")
        assertEquals(2, banco.bytesTotais())
    }

    @Test fun `limpa sem inscrição o que nunca foi usado e o que está parado`() {
        val dia = 86_400_000L
        val agora = 100 * dia
        novo("nunca-usado-velho", agora - 2 * dia)      // criado e nunca tocou em nada
        novo("nunca-usado-novo", agora - dia / 2)       // ainda dentro do prazo (alguém pode estar ativando)
        novo("parado", agora - 50 * dia); banco.salvarEstado("parado", "{}", "UTC", "09:00", agora - 20 * dia)
        novo("ativo-recente", agora - 50 * dia); banco.salvarEstado("ativo-recente", "{}", "UTC", "09:00", agora - 2 * dia)
        novo("com-inscricao", agora - 50 * dia); banco.salvarEstado("com-inscricao", "{}", "UTC", "09:00", agora - 30 * dia)
        banco.salvarInscricao("com-inscricao", "https://fcm.googleapis.com/z", "p", "a", agora - 30 * dia)
        banco.salvarEstado("com-inscricao", "{}", "UTC", "09:00", agora - 30 * dia)
        assertEquals(2, banco.limparSemInscricao(agora - dia, agora - 14 * dia))
        listOf("nunca-usado-velho", "parado").forEach { assertNull(banco.obter(it), it) }
        listOf("nunca-usado-novo", "ativo-recente", "com-inscricao").forEach { assertNotNull(banco.obter(it), it) }
    }

    @Test fun `bancos anteriores à cota recebem o tamanho dos estados que já tinham`() {
        val arquivo = File(dir, "v1.db").path
        java.sql.DriverManager.getConnection("jdbc:sqlite:$arquivo").use { c ->
            c.createStatement().use {
                it.execute("CREATE TABLE dispositivos (id TEXT PRIMARY KEY, segredo_hash BLOB NOT NULL, criado_em INTEGER NOT NULL, atualizado_em INTEGER NOT NULL, fuso TEXT NOT NULL, hora_resumo TEXT NOT NULL, estado_json TEXT NOT NULL, push_endpoint TEXT, push_p256dh TEXT, push_auth TEXT, ultimo_envio TEXT, tentativa_data TEXT, tentativas INTEGER NOT NULL DEFAULT 0, proxima_tentativa INTEGER NOT NULL DEFAULT 0)")
                it.execute("PRAGMA user_version = 1")
                it.execute("INSERT INTO dispositivos (id, segredo_hash, criado_em, atualizado_em, fuso, hora_resumo, estado_json) VALUES ('x', x'00', 1, 1, 'UTC', '09:00', '12345')")
            }
        }
        assertEquals(5, Banco(arquivo).bytesTotais())
    }
}
