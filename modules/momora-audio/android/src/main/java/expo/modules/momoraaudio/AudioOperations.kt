package expo.modules.momoraaudio

import android.content.Context
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Locale
import java.util.TimeZone
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToLong

const val RENDER_SAMPLE_RATE = 48_000

object AudioOperations {

  // ---------------------------------------------------------------- probe

  fun probe(context: Context, rawUri: String): Map<String, Any?> = guardAudio {
    AudioInput.open(context, rawUri).use { input ->
      val (extractor, format) = input.openAudioExtractor()
      try {
        val mime = format.getString(MediaFormat.KEY_MIME) ?: ""
        val codec = codecOf(mime)

        var containerMime: String? = null
        var date: String? = null
        var retrieverDurationMs: Long? = null
        val retriever = MediaMetadataRetriever()
        try {
          retriever.setDataSource(input.fileDescriptor())
          containerMime = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_MIMETYPE)
          date = parseCreationDate(retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE))
          retrieverDurationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        } catch (e: Exception) {
          // Metadata is best effort; the extractor already proved the file is readable.
        } finally {
          runCatching { retriever.release() }
        }

        val durationUs = format.longOrNull(MediaFormat.KEY_DURATION)
        val durationMs = when {
          durationUs != null && durationUs > 0 -> (durationUs / 1000.0).roundToLong()
          retrieverDurationMs != null && retrieverDurationMs > 0 -> retrieverDurationMs
          else -> 0L
        }

        mapOf(
          "durationMs" to durationMs,
          "container" to containerOf(containerMime, codec),
          "codec" to codec,
          "sampleRate" to (format.intOrNull(MediaFormat.KEY_SAMPLE_RATE) ?: 0),
          "channels" to (format.intOrNull(MediaFormat.KEY_CHANNEL_COUNT) ?: 0),
          "creationDate" to date,
          "sizeBytes" to input.sizeBytes
        )
      } finally {
        runCatching { extractor.release() }
      }
    }
  }

  private fun codecOf(mime: String): String = when (mime.lowercase(Locale.ROOT)) {
    "audio/mp4a-latm" -> "aac"
    "audio/opus" -> "opus"
    "audio/raw" -> "pcm"
    "audio/mpeg" -> "mp3"
    "audio/3gpp", "audio/amr-wb" -> "amr"
    else -> "other"
  }

  private fun containerOf(containerMime: String?, codec: String): String {
    val m = containerMime?.lowercase(Locale.ROOT) ?: return "other"
    return when {
      m.contains("amr") -> "amr"
      m.contains("3gpp") -> if (codec == "amr") "amr" else "mp4"
      m.contains("mp4") || m.contains("m4a") -> "mp4"
      m.contains("ogg") -> "ogg"
      m.contains("wav") -> "wav"
      m.contains("aiff") -> "aiff"
      m.contains("caf") -> "caf"
      m == "audio/mpeg" || m.contains("mp3") -> "mp3"
      else -> "other"
    }
  }

  /** METADATA_KEY_DATE is `yyyyMMdd'T'HHmmss.SSS'Z'` for MP4; be liberal about a few variants. */
  private fun parseCreationDate(raw: String?): String? {
    if (raw.isNullOrBlank()) return null
    val patterns = listOf(
      "yyyyMMdd'T'HHmmss.SSS'Z'",
      "yyyyMMdd'T'HHmmss'Z'",
      "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
      "yyyy-MM-dd'T'HH:mm:ss'Z'",
      "yyyy-MM-dd HH:mm:ss"
    )
    val utc = TimeZone.getTimeZone("UTC")
    for (p in patterns) {
      val parsed = runCatching {
        SimpleDateFormat(p, Locale.US).apply {
          timeZone = utc
          isLenient = false
        }.parse(raw.trim())
      }.getOrNull() ?: continue
      val year = Calendar.getInstance(utc).apply { time = parsed }.get(Calendar.YEAR)
      if (year < 1990) return null // zero/epoch placeholder dates
      return SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = utc }.format(parsed)
    }
    return null
  }

  // -------------------------------------------------------------- analyze

  fun analyze(context: Context, rawUri: String, maxBuckets: Int, minBucketMs: Int): Map<String, Any?> = guardAudio {
    if (maxBuckets <= 0 || minBucketMs <= 0) throw decodeFailed()
    AudioInput.open(context, rawUri).use { input ->
      val estimateMs = estimateDurationMs(input)
      if (estimateMs != null && estimateMs > MAX_DURATION_MS) throw tooLong()

      // No usable duration metadata: count decoded samples first so bucketMs can still follow the spec.
      val effectiveEstimateMs = estimateMs ?: run {
        var n = 0L
        var rate = 0
        PcmDecoder(input).decode(0L, null) { _, count, sampleRate ->
          n += count
          rate = sampleRate
          n * 1000L / sampleRate <= MAX_DURATION_MS + 1000L
        }
        if (n == 0L || rate <= 0) throw decodeFailed()
        val ms = (n * 1000.0 / rate).roundToLong()
        if (ms > MAX_DURATION_MS) throw tooLong()
        ms
      }

      val bucketMs = max(minBucketMs.toLong(), ceil(effectiveEstimateMs.toDouble() / maxBuckets).toLong())
      var spb = 0L
      var rate = 0
      var total = 0L
      var bucketSum = 0.0
      var bucketCount = 0L
      val energies = ArrayList<Double>()
      var tooLongSeen = false

      PcmDecoder(input).decode(0L, null) { samples, count, sampleRate ->
        if (spb == 0L) {
          rate = sampleRate
          spb = max(1L, (bucketMs * sampleRate / 1000.0).roundToLong())
        } else if (sampleRate != rate) {
          throw decodeFailed()
        }
        for (i in 0 until count) {
          val x = samples[i].toDouble()
          bucketSum += x * x
          bucketCount++
          if (bucketCount == spb) {
            energies.add(bucketSum / bucketCount)
            bucketSum = 0.0
            bucketCount = 0
          }
        }
        total += count
        if (total * 1000L / rate > MAX_DURATION_MS + 1000L) {
          tooLongSeen = true
          false
        } else {
          true
        }
      }
      if (tooLongSeen) throw tooLong()
      if (total == 0L || rate <= 0) throw decodeFailed()
      if (bucketCount > 0) energies.add(bucketSum / bucketCount) // last, partial bucket

      mapOf(
        "durationMs" to (total * 1000.0 / rate).roundToLong(),
        "bucketMs" to bucketMs,
        "energies" to energies.toDoubleArray()
      )
    }
  }

  /** Container-reported duration in whole ms, or null when unknown. */
  private fun estimateDurationMs(input: AudioInput): Long? {
    val (extractor, format) = input.openAudioExtractor()
    try {
      val us = format.longOrNull(MediaFormat.KEY_DURATION)
      if (us != null && us > 0) return (us / 1000.0).roundToLong()
    } finally {
      runCatching { extractor.release() }
    }
    val retriever = MediaMetadataRetriever()
    try {
      retriever.setDataSource(input.fileDescriptor())
      val ms = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
      if (ms != null && ms > 0) return ms
    } catch (e: Exception) {
      // fall through
    } finally {
      runCatching { retriever.release() }
    }
    return null
  }

  // --------------------------------------------------------------- render

  fun render(
    context: Context,
    rawUri: String,
    startMs: Long,
    endMs: Long,
    outputUri: String,
    bitrate: Int
  ): Map<String, Any?> = guardAudio {
    if (startMs < 0 || endMs <= startMs || bitrate <= 0) throw decodeFailed()
    if (endMs - startMs > MAX_DURATION_MS) throw tooLong()
    val outPath = localPath(outputUri)

    AudioInput.open(context, rawUri).use { input ->
      val estimateMs = estimateDurationMs(input)
      if (estimateMs != null && estimateMs > MAX_DURATION_MS) throw tooLong()

      var writer: AacM4aWriter? = null
      var succeeded = false
      try {
        val w = AacM4aWriter(outPath, RENDER_SAMPLE_RATE, bitrate)
        writer = w
        var resampler: LinearResampler? = null
        var shorts = ShortArray(0)

        PcmDecoder(input).decode(startMs * 1000L, endMs * 1000L) { samples, count, sampleRate ->
          val r = resampler ?: LinearResampler(sampleRate, RENDER_SAMPLE_RATE).also { resampler = it }
          r.setInputRate(sampleRate)
          val needed = r.maxOutput(count)
          if (shorts.size < needed) shorts = ShortArray(needed)
          val produced = r.process(samples, count, shorts)
          if (produced > 0) w.write(shorts, produced)
          true
        }

        w.finish()
        val written = w.samplesWritten
        w.release()
        writer = null
        succeeded = true

        mapOf(
          "uri" to outputUri,
          "durationMs" to (written * 1000.0 / RENDER_SAMPLE_RATE).roundToLong(),
          "sizeBytes" to File(outPath).length()
        )
      } finally {
        // Releasing a writer that did not finish deletes the partial output.
        writer?.release()
        if (!succeeded) runCatching { File(outPath).delete() }
      }
    }
  }
}
