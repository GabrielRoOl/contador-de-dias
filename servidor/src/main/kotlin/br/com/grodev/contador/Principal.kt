package br.com.grodev.contador

import io.ktor.server.cio.CIO
import io.ktor.server.engine.embeddedServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory
import kotlin.system.exitProcess

private val log = LoggerFactory.getLogger("principal")

fun main(args: Array<String>) {
    if (args.firstOrNull() == "gerar-vapid") {
        val (publica, privada) = ChavesVapid.gerar()
        println("# Cole estas duas linhas no arquivo .env (que não vai para o git). A privada é segredo.")
        println("VAPID_PUBLIC=$publica")
        println("VAPID_PRIVATE=$privada")
        return
    }

    if (args.firstOrNull() == "gerar-admin") {
        println("# Cole esta linha no arquivo .env (que não vai para o git). É a chave de administrador: guarde num gerenciador de senhas.")
        println("ADMIN=${Seguranca.novoAdmin()}")
        return
    }

    val config = try { Config.deAmbiente() } catch (e: IllegalStateException) {
        System.err.println("Configuração inválida: ${e.message}"); exitProcess(2)
    }
    val chaves = try { config.chavesVapid() } catch (e: Exception) {
        System.err.println("As chaves VAPID do .env são inválidas. Gere novas com: java -jar contador.jar gerar-vapid"); exitProcess(2)
    }
    if (chaves == null) log.warn("VAPID_PUBLIC/VAPID_PRIVATE ausentes: o servidor roda, mas sem enviar notificações. Use: java -jar contador.jar gerar-vapid")
    if (config.admin == null) log.warn("ADMIN ausente: qualquer pessoa pode cadastrar um aparelho e não há convites. Para restringir: java -jar contador.jar gerar-admin")
    if (config.pastaEstatica == null) log.warn("STATIC_DIR não encontrado: só a API será servida")

    val banco = Banco(config.caminhoBanco)
    val escopo = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    if (chaves != null) {
        val agendador = Agendador(banco, EnviadorWebPush(chaves, config.assuntoVapid))
        escopo.launch { agendador.rodar() }
        escopo.launch { AgendadorAlarmes(banco, EnviadorWebPush(chaves, config.assuntoVapid)).rodar() }
    }

    val servidor = embeddedServer(CIO, port = config.porta, host = config.endereco) { modulo(config, banco, chaves) }
    Runtime.getRuntime().addShutdownHook(Thread { log.info("encerrando"); escopo.cancel(); servidor.stop(500, 2000) })
    log.info("contador no ar em http://{}:{}{}/ (push {}, cadastro {})", config.endereco, config.porta, PREFIXO, if (chaves != null) "ativo" else "desligado", if (config.admin != null) "por convite" else "aberto")
    servidor.start(wait = true)
}
