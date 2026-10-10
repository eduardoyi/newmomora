import AVFoundation
import Foundation

/// A forward-only source of mono Float32 PCM at the file's *decoded* sample rate.
///
/// The decoder is a protocol so another container can slot in without touching
/// analysis or rendering: P1b adds `OggOpusSource` (the spike's hand-rolled Ogg
/// demux + Apple's Opus decoder, see docs/plans/audio-trim-import-spike) and only
/// `AudioDecoder.openSource` changes.
protocol PCMSource: AnyObject {
  /// Decoded sample rate in Hz (no resampling happens for analysis).
  var sampleRate: Double { get }
  /// Container-metadata length in frames. An estimate: lossy/VBR files can differ
  /// from the real decoded count by a few frames, so callers never trust it for
  /// the final duration (analysis counts decoded samples instead).
  var estimatedFrames: Int64 { get }
  /// Positions the next read at `frame` (decoded sample index).
  func seek(toFrame frame: Int64) throws
  /// Next chunk of mono samples (mean of all channels), at most `maxFrames` long.
  /// Returns an empty array at end of stream.
  func readMono(maxFrames: Int) throws -> [Float]
}

enum AudioDecoder {
  /// Hard ceiling on source length. Longer files are refused rather than
  /// decoded: a 30 min stream is already ~21 MB of 96 kbps AAC when rendered.
  static let maxDurationMs: Int64 = 30 * 60 * 1000

  /// ~1 s of audio per read. Large enough to amortise AVAudioFile call overhead,
  /// small enough that a 30 min file never holds more than a few hundred KB of PCM.
  static func chunkFrames(forSampleRate rate: Double) -> Int {
    max(1024, Int(rate.rounded()))
  }

  /// Accepts `file://` URIs (what JS passes) or plain absolute paths.
  static func fileURL(from uri: String) throws -> URL {
    if uri.hasPrefix("file://") {
      guard let url = URL(string: uri), url.isFileURL else {
        throw MomoraAudioError(.ioFailed, "Invalid file URI")
      }
      return url
    }
    guard uri.hasPrefix("/") else { throw MomoraAudioError(.ioFailed, "Invalid file URI") }
    return URL(fileURLWithPath: uri)
  }

  static func fileSize(_ url: URL) throws -> Int64 {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
      let size = attrs[.size] as? NSNumber
    else {
      throw MomoraAudioError(.ioFailed, "Cannot read file")
    }
    return size.int64Value
  }

  /// First bytes of the file, for magic-number sniffing (Ogg is not readable by
  /// AVAudioFile, everything else is).
  static func readHeader(_ url: URL, count: Int = 16) throws -> Data {
    do {
      let handle = try FileHandle(forReadingFrom: url)
      defer { try? handle.close() }
      return try handle.read(upToCount: count) ?? Data()
    } catch {
      throw MomoraAudioError(.ioFailed, "Cannot read file")
    }
  }

  static func isOgg(_ header: Data) -> Bool {
    header.prefix(4) == Data("OggS".utf8)
  }

  /// Opens the right decoder for the file, or throws a stable error code.
  static func openSource(_ url: URL) throws -> PCMSource {
    let header = try readHeader(url)
    if isOgg(header) {
      // P1b (owner decision pending): return an OggOpusSource here. Until then,
      // callers surface "In WhatsApp, use Forward -> Share -> Momora instead."
      throw MomoraAudioError(.unsupportedFormat, "Ogg is not supported on iOS yet")
    }
    return try AVAudioFileSource(url: url)
  }
}

/// Everything AVFoundation can read: AAC/ALAC m4a, caf (incl. Opus-in-CAF), wav,
/// aiff, mp3, amr.
final class AVAudioFileSource: PCMSource {
  private let file: AVAudioFile
  private let buffer: AVAudioPCMBuffer
  private let channelCount: Int
  let sampleRate: Double
  let estimatedFrames: Int64

  init(url: URL) throws {
    do {
      // Float32 non-interleaved processing format at the file's own rate: AVAudioFile
      // converts integer/compressed storage to float for us and does not resample.
      file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
    } catch {
      throw MomoraAudioError.from(error)
    }
    let format = file.processingFormat
    sampleRate = format.sampleRate
    channelCount = Int(format.channelCount)
    estimatedFrames = file.length
    guard sampleRate > 0, channelCount > 0 else {
      throw MomoraAudioError(.unsupportedFormat, "Unsupported audio format")
    }
    guard
      let buf = AVAudioPCMBuffer(
        pcmFormat: format,
        frameCapacity: AVAudioFrameCount(AudioDecoder.chunkFrames(forSampleRate: sampleRate)))
    else {
      throw MomoraAudioError(.decodeFailed, "Cannot allocate decode buffer")
    }
    buffer = buf
  }

  func seek(toFrame frame: Int64) throws {
    file.framePosition = max(0, frame)
  }

  func readMono(maxFrames: Int) throws -> [Float] {
    let want = min(maxFrames, Int(buffer.frameCapacity))
    guard want > 0 else { return [] }
    // `length` is container metadata and can be slightly off for VBR mp3, so EOF is
    // detected by an empty read rather than by comparing framePosition to length.
    // Some AVAudioFile versions throw on a read at EOF instead of returning 0 frames.
    do {
      try file.read(into: buffer, frameCount: AVAudioFrameCount(want))
    } catch {
      if file.framePosition >= file.length { return [] }
      throw MomoraAudioError.from(error)
    }
    let n = Int(buffer.frameLength)
    guard n > 0, let data = buffer.floatChannelData else { return [] }

    var mono = [Float](repeating: 0, count: n)
    if channelCount == 1 {
      mono.withUnsafeMutableBufferPointer { dst in
        dst.baseAddress!.update(from: data[0], count: n)
      }
    } else {
      // Plain arithmetic mean of channels (the energy bucket spec's downmix).
      let scale = 1 / Float(channelCount)
      mono.withUnsafeMutableBufferPointer { dst in
        for i in 0..<n {
          var sum: Float = 0
          for c in 0..<channelCount { sum += data[c][i] }
          dst[i] = sum * scale
        }
      }
    }
    return mono
  }
}
