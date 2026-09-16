package expo.modules.momorawidget

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.AtomicFile
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.time.Instant
import java.util.UUID

internal class WidgetStore(private val context: Context) {
  private val root: File = File(context.noBackupFilesDir, ROOT_NAME)
  private val generations: File = File(root, "generations")
  private val staging: File = File(root, "staging")
  private val activePointer: File = File(root, "active_generation")
  private val state = context.getSharedPreferences(STATE_NAME, Context.MODE_PRIVATE)

  fun readManifest(): String? {
    val active = activeSnapshot() ?: return null
    return active.raw
  }

  fun readWidgetContent(now: Instant = Instant.now()): WidgetRenderData {
    val active = activeSnapshot(now) ?: return WidgetRenderData(null, null, null)
    val entry = active.entries.lastOrNull { !it.startsAt.isAfter(now) }
      ?: active.entries.firstOrNull()
      ?: return WidgetRenderData(active.familyId, null, null)
    val bitmap = entry.imageFilename?.let { filename ->
      val file = File(File(generations, active.generationId), filename)
      decodeBitmap(file)
    }
    return WidgetRenderData(active.familyId, entry, bitmap)
  }

  fun publishManifest(manifestJson: String, filesJson: String) {
    val manifest = WidgetManifestParser.parse(manifestJson)
    val files = WidgetManifestParser.parseFiles(filesJson)
    val expectedFiles = manifest.entries.mapNotNull { it.imageFilename }.toSet()
    if (files.keys != expectedFiles) {
      throw WidgetManifestException("files", "Widget files do not match the manifest.")
    }

    val token = beginPublish(manifest.generationId)
    val stage = File(staging, "${manifest.generationId}-${UUID.randomUUID()}")
    try {
      ensureDirectory(stage)
      var totalBytes = manifestJson.toByteArray(Charsets.UTF_8).size.toLong()
      for (filename in expectedFiles) {
        val source = sourceFile(files.getValue(filename))
        val destination = File(stage, filename)
        val copied = copyBoundedImage(source, destination)
        totalBytes += copied
      }
      if (totalBytes > WIDGET_MAX_CACHE_BYTES) {
        throw WidgetManifestException("cache_size", "Widget cache is too large.")
      }
      atomicWrite(File(stage, MANIFEST_NAME), manifestJson.toByteArray(Charsets.UTF_8))

      synchronized(PROCESS_LOCK) {
        if (!isPublishCurrent(token, manifest.generationId)) {
          throw WidgetManifestException("stale_generation", "Widget generation was superseded.")
        }
        ensureDirectory(generations)
        val destination = File(generations, manifest.generationId)
        if (destination.exists()) deleteRecursively(destination)
        if (!stage.renameTo(destination)) {
          throw IOException("Could not commit widget generation")
        }
        atomicWrite(activePointer, manifest.generationId.toByteArray(Charsets.UTF_8))
        state.edit().remove(PENDING_GENERATION).apply()
        garbageCollect(manifest.generationId)
      }
    } finally {
      if (stage.exists()) deleteRecursively(stage)
      synchronized(PROCESS_LOCK) {
        if (isPublishCurrent(token, manifest.generationId)) {
          state.edit().remove(PENDING_GENERATION).apply()
        }
      }
    }
  }

  fun clearManifest(scopeJson: String?, generationId: String?): Boolean {
    val requestedScope = parseScope(scopeJson)
    val token = beginClear()
    synchronized(PROCESS_LOCK) {
      if (token != state.getLong(MUTATION_EPOCH, 0L)) return false
      val active = activeSnapshot(enforceExpiry = false)
      if (active != null && requestedScope != null
        && (active.accountId != requestedScope.first || active.familyId != requestedScope.second)) {
        return false
      }
      if (active != null && generationId != null && active.generationId != generationId) {
        return false
      }
      if (activePointer.exists()) activePointer.delete()
      if (root.exists()) {
        generations.listFiles()?.forEach { deleteRecursively(it) }
        staging.listFiles()?.forEach { deleteRecursively(it) }
      }
      return true
    }
  }

  fun sharedDirectory(): String {
    ensureDirectory(root)
    return root.absolutePath
  }

  private fun activeSnapshot(
    now: Instant = Instant.now(),
    enforceExpiry: Boolean = true,
  ): WidgetManifestSnapshot? {
    return try {
      val generationId = activePointer.takeIf { it.isFile }?.readText(Charsets.UTF_8)?.trim()
        ?: return null
      if (!GENERATION_PATTERN.matches(generationId)) return null
      val manifestFile = File(File(generations, generationId), MANIFEST_NAME)
      if (!manifestFile.isFile) return null
      WidgetManifestParser.parse(manifestFile.readText(Charsets.UTF_8), now, enforceExpiry)
    } catch (_: Exception) {
      null
    }
  }

  private fun beginPublish(generationId: String): Long = synchronized(PROCESS_LOCK) {
    val next = state.getLong(MUTATION_EPOCH, 0L) + 1L
    state.edit()
      .putLong(MUTATION_EPOCH, next)
      .putString(PENDING_GENERATION, generationId)
      .commit()
    next
  }

