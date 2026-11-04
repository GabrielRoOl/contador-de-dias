package br.com.grodev.contador

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.time.LocalDate
import java.time.ZoneId
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Confere que Logica.kt e Textos.kt dão exatamente os mesmos resultados de public/logica.js e public/textos.js.
 * Os casos vêm de `node scripts/fixtures.js` (fixtures-js.json), em vários fusos, incluindo horário de verão e 29/02.
 */
class ParidadeJsTest {
    private val raiz: JsonObject = Json.parseToJsonElement(
        javaClass.getResource("/fixtures-js.json")!!.readText(Charsets.UTF_8),
    ).jsonObject

    private val zonas get() = raiz["zonas"]!!.jsonObject
    private val textos get() = raiz["textos"]!!.jsonObject

    private fun JsonElement.o() = jsonObject
    private fun JsonObject.l(k: String) = this[k]!!.jsonPrimitive.long
    private fun JsonObject.i(k: String) = this[k]!!.jsonPrimitive.int
    private fun JsonObject.d(k: String) = this[k]!!.jsonPrimitive.double
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun JsonObject.b(k: String) = this[k]!!.jsonPrimitive.boolean
    private fun JsonObject.lista(k: String): JsonArray = this[k]!!.jsonArray

    private fun paraCada(chave: String, bloco: (zona: ZoneId, nome: String, caso: JsonObject) -> Unit) {
        for ((nome, dados) in zonas) {
            val zona = ZoneId.of(nome)
            dados.o().lista(chave).forEach { bloco(zona, nome, it.o()) }
        }
    }

    @Test
    fun `há casos suficientes`() {
        assertTrue(zonas.size >= 7)
        assertTrue(zonas.values.all { it.o().lista("calcular").size > 100 })
    }

    @Test
    fun `calcular dá o mesmo tempo decorrido`() = paraCada("calcular") { zona, nome, c ->
        val t = Logica.calcular(c.l("inicio"), c.l("agora"), zona)
        val msg = "$nome ${c}"
        assertEquals(c.i("dias"), t.dias, msg)
        assertEquals(c.i("horas"), t.horas, msg)
        assertEquals(c.i("minutos"), t.minutos, msg)
        assertEquals(c.d("decorrido"), t.decorrido, 1e-9, msg)
    }

    @Test
    fun `aniversários e dias até eles`() = paraCada("aniversarios") { zona, nome, c ->
        val msg = "$nome $c"
        assertEquals(c.l("ms"), Logica.adicionarAnos(c.l("inicio"), c.i("n"), zona), msg)
        assertEquals(c.i("dias"), Logica.diasAteAniversario(c.l("inicio"), c.i("n"), zona), msg)
    }

    @Test
    fun `anos completos`() = paraCada("anosCompletos") { zona, nome, c ->
        assertEquals(c.i("anos"), Logica.anosCompletos(c.l("inicio"), c.l("agora"), zona), "$nome $c")
    }

    @Test
    fun `marcos e próximo marco`() = paraCada("marcos") { zona, nome, c ->
        val msg = "$nome $c"
        if ("marco" in c) {
            val esperado = c["marco"]!!
            val m = Logica.marcoDoDia(c.l("inicio"), c.i("dias"), zona)
            if (esperado is JsonNull) assertNull(m, msg) else {
                assertEquals(esperado.o().s("tipo"), m?.tipo, msg)
                assertEquals(esperado.o().i("n"), m?.n, msg)
            }
        } else {
            val r = c["resultado"]!!.o()
            val p = Logica.proximoMarco(c.l("inicio"), c.d("proximo"), zona)
            assertEquals(r.i("dia"), p.dia, msg)
            assertEquals(r.s("tipo"), p.tipo, msg)
            assertEquals(r.i("n"), p.n, msg)
            assertEquals(r.d("faltam"), p.faltam, 1e-9, msg)
        }
    }

    @Test
    fun `sequência de check-ins e ciclo do hábito`() = paraCada("ciclos") { zona, nome, c ->
        val lista = c.lista("checkins").map { it.jsonPrimitive.content }
        val hoje = LocalDate.parse(c.s("hoje"))
        val msg = "$nome $c"
        val seq = c["sequencia"]!!.o()
        val s = Logica.sequenciaCheckins(lista, hoje)
        assertEquals(seq.i("dias"), s.dias, msg)
        assertEquals(seq.b("feitoHoje"), s.feitoHoje, msg)
        assertEquals(c.i("maior"), Logica.maiorSequencia(lista), msg)
        val e = c["ciclo"]!!.o()
        val ciclo = Logica.cicloManter(lista, hoje, zona)
        assertEquals(e.i("dias"), ciclo.dias, msg)
        assertEquals(e.b("feitoHoje"), ciclo.feitoHoje, msg)
        assertEquals(e.b("quebrou"), ciclo.quebrou, msg)
        if (e["inicio"] is JsonNull) {
            assertNull(ciclo.inicio, msg); assertNull(ciclo.referencia, msg)
        } else {
            assertEquals(e.l("inicio"), ciclo.inicio, msg)
            assertEquals(e.l("referencia"), ciclo.referencia, msg)
        }
    }

    @Test
    fun `frases de marco são idênticas`() {
        val casos = textos.lista("marcoCasos")
        assertTrue(casos.size >= 100)
        casos.forEach {
            val c = it.o()["ctx"]!!.o()
            val m = c["marco"]!!.o()
            val ctx = Textos.MarcoCtx(c.s("tipoContagem"), c.s("nome"), c.i("dias"), Logica.Marco(m.s("tipo"), m.i("n")), c.s("seed"))
            assertEquals(it.o().s("texto"), Textos.marco(ctx), c.toString())
        }
    }

    @Test
    fun `frases de retomada são idênticas e nunca citam zero dias`() {
        textos.lista("retomadas").forEach {
            val c = it.o()["ctx"]!!.o()
            val t = Textos.retomada(Textos.RetomadaCtx(c.s("tipoContagem"), c.i("recorde"), c.s("seed")))
            assertEquals(it.o().s("texto"), t, c.toString())
        }
    }

    @Test
    fun `hash da semente é igual ao do JavaScript, inclusive com acentos e emoji`() {
        textos.lista("hashes").forEach {
            assertEquals(it.o().l("hash"), Textos.hash(it.o().s("texto")), it.toString())
        }
    }

    @Test
    fun `economia e formatação em reais`() {
        textos.lista("economias").forEach {
            val c = it.o()
            val custo = if (c["custo"] is JsonNull) null else c.d("custo")
            val v = Logica.economia(c.i("dias"), custo)
            if (c["valor"] is JsonNull) assertNull(v, c.toString()) else {
                assertEquals(c.d("valor"), v!!, 1e-9, c.toString())
                assertEquals(c.s("formatado"), Logica.formatarReais(v), c.toString())
            }
        }
    }
}
