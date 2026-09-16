package expo.modules.momorawidget

import android.content.ComponentName
import android.content.Intent
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class WidgetIntentTest {
  private fun launchIntent() = Intent(Intent.ACTION_MAIN)
    .setComponent(ComponentName("com.memora.app", "com.memora.app.MainActivity"))
    .addCategory(Intent.CATEGORY_LAUNCHER)
    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

  private fun entry(id: String = "memory-a") = WidgetManifestEntry(
    Instant.parse("2026-09-16T00:00:00Z"), id, 0, "photo.jpg", "Synthetic caption",
    "Sep 16, 2026", "#FFFFFF", "#222222", "image",
  )

  @Test fun memoryTapIsAViewIntentForReactNativeOnColdAndWarmStarts() {
    val intent = configureWidgetIntent(launchIntent(), "family-a", entry())
    assertEquals(Intent.ACTION_VIEW, intent.action)
    assertEquals("com.memora.app.MainActivity", intent.component?.className)
    assertFalse(intent.hasCategory(Intent.CATEGORY_LAUNCHER))
    assertEquals("momora", intent.data?.scheme)
    assertEquals("widget", intent.data?.host)
    assertEquals("family-a", intent.data?.getQueryParameter("familyId"))
    assertEquals("memory-a", intent.data?.getQueryParameter("memoryId"))
    assertEquals("0", intent.data?.getQueryParameter("mediaIndex"))
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_SINGLE_TOP != 0)
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_CLEAR_TOP != 0)
    assertTrue(intent.flags and Intent.FLAG_ACTIVITY_NEW_TASK != 0)
  }

  @Test fun differentCardsHaveDistinctPendingIntentIdentity() {
    val first = configureWidgetIntent(launchIntent(), "family-a", entry("memory-a"))
    val second = configureWidgetIntent(launchIntent(), "family-a", entry("memory-b"))
    assertFalse(first.filterEquals(second))
  }

  @Test fun neutralCardDoesNotCarryAPrivateTarget() {
    val intent = configureWidgetIntent(launchIntent(), null, null)
    assertEquals(Intent.ACTION_MAIN, intent.action)
    assertNull(intent.data)
  }
}
