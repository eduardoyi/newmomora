package expo.modules.momorawidget

import java.time.Instant
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class WidgetManifestParserTest {
  private val verified = Instant.parse("2026-09-15T12:00:00Z")

  private fun fixture(): JSONObject {
    val entries = JSONArray()
    for (day in 0..6) {
      entries.put(JSONObject().apply {
        put("startsAt", verified.plusSeconds(day * 86400L).toString())
        put("memoryId", "one-memory")
        put("sourceUpdatedAt", verified.toString())
        put("memoryDate", "2026-09-15")
        put("dateLabel", "September 15")
        put("excerpt", "Synthetic test memory")
        put("kind", "text")
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
