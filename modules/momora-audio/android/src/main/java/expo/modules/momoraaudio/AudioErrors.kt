package expo.modules.momoraaudio

import android.util.Log
import expo.modules.kotlin.exception.CodedException
import kotlinx.coroutines.CancellationException

private const val TAG = "MomoraAudio"

/**
 * Stable, JS-visible error codes (`error.code`). Messages are static strings: they must never
 * contain file names, paths or any other content derived from the user's audio (child PII).
 */
object AudioErrorCodes {
  const val UNSUPPORTED_FORMAT = "unsupported_format"
  const val DECODE_FAILED = "decode_failed"
  const val TOO_LONG = "too_long"
  const val IO_FAILED = "io_failed"
}

class AudioException(code: String, message: String) : CodedException(code, message, null)

fun unsupportedFormat() = AudioException(AudioErrorCodes.UNSUPPORTED_FORMAT, "This kind of sound file is not supported.")
fun decodeFailed() = AudioException(AudioErrorCodes.DECODE_FAILED, "The sound could not be decoded.")
fun tooLong() = AudioException(AudioErrorCodes.TOO_LONG, "The sound is longer than the allowed maximum.")
fun ioFailed() = AudioException(AudioErrorCodes.IO_FAILED, "The sound file could not be read or written.")

/**
 * Runs [block] and maps anything that is not already an [AudioException] to a stable code.
 * Only the exception class name is logged (never the message, which can embed a path).
 */
fun <T> guardAudio(block: () -> T): T {
  try {
    return block()
  } catch (e: AudioException) {
    throw e
  } catch (e: CancellationException) {
    throw e
  } catch (e: java.io.IOException) {
    Log.w(TAG, "io failure: ${e.javaClass.simpleName}")
    throw ioFailed()
  } catch (e: Throwable) {
    Log.w(TAG, "failure: ${e.javaClass.simpleName}")
    throw decodeFailed()
  }
}
