package expo.modules.momorawidget

import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class WidgetRefreshSchedulerTest {
  private val verified = Instant.parse("2026-09-17T06:00:00Z")
  private val expiry = verified.plusSeconds(WIDGET_LEASE_SECONDS)

  private fun entry(startsAt: String, index: Int) = WidgetManifestEntry(
    startsAt = Instant.parse(startsAt),
    memoryId = "memory-$index",
    mediaIndex = null,
    imageFilename = "memory-$index.jpg",
    excerpt = "Synthetic memory",
    dateLabel = "Sep 17, 2026",
    background = "#FFFFFF",
    foreground = "#222222",
    kind = "photo",
  )

  private fun manifest(vararg startsAt: String): WidgetManifestSnapshot = WidgetManifestSnapshot(
    raw = "{}",
    schemaVersion = WIDGET_SCHEMA_VERSION,
    accountId = "account-a",
    familyId = "family-a",
    generationId = "generation-a",
    verifiedAt = verified,
    expiresAt = expiry,
    entries = startsAt.mapIndexed { index, value -> entry(value, index) },
  )

  private val daytimeManifest = manifest(
    "2026-09-17T07:00:00Z", // 08:00 in the family timezone
    "2026-09-17T12:00:00Z", // 13:00
    "2026-09-17T17:00:00Z", // 18:00
    "2026-09-18T07:00:00Z",
  )

  @Test fun schedulesTheNextActualDaytimeBoundaryBeforeEight() {
    assertEquals(
      Instant.parse("2026-09-17T07:00:00Z"),
      WidgetRefreshScheduler.nextRefreshAt(daytimeManifest, Instant.parse("2026-09-17T06:59:59Z")),
    )
  }

  @Test fun schedulesTheNextActualDaytimeBoundaryAtOnePm() {
    assertEquals(
      Instant.parse("2026-09-17T17:00:00Z"),
      WidgetRefreshScheduler.nextRefreshAt(daytimeManifest, Instant.parse("2026-09-17T12:00:00Z")),
    )
  }

  @Test fun schedulesTheNextDayAfterSixPm() {
    assertEquals(
      Instant.parse("2026-09-18T07:00:00Z"),
      WidgetRefreshScheduler.nextRefreshAt(daytimeManifest, Instant.parse("2026-09-17T18:00:01Z")),
    )
    assertEquals(
      Instant.parse("2026-09-18T07:00:00Z"),
      WidgetRefreshScheduler.nextRefreshAt(daytimeManifest, Instant.parse("2026-09-17T19:00:00Z")),
    )
  }

  @Test fun schedulesExpiryAfterTheLastEntryAndStopsAtExpiry() {
    val lastOnly = manifest("2026-09-17T07:00:00Z")
    assertEquals(
      expiry,
      WidgetRefreshScheduler.nextRefreshAt(lastOnly, Instant.parse("2026-09-17T08:00:00Z")),
    )
    assertNull(WidgetRefreshScheduler.nextRefreshAt(daytimeManifest, expiry))
  }
}