  private fun beginClear(): Long = synchronized(PROCESS_LOCK) {
    val next = state.getLong(MUTATION_EPOCH, 0L) + 1L
    state.edit()
      .putLong(MUTATION_EPOCH, next)
      .remove(PENDING_GENERATION)
      .commit()
    next
  }

  private fun isPublishCurrent(token: Long, generationId: String): Boolean {
    return token == state.getLong(MUTATION_EPOCH, 0L)
      && state.getString(PENDING_GENERATION, null) == generationId
  }

  private fun parseScope(scopeJson: String?): Pair<String, String>? {
    if (scopeJson.isNullOrBlank()) return null
    return try {
      val json = org.json.JSONObject(scopeJson)
      val account = json.optString("accountId", "")
      val family = json.optString("familyId", "")
      if (account.isEmpty() || family.isEmpty()) null else account to family
    } catch (_: Exception) {
      null
    }
  }

  private fun sourceFile(rawUri: String): File {
    val uri = Uri.parse(rawUri)
    if (uri.scheme != "file" || uri.path.isNullOrEmpty()) {
      throw WidgetManifestException("file_uri", "Widget image source must be a local file.")
    }
    val file = File(uri.path!!).canonicalFile
    val allowedRoots = listOfNotNull(
      context.cacheDir,
      context.filesDir,
      context.noBackupFilesDir,
      context.externalCacheDir,
    ).map { it.canonicalFile }
    if (allowedRoots.none { file.path == it.path || file.path.startsWith(it.path + File.separator) }) {
      throw WidgetManifestException("file_scope", "Widget image source is outside app storage.")
    }
    if (!file.isFile || !file.canRead()) {
      throw WidgetManifestException("file_missing", "Widget image source is unavailable.")
    }
    return file
  }

  private fun copyBoundedImage(source: File, destination: File): Long {
    if (source.length() <= 0L || source.length() > WIDGET_MAX_IMAGE_BYTES) {
      throw WidgetManifestException("image_size", "Widget image exceeds the size limit.")
    }
    ensureDirectory(destination.parentFile!!)
    var copied = 0L
    FileInputStream(source).use { input ->
      FileOutputStream(destination).use { output ->
        val buffer = ByteArray(32 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          copied += read
          if (copied > WIDGET_MAX_IMAGE_BYTES) {
            throw WidgetManifestException("image_size", "Widget image exceeds the size limit.")
          }
          output.write(buffer, 0, read)
        }
        output.fd.sync()
      }
    }
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(destination.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
      destination.delete()
      throw WidgetManifestException("image_format", "Widget image is not a decodable bitmap.")
    }
    if (maxOf(bounds.outWidth, bounds.outHeight) > WIDGET_MAX_IMAGE_EDGE) {
      destination.delete()
      throw WidgetManifestException("image_dimensions", "Widget image dimensions exceed the limit.")
    }
    return copied
  }

  private fun decodeBitmap(file: File): android.graphics.Bitmap? {
    if (!file.isFile) return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.absolutePath, bounds)
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / sample > WIDGET_MAX_IMAGE_EDGE
      || bounds.outHeight / sample > WIDGET_MAX_IMAGE_EDGE) {
      sample *= 2
    }
    return BitmapFactory.decodeFile(
      file.absolutePath,
      BitmapFactory.Options().apply { inSampleSize = sample },
    )
  }

  private fun atomicWrite(file: File, bytes: ByteArray) {
    ensureDirectory(file.parentFile!!)
    val atomic = AtomicFile(file)
    var stream: FileOutputStream? = null
    try {
      stream = atomic.startWrite()
      stream.write(bytes)
      stream.fd.sync()
      atomic.finishWrite(stream)
      stream = null
    } finally {
      if (stream != null) atomic.failWrite(stream)
    }
  }

  private fun garbageCollect(activeGeneration: String) {
    generations.listFiles()?.forEach { directory ->
      if (directory.name != activeGeneration) deleteRecursively(directory)
    }
  }

  private fun ensureDirectory(directory: File) {
    if (directory.isDirectory) return
    if (!directory.mkdirs() && !directory.isDirectory) {
      throw IOException("Could not create widget cache directory")
    }
  }

  private fun deleteRecursively(file: File) {
    if (file.isDirectory) file.listFiles()?.forEach(::deleteRecursively)
    file.delete()
  }

  private companion object {
    const val ROOT_NAME = "momora-widget"
    const val STATE_NAME = "momora_widget_state"
    const val MUTATION_EPOCH = "mutation_epoch"
    const val PENDING_GENERATION = "pending_generation"
    const val MANIFEST_NAME = "manifest.json"
    val PROCESS_LOCK = Any()
    val GENERATION_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
  }
}

internal data class WidgetRenderData(
  val familyId: String?,
  val entry: WidgetManifestEntry?,
  val bitmap: android.graphics.Bitmap?,
)
