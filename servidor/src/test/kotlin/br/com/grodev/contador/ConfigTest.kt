package br.com.grodev.contador

import java.io.File
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

class ConfigTest {
    private val semArquivo = File(createTempDirectory("config-teste").toFile(), "nao-existe.env")

    @Test fun `sem ADMIN o cadastro é aberto e não há convites`() {
        assertNull(Config.deAmbiente(emptyMap(), semArquivo).admin)
        assertNull(Config.deAmbiente(mapOf("ADMIN" to "   "), semArquivo).admin)
    }

    @Test fun `ADMIN válido é lido do ambiente`() {
        assertEquals("a".repeat(16), Config.deAmbiente(mapOf("ADMIN" to "a".repeat(16)), semArquivo).admin)
    }

    @Test fun `chave de administrador curta demais é recusado na configuração`() {
        val e = assertFailsWith<IllegalStateException> { Config.deAmbiente(mapOf("ADMIN" to "curto"), semArquivo) }
        assertEquals(true, "ADMIN" in e.message!! && "16" in e.message!!)
    }

    @Test fun `ADMIN também vem do arquivo env`() {
        val env = File(semArquivo.parentFile, ".env").apply { writeText("ADMIN=\"${"z".repeat(20)}\"\n") }
        assertEquals("z".repeat(20), Config.deAmbiente(emptyMap(), env).admin)
    }
}
