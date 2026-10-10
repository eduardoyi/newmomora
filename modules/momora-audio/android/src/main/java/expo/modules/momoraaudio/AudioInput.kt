package expo.modules.momoraaudio

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/** Longest clip the module will analyze or render. */
const val MAX_DURATION_MS = 30L * 60L * 1000L

/** Parses a `file://`, `content://` or bare-path string into a [Uri]. */
fun parseUri(raw: String): Uri {
  val uri = Uri.parse(raw)
  return if (uri.scheme.isNullOrEmpty()) Uri.fromFile(File(raw)) else uri
}

/** Local filesystem path for a `file://` URI or bare path (used for the render output). */
fun localPath(raw: String): String {
  val uri = parseUri(raw)
  if (uri.scheme != "file") throw ioFailed()
  return uri.path ?: throw ioFailed()
}

/**
 * An opened audio source. Holds a [ParcelFileDescriptor] so `file://` and `content://` URIs are
 * handled identically. The descriptor must stay open while any extractor made from it is in use.
 */
class AudioInput private constructor(
  private val pfd: ParcelFileDescriptor,
  val sizeBytes: Long
) : AutoCloseable {

  /**
   * A fresh extractor positioned at the first audio track (already selected), or
   * `unsupported_format` when the container cannot be opened or has no audio track.
   */
  fun openAudioExtractor(): Pair<MediaExtractor, MediaFormat> {
    val extractor = MediaExtractor()
    try {
      try {
        extractor.setDataSource(pfd.fileDescriptor)
      } catch (e: Exception) {
        // NOTE: the plan requires verifying Ogg Opus extraction on API 24-28. If the platform's
        // MediaExtractor cannot open Ogg/Opus there it throws here and the clip surfaces as
        // `unsupported_format` (the intended fallback), so no special path is needed.
        throw unsupportedFormat()
      }
      for (i in 0 until extractor.trackCount) {
        val format = extractor.getTrackFormat(i)
        val mime = format.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) {
          extractor.selectTrack(i)
          return Pair(extractor, format)
        }
      }
      throw unsupportedFormat()
    } catch (e: Throwable) {
      runCatching { extractor.release() }
      throw e
    }
  }

  /** The underlying descriptor, for APIs that need one (e.g. MediaMetadataRetriever). */
  fun fileDescriptor(): java.io.FileDescriptor = pfd.fileDescriptor

  override fun close() {
    runCatching { pfd.close() }
  }

  companion object {
    fun open(context: Context, raw: String): AudioInput {
      val uri = parseUri(raw)
      val resolver = context.contentResolver
      val pfd = try {
        resolver.openFileDescriptor(uri, "r")
      } catch (e: FileNotFoundException) {
        null
      } catch (e: SecurityException) {
        null
      } ?: throw ioFailed()
      return AudioInput(pfd, sizeOf(context, uri, pfd))
    }

    private fun sizeOf(context: Context, uri: Uri, pfd: ParcelFileDescriptor): Long {
      val fdSize = pfd.statSize
      if (fdSize >= 0) return fdSize
      return runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { c ->
          if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else null
        }
      }.getOrNull() ?: 0L
    }
  }
}

/** Reads an optional integer track-format key. */
fun MediaFormat.intOrNull(key: String): Int? =
  if (containsKey(key)) runCatching { getInteger(key) }.getOrNull() else null

/** Reads an optional long track-format key. */
fun MediaFormat.longOrNull(key: String): Long? =
  if (containsKey(key)) runCatching { getLong(key) }.getOrNull() else null
