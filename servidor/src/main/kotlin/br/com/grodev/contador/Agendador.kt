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
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.coroutines.coroutineContext

/** O que o service worker recebe e mostra. */
@Serializable
data class CargaAviso(val titulo: String, val corpo: String, val tag: String, val url: String = "./", val marco: Boolean = false)

data class ResumoRodada(val enviados: Int = 0, val falhas: Int = 0, val expiradas: Int = 0, val ignorados: Int = 0)

/**
 * Roda a cada minuto. Para cada dispositivo com inscrição, no fuso dele: se já passou da hora do resumo, ainda estamos
 * dentro da janela e o dia ainda não recebeu o aviso, monta a mensagem e envia. O dia só conta como enviado depois do
 * sucesso, então um erro passageiro (ou o Termux voltando atrasado) não faz o aviso se perder.
 */
class Agendador(
    private val banco: Banco,
    private val enviador: EnviadorPush,
    private val relogio: () -> Long = System::currentTimeMillis,
    private val janela: Duration = Duration.ofHours(3),
    private val maxTentativas: Int = 5,
    private val intervaloTentativa: Duration = Duration.ofMinutes(5),
    private val ttlSegundos: Int = 3 * 3600,
    private val inatividadeMax: Duration = Duration.ofDays(365),
    private val paralelismo: Int = 8,
    private val despachante: CoroutineDispatcher = Dispatchers.IO,
) {
    private val log = LoggerFactory.getLogger(Agendador::class.java)
    private val json = Json { ignoreUnknownKeys = true; coerceInputValues = true }
    private val padraoZona = ZoneId.of("America/Sao_Paulo")

    private class Alvo(val d: Dispositivo, val dia: LocalDate, val zona: ZoneId)

    /** Qual dia (se algum) deve receber o aviso agora. Olha ontem e hoje porque a janela pode atravessar a meia-noite. */
    private fun decidir(d: Dispositivo, agora: Long): Alvo? {
        val zona = try { ZoneId.of(d.fuso) } catch (_: Exception) { padraoZona }
        val hora = try { LocalTime.parse(d.horaResumo) } catch (_: Exception) { LocalTime.of(9, 0) }
        val hoje = Instant.ofEpochMilli(agora).atZone(zona).toLocalDate()
        for (dia in listOf(hoje.minusDays(1), hoje)) {
            val inicio = ZonedDateTime.of(dia, hora, zona).toInstant().toEpochMilli()
            if (agora < inicio || agora >= inicio + janela.toMillis()) continue
            if (d.ultimoEnvio == dia.toString()) continue
            val tentativas = if (d.tentativaData == dia.toString()) d.tentativas else 0
            if (tentativas >= maxTentativas || agora < d.proximaTentativa) continue
            return Alvo(d, dia, zona)
        }
        return null
    }

    suspend fun executarMinuto(): ResumoRodada {
        val agora = relogio()
        val alvos = banco.comInscricao().mapNotNull { decidir(it, agora) }
        if (alvos.isEmpty()) return ResumoRodada()
        val limite = Semaphore(paralelismo)
        val resultados = coroutineScope {
            alvos.map { a -> async(despachante) { limite.withPermit { enviarPara(a, agora) } } }.awaitAll()
        }
        return ResumoRodada(
            enviados = resultados.count { it == Destino.ENVIADO },
            falhas = resultados.count { it == Destino.FALHA },
            expiradas = resultados.count { it == Destino.EXPIRADA },
            ignorados = resultados.count { it == Destino.IGNORADO },
        )
    }

    private enum class Destino { ENVIADO, FALHA, EXPIRADA, IGNORADO }

    private fun enviarPara(a: Alvo, agora: Long): Destino {
        val d = a.d
        val rotulo = d.id.take(6)
        try {
            val estado = try { json.decodeFromString<Estado>(d.estadoJson) } catch (e: Exception) {
                log.warn("dispositivo {}: estado ilegível, nada enviado", rotulo); return Destino.IGNORADO
            }
            val aviso = Mensagens.compor(estado, agora, a.zona)
            if (aviso == null) { // nada a avisar: conta o dia como resolvido para não reprocessar a cada minuto
                banco.marcarEnvio(d.id, a.dia.toString()); return Destino.IGNORADO
            }
            val carga = json.encodeToString(CargaAviso.serializer(), CargaAviso(aviso.titulo, aviso.corpo, aviso.tag, "./", aviso.temMarco))
            val resultado = try {
                enviador.enviar(Inscricao(d.pushEndpoint!!, d.pushP256dh!!, d.pushAuth!!), carga.toByteArray(Charsets.UTF_8), ttlSegundos, aviso.tag)
            } catch (e: Exception) {
                ResultadoEnvio.Falha("erro: ${e.javaClass.simpleName}")
            }
            return when (resultado) {
                ResultadoEnvio.Sucesso -> { banco.marcarEnvio(d.id, a.dia.toString()); log.info("dispositivo {}: aviso enviado", rotulo); Destino.ENVIADO }
                ResultadoEnvio.Expirada -> { banco.removerInscricao(d.id); log.info("dispositivo {}: inscrição expirada, removida", rotulo); Destino.EXPIRADA }
                is ResultadoEnvio.Falha -> {
                    banco.registrarFalha(d.id, a.dia.toString(), agora + intervaloTentativa.toMillis())
                    log.warn("dispositivo {}: falha no envio ({}), nova tentativa em {} min", rotulo, resultado.motivo, intervaloTentativa.toMinutes())
                    Destino.FALHA
                }
            }
        } catch (e: Exception) {
            log.error("dispositivo {}: erro inesperado: {}", rotulo, e.javaClass.simpleName)
            return Destino.FALHA
        }
    }

    /** Apaga quem não sincroniza há muito tempo (LGPD). */
    fun limparInativos(): Int {
        val apagados = banco.limparInativos(relogio() - inatividadeMax.toMillis())
        if (apagados > 0) log.info("{} dispositivos inativos apagados", apagados)
        return apagados
    }

    /** Laço principal: uma rodada por minuto, alinhada ao relógio. Cancele a corrotina para parar. */
    suspend fun rodar() {
        var ultimaLimpeza = 0L
        while (coroutineContext.isActive) {
            val agora = relogio()
            try {
                if (agora - ultimaLimpeza > Duration.ofHours(6).toMillis()) { withContext(despachante) { limparInativos() }; ultimaLimpeza = agora }
                executarMinuto()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                log.error("rodada falhou: {}", e.javaClass.simpleName)
            }
            delay(maxOf(1_000L, 60_000L - relogio() % 60_000L))
        }
    }
}
