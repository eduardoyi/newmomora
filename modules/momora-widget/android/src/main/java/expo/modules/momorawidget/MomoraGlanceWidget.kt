package expo.modules.momorawidget

import android.content.Context
import android.content.Intent
import android.graphics.Color as AndroidColor
import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.compose.ui.graphics.Color
import androidx.glance.text.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.layout.size
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.currentState
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.action.clickable
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Spacer
import androidx.glance.layout.ContentScale
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private const val MOMORA_SCHEME = "momora"
private val widgetRevision = longPreferencesKey("momora_widget_revision")

class MomoraGlanceWidget : GlanceAppWidget() {
  override suspend fun provideGlance(context: Context, id: GlanceId) {
    provideContent {
      // Glance may retain this composition between update requests. Read its
      // invalidated state so a new generation or clear cannot reuse captured
      // private content from a previous provideGlance invocation.
      val revision = currentState<Preferences>()[widgetRevision]
      val content = remember(revision) {
        WidgetStore(context.applicationContext).readWidgetContent()
      }
      MomoraWidgetContent(context, content)
    }
  }
}

class MomoraWidgetReceiver : GlanceAppWidgetReceiver() {
  override val glanceAppWidget: GlanceAppWidget = MomoraGlanceWidget()

  override fun onEnabled(context: Context) {
    super.onEnabled(context)
    WidgetRefreshScheduler.schedule(context)
  }

  override fun onUpdate(
    context: Context,
    appWidgetManager: android.appwidget.AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    super.onUpdate(context, appWidgetManager, appWidgetIds)
    WidgetRefreshScheduler.schedule(context)
  }

  override fun onDeleted(context: Context, appWidgetIds: IntArray) {
    super.onDeleted(context, appWidgetIds)
    if (appWidgetIds.isNotEmpty()) WidgetRefreshScheduler.schedule(context)
  }

  override fun onDisabled(context: Context) {
    WidgetRefreshScheduler.cancel(context)
    super.onDisabled(context)
  }

  companion object {
    internal suspend fun refreshNow(context: Context) {
      val appContext = context.applicationContext
      for (id in GlanceAppWidgetManager(appContext).getGlanceIds(MomoraGlanceWidget::class.java)) {
        updateAppWidgetState(appContext, id) { preferences ->
          preferences[widgetRevision] = System.nanoTime()
        }
      }
      MomoraGlanceWidget().updateAll(appContext)
      WidgetRefreshScheduler.schedule(appContext)
    }

    fun requestRefresh(context: Context) {
      val appContext = context.applicationContext
      CoroutineScope(Dispatchers.Default).launch {
        refreshNow(appContext)
      }
    }
  }
}

internal class MomoraWidgetSystemReceiver : android.content.BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_TIME_CHANGED,
      Intent.ACTION_TIMEZONE_CHANGED,
      Intent.ACTION_BOOT_COMPLETED,
      -> {
        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.Default).launch {
          try {
            MomoraWidgetReceiver.refreshNow(context)
          } finally {
            pendingResult.finish()
          }
        }
      }
    }
  }
}

