package expo.modules.momoraaudio

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.PI
import kotlin.math.sin

class LinearResamplerTest {
  private fun tone(n: Int, rate: Int): FloatArray =
    FloatArray(n) { (0.5 * sin(2 * PI * 440.0 * it / rate)).toFloat() }

  private fun run(input: FloatArray, inRate: Int, chunk: Int): ShortArray {
    val r = LinearResampler(inRate, 48_000)
    val out = ArrayList<Short>()
    var off = 0
    while (off < input.size) {
      val n = minOf(chunk, input.size - off)
      val slice = input.copyOfRange(off, off + n)
      val buf = ShortArray(r.maxOutput(n))
      val produced = r.process(slice, n, buf)
      for (i in 0 until produced) out.add(buf[i])
      off += n
    }
    return out.toShortArray()
  }

  @Test
  fun chunkingDoesNotChangeOutput() {
    for (inRate in intArrayOf(16_000, 44_100, 48_000)) {
      val input = tone(inRate, inRate) // 1 s
      val whole = run(input, inRate, input.size)
      for (chunk in intArrayOf(1, 7, 1000, 4096)) {
        assertArrayEquals("rate=$inRate chunk=$chunk", whole, run(input, inRate, chunk))
      }
    }
  }

  @Test
  fun outputLengthMatchesRatio() {
    val out = run(tone(44_100, 44_100), 44_100, 1024)
    assertEquals(48_000.0, out.size.toDouble(), 3.0)
  }
}
