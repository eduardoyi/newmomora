package expo.modules.momorawidget

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException

internal const val WIDGET_SCHEMA_VERSION = 1
internal const val WIDGET_MAX_ENTRIES = 7
internal const val WIDGET_LEASE_SECONDS = 168L * 60L * 60L
internal const val WIDGET_MAX_IMAGE_BYTES = 1L * 1024L * 1024L
internal const val WIDGET_MAX_CACHE_BYTES = 10L * 1024L * 1024L
internal const val WIDGET_MAX_IMAGE_EDGE = 512

internal class WidgetManifestException(
  val code: String,
  message: String,
) : Exception(message)

internal data class WidgetManifestEntry(
  val startsAt: Instant,
  val memoryId: String,
  val mediaIndex: Int?,
  val imageFilename: String?,
  val excerpt: String,
  val dateLabel: String,
  val background: String,
  val foreground: String,
  val kind: String,
)

internal data class WidgetManifestSnapshot(
  val raw: String,
  val schemaVersion: Int,
  val accountId: String,
  val familyId: String,
  val generationId: String,
  val verifiedAt: Instant,
  val expiresAt: Instant,
  val entries: List<WidgetManifestEntry>,
)

private val safeFileName = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
private val safeColor = Regex("^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$")
private val safeDate = Regex("^\\d{4}-\\d{2}-\\d{2}$")
private val safeGeneration = safeFileName

internal object WidgetManifestParser {
  fun parse(
    raw: String,
    now: Instant = Instant.now(),
    enforceExpiry: Boolean = true,
  ): WidgetManifestSnapshot {
    val root = try {
      JSONObject(raw)
    } catch (_: Exception) {
      invalid("manifest_json", "Widget manifest is not valid JSON.")
    }

    val schemaVersion = root.optInt("schemaVersion", -1)
    if (schemaVersion != WIDGET_SCHEMA_VERSION) {
      invalid("schema_version", "Unsupported widget manifest schema.")
    }

    val accountId = requiredString(root, "accountId", 128)
    val familyId = requiredString(root, "familyId", 128)
    val generationId = requiredString(root, "generationId", 128)
    if (!safeGeneration.matches(generationId)) {
      invalid("generation_id", "Widget generation id is not safe.")
    }
    requiredString(root, "timezone", 128)

    val verifiedAt = requiredInstant(root, "verifiedAt")
    val expiresAt = requiredInstant(root, "expiresAt")
    if (verifiedAt.plusSeconds(WIDGET_LEASE_SECONDS) != expiresAt) {
      invalid("lease_duration", "Widget manifest lease must be exactly 168 hours.")
    }
    if (enforceExpiry && !expiresAt.isAfter(now)) {
      invalid("expired", "Widget manifest lease has expired.")
    }

    val entriesJson = root.optJSONArray("entries")
      ?: invalid("entries", "Widget manifest entries must be an array.")
    if (entriesJson.length() > WIDGET_MAX_ENTRIES) {
      invalid("entry_limit", "Widget manifest has too many entries.")
    }

    val entries = mutableListOf<WidgetManifestEntry>()
    var previousStart: Instant? = null
    for (index in 0 until entriesJson.length()) {
      val entry = entriesJson.optJSONObject(index)
        ?: invalid("entry", "Widget manifest entry is not an object.")
      val parsed = parseEntry(entry)
      if (parsed.startsAt.isBefore(verifiedAt) || !parsed.startsAt.isBefore(expiresAt)) {
        invalid("entry_window", "Widget manifest entry is outside the lease.")
      }
      if (previousStart != null && !parsed.startsAt.isAfter(previousStart)) {
        invalid("entry_order", "Widget manifest entries must have increasing startsAt values.")
      }
      previousStart = parsed.startsAt
      entries += parsed
    }

    return WidgetManifestSnapshot(
      raw = raw,
      schemaVersion = schemaVersion,
      accountId = accountId,
      familyId = familyId,
      generationId = generationId,
      verifiedAt = verifiedAt,
      expiresAt = expiresAt,
      entries = entries,
    )
  }

