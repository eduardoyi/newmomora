// Test-only command line driver for the Expo-free core in ../ios/*.swift (everything
// except MomoraAudioModule.swift). Used by verify-macos.sh for macOS and the iOS
// simulator. Prints one JSON object per call; on failure prints {"error": "<code>"}
// and exits 1. Must be named main.swift when compiled, so the script copies it.
import Foundation

func emit(_ object: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
}

func fail(_ error: Error) -> Never {
  let e = MomoraAudioError.from(error)
  emit(["error": e.code.rawValue, "message": e.message])
  exit(1)
}

let args = CommandLine.arguments
guard args.count >= 3 else {
  FileHandle.standardError.write(
    Data("usage: cli probe <in> | analyze <in> <maxBuckets> <minBucketMs> | render <in> <out> <startMs> <endMs> <bitrate>\n".utf8))
  exit(2)
}

do {
  let input = URL(fileURLWithPath: args[2])
  switch args[1] {
  case "probe":
    emit(try AudioProbe.probe(url: input).dictionary)
  case "analyze":
    emit(try AudioAnalysis.analyze(url: input, maxBuckets: Int(args[3])!, minBucketMs: Int(args[4])!).dictionary)
  case "render":
    emit(
      try AudioRender.render(
        inputURL: input, outputURL: URL(fileURLWithPath: args[3]),
        startMs: Int64(args[4])!, endMs: Int64(args[5])!, bitrate: Int(args[6])!
      ).dictionary)
  default:
    exit(2)
  }
} catch {
  fail(error)
}