@Composable
private fun MomoraWidgetContent(context: Context, content: WidgetRenderData) {
  val entry = content.entry?.takeIf { content.bitmap != null && (it.kind == "photo" || it.kind == "illustration") }
  val background = entry?.backgroundColor() ?: EMPTY_BACKGROUND
  val clickAction = actionStartActivity(widgetIntent(context, content.familyId, entry))

  Box(
    modifier = GlanceModifier
      .fillMaxSize()
      .background(ColorProvider(background))
      .appWidgetBackground()
      .cornerRadius(24.dp)
      .clickable(onClick = clickAction),
    contentAlignment = Alignment.Center,
  ) {
    if (content.bitmap != null && entry != null) {
      Box(
        modifier = GlanceModifier.fillMaxSize(),
        contentAlignment = Alignment.Center,
      ) {
        Image(
          provider = ImageProvider(content.bitmap),
          contentDescription = "Memory from ${entry.dateLabel}",
          contentScale = ContentScale.Crop,
          modifier = GlanceModifier.fillMaxSize(),
        )

      }
      // Reuse the brand asset; keep it away from the crop edges.
      Box(
        modifier = GlanceModifier.fillMaxSize().padding(10.dp),
        contentAlignment = Alignment.TopEnd,
      ) {
        Image(
          provider = ImageProvider(R.drawable.momora_widget_brand),
          contentDescription = "Momora",
          modifier = GlanceModifier.size(28.dp).cornerRadius(8.dp),
        )
      }
    } else {
      val copy = emptyCopy(content.emptyState ?: WidgetEmptyState.NEEDS_REFRESH)
      Column(
        horizontalAlignment = Alignment.Horizontal.CenterHorizontally,
        verticalAlignment = Alignment.Vertical.CenterVertically,
        modifier = GlanceModifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 14.dp),
      ) {
        Image(
          provider = ImageProvider(R.drawable.momora_widget_brand),
          contentDescription = null,
          modifier = GlanceModifier.size(40.dp).cornerRadius(11.dp),
        )
        Spacer(GlanceModifier.height(10.dp))
        Text(
          text = copy.title,
          maxLines = 2,
          style = TextStyle(
            color = ColorProvider(EMPTY_TITLE),
            fontSize = 16.sp,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
          ),
        )
        Spacer(GlanceModifier.height(4.dp))
        Text(
          text = copy.body,
          maxLines = 3,
          style = TextStyle(
            color = ColorProvider(EMPTY_BODY),
            fontSize = 12.sp,
            textAlign = TextAlign.Center,
          ),
        )
        Spacer(GlanceModifier.height(12.dp))
        Box(
          modifier = GlanceModifier
            .background(ColorProvider(EMPTY_ACCENT))
            .cornerRadius(16.dp)
            .padding(horizontal = 14.dp, vertical = 6.dp),
          contentAlignment = Alignment.Center,
        ) {
          Text(
            text = copy.action,
            maxLines = 1,
            style = TextStyle(
              color = ColorProvider(Color.White),
              fontSize = 12.sp,
              fontWeight = FontWeight.Medium,
            ),
          )
        }
      }
    }
  }
}

private val EMPTY_BACKGROUND = Color(0xFFFBEFF3)
private val EMPTY_TITLE = Color(0xFF2C2418)
private val EMPTY_BODY = Color(0xFF6B5E57)
private val EMPTY_ACCENT = Color(0xFFD63E78)

internal data class WidgetEmptyCopy(val title: String, val body: String, val action: String)

internal fun emptyCopy(state: WidgetEmptyState): WidgetEmptyCopy = when (state) {
  WidgetEmptyState.NO_MEMORIES -> WidgetEmptyCopy(
    title = "Your memories will live here",
    body = "Add a photo or illustrated moment to see it here.",
    action = "Open Momora",
  )
  WidgetEmptyState.NEEDS_REFRESH -> WidgetEmptyCopy(
    title = "Your memories are waiting",
    body = "Tap to catch up on your family's moments.",
    action = "Open Momora",
  )
}

private fun WidgetManifestEntry.backgroundColor(): Color =
  Color(AndroidColor.parseColor(background))

internal fun widgetIntent(context: Context, familyId: String?, entry: WidgetManifestEntry?): Intent {
  val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
    ?: Intent(Intent.ACTION_MAIN).setPackage(context.packageName)
  return configureWidgetIntent(intent, familyId, entry)
}

internal fun configureWidgetIntent(intent: Intent, familyId: String?, entry: WidgetManifestEntry?): Intent {
  if (entry == null || familyId == null) return intent
  val uri = Uri.Builder()
    .scheme(MOMORA_SCHEME)
    .authority("widget")
    .appendQueryParameter("familyId", familyId)
    .appendQueryParameter("memoryId", entry.memoryId)
    .apply { entry.mediaIndex?.let { appendQueryParameter("mediaIndex", it.toString()) } }
    .build()
  // React Native reads/emits URLs only for ACTION_VIEW, on both cold and warm starts.
  // A package launch intent has ACTION_MAIN and CATEGORY_LAUNCHER by default.
  intent.removeCategory(Intent.CATEGORY_LAUNCHER)
  return intent.setAction(Intent.ACTION_VIEW).setData(uri)
    .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
}
