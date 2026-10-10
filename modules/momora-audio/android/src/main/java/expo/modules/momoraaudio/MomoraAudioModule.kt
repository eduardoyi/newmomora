package expo.modules.momoraaudio

import android.content.Context
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@OptimizedRecord
class AnalyzeOptions : Record {
  @Field var maxBuckets: Int = 0
  @Field var minBucketMs: Int = 0
}

@OptimizedRecord
class RenderOptions : Record {
  @Field var startMs: Double = 0.0
  @Field var endMs: Double = 0.0
  @Field var outputUri: String = ""
  @Field var bitrate: Int = 96_000
}

class MomoraAudioModule : Module() {
  private val context: Context
    get() = appContext.reactContext?.applicationContext
      ?: throw ioFailed()

  override fun definition() = ModuleDefinition {
    Name("MomoraAudio")

    // All decode/encode work runs on Dispatchers.IO so neither the JS thread nor Expo's shared
    // modules queue is blocked by long files.
    AsyncFunction("probe") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        AudioOperations.probe(context, uri)
      }
    }

    AsyncFunction("analyze") Coroutine { uri: String, options: AnalyzeOptions ->
      withContext(Dispatchers.IO) {
        AudioOperations.analyze(context, uri, options.maxBuckets, options.minBucketMs)
      }
    }

    AsyncFunction("render") Coroutine { uri: String, options: RenderOptions ->
      withContext(Dispatchers.IO) {
        AudioOperations.render(
          context,
          uri,
          options.startMs.toLong(),
          options.endMs.toLong(),
          options.outputUri,
          options.bitrate
        )
      }
    }
  }
}
