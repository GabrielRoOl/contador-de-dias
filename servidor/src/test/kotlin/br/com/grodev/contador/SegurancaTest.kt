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

    @Test fun `chave de rede, IPv4 igual, IPv6 vira o bloco 64, IPv4 embutido volta a IPv4`() {
        assertEquals("200.1.2.3", Rede.chave("200.1.2.3"))
        assertEquals("200.1.2.3", Rede.chave("::ffff:200.1.2.3"))
        val a = Rede.chave("2804:14d:1:2:aaaa:bbbb:cccc:dddd")
        assertEquals(a, Rede.chave("2804:14d:1:2::1"), "mesmo /64 = mesmo cliente")
        assertEquals(a, Rede.chave("2804:14D:1:2:ffff:ffff:ffff:ffff"))
        assertNotEquals(a, Rede.chave("2804:14d:1:3::1"), "outro /64 = outro cliente")
        assertNotEquals(Rede.chave("2804:14d:1:2::1"), Rede.chave("200.1.2.3"))
    }

    @Test fun `chave de rede recusa o que não é endereço IP`() {
        listOf("", "lixo", "../x", "<script>", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.4 ", "a:b", ":::", "example.com:80", "x".repeat(500), "2804::1::2", "[::1]", "g::1").forEach {
            if (it == "1.2.3.4 ") assertEquals("1.2.3.4", Rede.chave(it)) else assertNull(Rede.chave(it), "'$it'")
        }
    }

    @Test fun `convite confere em tempo constante e recusa o que não é igual`() {
        val c = Seguranca.novoConvite()
        assertTrue(c.length >= Config.TAMANHO_MINIMO_CONVITE && Validacao.idValido(c.take(10)))
        assertNotEquals(c, Seguranca.novoConvite())
        assertTrue(Seguranca.conviteConfere(c, c))
        listOf(null, "", c + "x", c.dropLast(1), c.uppercase(), " $c", "x".repeat(500)).forEach { assertFalse(Seguranca.conviteConfere(it, c), "'$it'") }
    }
}
