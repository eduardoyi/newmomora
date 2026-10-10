import ExpoModulesCore
import Foundation

/// Thin Expo wrapper. All decoding/encoding lives in the Swift files next to this
/// one that do NOT import ExpoModulesCore, so `scripts/verify-macos.sh` can compile
/// them standalone for macOS and the iOS simulator.
public class MomoraAudioModule: Module {
  public func definition() -> ModuleDefinition {
    Name("MomoraAudio")

    // Heavy, blocking work (decode/encode) must stay off the JS thread and off the
    // main thread; a dedicated user-initiated queue keeps UI responsive during a 30 min decode.
    let queue = DispatchQueue(label: "app.momora.audio", qos: .userInitiated, attributes: .concurrent)

    AsyncFunction("probe") { (uri: String) -> [String: Any] in
      try Self.run {
        try AudioProbe.probe(url: try AudioDecoder.fileURL(from: uri)).dictionary
      }
    }.runOnQueue(queue)

    AsyncFunction("analyze") { (uri: String, options: [String: Any]) -> [String: Any] in
      try Self.run {
        let maxBuckets = Self.intOption(options, "maxBuckets") ?? 4000
        let minBucketMs = Self.intOption(options, "minBucketMs") ?? 20
        return try AudioAnalysis.analyze(
          url: try AudioDecoder.fileURL(from: uri), maxBuckets: maxBuckets, minBucketMs: minBucketMs
        ).dictionary
      }
    }.runOnQueue(queue)

    AsyncFunction("render") { (uri: String, options: [String: Any]) -> [String: Any] in
      try Self.run {
        guard
          let startMs = Self.intOption(options, "startMs"),
          let endMs = Self.intOption(options, "endMs"),
          let outputUri = options["outputUri"] as? String
        else {
          throw MomoraAudioError(.decodeFailed, "Invalid render options")
        }
        let bitrate = Self.intOption(options, "bitrate") ?? 96_000
        return try AudioRender.render(
          inputURL: try AudioDecoder.fileURL(from: uri),
          outputURL: try AudioDecoder.fileURL(from: outputUri),
          startMs: Int64(startMs), endMs: Int64(endMs), bitrate: bitrate
        ).dictionary
      }
    }.runOnQueue(queue)
  }

  /// Converts core errors into Expo exceptions whose `code` is one of the stable
  /// strings the TS wrapper switches on. Messages carry no paths or file names.
  private static func run<T>(_ body: () throws -> T) throws -> T {
    do {
      return try body()
    } catch {
      let mapped = MomoraAudioError.from(error)
      throw Exception(name: "MomoraAudioError", description: mapped.message, code: mapped.code.rawValue)
    }
  }

  private static func intOption(_ options: [String: Any], _ key: String) -> Int? {
    if let n = options[key] as? NSNumber { return n.intValue }
    if let d = options[key] as? Double { return Int(d) }
    return nil
  }
}
