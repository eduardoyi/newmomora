package expo.modules.momorawidget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.time.Duration
import java.time.Instant
import java.util.concurrent.TimeUnit

internal object WidgetRefreshScheduler {
  private const val UNIQUE_WORK_NAME = "momora-widget-refresh"
  private const val MIN_DELAY_MILLIS = 10_000L

  /**
   * Return the next real timeline boundary, followed by the fixed lease
   * expiry. Entries are already UTC instants from the app's validated family
   * timezone, so Android must not rebuild 08:00/13:00/18:00 from its device
   * timezone or use a periodic WorkManager interval.
   */
  internal fun nextRefreshAt(manifest: WidgetManifestSnapshot, now: Instant): Instant? {
    if (!manifest.expiresAt.isAfter(now)) return null
    return manifest.entries.firstOrNull { it.startsAt.isAfter(now) }?.startsAt
      ?: manifest.expiresAt
  }

  fun schedule(context: Context) {
    val appContext = context.applicationContext
    val raw = WidgetStore(appContext).readManifest()
    if (raw == null) {
      cancel(appContext)
      return
    }
    val manifest = try {
      WidgetManifestParser.parse(raw)
    } catch (_: Exception) {
      cancel(appContext)
      return
    }
    val now = Instant.now()
    val next = nextRefreshAt(manifest, now)
    if (next == null) {
      cancel(appContext)
      return
    }
    val delay = Duration.between(now, next).toMillis().coerceAtLeast(MIN_DELAY_MILLIS)
    val work = OneTimeWorkRequestBuilder<WidgetRefreshWorker>()
      .setInitialDelay(delay, TimeUnit.MILLISECONDS)
      .build()
    WorkManager.getInstance(appContext).enqueueUniqueWork(
      UNIQUE_WORK_NAME,
      ExistingWorkPolicy.REPLACE,
      work,
    )
  }

  fun cancel(context: Context) {
    WorkManager.getInstance(context.applicationContext).cancelUniqueWork(UNIQUE_WORK_NAME)
  }
}

internal class WidgetRefreshWorker(
  context: Context,
  params: WorkerParameters,
) : CoroutineWorker(context, params) {
  override suspend fun doWork(): Result {
    MomoraWidgetReceiver.refreshNow(applicationContext)
    return Result.success()
  }
}