  fun parseFiles(raw: String): Map<String, String> {
    val root = try {
      JSONObject(raw)
    } catch (_: Exception) {
      invalid("files_json", "Widget files are not valid JSON.")
    }
    val files = linkedMapOf<String, String>()
    val keys = root.keys()
    while (keys.hasNext()) {
      val filename = keys.next()
      if (!safeFileName.matches(filename) || filename.contains("..")) {
        invalid("filename", "Widget filename is not safe.")
      }
      val uri = root.optString(filename, "")
      if (uri.isBlank()) {
        invalid("file_uri", "Widget file URI is empty.")
      }
      files[filename] = uri
    }
    return files
  }

  private fun parseEntry(entry: JSONObject): WidgetManifestEntry {
    val kind = requiredString(entry, "kind", 32)
    if (kind !in setOf("illustration", "photo", "video", "audio", "text", "neutral")) {
      invalid("entry_kind", "Widget entry kind is not supported.")
    }
    val memoryDate = requiredString(entry, "memoryDate", 10)
    if (!safeDate.matches(memoryDate)) {
      invalid("memory_date", "Widget memory date is invalid.")
    }
    val dateLabel = requiredString(entry, "dateLabel", 80)
    val excerpt = requiredString(entry, "excerpt", 500)
    val memoryId = requiredString(entry, "memoryId", 128)
    val startsAt = requiredInstant(entry, "startsAt")
    requiredInstant(entry, "sourceUpdatedAt")

    val imageFilename = if (entry.has("imageFilename") && !entry.isNull("imageFilename")) {
      val filename = requiredString(entry, "imageFilename", 180)
      if (!safeFileName.matches(filename) || filename.contains("..")) {
        invalid("filename", "Widget image filename is not safe.")
      }
      filename
    } else {
      null
    }

    val colors = entry.optJSONObject("colors")
      ?: invalid("colors", "Widget entry colors are missing.")
    val background = requiredString(colors, "background", 9)
    val foreground = requiredString(colors, "foreground", 9)
    val accent = if (colors.has("accent") && !colors.isNull("accent")) {
      requiredString(colors, "accent", 9)
    } else {
      null
    }
    if (!safeColor.matches(background)
      || !safeColor.matches(foreground)
      || (accent != null && !safeColor.matches(accent))) {
      invalid("colors", "Widget entry color is invalid.")
    }

    val mediaIndex = if (entry.has("mediaIndex") && !entry.isNull("mediaIndex")) {
      val mediaIndex = entry.optInt("mediaIndex", -1)
      if (mediaIndex !in 0..9) {
        invalid("media_index", "Widget media index is invalid.")
      }
      mediaIndex
    } else {
      null
    }

    return WidgetManifestEntry(
      startsAt = startsAt,
      memoryId = memoryId,
      mediaIndex = mediaIndex,
      imageFilename = imageFilename,
      excerpt = excerpt,
      dateLabel = dateLabel,
      background = background,
      foreground = foreground,
      kind = kind,
    )
  }

  private fun requiredString(root: JSONObject, field: String, maxLength: Int): String {
    val value = root.optString(field, "")
    if (value.isEmpty() || value.length > maxLength || value.any { it == '\u0000' }) {
      invalid("field", "Widget manifest field is invalid: $field.")
    }
    return value
  }

  private fun requiredInstant(root: JSONObject, field: String): Instant {
    val value = requiredString(root, field, 40)
    return try {
      Instant.parse(value)
    } catch (_: DateTimeParseException) {
      try {
        OffsetDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
      } catch (_: DateTimeParseException) {
        invalid("timestamp", "Widget timestamp is invalid: $field.")
      }
    }
  }

  private fun invalid(code: String, message: String): Nothing {
    throw WidgetManifestException(code, message)
  }
}
