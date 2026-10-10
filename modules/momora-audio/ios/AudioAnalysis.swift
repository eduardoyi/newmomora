import Foundation

struct AudioEnergiesResult {
  var durationMs: Int64
  var bucketMs: Int
  var energies: [Double]

  /// Shape of the TS `AudioEnergies` interface.
  var dictionary: [String: Any] {
    ["durationMs": durationMs, "bucketMs": bucketMs, "energies": energies]
  }
}

enum AudioAnalysis {
  /// Mean-square energy per time bucket of the mono downmix, streamed chunk by chunk.
  ///
  /// This implements the plan's "Energy bucket spec" exactly; the TS reference
  /// (`energiesFromPcm`), the Kotlin module and the backfill script must agree:
  ///   - bucketMs = max(minBucketMs, ceil(durationMsEstimate / maxBuckets))
  ///   - samplesPerBucket = max(1, round(bucketMs * sampleRate / 1000)) at the DECODED rate
  ///   - energies[i] = mean(x^2) over bucket i; the last bucket may be partial and
  ///     averages over its own samples only
  ///   - durationMs = round(decodedSamples * 1000 / sampleRate)
  ///
  /// `durationMsEstimate` is the container's length (unrounded) so the bucket size is
  /// known before decoding; the reported durationMs always comes from the decoded count.
  /// Sums accumulate in Double so results do not depend on chunk boundaries.
  static func analyze(url: URL, maxBuckets: Int, minBucketMs: Int) throws -> AudioEnergiesResult {
    let maxBuckets = max(1, maxBuckets)
    let minBucketMs = max(1, minBucketMs)
    let source = try AudioDecoder.openSource(url)
    let rate = source.sampleRate

    let estimateMs = Double(source.estimatedFrames) * 1000 / rate
    if estimateMs > Double(AudioDecoder.maxDurationMs) {
      throw MomoraAudioError(.tooLong, "Audio is longer than 30 minutes")
    }
    let bucketMs = max(minBucketMs, Int((estimateMs / Double(maxBuckets)).rounded(.up)))
    let samplesPerBucket = max(1, Int((Double(bucketMs) * rate / 1000).rounded()))
    // Backstop for files whose metadata under-reports length.
    let frameCeiling = Int64(Double(AudioDecoder.maxDurationMs) * rate / 1000) + Int64(rate)

    var energies: [Double] = []
    energies.reserveCapacity(maxBuckets + 1)
    var sum = 0.0
    var inBucket = 0
    var total: Int64 = 0
    let chunk = AudioDecoder.chunkFrames(forSampleRate: rate)

    while true {
      let samples = try source.readMono(maxFrames: chunk)
      if samples.isEmpty { break }
      total += Int64(samples.count)
      if total > frameCeiling {
        throw MomoraAudioError(.tooLong, "Audio is longer than 30 minutes")
      }
      samples.withUnsafeBufferPointer { p in
        for x in p {
          let v = Double(x)
          sum += v * v
          inBucket += 1
          if inBucket == samplesPerBucket {
            energies.append(sum / Double(samplesPerBucket))
            sum = 0
            inBucket = 0
          }
        }
      }
    }
    if inBucket > 0 { energies.append(sum / Double(inBucket)) }

    guard total > 0 else { throw MomoraAudioError(.decodeFailed, "No audio could be decoded") }
    let durationMs = Int64((Double(total) * 1000 / rate).rounded())
    return AudioEnergiesResult(durationMs: durationMs, bucketMs: bucketMs, energies: energies)
  }
}
