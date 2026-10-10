package expo.modules.momoraaudio

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import java.io.IOException
import java.nio.ByteOrder
import kotlin.math.roundToLong

/**
 * Chunked decoder: MediaExtractor + MediaCodec -> mono Float32 PCM in [-1, 1].
 *
 * Mono downmix is the arithmetic mean of the channels. Chunks are handed to a sink as they are
 * decoded (one codec output buffer at a time), so the whole file is never held in memory.
 * The sample rate reported to the sink is the DECODER OUTPUT rate (it can differ from the
 * container's input format, e.g. HE-AAC), taken from the codec's output MediaFormat.
 */
class PcmDecoder(private val input: AudioInput) {

  /** Receives one mono chunk. Return false to stop decoding early. */
  fun interface Sink {
    fun onChunk(samples: FloatArray, count: Int, sampleRate: Int): Boolean
  }

  /**
   * Decodes from the start (when [startUs] == 0 and [endUs] is null) or only the window
   * [startUs, endUs). In window mode the extractor seeks to the previous sync sample and decoded
   * samples outside the window are dropped by presentation time.
   */
  fun decode(startUs: Long, endUs: Long?, sink: Sink) {
    val windowed = startUs > 0 || endUs != null
    val (extractor, trackFormat) = input.openAudioExtractor()
    var codec: MediaCodec? = null
    var codecStarted = false
    try {
      val mime = trackFormat.getString(MediaFormat.KEY_MIME) ?: throw unsupportedFormat()
      if (startUs > 0) extractor.seekTo(startUs, MediaExtractor.SEEK_TO_PREVIOUS_SYNC)

      codec = try {
        MediaCodec.createDecoderByType(mime)
      } catch (e: IOException) {
        throw unsupportedFormat()
      } catch (e: IllegalArgumentException) {
        throw unsupportedFormat()
      }
      try {
        codec.configure(trackFormat, null, null, 0)
        codec.start()
        codecStarted = true
      } catch (e: Exception) {
        throw unsupportedFormat()
      }

      runLoop(codec, extractor, trackFormat, windowed, startUs, endUs, sink)
    } finally {
      if (codec != null) {
        if (codecStarted) runCatching { codec.stop() }
        runCatching { codec.release() }
      }
      runCatching { extractor.release() }
    }
  }

