package br.com.grodev.contador

import io.ktor.client.HttpClient
import io.ktor.client.request.delete
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.post
import io.ktor.client.request.put
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.http.content.OutgoingContent
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.writeFully
import io.ktor.server.testing.ApplicationTestBuilder
import io.ktor.server.testing.testApplication
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RotasTest {
    private val dir: File = createTempDirectory("rotas-teste").toFile()
    private val pasta = File(dir, "public").apply {
        mkdirs()
        File(this, "index.html").writeText("<html>inicio</html>")
        File(this, "app.js").writeText("console.log(1)")
        File(this, "sw.js").writeText("// sw")
        File(this, "manifest.webmanifest").writeText("{}")
        File(this, "fonts").mkdirs()
        File(this, "fonts/a.woff2").writeBytes(byteArrayOf(1, 2, 3))
    }.also { File(dir, "segredo.txt").writeText("NÃO PODE VAZAR") }
    private val banco = Banco(File(dir, "t.db").path)
    private val chaves = ChavesVapid.gerar().let { ChavesVapid.deBase64(it.first, it.second) }
    private var agora = 1_762_000_000_000L

    @AfterTest fun limpar() { dir.deleteRecursively() }

    private fun config(max: Int = 10_000) = Config(pastaEstatica = pasta, maxDispositivos = max, caminhoBanco = File(dir, "t.db").path)

    private fun comApp(
        c: Config = config(), vapid: ChavesVapid? = chaves,
        geral: LimitadorTaxa = LimitadorTaxa(10_000, 60_000) { agora },
        criacao: LimitadorTaxa = LimitadorTaxa(10_000, 3_600_000) { agora },
        bloco: suspend ApplicationTestBuilder.(HttpClient) -> Unit,
    ) = testApplication {
        application { modulo(c, banco, vapid, { agora }, geral, criacao) }
        bloco(createClient { followRedirects = false })
    }

    private suspend fun HttpClient.novo(): Pair<String, String> {
        val r = post("/contador/api/dispositivos")
        assertEquals(HttpStatusCode.Created, r.status)
        val o = Json.parseToJsonElement(r.bodyAsText()).jsonObject
        return o["id"]!!.jsonPrimitive.content to o["segredo"]!!.jsonPrimitive.content
    }

    private suspend fun HttpClient.putJson(caminho: String, corpo: String, segredo: String?, tipo: ContentType? = ContentType.Application.Json): HttpResponse =
        put(caminho) {
            if (segredo != null) header(HttpHeaders.Authorization, "Bearer $segredo")
            if (tipo != null) contentType(tipo)
            setBody(corpo)
        }

    private val estadoOk = """{"versao":2,"preferencias":{"horaResumo":"07:30","fuso":"Europe/London"},"contagens":[{"id":"a1","nome":"Refrigerante","tipo":"parar","inicio":1761000000000,"custoDia":6.5}]}"""

    private fun inscricaoOk(endpoint: String = "https://fcm.googleapis.com/fcm/send/abc"): String {
        val nav = NavegadorFalso()
        return """{"endpoint":"$endpoint","keys":{"p256dh":"${base64Url(nav.publica)}","auth":"${base64Url(nav.auth)}"}}"""
    }

    // ---------------------------------------------------------------- saúde e chave pública

    @Test fun `saude responde e envia cabeçalhos de segurança, sem cache`() = comApp { c ->
        val r = c.get("/contador/api/saude")
        assertEquals(HttpStatusCode.OK, r.status)
        assertEquals("""{"ok":true,"push":true}""", r.bodyAsText())
        assertEquals("no-store", r.headers[HttpHeaders.CacheControl])
        assertEquals("nosniff", r.headers["X-Content-Type-Options"])
        assertEquals("DENY", r.headers["X-Frame-Options"])
        assertEquals("no-referrer", r.headers["Referrer-Policy"])
    }

    @Test fun `chave pública VAPID`() = comApp { c ->
        val r = c.get("/contador/api/chave-publica")
        assertEquals(HttpStatusCode.OK, r.status)
        assertEquals(chaves.publicaB64, Json.parseToJsonElement(r.bodyAsText()).jsonObject["chave"]!!.jsonPrimitive.content)
    }

    @Test fun `sem VAPID configurado a saúde diz push falso e a chave dá 503`() = comApp(vapid = null) { c ->
        assertEquals("""{"ok":true,"push":false}""", c.get("/contador/api/saude").bodyAsText())
        assertEquals(HttpStatusCode.ServiceUnavailable, c.get("/contador/api/chave-publica").status)
    }

    // ---------------------------------------------------------------- criar dispositivo

    @Test fun `cria dispositivo e guarda só o hash do segredo`() = comApp { c ->
        val (id, segredo) = c.novo()
        assertEquals(22, id.length); assertEquals(43, segredo.length)
        val d = assertNotNull(banco.obter(id))
        assertTrue(Seguranca.confere(segredo, d.segredoHash))
        assertFalse(d.segredoHash.decodeToString().contains(segredo))
        assertNotEquals(id, c.novo().first)
    }

    @Test fun `limite de dispositivos novos por IP`() = comApp(criacao = LimitadorTaxa(2, 3_600_000) { agora }) { c ->
        c.novo(); c.novo()
        val r = c.post("/contador/api/dispositivos")
        assertEquals(HttpStatusCode.TooManyRequests, r.status)
        assertEquals("3600", r.headers[HttpHeaders.RetryAfter])
    }

    @Test fun `o limite usa o IP real que vem do túnel`() = comApp(criacao = LimitadorTaxa(1, 3_600_000) { agora }) { c ->
        assertEquals(HttpStatusCode.Created, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "200.1.1.1") }.status)
        assertEquals(HttpStatusCode.Created, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "200.2.2.2") }.status)
        assertEquals(HttpStatusCode.TooManyRequests, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "200.1.1.1") }.status)
    }

    @Test fun `limite geral por IP em toda a API`() = comApp(geral = LimitadorTaxa(3, 60_000) { agora }) { c ->
        repeat(3) { assertEquals(HttpStatusCode.OK, c.get("/contador/api/saude").status) }
        val r = c.get("/contador/api/saude")
        assertEquals(HttpStatusCode.TooManyRequests, r.status)
        assertEquals("60", r.headers[HttpHeaders.RetryAfter])
        agora += 60_000
        assertEquals(HttpStatusCode.OK, c.get("/contador/api/saude").status)
    }

    @Test fun `servidor cheio recusa novos dispositivos`() = comApp(config(max = 2)) { c ->
        c.novo(); c.novo()
        assertEquals(HttpStatusCode.ServiceUnavailable, c.post("/contador/api/dispositivos").status)
    }

    // ---------------------------------------------------------------- autenticação

    @Test fun `sem segredo, com segredo errado, id desconhecido ou malformado dão sempre o mesmo 401`() = comApp { c ->
        val (id, segredo) = c.novo()
        val respostas = listOf(
            c.putJson("/contador/api/dispositivos/$id/estado", estadoOk, null),
            c.putJson("/contador/api/dispositivos/$id/estado", estadoOk, segredo + "x"),
            c.putJson("/contador/api/dispositivos/${Seguranca.novoId()}/estado", estadoOk, segredo),
            c.putJson("/contador/api/dispositivos/a%20b/estado", estadoOk, segredo),
            c.put("/contador/api/dispositivos/$id/estado") { header(HttpHeaders.Authorization, "Basic $segredo"); contentType(ContentType.Application.Json); setBody(estadoOk) },
            c.delete("/contador/api/dispositivos/$id"),
        )
        respostas.forEach { assertEquals(HttpStatusCode.Unauthorized, it.status) }
        assertEquals(1, respostas.map { it.bodyAsText() }.toSet().size, "mesma resposta para todos: não revela se o id existe")
        assertNotNull(banco.obter(id), "nada foi apagado")
    }

    // ---------------------------------------------------------------- estado

    @Test fun `guarda o estado e as preferências`() = comApp { c ->
        val (id, segredo) = c.novo()
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/estado", estadoOk, segredo).status)
        val d = banco.obter(id)!!
        assertEquals("Europe/London", d.fuso); assertEquals("07:30", d.horaResumo)
        val e = Json.decodeFromString(Estado.serializer(), d.estadoJson)
        assertEquals("Refrigerante", e.contagens.single().nome)
        assertEquals(6.5, e.contagens.single().custoDia)
    }

    @Test fun `campos desconhecidos são ignorados, o resto é validado`() = comApp { c ->
        val (id, segredo) = c.novo()
        val corpo = estadoOk.replace("\"versao\":2,", "\"versao\":2,\"extra\":{\"x\":1},")
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/estado", corpo, segredo).status)
    }

    @Test fun `estado inválido dá 400 com os detalhes e não altera nada`() = comApp { c ->
        val (id, segredo) = c.novo()
        c.putJson("/contador/api/dispositivos/$id/estado", estadoOk, segredo)
        val antes = banco.obter(id)!!.estadoJson
        val ruim = estadoOk.replace("07:30", "7h30").replace("Europe/London", "Marte/Olympus")
        val r = c.putJson("/contador/api/dispositivos/$id/estado", ruim, segredo)
        assertEquals(HttpStatusCode.BadRequest, r.status)
        val corpo = r.bodyAsText()
        assertTrue("horaResumo" in corpo && "fuso" in corpo, corpo)
        assertEquals(antes, banco.obter(id)!!.estadoJson)
    }

    @Test fun `JSON quebrado, tipo errado e corpo vazio dão 400`() = comApp { c ->
        val (id, segredo) = c.novo()
        listOf("{quebrado", "", "[]", "null", """{"versao":"dois"}""", """{"versao":2,"contagens":[{"id":5}]}""").forEach {
            assertEquals(HttpStatusCode.BadRequest, c.putJson("/contador/api/dispositivos/$id/estado", it, segredo).status, "corpo: $it")
        }
    }

    @Test fun `exige Content-Type JSON`() = comApp { c ->
        val (id, segredo) = c.novo()
        assertEquals(HttpStatusCode.UnsupportedMediaType, c.putJson("/contador/api/dispositivos/$id/estado", estadoOk, segredo, ContentType.Text.Plain).status)
    }

    @Test fun `corpo grande demais dá 413`() = comApp { c ->
        val (id, segredo) = c.novo()
        val enorme = """{"versao":2,"x":"${"a".repeat(600 * 1024)}"}"""
        assertEquals(HttpStatusCode.PayloadTooLarge, c.putJson("/contador/api/dispositivos/$id/estado", enorme, segredo).status)
    }

    @Test fun `corpo grande enviado em partes, sem Content-Length, também dá 413`() = comApp { c ->
        val (id, segredo) = c.novo()
        val bytes = ("{\"versao\":2,\"x\":\"" + "a".repeat(600 * 1024) + "\"}").toByteArray()
        val r = c.put("/contador/api/dispositivos/$id/estado") {
            header(HttpHeaders.Authorization, "Bearer $segredo")
            setBody(object : OutgoingContent.WriteChannelContent() {
                override val contentType = ContentType.Application.Json
                override val contentLength: Long? = null
                override suspend fun writeTo(channel: ByteWriteChannel) { channel.writeFully(bytes) }
            })
        }
        assertEquals(HttpStatusCode.PayloadTooLarge, r.status)
    }

    // ---------------------------------------------------------------- inscrição de push

    @Test fun `guarda a inscrição de push`() = comApp { c ->
        val (id, segredo) = c.novo()
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/push", inscricaoOk(), segredo).status)
        assertEquals("https://fcm.googleapis.com/fcm/send/abc", banco.obter(id)!!.pushEndpoint)
    }

    @Test fun `recusa endpoints que não são de serviços de push, inclusive endereços internos`() = comApp { c ->
        val (id, segredo) = c.novo()
        listOf("http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://localhost/x", "https://169.254.169.254/x", "https://exemplo.com/x", "https://fcm.googleapis.com.exemplo.com/x").forEach {
            val r = c.putJson("/contador/api/dispositivos/$id/push", inscricaoOk(it), segredo)
            assertEquals(HttpStatusCode.BadRequest, r.status, it)
        }
        assertNull(banco.obter(id)!!.pushEndpoint)
    }

    @Test fun `recusa chaves inválidas e corpo sem chaves`() = comApp { c ->
        val (id, segredo) = c.novo()
        listOf(
            """{"endpoint":"https://fcm.googleapis.com/x","keys":{"p256dh":"abc","auth":"abc"}}""",
            """{"endpoint":"https://fcm.googleapis.com/x"}""", """{"keys":{"p256dh":"a","auth":"b"}}""", "{}", "{quebrado",
        ).forEach { assertEquals(HttpStatusCode.BadRequest, c.putJson("/contador/api/dispositivos/$id/push", it, segredo).status, it) }
    }

    @Test fun `sem VAPID a inscrição dá 503`() = comApp(vapid = null) { c ->
        val (id, segredo) = c.novo()
        assertEquals(HttpStatusCode.ServiceUnavailable, c.putJson("/contador/api/dispositivos/$id/push", inscricaoOk(), segredo).status)
    }

    // ---------------------------------------------------------------- apagar

    @Test fun `apagar remove só o dispositivo certo, e o segredo antigo deixa de valer`() = comApp { c ->
        val (id1, s1) = c.novo(); val (id2, s2) = c.novo()
        assertEquals(HttpStatusCode.NoContent, c.delete("/contador/api/dispositivos/$id1") { header(HttpHeaders.Authorization, "Bearer $s1") }.status)
        assertNull(banco.obter(id1)); assertNotNull(banco.obter(id2))
        assertEquals(HttpStatusCode.Unauthorized, c.putJson("/contador/api/dispositivos/$id1/estado", estadoOk, s1).status)
        assertEquals(HttpStatusCode.Unauthorized, c.delete("/contador/api/dispositivos/$id1") { header(HttpHeaders.Authorization, "Bearer $s2") }.status, "o segredo de outro não serve")
        assertNotNull(banco.obter(id2))
    }

    // ---------------------------------------------------------------- arquivos do app

    @Test fun `serve o app em contador com revalidação obrigatória`() = comApp { c ->
        val r = c.get("/contador/")
        assertEquals(HttpStatusCode.OK, r.status)
        assertEquals("<html>inicio</html>", r.bodyAsText())
        assertEquals("no-cache", r.headers[HttpHeaders.CacheControl])
        assertEquals("console.log(1)", c.get("/contador/app.js").bodyAsText())
    }

    @Test fun `tipos de conteúdo corretos para manifest, fonte e js`() = comApp { c ->
        assertTrue(c.get("/contador/manifest.webmanifest").contentType()!!.match(ContentType("application", "manifest+json")))
        assertTrue(c.get("/contador/fonts/a.woff2").contentType()!!.match(ContentType("font", "woff2")))
        assertTrue(c.get("/contador/app.js").contentType()!!.match(ContentType("text", "javascript")))
    }

    @Test fun `a raiz e o caminho sem barra levam ao app`() = comApp { c ->
        val raiz = c.get("/")
        assertTrue(raiz.status.value in 300..399); assertEquals("/contador/", raiz.headers[HttpHeaders.Location])
        val sem = c.get("/contador")
        assertTrue(sem.status == HttpStatusCode.OK || sem.status.value in 300..399, sem.status.toString())
    }

    @Test fun `não é possível sair da pasta pública`() = comApp { c ->
        listOf("/contador/../segredo.txt", "/contador/%2e%2e/segredo.txt", "/contador/..%2fsegredo.txt", "/contador/fonts/../../segredo.txt", "/contador/%2e%2e%2fsegredo.txt").forEach {
            val r = c.get(it)
            assertFalse("NÃO PODE VAZAR" in r.bodyAsText(), it)
            assertTrue(r.status != HttpStatusCode.OK, "$it -> ${r.status}")
        }
    }

    @Test fun `rota de API desconhecida devolve 404 em JSON`() = comApp { c ->
        val r = c.get("/contador/api/nada")
        assertEquals(HttpStatusCode.NotFound, r.status)
        assertTrue("erro" in r.bodyAsText())
    }

    @Test fun `método errado não funciona`() = comApp { c ->
        assertTrue(c.post("/contador/api/saude").status.value in listOf(404, 405))
        assertTrue(c.get("/contador/api/dispositivos").status.value in listOf(404, 405))
    }

    @Test fun `sem pasta estática só a API responde`() = comApp(c = Config(pastaEstatica = null)) { c ->
        assertEquals(HttpStatusCode.OK, c.get("/contador/api/saude").status)
        assertEquals(HttpStatusCode.NotFound, c.get("/contador/").status)
    }
}
