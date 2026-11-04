package br.com.grodev.contador

import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.ApplicationCall
import io.ktor.server.application.ApplicationCallPipeline
import io.ktor.server.application.call
import io.ktor.server.application.createApplicationPlugin
import io.ktor.server.application.install
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.origin
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.request.contentLength
import io.ktor.server.request.contentType
import io.ktor.server.request.header
import io.ktor.server.request.path
import io.ktor.server.request.receiveChannel
import io.ktor.server.response.header
import io.ktor.server.response.respond
import io.ktor.server.response.respondRedirect
import io.ktor.server.routing.delete
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.put
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import io.ktor.server.http.content.staticFiles
import io.ktor.utils.io.readRemaining
import kotlinx.io.readByteArray
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.io.File
import java.security.MessageDigest

@Serializable data class RespostaDispositivo(val id: String, val segredo: String)
@Serializable data class RespostaChavePublica(val chave: String)
@Serializable data class RespostaSaude(val ok: Boolean = true, val push: Boolean)
@Serializable data class RespostaErro(val erro: String, val detalhes: List<String> = emptyList())
@Serializable data class ChavesInscricao(val p256dh: String, val auth: String)
@Serializable data class InscricaoPush(val endpoint: String, val keys: ChavesInscricao)

const val PREFIXO = "/contador"
private const val MAX_CORPO_ESTADO = 256 * 1024
private const val MAX_CORPO_PUSH = 8 * 1024
const val LIMITE_CRIACAO_POR_HORA = 5

private val json = Json { ignoreUnknownKeys = true }
private val log = LoggerFactory.getLogger("rotas")

/**
 * Content-Security-Policy do app. O único script embutido do index.html (aplica o tema antes de pintar) entra pelo hash
 * do conteúdo, recalculado quando o arquivo muda; o resto só roda se vier do próprio site. Se alguém conseguir injetar
 * HTML, o navegador recusa o script injetado, o estilo embutido, e conexões e formulários para outros sites.
 */
internal class PoliticaCsp(private val pasta: File?) {
    private var modificado = Long.MIN_VALUE
    private var atual = montar(emptyList())

    @Synchronized fun valor(): String {
        val index = pasta?.resolve("index.html")?.takeIf { it.isFile }
        val mod = index?.lastModified() ?: -1L
        if (mod != modificado) { atual = montar(hashesDeScriptsEmbutidos(index?.readText() ?: "")); modificado = mod }
        return atual
    }

