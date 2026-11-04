package br.com.grodev.contador

import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import kotlin.coroutines.coroutineContext

/** O aviso de fim de fase do Pomodoro. As frases combinam com `textoConclusao` do app.js; não leva nome de contagem. */
object MensagensPomodoro {
    const val TAG = "pomodoro"
    const val URL = "./#pomodoro"
    val FASES = setOf("foco", "pausa", "longa")

    fun compor(fase: String, proxima: String): Aviso =
        if (fase == "foco") Aviso(
            "Foco concluído",
            if (proxima == "longa") "Quatro focos! Pausa longa de 15 min." else "Hora da pausa de 5 min.",
            TAG,
        ) else Aviso("Pausa concluída", "Pronto para o próximo foco?", TAG)
}

data class ResumoAlarmes(val enviados: Int = 0, val falhas: Int = 0, val expirados: Int = 0, val descartados: Int = 0)

/**
 * Confere os alarmes do Pomodoro de poucos em poucos segundos e manda o push de quem venceu. O app fechado não tem relógio:
 * este é o único jeito de avisar. O push tem vida curta (um aviso de "acabou o foco" que chega 10 minutos depois só atrapalha),
 * então alarme vencido há mais que o TTL é descartado sem enviar, e uma falha é repetida a cada rodada só até o limite.
 */
class AgendadorAlarmes(
    private val banco: Banco,
    private val enviador: EnviadorPush,
    private val relogio: () -> Long = System::currentTimeMillis,
    private val ttlSegundos: Int = 120,
    private val maxTentativas: Int = 3,
    private val paralelismo: Int = 8,
    private val despachante: CoroutineDispatcher = Dispatchers.IO,
    private val intervaloRodada: Long = 15_000,
) {
    private val log = LoggerFactory.getLogger(AgendadorAlarmes::class.java)
    private val json = Json

    private enum class Destino { ENVIADO, FALHA, EXPIRADO }

    suspend fun executarRodada(): ResumoAlarmes {
        val agora = relogio()
        val antigos = withContext(despachante) { banco.limparAlarmesAntigos(agora - ttlSegundos * 1000L) }
        val vencidos = withContext(despachante) { banco.alarmesVencidos(agora) }
        if (vencidos.isEmpty()) return ResumoAlarmes(descartados = antigos)
        val limite = Semaphore(paralelismo)
        val resultados = coroutineScope {
            vencidos.map { a -> async(despachante) { limite.withPermit { enviarPara(a) } } }.awaitAll()
        }
        return ResumoAlarmes(
            enviados = resultados.count { it == Destino.ENVIADO },
            falhas = resultados.count { it == Destino.FALHA },
            expirados = resultados.count { it == Destino.EXPIRADO },
            descartados = antigos,
        )
    }

    private fun enviarPara(a: AlarmeVencido): Destino {
        val rotulo = a.id.take(6)
        try {
            val aviso = MensagensPomodoro.compor(a.fase, a.proxima)
            val carga = json.encodeToString(CargaAviso.serializer(), CargaAviso(aviso.titulo, aviso.corpo, aviso.tag, MensagensPomodoro.URL))
            val resultado = try {
                enviador.enviar(a.inscricao, carga.toByteArray(Charsets.UTF_8), ttlSegundos, aviso.tag)
            } catch (e: Exception) {
                ResultadoEnvio.Falha("erro: ${e.javaClass.simpleName}")
            }
            return when (resultado) {
                ResultadoEnvio.Sucesso -> { banco.cancelarAlarme(a.id); log.info("dispositivo {}: alarme do pomodoro enviado", rotulo); Destino.ENVIADO }
                ResultadoEnvio.Expirada -> { banco.removerInscricao(a.id); log.info("dispositivo {}: inscrição expirada, removida", rotulo); Destino.EXPIRADO }
                is ResultadoEnvio.Falha -> {
                    if (a.tentativas + 1 >= maxTentativas) banco.cancelarAlarme(a.id) else banco.registrarFalhaAlarme(a.id)
                    log.warn("dispositivo {}: falha no alarme do pomodoro ({}), tentativa {} de {}", rotulo, resultado.motivo, a.tentativas + 1, maxTentativas)
                    Destino.FALHA
                }
            }
        } catch (e: Exception) {
            log.error("dispositivo {}: erro inesperado no alarme: {}", rotulo, e.javaClass.simpleName)
            return Destino.FALHA
        }
    }

    suspend fun rodar() {
        while (coroutineContext.isActive) {
            try {
                executarRodada()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                log.error("rodada de alarmes falhou: {}", e.javaClass.simpleName)
            }
            delay(intervaloRodada)
        }
    }
}
