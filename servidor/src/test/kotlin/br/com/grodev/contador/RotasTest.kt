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
        tentativasConvite: LimitadorTaxa = LimitadorTaxa(10_000, 3_600_000) { agora },
        alarmes: LimitadorTaxa = LimitadorTaxa(10_000, 3_600_000) { agora },
        bloco: suspend ApplicationTestBuilder.(HttpClient) -> Unit,
    ) = testApplication {
        application { modulo(c, banco, vapid, { agora }, geral, criacao, tentativasConvite, limiteAlarme = alarmes) }
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

    @Test fun `o servidor guarda só o necessário, sem notas nem deslizes`() = comApp { c ->
        val (id, segredo) = c.novo()
        val corpo = """{"versao":2,"preferencias":{"horaResumo":"07:30","fuso":"Europe/London","visual":"classico","modo":"escuro"},"contagens":[{"id":"a1","nome":"Cigarro","tipo":"parar","inicio":1761000000000,
            "deslizes":[{"em":1761000001000,"nota":"NOTA_PRIVADA_DE_DESLIZE"}],
            "tentativas":[{"inicio":1,"fim":2,"dias":3,"nota":"NOTA_PRIVADA_DE_RECOMECO"},{"inicio":4,"fim":5,"dias":6,"nota":"OUTRA"}],
            "checkins":["2026-11-02","2026-11-01","2026-11-02"]}]}"""
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/estado", corpo, segredo).status)
        val guardado = banco.obter(id)!!.estadoJson
        assertFalse("NOTA_PRIVADA" in guardado || "OUTRA" in guardado, guardado)
        val e = Json.decodeFromString(Estado.serializer(), guardado)
        assertTrue(e.contagens.single().deslizes.isEmpty())
        assertEquals(1, e.contagens.single().tentativas.size)
        assertEquals(listOf("2026-11-01", "2026-11-02"), e.contagens.single().checkins)
    }

    @Test fun `corpo do estado acima de 256 KB é recusado`() = comApp { c ->
        val (id, segredo) = c.novo()
        val enorme = """{"versao":2,"x":"${"a".repeat(260 * 1024)}"}"""
        assertEquals(HttpStatusCode.PayloadTooLarge, c.putJson("/contador/api/dispositivos/$id/estado", enorme, segredo).status)
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
        // servir o HTML aqui quebraria os caminhos relativos (app.css, sw.js): tem que redirecionar para a barra final
        assertTrue(sem.status.value in 300..399, sem.status.toString())
        assertEquals("/contador/", sem.headers[HttpHeaders.Location])
        assertEquals(HttpStatusCode.OK, c.get("/contador/").status)
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

    // ---------------------------------------------------------------- limites e cota

    @Test fun `por padrão só 5 dispositivos novos por hora do mesmo endereço`() = testApplication {
        application { modulo(config(), banco, chaves, { agora }) }
        val c = createClient { followRedirects = false }
        repeat(5) { assertEquals(HttpStatusCode.Created, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "200.9.9.9") }.status) }
        assertEquals(HttpStatusCode.TooManyRequests, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "200.9.9.9") }.status)
        assertEquals(HttpStatusCode.Created, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "200.9.9.10") }.status, "outro endereço não é afetado")
    }

    @Test fun `trocar o fim do IPv6 não vale como outro cliente`() = comApp(criacao = LimitadorTaxa(2, 3_600_000) { agora }) { c ->
        suspend fun cria(ip: String) = c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", ip) }.status
        assertEquals(HttpStatusCode.Created, cria("2804:14d:1:2::1"))
        assertEquals(HttpStatusCode.Created, cria("2804:14d:1:2:abcd:1234:5678:9abc"))
        assertEquals(HttpStatusCode.TooManyRequests, cria("2804:14d:1:2:ffff::7"))
        assertEquals(HttpStatusCode.Created, cria("2804:14d:1:3::1"), "outro /64")
    }

    @Test fun `CF-Connecting-IP que não é um IP é ignorado, não vira chave do limitador`() = comApp(criacao = LimitadorTaxa(1, 3_600_000) { agora }) { c ->
        assertEquals(HttpStatusCode.Created, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "lixo-1") }.status)
        assertEquals(HttpStatusCode.TooManyRequests, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "lixo-2") }.status)
        assertEquals(HttpStatusCode.TooManyRequests, c.post("/contador/api/dispositivos") { header("CF-Connecting-IP", "x".repeat(60)) }.status)
    }

    @Test fun `a cota de bytes recusa estado que a estoura e novos dispositivos`() = comApp(Config(pastaEstatica = pasta, maxBytes = 3_000, caminhoBanco = File(dir, "t.db").path)) { c ->
        val (id, segredo) = c.novo()
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/estado", estadoOk, segredo).status)
        val grande = estadoOk.replace("\"contagens\":[", "\"contagens\":[" + (1..40).joinToString(",") { """{"id":"c$it","nome":"Refrigerante numero $it","tipo":"parar","inicio":1761000000000}""" } + ",")
        assertEquals(HttpStatusCode.InsufficientStorage, c.putJson("/contador/api/dispositivos/$id/estado", grande, segredo).status)
        val (id2, seg2) = c.novo()
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id2/estado", estadoOk, seg2).status)
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/estado", estadoOk, segredo).status, "reenviar o mesmo tamanho cabe")
        while (banco.bytesTotais() < 3_000) banco.salvarEstado(id2, "x".repeat(3_000), "UTC", "09:00", agora)
        assertEquals(HttpStatusCode.ServiceUnavailable, c.post("/contador/api/dispositivos").status)
    }

    // ---------------------------------------------------------------- CSP e cabeçalhos de defesa

    private fun sha256B64(t: String) = java.util.Base64.getEncoder().encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(t.toByteArray()))

    @Test fun `CSP com o hash do único script embutido, sem unsafe-inline, em tudo que o servidor responde`() {
        val inline = "try{document.documentElement.dataset.x=1}catch(e){}"
        File(pasta, "index.html").writeText("<html><head><script>$inline</script><script src=\"app.js\"></script></head></html>")
        comApp { c ->
            listOf("/contador/", "/contador/app.js", "/contador/sw.js", "/contador/api/saude", "/contador/nao-existe").forEach { caminho ->
                val csp = c.get(caminho).headers["Content-Security-Policy"]
                assertNotNull(csp, caminho)
                assertTrue("script-src 'self' 'sha256-${sha256B64(inline)}'" in csp, "$caminho: $csp")
                assertFalse("unsafe" in csp, csp)
                listOf("default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'self'", "connect-src 'self'", "style-src 'self'").forEach {
                    assertTrue(it in csp, "$caminho sem $it")
                }
                assertEquals(1, Regex("sha256-").findAll(csp).count(), "o script com src= não ganha hash")
            }
        }
    }

    @Test fun `o hash da CSP acompanha o index que mudou`() = comApp { c ->
        File(pasta, "index.html").writeText("<script>a()</script>")
        val a = c.get("/contador/").headers["Content-Security-Policy"]!!
        assertTrue(sha256B64("a()") in a)
        File(pasta, "index.html").apply { writeText("<script>b()</script>"); setLastModified(lastModified() + 5_000) }
        val b = c.get("/contador/").headers["Content-Security-Policy"]!!
        assertTrue(sha256B64("b()") in b && sha256B64("a()") !in b, b)
    }

    @Test fun `sem index ou sem script embutido a CSP não abre nenhuma exceção`() = comApp { c ->
        File(pasta, "index.html").delete()
        val csp = c.get("/contador/api/saude").headers["Content-Security-Policy"]!!
        assertTrue("script-src 'self';" in csp, csp)
    }

    @Test fun `outros cabeçalhos de defesa em profundidade`() = comApp { c ->
        val h = c.get("/contador/api/saude").headers
        assertEquals("same-origin", h["Cross-Origin-Opener-Policy"])
        assertEquals("same-origin", h["Cross-Origin-Resource-Policy"])
        assertTrue(h["Permissions-Policy"]!!.let { "camera=()" in it && "microphone=()" in it && "geolocation=()" in it })
    }

    @Test fun `o index real do app tem um único script embutido e nenhum handler ou estilo embutido`() {
        val index = File("../public/index.html").takeIf { it.isFile } ?: return
        val html = index.readText()
        assertEquals(1, PoliticaCsp.hashesDeScriptsEmbutidos(html).size, "um script embutido (o do tema); mais um exigiria outro hash")
        assertFalse(Regex("\\son[a-z]+\\s*=", RegexOption.IGNORE_CASE).containsMatchIn(html), "handler onclick= etc. é bloqueado pela CSP")
        assertFalse(Regex("\\sstyle\\s*=", RegexOption.IGNORE_CASE).containsMatchIn(html), "style= embutido é bloqueado pela CSP")
        val app = File("../public/app.js").takeIf { it.isFile }?.readText() ?: return
        assertFalse(Regex("style=|\\.setAttribute\\('style'|insertAdjacentHTML", RegexOption.IGNORE_CASE).containsMatchIn(app), "app.js não pode montar style= nem HTML por fora do esc()")
    }

    // ---------------------------------------------------------------- convites

    private val admin = "admin-de-teste-0123456789"
    private val limitePadrao get() = LimitadorTaxa(10_000, 3_600_000) { agora }
    private fun comConvites(tentativas: LimitadorTaxa = limitePadrao, bloco: suspend ApplicationTestBuilder.(HttpClient) -> Unit) =
        comApp(Config(pastaEstatica = pasta, admin = admin, caminhoBanco = File(dir, "t.db").path), tentativasConvite = tentativas, bloco = bloco)

    private suspend fun HttpClient.cadastra(codigo: String?, ip: String? = null) = post("/contador/api/dispositivos") {
        if (codigo != null) header("X-Convite", codigo)
        if (ip != null) header("CF-Connecting-IP", ip)
    }

    private fun HttpResponse.credenciais(texto: String): Pair<String, String> =
        Json.parseToJsonElement(texto).jsonObject.let { it["id"]!!.jsonPrimitive.content to it["segredo"]!!.jsonPrimitive.content }

    private suspend fun HttpClient.administrador(): Pair<String, String> {
        val r = cadastra(admin); assertEquals(HttpStatusCode.Created, r.status)
        return r.credenciais(r.bodyAsText())
    }

    private suspend fun HttpClient.gerarConvite(adm: Pair<String, String>, nome: String = "Maria"): HttpResponse =
        post("/contador/api/dispositivos/${adm.first}/convites") {
            header(HttpHeaders.Authorization, "Bearer ${adm.second}"); contentType(ContentType.Application.Json); setBody("""{"nome":"$nome"}""")
        }

    private fun codigoDe(r: String) = Json.parseToJsonElement(r).jsonObject["codigo"]!!.jsonPrimitive.content

    @Test fun `com ADMIN configurado, sem código, errado ou vazio não cadastra e a resposta é sempre a mesma`() = comConvites { c ->
        val rs = listOf(c.cadastra(null), c.cadastra("$admin-x"), c.cadastra(""), c.cadastra(admin.uppercase()), c.cadastra("ABCD-EFGH-JKLM-NPQR-STUV"))
        rs.forEach { assertEquals(HttpStatusCode.Forbidden, it.status) }
        assertEquals(1, rs.map { it.bodyAsText() }.toSet().size, "mesma resposta: não diz se faltou, errou ou o convite não existe")
        assertEquals(0, banco.contarDispositivos())
    }

    @Test fun `o código de administrador cadastra um aparelho administrador`() = comConvites { c ->
        val r = c.cadastra(admin)
        assertEquals(HttpStatusCode.Created, r.status)
        val texto = r.bodyAsText()
        assertFalse(admin in texto)
        assertTrue(banco.obter(r.credenciais(texto).first)!!.admin)
    }

    @Test fun `administrador gera convite que cadastra uma única vez e o aparelho convidado não é administrador`() = comConvites { c ->
        val adm = c.administrador()
        val r = c.gerarConvite(adm, "Maria")
        assertEquals(HttpStatusCode.Created, r.status)
        val codigo = codigoDe(r.bodyAsText())
        assertTrue(Regex("^([A-Z2-9]{4}-){4}[A-Z2-9]{4}$").matches(codigo), codigo)
        assertFalse(banco.listarConvites().single().let { String(it.nome.toByteArray()) == codigo }, "o código em si não é guardado")

        val primeiro = c.cadastra(codigo.lowercase().replace("-", " "))
        assertEquals(HttpStatusCode.Created, primeiro.status, "aceita minúsculas e espaços no lugar dos hífens")
        val convidado = primeiro.credenciais(primeiro.bodyAsText())
        assertFalse(banco.obter(convidado.first)!!.admin)

        assertEquals(HttpStatusCode.Forbidden, c.cadastra(codigo).status, "uso único")
        val lista = c.get("/contador/api/dispositivos/${adm.first}/convites") { header(HttpHeaders.Authorization, "Bearer ${adm.second}") }
        val item = Json.parseToJsonElement(lista.bodyAsText()).let { it as kotlinx.serialization.json.JsonArray }.single().jsonObject
        assertEquals("usado", item["estado"]!!.jsonPrimitive.content); assertEquals("Maria", item["nome"]!!.jsonPrimitive.content)
        assertFalse(codigo in lista.bodyAsText() && codigo.replace("-", "") in lista.bodyAsText(), "a lista não traz o código")
    }

    @Test fun `aparelho comum e quem não se autentica não gera nem lista nem revoga convites`() = comConvites { c ->
        val adm = c.administrador()
        val codigo = codigoDe(c.gerarConvite(adm).bodyAsText())
        val r = c.cadastra(codigo); val comum = r.credenciais(r.bodyAsText())
        val convite = banco.listarConvites().single().id
        val base = "/contador/api/dispositivos/${comum.first}/convites"
        fun HttpRequestBuilderCom(seg: String?) : io.ktor.client.request.HttpRequestBuilder.() -> Unit = { if (seg != null) header(HttpHeaders.Authorization, "Bearer $seg") }
        assertEquals(HttpStatusCode.Forbidden, c.get(base, HttpRequestBuilderCom(comum.second)).status)
        assertEquals(HttpStatusCode.Forbidden, c.gerarConvite(comum).status)
        assertEquals(HttpStatusCode.Forbidden, c.delete("$base/$convite", HttpRequestBuilderCom(comum.second)).status)
        assertEquals(HttpStatusCode.Unauthorized, c.get(base, HttpRequestBuilderCom(null)).status)
        assertEquals(HttpStatusCode.Unauthorized, c.get(base, HttpRequestBuilderCom("segredo-errado")).status)
        assertEquals(HttpStatusCode.Unauthorized, c.get("/contador/api/dispositivos/${adm.first}/convites", HttpRequestBuilderCom(comum.second)).status, "o segredo de um aparelho não vale no id de outro")
        assertEquals(1, banco.listarConvites().size, "nada foi gerado nem revogado")
        assertNotNull(banco.obter(comum.first))
    }

    @Test fun `convite vale até o último instante do prazo`() = comConvites { c ->
        val adm = c.administrador()
        val codigo = codigoDe(c.gerarConvite(adm).bodyAsText())
        agora += VALIDADE_CONVITE_MS - 1
        assertEquals(HttpStatusCode.Created, c.cadastra(codigo).status)
    }

    @Test fun `convite expirado não cadastra`() = comConvites { c ->
        val adm = c.administrador()
        val codigo = codigoDe(c.gerarConvite(adm).bodyAsText())
        agora += VALIDADE_CONVITE_MS
        assertEquals(HttpStatusCode.Forbidden, c.cadastra(codigo).status)
        assertEquals(1, banco.contarDispositivos(), "só o administrador")
        assertEquals("expirado", banco.listarConvites().single().estado(agora))
    }

    @Test fun `revogar convite pendente impede o uso e revogar um usado apaga o aparelho convidado`() = comConvites { c ->
        val adm = c.administrador()
        val auth: io.ktor.client.request.HttpRequestBuilder.() -> Unit = { header(HttpHeaders.Authorization, "Bearer ${adm.second}") }
        val pendente = codigoDe(c.gerarConvite(adm, "A").bodyAsText())
        val usado = codigoDe(c.gerarConvite(adm, "B").bodyAsText())
        val r = c.cadastra(usado); val convidado = r.credenciais(r.bodyAsText())
        val ids = banco.listarConvites().associate { it.nome to it.id }
        assertEquals(HttpStatusCode.NoContent, c.delete("/contador/api/dispositivos/${adm.first}/convites/${ids["A"]}", auth).status)
        assertEquals(HttpStatusCode.Forbidden, c.cadastra(pendente).status)
        assertEquals(HttpStatusCode.NoContent, c.delete("/contador/api/dispositivos/${adm.first}/convites/${ids["B"]}", auth).status)
        assertNull(banco.obter(convidado.first), "o aparelho que usou o convite foi apagado")
        assertNotNull(banco.obter(adm.first), "o administrador continua")
        assertEquals(HttpStatusCode.NotFound, c.delete("/contador/api/dispositivos/${adm.first}/convites/nao-existe", auth).status)
        assertEquals(setOf("revogado"), banco.listarConvites().map { it.estado(agora) }.toSet())
    }

    @Test fun `no máximo 10 convites pendentes, nome obrigatório e limite de criação`() = comConvites { c ->
        val adm = c.administrador()
        repeat(MAX_CONVITES_PENDENTES) { assertEquals(HttpStatusCode.Created, c.gerarConvite(adm, "P$it").status) }
        assertEquals(HttpStatusCode.Conflict, c.gerarConvite(adm, "demais").status)
        listOf("", "   ", "x".repeat(41), "a\u0000b").forEach {
            val r = c.post("/contador/api/dispositivos/${adm.first}/convites") {
                header(HttpHeaders.Authorization, "Bearer ${adm.second}"); contentType(ContentType.Application.Json); setBody("""{"nome":${Json.encodeToString(kotlinx.serialization.serializer<String>(), it)}}""")
            }
            assertEquals(HttpStatusCode.BadRequest, r.status, "nome '${it.take(5)}'")
        }
    }

    @Test fun `toda tentativa conta no limite, até a certa, e passado o limite nem o código certo entra`() = comConvites(LimitadorTaxa(3, 3_600_000) { agora }) { c ->
        repeat(2) { assertEquals(HttpStatusCode.Forbidden, c.cadastra("errado-$it").status) }
        assertEquals(HttpStatusCode.Created, c.cadastra(admin).status)
        val r = c.cadastra(admin)
        assertEquals(HttpStatusCode.TooManyRequests, r.status)
        assertEquals("3600", r.headers[HttpHeaders.RetryAfter])
        agora += 3_600_000
        assertEquals(HttpStatusCode.Created, c.cadastra(admin).status, "a janela renova")
    }

    @Test fun `as tentativas são por endereço, uma pessoa errando não trava a outra`() = comConvites(LimitadorTaxa(1, 3_600_000) { agora }) { c ->
        assertEquals(HttpStatusCode.Forbidden, c.cadastra(null, "200.1.1.1").status)
        assertEquals(HttpStatusCode.TooManyRequests, c.cadastra(admin, "200.1.1.1").status)
        assertEquals(HttpStatusCode.Created, c.cadastra(admin, "200.2.2.2").status)
    }

    @Test fun `convite não é gasto quando o cadastro não acontece por servidor cheio`() = comApp(Config(pastaEstatica = pasta, admin = admin, maxDispositivos = 2, caminhoBanco = File(dir, "t.db").path)) { c ->
        val adm = c.administrador()
        val codigo = codigoDe(c.gerarConvite(adm).bodyAsText())
        c.cadastra(admin)
        assertEquals(HttpStatusCode.ServiceUnavailable, c.cadastra(codigo).status)
        assertEquals("pendente", banco.listarConvites().single().estado(agora), "o convite continua valendo")
    }

    @Test fun `administrador nunca é apagado pela limpeza de parados`() = comConvites { c ->
        val adm = c.administrador()
        val dia = 86_400_000L
        banco.limparSemInscricao(agora + 400 * dia, agora + 400 * dia)
        banco.limparInativos(agora + 400 * dia)
        assertNotNull(banco.obter(adm.first))
    }

    @Test fun `sem ADMIN o cadastro continua aberto e não existem convites`() = comApp { c ->
        assertEquals(HttpStatusCode.Created, c.cadastra(null).status)
        assertEquals(HttpStatusCode.Created, c.cadastra("qualquer").status)
        val (id, seg) = c.novo()
        assertEquals(HttpStatusCode.Forbidden, c.gerarConvite(id to seg).status, "ninguém é administrador")
    }

    // ---------------------------------------------------------------- alarme do Pomodoro

    private fun pedidoAlarme(em: Long, fase: String = "foco", proxima: String = "pausa") = """{"em":$em,"fase":"$fase","proxima":"$proxima"}"""

    private suspend fun HttpClient.inscrito(): Pair<String, String> {
        val (id, segredo) = novo()
        assertEquals(HttpStatusCode.NoContent, putJson("/contador/api/dispositivos/$id/push", inscricaoOk(), segredo).status)
        return id to segredo
    }

    @Test fun `grava o alarme e DELETE cancela`() = comApp { c ->
        val (id, segredo) = c.inscrito()
        val em = agora + 25 * 60_000
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(em), segredo).status)
        assertEquals(em to "foco", banco.alarmeDe(id))
        val r = c.delete("/contador/api/dispositivos/$id/alarme") { header(HttpHeaders.Authorization, "Bearer $segredo") }
        assertEquals(HttpStatusCode.NoContent, r.status)
        assertNull(banco.alarmeDe(id))
    }

    @Test fun `um segundo alarme substitui o primeiro`() = comApp { c ->
        val (id, segredo) = c.inscrito()
        c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(agora + 60_000), segredo)
        c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(agora + 300_000, "pausa", "foco"), segredo)
        assertEquals((agora + 300_000) to "pausa", banco.alarmeDe(id))
    }

    @Test fun `cancelar sem alarme também responde 204`() = comApp { c ->
        val (id, segredo) = c.inscrito()
        assertEquals(HttpStatusCode.NoContent, c.delete("/contador/api/dispositivos/$id/alarme") { header(HttpHeaders.Authorization, "Bearer $segredo") }.status)
    }

    @Test fun `alarme exige o segredo do dispositivo`() = comApp { c ->
        val (id, _) = c.inscrito()
        val (_, outro) = c.novo()
        assertEquals(HttpStatusCode.Unauthorized, c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(agora + 60_000), null).status)
        assertEquals(HttpStatusCode.Unauthorized, c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(agora + 60_000), outro).status)
        assertEquals(HttpStatusCode.Unauthorized, c.delete("/contador/api/dispositivos/$id/alarme").status)
        assertNull(banco.alarmeDe(id))
    }

    @Test fun `alarme recusa horário fora da janela, fase desconhecida e corpo ruim`() = comApp { c ->
        val (id, segredo) = c.inscrito()
        val url = "/contador/api/dispositivos/$id/alarme"
        listOf(
            pedidoAlarme(agora - 61_000), pedidoAlarme(agora + 2 * 3_600_000 + 1_000), pedidoAlarme(0),
            pedidoAlarme(agora + 60_000, "descanso"), pedidoAlarme(agora + 60_000, "foco", "x"),
            """{"em":"amanhã","fase":"foco","proxima":"pausa"}""", """{"fase":"foco","proxima":"pausa"}""", "[]", "nada",
        ).forEach { assertEquals(HttpStatusCode.BadRequest, c.putJson(url, it, segredo).status, it) }
        assertNull(banco.alarmeDe(id))
        assertEquals(HttpStatusCode.UnsupportedMediaType, c.putJson(url, pedidoAlarme(agora + 60_000), segredo, ContentType.Text.Plain).status)
        assertEquals(HttpStatusCode.PayloadTooLarge, c.putJson(url, pedidoAlarme(agora + 60_000) + " ".repeat(600), segredo).status)
    }

    @Test fun `aceita um alarme que acabou de vencer (relógio do aparelho um pouco atrás)`() = comApp { c ->
        val (id, segredo) = c.inscrito()
        assertEquals(HttpStatusCode.NoContent, c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(agora - 30_000), segredo).status)
    }

    @Test fun `sem inscrição de push o alarme dá 409, sem VAPID dá 503`() {
        comApp { c ->
            val (id, segredo) = c.novo()
            assertEquals(HttpStatusCode.Conflict, c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(agora + 60_000), segredo).status)
        }
        comApp(vapid = null) { c ->
            val (id, segredo) = c.novo()
            assertEquals(HttpStatusCode.ServiceUnavailable, c.putJson("/contador/api/dispositivos/$id/alarme", pedidoAlarme(agora + 60_000), segredo).status)
        }
    }

    @Test fun `limite de alterações de alarme por dispositivo`() = comApp(alarmes = LimitadorTaxa(2, 3_600_000) { agora }) { c ->
        val (id, segredo) = c.inscrito()
        val url = "/contador/api/dispositivos/$id/alarme"
        repeat(2) { assertEquals(HttpStatusCode.NoContent, c.putJson(url, pedidoAlarme(agora + 60_000), segredo).status) }
        val r = c.putJson(url, pedidoAlarme(agora + 60_000), segredo)
        assertEquals(HttpStatusCode.TooManyRequests, r.status)
        assertEquals("3600", r.headers[HttpHeaders.RetryAfter])
        assertEquals(HttpStatusCode.TooManyRequests, c.delete(url) { header(HttpHeaders.Authorization, "Bearer $segredo") }.status)
    }

    @Test fun `trocar a inscrição de aparelho leva o alarme embora, e apagar o dispositivo também`() = comApp { c ->
        val (a, segA) = c.inscrito()
        c.putJson("/contador/api/dispositivos/$a/alarme", pedidoAlarme(agora + 60_000), segA)
        val (b, segB) = c.novo()
        c.putJson("/contador/api/dispositivos/$b/push", inscricaoOk(), segB) // mesmo endpoint: B rouba de A
        assertNull(banco.alarmeDe(a))
        c.putJson("/contador/api/dispositivos/$b/alarme", pedidoAlarme(agora + 60_000), segB)
        assertEquals(HttpStatusCode.NoContent, c.delete("/contador/api/dispositivos/$b") { header(HttpHeaders.Authorization, "Bearer $segB") }.status)
        assertNull(banco.alarmeDe(b))
    }
}
