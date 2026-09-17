package expo.modules.momorawidget

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WidgetManifestParserTest {
  private val verified = Instant.parse("2026-09-15T12:00:00Z")

  private fun fixture(
    entryCount: Int = 7,
    uniqueMemoryIds: Int = 1,
    uniqueImages: Int = 0,
  ): JSONObject {
    val entries = JSONArray()
    for (index in 0 until entryCount) {
      entries.put(JSONObject().apply {
        put("startsAt", verified.plusSeconds(index * 6 * 60 * 60L).toString())
        put("memoryId", "memory-${index % uniqueMemoryIds}")
        put("sourceUpdatedAt", verified.toString())
        put("memoryDate", "2026-09-15")
        put("dateLabel", "September 15")
        put("excerpt", "Synthetic test memory")
        put("kind", "text")
        if (uniqueImages > 0) put("imageFilename", "memory-${index % uniqueImages}.jpg")
        put("colors", JSONObject().put("background", "#FFFFFF").put("foreground", "#222222"))
      })
    }
    return JSONObject().apply {
      put("schemaVersion", 1)
      put("accountId", "account-a")
      put("familyId", "family-a")
      put("generationId", "generation-a")
      put("verifiedAt", verified.toString())
      put("expiresAt", verified.plusSeconds(WIDGET_LEASE_SECONDS).toString())
      put("timezone", "UTC")
      put("entries", entries)
    }
  }

  @Test fun repeatsOneMemoryAcrossSevenSlots() {
    val parsed = WidgetManifestParser.parse(fixture().toString(), verified)
    assertEquals(7, parsed.entries.size)
    assertEquals(1, parsed.entries.map { it.memoryId }.toSet().size)
  }

  @Test fun accepts24EntriesForDaytimeTimeline() {
    val parsed = WidgetManifestParser.parse(fixture(24, uniqueMemoryIds = 7, uniqueImages = 7).toString(), verified)
    assertEquals(24, parsed.entries.size)
  }

  @Test fun rejects25Entries() {
    assertThrows(WidgetManifestException::class.java) {
      WidgetManifestParser.parse(fixture(25, uniqueMemoryIds = 7, uniqueImages = 7).toString(), verified)
    }
  }

  @Test fun rejectsMoreThanSevenRetainedIdsOrCachedImages() {
    assertThrows(WidgetManifestException::class.java) {
      WidgetManifestParser.parse(fixture(8, uniqueMemoryIds = 8).toString(), verified)
    }
    assertThrows(WidgetManifestException::class.java) {
      WidgetManifestParser.parse(fixture(8, uniqueMemoryIds = 1, uniqueImages = 8).toString(), verified)
    }
  }

  @Test fun expiresAtExactLeaseBoundary() {
    assertThrows(WidgetManifestException::class.java) {
      WidgetManifestParser.parse(fixture().toString(), verified.plusSeconds(WIDGET_LEASE_SECONDS))
    }
  }

  @Test fun rejectsExtendedLease() {
    val raw = fixture().put("expiresAt", verified.plusSeconds(WIDGET_LEASE_SECONDS + 1).toString())
    assertThrows(WidgetManifestException::class.java) { WidgetManifestParser.parse(raw.toString(), verified) }
  }

  @Test fun rejectsPathTraversalAndInvalidColors() {
    for (field in listOf("imageFilename", "color")) {
      val raw = fixture()
      val entry = raw.getJSONArray("entries").getJSONObject(0)
      if (field == "imageFilename") entry.put(field, "../other-family.jpg")
      else entry.getJSONObject("colors").put("background", "#12345")
      assertThrows(WidgetManifestException::class.java) { WidgetManifestParser.parse(raw.toString(), verified) }
    }
  }

  @Test fun rejectsUnknownSchemaAndUnorderedStarts() {
    val schema = fixture().put("schemaVersion", 2)
    assertThrows(WidgetManifestException::class.java) { WidgetManifestParser.parse(schema.toString(), verified) }
    val starts = fixture()
    starts.getJSONArray("entries").getJSONObject(1).put("startsAt", verified.toString())
    assertThrows(WidgetManifestException::class.java) { WidgetManifestParser.parse(starts.toString(), verified) }
  }
}
