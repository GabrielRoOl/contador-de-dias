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

@Serializable data class RespostaDispositivo(val id: String, val segredo: String)
@Serializable data class RespostaChavePublica(val chave: String)
@Serializable data class RespostaSaude(val ok: Boolean = true, val push: Boolean)
@Serializable data class RespostaErro(val erro: String, val detalhes: List<String> = emptyList())
@Serializable data class ChavesInscricao(val p256dh: String, val auth: String)
@Serializable data class InscricaoPush(val endpoint: String, val keys: ChavesInscricao)

const val PREFIXO = "/contador"
private const val MAX_CORPO_ESTADO = 256 * 1024
private const val MAX_CORPO_PUSH = 8 * 1024

private val json = Json { ignoreUnknownKeys = true }
private val log = LoggerFactory.getLogger("rotas")

/** Cabeçalhos de segurança e de cache: nada é guardado pelo navegador sem revalidar (evita arquivos velhos). */
private val CabecalhosPadrao = createApplicationPlugin("CabecalhosPadrao") {
    onCallRespond { call, _ ->
        call.response.header("X-Content-Type-Options", "nosniff")
        call.response.header("Referrer-Policy", "no-referrer")
        call.response.header("X-Frame-Options", "DENY")
        val api = call.request.path().startsWith("$PREFIXO/api")
        call.response.header(HttpHeaders.CacheControl, if (api) "no-store" else "no-cache")
    }
}

/** IP do cliente. Atrás do túnel (conexão vinda de 127.0.0.1) confia no CF-Connecting-IP; fora disso usa o endereço da conexão. */
internal fun ApplicationCall.ipCliente(): String {
    val remoto = request.origin.remoteAddress
    val local = remoto == "127.0.0.1" || remoto == "::1" || remoto == "0:0:0:0:0:0:0:1" || remoto == "localhost"
    return (if (local) request.header("CF-Connecting-IP")?.trim()?.take(64) else null) ?: remoto
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
    limiteCriacao: LimitadorTaxa = LimitadorTaxa(10, 3_600_000, relogio),
) {
    install(CabecalhosPadrao)
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
                if (banco.contarDispositivos() >= config.maxDispositivos) return@post call.erro(HttpStatusCode.ServiceUnavailable, "Servidor cheio.")
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
                    banco.salvarEstado(d.id, json.encodeToString(Estado.serializer(), estado.paraServidor()), estado.preferencias.fuso, estado.preferencias.horaResumo, relogio())
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
