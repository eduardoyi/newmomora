package expo.modules.momoraartworkscanner

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.activity.result.IntentSenderRequest
import androidx.activity.result.contract.ActivityResultContracts
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.io.File
import java.io.Serializable
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val MAX_PAGE_LIMIT = 10

// region Records / exceptions

class ScanOptions : Record {
  @Field
  val pageLimit: Int = MAX_PAGE_LIMIT
}

class ScanPageRecord : Record {
  @Field
  var uri: String = ""

  @Field
  var width: Int = 0

  @Field
  var height: Int = 0
}

class ScanResultRecord : Record {
  @Field
  var status: String = "cancel"

  @Field
  var pages: List<ScanPageRecord> = emptyList()
}

internal class ScannerUnavailableException(cause: Throwable? = null) :
  CodedException("scanner_unavailable", "The document scanner is not available on this device", cause)

internal class ScannerFailedException(message: String = "The document scanner failed", cause: Throwable? = null) :
  CodedException("scanner_failed", message, cause)

internal class ScannerBusyException :
  CodedException("scanner_busy", "A scan is already in progress", null)

// endregion

// region Activity-result contract

/**
 * expo-modules-core requires a [Serializable] contract input, but the real
 * launch payload (the ML Kit [IntentSender]) is not serializable. The module
 * fetches the sender first and stashes it; this token only identifies the call.
 */
internal data class ScanToken(val id: Long) : Serializable

internal sealed interface ScanOutcome {
  data class Success(val uris: List<String>) : ScanOutcome
  data object Cancelled : ScanOutcome
  data object Failed : ScanOutcome
}

internal class ScanContract(
  private val module: MomoraArtworkScannerModule
) : AppContextActivityResultContract<ScanToken, ScanOutcome> {
  override fun createIntent(context: Context, input: ScanToken): Intent {
    val sender = module.takePendingSender()
      ?: throw ScannerFailedException("The scanner was not prepared")
    return ActivityResultContracts.StartIntentSenderForResult()
      .createIntent(context, IntentSenderRequest.Builder(sender).build())
  }

  override fun parseResult(input: ScanToken, resultCode: Int, intent: Intent?): ScanOutcome {
    if (resultCode != Activity.RESULT_OK) {
      return ScanOutcome.Cancelled
    }
    val result = GmsDocumentScanningResult.fromActivityResultIntent(intent)
    val uris = result?.pages?.map { it.imageUri.toString() }.orEmpty()
    return if (uris.isEmpty()) ScanOutcome.Failed else ScanOutcome.Success(uris)
  }
}

// endregion

class MomoraArtworkScannerModule : Module() {
  private val scanInFlight = AtomicBoolean(false)

  @Volatile
  private var pendingSender: IntentSender? = null

  private lateinit var scanLauncher: AppContextActivityResultLauncher<ScanToken, ScanOutcome>

  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw ScannerFailedException("Application context is unavailable")

  internal fun takePendingSender(): IntentSender? {
    val sender = pendingSender
    pendingSender = null
    return sender
  }

  override fun definition() = ModuleDefinition {
    Name("MomoraArtworkScanner")

    // Play services / the ML Kit module can only be probed by starting a
    // scan, so availability is reported on `scan` (scanner_unavailable).
    Function("isAvailable") {
      true
    }

    AsyncFunction("scan") Coroutine { options: ScanOptions ->
      if (!scanInFlight.compareAndSet(false, true)) {
        throw ScannerBusyException()
      }

      try {
        val activity = appContext.currentActivity
          ?: throw ScannerFailedException("No foreground activity")
        val pageLimit = options.pageLimit.coerceIn(1, MAX_PAGE_LIMIT)

        pendingSender = fetchStartScanIntent(activity, pageLimit)

        val outcome = withContext(Dispatchers.Main) {
          scanLauncher.launch(ScanToken(System.nanoTime()))
        }

        when (outcome) {
          is ScanOutcome.Cancelled -> ScanResultRecord()
          is ScanOutcome.Failed -> throw ScannerFailedException("The scanner returned no pages")
          is ScanOutcome.Success -> withContext(Dispatchers.IO) { buildResult(outcome.uris) }
        }
      } catch (error: CancellationException) {
        throw error
      } catch (error: CodedException) {
        throw error
      } catch (error: Exception) {
        throw ScannerFailedException(cause = error)
      } finally {
        pendingSender = null
        scanInFlight.set(false)
      }
    }

    RegisterActivityContracts {
      // The fallback is intentionally a no-op: if Android destroys the host
      // activity mid-scan the promise is dropped and the JS re-entry guard
      // recovers (docs/plans/artwork-scanning.md, 3.1 / 3.3).
      scanLauncher = registerForActivityResult(
        ScanContract(this@MomoraArtworkScannerModule)
      ) { _, _ -> }
    }
  }

  /**
   * Fetches the ML Kit scan [IntentSender]. A failure here means the scanner
   * cannot start at all (Play services missing/outdated, ML Kit module not
   * downloadable, offline on first use), so it maps to `scanner_unavailable`.
   * That can be transient -- callers must not cache it as permanent.
   */
  private suspend fun fetchStartScanIntent(activity: Activity, pageLimit: Int): IntentSender =
    suspendCancellableCoroutine { continuation ->
      val options = GmsDocumentScannerOptions.Builder()
        .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_BASE)
        .setGalleryImportAllowed(false)
        .setPageLimit(pageLimit)
        .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
        .build()

      GmsDocumentScanning.getClient(options)
        .getStartScanIntent(activity)
        .addOnSuccessListener { sender ->
          if (continuation.isActive) continuation.resume(sender)
        }
        .addOnFailureListener { error ->
          if (continuation.isActive) {
            continuation.resumeWithException(ScannerUnavailableException(error))
          }
        }
    }

  private fun buildResult(uris: List<String>): ScanResultRecord {
    val pages = uris.map { rawUri -> readPage(Uri.parse(rawUri)) }
    return ScanResultRecord().apply {
      status = "success"
      this.pages = pages
    }
  }

  /** Returns a `file://` page record, copying out of a content:// Uri if needed. */
  private fun readPage(uri: Uri): ScanPageRecord {
    val fileUri = if (uri.scheme == "file") {
      // Normalize to file:///... regardless of how the scanner spelled it.
      Uri.fromFile(File(uri.path ?: throw ScannerFailedException("Invalid scanned page path")))
    } else {
      val outputDirectory = File(context.cacheDir, "momora-artwork-scanner").apply { mkdirs() }
      val outputFile = File(outputDirectory, "${UUID.randomUUID()}.jpg")
      val input = context.contentResolver.openInputStream(uri)
        ?: throw ScannerFailedException("Could not read the scanned page")
      input.use { source -> outputFile.outputStream().use { sink -> source.copyTo(sink) } }
      Uri.fromFile(outputFile)
    }

    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    val path = fileUri.path ?: throw ScannerFailedException("Invalid scanned page path")
    BitmapFactory.decodeFile(path, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      throw ScannerFailedException("Could not read the scanned page size")
    }

    return ScanPageRecord().apply {
      this.uri = fileUri.toString()
      width = bounds.outWidth
      height = bounds.outHeight
    }
  }
}