  private fun runLoop(
    codec: MediaCodec,
    extractor: MediaExtractor,
    trackFormat: MediaFormat,
    windowed: Boolean,
    startUs: Long,
    endUs: Long?,
    sink: Sink
  ) {
    val info = MediaCodec.BufferInfo()
    var inputDone = false
    var outputDone = false
    var outRate = 0
    var outChannels = 0
    var outEncoding = AudioFormat.ENCODING_PCM_16BIT
    var haveFormat = false
    var mono = FloatArray(0)

    // Windowed mode bookkeeping, in samples at the output rate.
    var pos = 0L                 // sample index (stream time) of the next output frame
    var posKnown = false
    var startSample = 0L
    var endSample = Long.MAX_VALUE

    // Stall guard: bail out if the codec makes no progress for a long time.
    var lastProgress = System.nanoTime()

    // Feeding stops a little after endUs so the codec can flush the last window samples.
    val feedLimitUs = endUs?.plus(FEED_MARGIN_US)

    while (!outputDone) {
      var progressed = false

      if (!inputDone) {
        val inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
        if (inIndex >= 0) {
          progressed = true
          val buf = codec.getInputBuffer(inIndex) ?: throw decodeFailed()
          val size = extractor.readSampleData(buf, 0)
          val sampleTime = extractor.sampleTime
          if (size < 0 || (feedLimitUs != null && sampleTime > feedLimitUs)) {
            codec.queueInputBuffer(inIndex, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
            inputDone = true
          } else {
            codec.queueInputBuffer(inIndex, 0, size, sampleTime, 0)
            extractor.advance()
          }
        }
      }

      val outIndex = codec.dequeueOutputBuffer(info, TIMEOUT_US)
      when {
        outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          progressed = true
          val f = codec.outputFormat
          val rate = f.intOrNull(MediaFormat.KEY_SAMPLE_RATE) ?: trackFormat.intOrNull(MediaFormat.KEY_SAMPLE_RATE)
          val ch = f.intOrNull(MediaFormat.KEY_CHANNEL_COUNT) ?: trackFormat.intOrNull(MediaFormat.KEY_CHANNEL_COUNT)
          if (rate == null || rate <= 0 || ch == null || ch <= 0) throw decodeFailed()
          // A rate change after samples were already emitted would corrupt the energy buckets.
          if (haveFormat && rate != outRate && posKnown) throw decodeFailed()
          outRate = rate
          outChannels = ch
          outEncoding = f.intOrNull(MediaFormat.KEY_PCM_ENCODING) ?: AudioFormat.ENCODING_PCM_16BIT
          haveFormat = true
          if (windowed) {
            startSample = (startUs * outRate / 1_000_000.0).roundToLong()
            endSample = endUs?.let { (it * outRate / 1_000_000.0).roundToLong() } ?: Long.MAX_VALUE
          }
        }
        outIndex >= 0 -> {
          progressed = true
          if (!haveFormat) {
            // Defensive: FORMAT_CHANGED normally precedes the first buffer.
            val f = codec.getOutputFormat(outIndex)
            outRate = f.intOrNull(MediaFormat.KEY_SAMPLE_RATE) ?: trackFormat.intOrNull(MediaFormat.KEY_SAMPLE_RATE) ?: throw decodeFailed()
            outChannels = f.intOrNull(MediaFormat.KEY_CHANNEL_COUNT) ?: trackFormat.intOrNull(MediaFormat.KEY_CHANNEL_COUNT) ?: throw decodeFailed()
            outEncoding = f.intOrNull(MediaFormat.KEY_PCM_ENCODING) ?: AudioFormat.ENCODING_PCM_16BIT
            haveFormat = true
            if (windowed) {
              startSample = (startUs * outRate / 1_000_000.0).roundToLong()
              endSample = endUs?.let { (it * outRate / 1_000_000.0).roundToLong() } ?: Long.MAX_VALUE
            }
          }
          var keepGoing = true
          if (info.size > 0 && (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) == 0) {
            val out = codec.getOutputBuffer(outIndex) ?: throw decodeFailed()
            out.position(info.offset)
            out.limit(info.offset + info.size)
            val bytes = out.slice().order(ByteOrder.nativeOrder())
            val bytesPerSample = if (outEncoding == AudioFormat.ENCODING_PCM_FLOAT) 4 else 2
            if (outEncoding != AudioFormat.ENCODING_PCM_FLOAT && outEncoding != AudioFormat.ENCODING_PCM_16BIT) {
              throw decodeFailed()
            }
            val frames = info.size / (bytesPerSample * outChannels)
            if (frames > 0) {
              if (mono.size < frames) mono = FloatArray(frames)
              if (outEncoding == AudioFormat.ENCODING_PCM_FLOAT) {
                val fb = bytes.asFloatBuffer()
                for (i in 0 until frames) {
                  var sum = 0f
                  for (c in 0 until outChannels) sum += fb.get()
                  mono[i] = sum / outChannels
                }
              } else {
                val sb = bytes.asShortBuffer()
                for (i in 0 until frames) {
                  var sum = 0f
                  for (c in 0 until outChannels) sum += sb.get() / 32768f
                  mono[i] = sum / outChannels
                }
              }

              if (!windowed) {
                posKnown = true
                keepGoing = sink.onChunk(mono, frames, outRate)
              } else {
                if (!posKnown) {
                  // First buffer after the seek: anchor stream time to its presentation time.
                  pos = (info.presentationTimeUs * outRate / 1_000_000.0).roundToLong()
                  posKnown = true
                }
                val bufStart = pos
                val bufEnd = pos + frames
                pos = bufEnd
                val from = maxOf(bufStart, startSample)
                val to = minOf(bufEnd, endSample)
                if (to > from) {
                  val offset = (from - bufStart).toInt()
                  val count = (to - from).toInt()
                  if (offset > 0) System.arraycopy(mono, offset, mono, 0, count)
                  keepGoing = sink.onChunk(mono, count, outRate)
                }
                if (bufEnd >= endSample) keepGoing = false
              }
            }
          }
          val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
          codec.releaseOutputBuffer(outIndex, false)
          if (eos) outputDone = true
          if (!keepGoing) return
        }
        // INFO_TRY_AGAIN_LATER and the deprecated INFO_OUTPUT_BUFFERS_CHANGED: nothing to do.
      }

      val now = System.nanoTime()
      if (progressed) lastProgress = now
      else if (now - lastProgress > STALL_TIMEOUT_NS) throw decodeFailed()
    }
  }

  private companion object {
    const val TIMEOUT_US = 10_000L
    const val FEED_MARGIN_US = 250_000L
    const val STALL_TIMEOUT_NS = 15_000_000_000L
  }
}
