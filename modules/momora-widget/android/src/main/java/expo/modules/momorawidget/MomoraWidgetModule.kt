package expo.modules.momorawidget

import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class MomoraWidgetModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw IllegalStateException("Momora widget app context is unavailable")

  private val store: WidgetStore by lazy { WidgetStore(context) }

  override fun definition() = ModuleDefinition {
    Name("MomoraWidget")

    Function("getCapabilities") {
      mapOf(
        "supported" to true,
        "enabled" to true,
        "platform" to "android",
        "sharedDirectory" to store.sharedDirectory(),
        "supportsAndroidTall" to true,
        "supportsSystemSmall" to false,
      )
    }

    AsyncFunction("readManifest") {
      store.readManifest()
    }

    AsyncFunction("publishManifest") { manifestJson: String, filesJson: String ->
      store.publishManifest(manifestJson, filesJson)
      MomoraWidgetReceiver.requestRefresh(context)
    }

    AsyncFunction("clearManifest") { scopeJson: String?, generationId: String? ->
      val cleared = store.clearManifest(scopeJson, generationId)
      MomoraWidgetReceiver.requestRefresh(context)
      cleared
    }

    Function("reload") {
      MomoraWidgetReceiver.requestRefresh(context)
    }
  }
}