    companion object {
        private val SCRIPT_EMBUTIDO = Regex("<script(?![^>]*\\bsrc\\s*=)[^>]*>(.*?)</script>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))

        fun hashesDeScriptsEmbutidos(html: String): List<String> = SCRIPT_EMBUTIDO.findAll(html).map { m ->
            "'sha256-" + java.util.Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-256").digest(m.groupValues[1].toByteArray())) + "'"
        }.toList()

        fun montar(hashes: List<String>) = listOf(
            "default-src 'self'", "script-src " + (listOf("'self'") + hashes).joinToString(" "), "style-src 'self'", "img-src 'self'",
            "font-src 'self'", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "object-src 'none'",
            "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
        ).joinToString("; ")
    }
}

/** Cabeçalhos de segurança e de cache: nada é guardado pelo navegador sem revalidar (evita arquivos velhos). */
private fun cabecalhosPadrao(csp: PoliticaCsp) = createApplicationPlugin("CabecalhosPadrao") {
    onCallRespond { call, _ ->
        call.response.header("X-Content-Type-Options", "nosniff")
        call.response.header("Referrer-Policy", "no-referrer")
        call.response.header("X-Frame-Options", "DENY")
        call.response.header("Content-Security-Policy", csp.valor())
        call.response.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()")
        call.response.header("Cross-Origin-Opener-Policy", "same-origin")
        call.response.header("Cross-Origin-Resource-Policy", "same-origin")
        val api = call.request.path().startsWith("$PREFIXO/api")
        call.response.header(HttpHeaders.CacheControl, if (api) "no-store" else "no-cache")
    }
}

/**
 * Chave de rede do cliente (ver [Rede.chave]). Atrás do túnel (conexão vinda de 127.0.0.1) confia no CF-Connecting-IP,
 * mas só se ele for mesmo um endereço IP; fora disso usa o endereço da conexão.
 */
internal fun ApplicationCall.ipCliente(): String {
    val remoto = request.origin.remoteAddress
    val local = remoto == "127.0.0.1" || remoto == "::1" || remoto == "0:0:0:0:0:0:0:1" || remoto == "localhost"
    val doCabecalho = if (local) request.header("CF-Connecting-IP")?.let(Rede::chave) else null
    return doCabecalho ?: Rede.chave(remoto) ?: remoto.take(64)
}

private suspend fun ApplicationCall.erro(status: HttpStatusCode, msg: String, detalhes: List<String> = emptyList()) =
    respond(status, RespostaErro(msg, detalhes))

/** Lê o corpo respeitando o limite, mesmo sem Content-Length. Devolve null se passar do limite. */
private suspend fun ApplicationCall.corpoLimitado(max: Int): String? {
    val declarado = request.contentLength()
    if (declarado != null && declarado > max) return null
    val bytes = receiveChannel().readRemaining((max + 1).toLong()).readByteArray()
    return if (bytes.size > max) null else bytes.decodeToString()
}

private fun ApplicationCall.ehJson() = request.contentType().match(ContentType.Application.Json)

fun Application.modulo(
    config: Config,
    banco: Banco,
    chaves: ChavesVapid?,
    relogio: () -> Long = System::currentTimeMillis,
    limiteGeral: LimitadorTaxa = LimitadorTaxa(240, 60_000, relogio),
    limiteCriacao: LimitadorTaxa = LimitadorTaxa(LIMITE_CRIACAO_POR_HORA, 3_600_000, relogio),
) {
    install(cabecalhosPadrao(PoliticaCsp(config.pastaEstatica)))
    install(ContentNegotiation) { json(Json { encodeDefaults = true }) }
    install(StatusPages) {
        exception<Throwable> { call, e ->
            log.error("erro não tratado em {}: {}", call.request.path(), e.javaClass.simpleName)
            call.erro(HttpStatusCode.InternalServerError, "Erro interno.")
        }
        status(HttpStatusCode.NotFound) { call, _ ->
            if (call.request.path().startsWith("$PREFIXO/api")) call.erro(HttpStatusCode.NotFound, "Não encontrado.")
        }
    }

    /** Confere id + segredo. Devolve o dispositivo ou responde 401 (o mesmo erro para id desconhecido e segredo errado). */
    suspend fun autenticar(call: ApplicationCall, id: String?): Dispositivo? {
        val segredo = Seguranca.segredoDoCabecalho(call.request.header(HttpHeaders.Authorization))
        val d = if (id != null && Validacao.idValido(id)) banco.obter(id) else null
        val hashEsperado = d?.segredoHash ?: ByteArray(32)
        val ok = segredo != null && Seguranca.confere(segredo, hashEsperado) && d != null
        if (!ok) { call.erro(HttpStatusCode.Unauthorized, "Não autorizado."); return null }
        return d
    }

    routing {
        get("/") { call.respondRedirect("$PREFIXO/") }
        // Sem a barra final os caminhos relativos do app (app.css, sw.js...) apontariam para a raiz do domínio.
        get(PREFIXO) { call.respondRedirect("$PREFIXO/") }

        route("$PREFIXO/api") {
            // limite geral por IP, antes de qualquer rota
            intercept(ApplicationCallPipeline.Plugins) {
                if (!limiteGeral.permitir("ip:" + call.ipCliente())) {
                    call.response.header(HttpHeaders.RetryAfter, "60")
                    call.erro(HttpStatusCode.TooManyRequests, "Muitas requisições. Tente de novo em instantes.")
                    finish()
                }
            }

            get("/saude") { call.respond(RespostaSaude(push = chaves != null)) }

            get("/chave-publica") {
                if (chaves == null) call.erro(HttpStatusCode.ServiceUnavailable, "Notificações não configuradas neste servidor.")
                else call.respond(RespostaChavePublica(chaves.publicaB64))
            }

            post("/dispositivos") {
                if (!limiteCriacao.permitir("novo:" + call.ipCliente())) {
                    call.response.header(HttpHeaders.RetryAfter, "3600")
                    return@post call.erro(HttpStatusCode.TooManyRequests, "Muitos dispositivos novos deste endereço. Tente mais tarde.")
                }
                if (banco.contarDispositivos() >= config.maxDispositivos || banco.bytesTotais() >= config.maxBytes) return@post call.erro(HttpStatusCode.ServiceUnavailable, "Servidor cheio.")
                val id = Seguranca.novoId()
                val segredo = Seguranca.novoSegredo()
                val padrao = Preferencias()
                banco.criarDispositivo(id, Seguranca.hash(segredo), relogio(), json.encodeToString(Estado.serializer(), Estado()), padrao.fuso, padrao.horaResumo)
                call.respond(HttpStatusCode.Created, RespostaDispositivo(id, segredo))
            }

            route("/dispositivos/{id}") {
                put("/estado") {
                    val d = autenticar(call, call.parameters["id"]) ?: return@put
                    if (!call.ehJson()) return@put call.erro(HttpStatusCode.UnsupportedMediaType, "Envie application/json.")
                    val texto = call.corpoLimitado(MAX_CORPO_ESTADO) ?: return@put call.erro(HttpStatusCode.PayloadTooLarge, "Corpo grande demais.")
                    val estado = try { json.decodeFromString(Estado.serializer(), texto) } catch (e: SerializationException) {
                        return@put call.erro(HttpStatusCode.BadRequest, "JSON inválido.")
                    } catch (e: IllegalArgumentException) {
                        return@put call.erro(HttpStatusCode.BadRequest, "JSON inválido.")
                    }
                    val problemas = Validacao.erros(estado, relogio())
                    if (problemas.isNotEmpty()) return@put call.erro(HttpStatusCode.BadRequest, "Estado inválido.", problemas)
                    val guardar = json.encodeToString(Estado.serializer(), estado.paraServidor())
                    if (banco.bytesTotais() - d.tamanho + guardar.toByteArray().size > config.maxBytes) {
                        return@put call.erro(HttpStatusCode.InsufficientStorage, "Servidor sem espaço.")
                    }
                    banco.salvarEstado(d.id, guardar, estado.preferencias.fuso, estado.preferencias.horaResumo, relogio())
                    call.respond(HttpStatusCode.NoContent)
                }

                put("/push") {
                    val d = autenticar(call, call.parameters["id"]) ?: return@put
                    if (chaves == null) return@put call.erro(HttpStatusCode.ServiceUnavailable, "Notificações não configuradas neste servidor.")
                    if (!call.ehJson()) return@put call.erro(HttpStatusCode.UnsupportedMediaType, "Envie application/json.")
                    val texto = call.corpoLimitado(MAX_CORPO_PUSH) ?: return@put call.erro(HttpStatusCode.PayloadTooLarge, "Corpo grande demais.")
                    val insc = try { json.decodeFromString(InscricaoPush.serializer(), texto) } catch (e: Exception) {
                        return@put call.erro(HttpStatusCode.BadRequest, "Inscrição inválida.")
                    }
                    if (!EndpointPush.valido(insc.endpoint)) return@put call.erro(HttpStatusCode.BadRequest, "Endpoint de push não permitido.")
                    if (!EndpointPush.chavesValidas(insc.keys.p256dh, insc.keys.auth)) return@put call.erro(HttpStatusCode.BadRequest, "Chaves da inscrição inválidas.")
                    banco.salvarInscricao(d.id, insc.endpoint, insc.keys.p256dh, insc.keys.auth, relogio())
                    call.respond(HttpStatusCode.NoContent)
                }

                delete {
                    val d = autenticar(call, call.parameters["id"]) ?: return@delete
                    banco.apagar(d.id)
                    call.respond(HttpStatusCode.NoContent)
                }
            }
        }

        config.pastaEstatica?.let { pasta ->
            staticFiles(PREFIXO, pasta, index = "index.html") {
                contentType { arquivo ->
                    when (arquivo.extension.lowercase()) {
                        "webmanifest" -> ContentType("application", "manifest+json")
                        "woff2" -> ContentType("font", "woff2")
                        "js" -> ContentType("text", "javascript")
                        else -> null
                    }
                }
            }
        }
    }
}
