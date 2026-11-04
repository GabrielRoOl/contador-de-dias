package br.com.grodev.contador

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class ConfigTest {
    private val semArquivo = File(createTempDirectory("config-teste").toFile(), "nao-existe.env")

    @Test fun `sem CONVITE o cadastro é aberto`() {
        assertNull(Config.deAmbiente(emptyMap(), semArquivo).convite)
        assertNull(Config.deAmbiente(mapOf("CONVITE" to "   "), semArquivo).convite)
    }

    @Test fun `CONVITE válido é lido do ambiente`() {
        assertEquals("a".repeat(16), Config.deAmbiente(mapOf("CONVITE" to "a".repeat(16)), semArquivo).convite)
    }

    @Test fun `convite curto demais é recusado na configuração`() {
        val e = assertFailsWith<IllegalStateException> { Config.deAmbiente(mapOf("CONVITE" to "curto"), semArquivo) }
        assertEquals(true, "CONVITE" in e.message!! && "16" in e.message!!)
    }

    @Test fun `CONVITE também vem do arquivo env`() {
        val env = File(semArquivo.parentFile, ".env").apply { writeText("CONVITE=\"${"z".repeat(20)}\"\n") }
        assertEquals("z".repeat(20), Config.deAmbiente(emptyMap(), env).convite)
    }
}
