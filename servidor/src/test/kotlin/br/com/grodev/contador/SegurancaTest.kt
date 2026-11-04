package br.com.grodev.contador

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class SegurancaTest {
    @Test fun `ids e segredos são aleatórios e têm o tamanho esperado`() {
        val ids = (1..200).map { Seguranca.novoId() }.toSet()
        assertEquals(200, ids.size)
        assertTrue(ids.all { it.length == 22 && Validacao.idValido(it) })
        val s = Seguranca.novoSegredo()
        assertEquals(43, s.length)
        assertNotEquals(s, Seguranca.novoSegredo())
    }

    @Test fun `só o hash é comparável e a conferência funciona`() {
        val s = Seguranca.novoSegredo()
        val h = Seguranca.hash(s)
        assertEquals(32, h.size)
        assertTrue(Seguranca.confere(s, h))
        assertFalse(Seguranca.confere(s + "x", h))
        assertFalse(Seguranca.confere("", h))
    }

    @Test fun `cabeçalho Authorization`() {
        assertEquals("abc", Seguranca.segredoDoCabecalho("Bearer abc"))
        assertNull(Seguranca.segredoDoCabecalho(null))
        assertNull(Seguranca.segredoDoCabecalho("Basic abc"))
        assertNull(Seguranca.segredoDoCabecalho("Bearer "))
        assertNull(Seguranca.segredoDoCabecalho("Bearer " + "x".repeat(300)))
    }

    @Test fun `limitador libera até o máximo por janela e depois renova`() {
        var agora = 0L
        val l = LimitadorTaxa(3, 1000) { agora }
        assertTrue(l.permitir("a")); assertTrue(l.permitir("a")); assertTrue(l.permitir("a"))
        assertFalse(l.permitir("a"))
        assertTrue(l.permitir("b"), "outra chave não é afetada")
        agora = 999; assertFalse(l.permitir("a"))
        agora = 1000; assertTrue(l.permitir("a"), "nova janela")
    }
}
