package expo.modules.momoraaudio

import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * Streaming mono linear-interpolation resampler. State (fractional read position and the last
 * input sample) is kept across [process] calls, so chunk boundaries produce no clicks.
 * Linear interpolation with no low-pass is acceptable for voice; it aliases slightly when
 * decimating from rates above 48 kHz, which voice notes essentially never use.
 */
class LinearResampler(private var inRate: Int, private val outRate: Int) {
  private var prev = 0f
  // Output samples produced and input samples consumed so far. The position of the next output
  // sample is derived from these totals (not accumulated per step), so the result does not
  // depend on how the input is chunked.
  private var outTotal = 0L
  private var consumed = 0L

  fun setInputRate(rate: Int) {
    inRate = rate
  }

  /** Resamples [count] samples of [input] into [out] (16-bit PCM); returns samples produced. */
  fun process(input: FloatArray, count: Int, out: ShortArray): Int {
    if (count <= 0) return 0
    val step = inRate.toDouble() / outRate
    var n = 0
    val limit = (count - 1).toDouble()
    // Next output position in input-sample units relative to this chunk's sample 0;
    // index -1 is the final sample of the previous chunk.
    var t = outTotal * step - consumed
    while (t < limit) {
      val i = floor(t).toInt()
      val frac = (t - i).toFloat()
      val a = if (i < 0) prev else input[i]
      val b = input[i + 1]
      out[n++] = toPcm16(a + (b - a) * frac)
      outTotal++
      t = outTotal * step - consumed
    }
    prev = input[count - 1]
    consumed += count
    return n
  }

  /** Upper bound on output samples for a chunk of [count] input samples. */
  fun maxOutput(count: Int): Int = (count * (outRate.toDouble() / inRate)).toInt() + 3

  private fun toPcm16(x: Float): Short {
    val v = (x * 32767f).roundToInt()
    return when {
      v > 32767 -> 32767
      v < -32768 -> -32768
      else -> v
    }.toShort()
  }
}
