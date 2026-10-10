package expo.modules.momoraaudio

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import java.io.File
import java.nio.ByteOrder

/**
 * Mono 16-bit PCM -> AAC-LC (MediaCodec) -> MPEG-4 `.m4a` (MediaMuxer). Fed chunk by chunk.
 * Call [finish] on success, then always [release]. [release] without [finish] deletes the partial
 * output file.
 */
class AacM4aWriter(private val path: String, private val sampleRate: Int, bitrate: Int) {
  private val codec: MediaCodec
  private val muxer: MediaMuxer
  private val info = MediaCodec.BufferInfo()
  private var trackIndex = -1
  private var muxerStarted = false
  private var finished = false
  private var released = false
  private var framesQueued = 0L
  private var samplesWrittenToMuxer = 0
  private var lastProgress = System.nanoTime()

  init {
    val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, 1).apply {
      setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
      setInteger(MediaFormat.KEY_BIT_RATE, bitrate)
      setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16 * 1024)
    }
    val file = File(path)
    file.parentFile?.mkdirs()
    if (file.exists()) file.delete()
    val c = try {
      MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
    } catch (e: Exception) {
      throw decodeFailed()
    }
    try {
      c.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      c.start()
    } catch (e: Exception) {
      runCatching { c.release() }
      throw decodeFailed()
    }
    val m = try {
      MediaMuxer(path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
    } catch (e: Exception) {
      runCatching { c.stop() }
      runCatching { c.release() }
      runCatching { file.delete() }
      throw ioFailed()
    }
    codec = c
    muxer = m
  }

  val samplesWritten: Long get() = framesQueued

  /** Queues [count] PCM samples (sample rate = the constructor's). */
  fun write(pcm: ShortArray, count: Int) {
    var offset = 0
    while (offset < count) {
      drain(endOfStream = false)
      val index = codec.dequeueInputBuffer(TIMEOUT_US)
      if (index < 0) {
        checkStall()
        continue
      }
      val buf = codec.getInputBuffer(index) ?: throw decodeFailed()
      buf.clear()
      val n = minOf(count - offset, buf.capacity() / 2)
      buf.order(ByteOrder.nativeOrder()).asShortBuffer().put(pcm, offset, n)
      codec.queueInputBuffer(index, 0, n * 2, ptsUs(framesQueued), 0)
      framesQueued += n
      offset += n
      lastProgress = System.nanoTime()
    }
  }

  /** Signals end of stream, drains the encoder and finalizes the MP4. */
  fun finish() {
    if (framesQueued == 0L) throw decodeFailed()
    while (true) {
      val index = codec.dequeueInputBuffer(TIMEOUT_US)
      if (index >= 0) {
        codec.queueInputBuffer(index, 0, 0, ptsUs(framesQueued), MediaCodec.BUFFER_FLAG_END_OF_STREAM)
        break
      }
      drain(endOfStream = false)
      checkStall()
    }
    drain(endOfStream = true)
    if (!muxerStarted || samplesWrittenToMuxer == 0) throw decodeFailed()
    muxer.stop()
    muxerStarted = false
    finished = true
  }

  fun release() {
    if (released) return
    released = true
    runCatching { codec.stop() }
    runCatching { codec.release() }
    if (muxerStarted) runCatching { muxer.stop() }
    runCatching { muxer.release() }
    if (!finished) runCatching { File(path).delete() }
  }

  private fun ptsUs(frames: Long): Long = frames * 1_000_000L / sampleRate

  private fun checkStall() {
    if (System.nanoTime() - lastProgress > STALL_TIMEOUT_NS) throw decodeFailed()
  }

  private fun drain(endOfStream: Boolean) {
    while (true) {
      val index = codec.dequeueOutputBuffer(info, if (endOfStream) TIMEOUT_US else 0L)
      when {
        index == MediaCodec.INFO_TRY_AGAIN_LATER -> {
          if (!endOfStream) return
          checkStall()
        }
        index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
          if (muxerStarted) throw decodeFailed()
          trackIndex = muxer.addTrack(codec.outputFormat)
          muxer.start()
          muxerStarted = true
          lastProgress = System.nanoTime()
        }
        index >= 0 -> {
          lastProgress = System.nanoTime()
          val out = codec.getOutputBuffer(index) ?: throw decodeFailed()
          val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
          if (!isConfig && info.size > 0) {
            if (!muxerStarted) throw decodeFailed()
            out.position(info.offset)
            out.limit(info.offset + info.size)
            muxer.writeSampleData(trackIndex, out, info)
            samplesWrittenToMuxer++
          }
          val eos = (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0
          codec.releaseOutputBuffer(index, false)
          if (eos) return
        }
        // Deprecated INFO_OUTPUT_BUFFERS_CHANGED: ignored.
      }
    }
  }

  private companion object {
    const val TIMEOUT_US = 10_000L
    const val STALL_TIMEOUT_NS = 15_000_000_000L
  }
}
