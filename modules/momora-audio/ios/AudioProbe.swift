import AVFoundation
import AudioToolbox
import Foundation

struct AudioProbeResult {
  var durationMs: Int64
  var container: String
  var codec: String
  var sampleRate: Double
  var channels: Int
  var creationDate: String?
  var sizeBytes: Int64

  /// Shape of the TS `AudioProbe` interface (`creationDate` is JS null when absent).
  var dictionary: [String: Any] {
    [
      "durationMs": durationMs,
      "container": container,
      "codec": codec,
      "sampleRate": sampleRate,
      "channels": channels,
      "creationDate": creationDate ?? NSNull(),
      "sizeBytes": sizeBytes,
    ]
  }
}

enum AudioProbe {
  /// Cheap metadata read; never decodes. Does not enforce the 30 min ceiling
  /// (callers need the duration to show the right message); `analyze`/`render` do.
  static func probe(url: URL) throws -> AudioProbeResult {
    let size = try AudioDecoder.fileSize(url)
    let header = try AudioDecoder.readHeader(url, count: 64)
    let container = detectContainer(header)

    if container == "ogg" {
      return try probeOgg(url: url, size: size)
    }

    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: url)
    } catch {
      throw MomoraAudioError.from(error)
    }
    let format = file.fileFormat
    guard format.sampleRate > 0, file.length >= 0 else {
      throw MomoraAudioError(.unsupportedFormat, "Unsupported audio format")
    }
    let durationMs = Int64((Double(file.length) * 1000 / format.sampleRate).rounded())
    let formatID = (format.settings[AVFormatIDKey] as? NSNumber)?.uint32Value ?? 0
    return AudioProbeResult(
      durationMs: durationMs,
      container: container,
      codec: codecName(formatID: formatID),
      sampleRate: format.sampleRate,
      channels: Int(format.channelCount),
      creationDate: creationDate(url: url),
      sizeBytes: size)
  }

  /// Magic-number sniffing. Extensions lie (WhatsApp, renamed Files), bytes don't.
  static func detectContainer(_ h: Data) -> String {
    let b = [UInt8](h)
    func at(_ i: Int, _ s: String) -> Bool {
      let u = Array(s.utf8)
      return b.count >= i + u.count && Array(b[i..<i + u.count]) == u
    }
    if at(0, "OggS") { return "ogg" }
    if at(0, "RIFF") && at(8, "WAVE") { return "wav" }
    if at(0, "caff") { return "caf" }
    if at(0, "FORM") && (at(8, "AIFF") || at(8, "AIFC")) { return "aiff" }
    if at(4, "ftyp") { return "mp4" }
    if at(0, "#!AMR") { return "amr" }
    if at(0, "ID3") { return "mp3" }
    // Raw MPEG audio frame sync: 11 set bits.
    if b.count >= 2 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0 { return "mp3" }
    return "other"
  }

  static func codecName(formatID: UInt32) -> String {
    switch formatID {
    case kAudioFormatMPEG4AAC, kAudioFormatMPEG4AAC_HE, kAudioFormatMPEG4AAC_HE_V2,
      kAudioFormatMPEG4AAC_LD, kAudioFormatMPEG4AAC_ELD, kAudioFormatMPEG4AAC_ELD_SBR,
      kAudioFormatMPEG4AAC_ELD_V2, kAudioFormatMPEG4AAC_Spatial:
      return "aac"
    case kAudioFormatOpus: return "opus"
    case kAudioFormatLinearPCM: return "pcm"
    case kAudioFormatMPEGLayer3: return "mp3"
    case kAudioFormatAMR, kAudioFormatAMR_WB: return "amr"
    default: return "other"
    }
  }

  /// `creationDate` from the container (QuickTime/MP4 `mvhd` or common metadata).
  /// Voice Memos carries the recording time; WhatsApp stamps the *export* time, so
  /// JS must not trust it for WhatsApp files (plan: "WhatsApp date").
  private static func creationDate(url: URL) -> String? {
    let asset = AVURLAsset(url: url)
    // Metadata only; a pathological file must not block the worker forever.
    return blocking(timeout: 10) {
      if let item = try? await asset.load(.creationDate),
        let date = try? await item.load(.dateValue)
      {
        return iso(date)
      }
      if let common = try? await asset.load(.commonMetadata) {
        let items = AVMetadataItem.metadataItems(
          from: common, filteredByIdentifier: .commonIdentifierCreationDate)
        if let item = items.first {
          if let date = try? await item.load(.dateValue) { return iso(date) }
          if let text = try? await item.load(.stringValue), let date = parseISO(text) {
            return iso(date)
          }
        }
      }
      return nil
    }
  }

  private final class ResultBox<T>: @unchecked Sendable {
    var value: T?
  }

  /// Runs an async metadata load from a synchronous worker-queue context.
  private static func blocking<T>(
    timeout: TimeInterval, _ operation: @escaping @Sendable () async -> T?
  ) -> T? {
    let box = ResultBox<T>()
    let done = DispatchSemaphore(value: 0)
    Task.detached {
      box.value = await operation()
      done.signal()
    }
    guard done.wait(timeout: .now() + timeout) == .success else { return nil }
    return box.value
  }

  private static func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
  }

  private static func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
  }

  /// Ogg probe without decoding: OpusHead for channels, last page granule for length
  /// (RFC 7845: duration = finalGranule - preSkip at 48 kHz). Kept even though iOS
  /// cannot decode Ogg yet, so JS can show a precise "unsupported" message and P1b
  /// needs no probe change.
  private static func probeOgg(url: URL, size: Int64) throws -> AudioProbeResult {
    let head = try AudioDecoder.readHeader(url, count: 4096)
    let bytes = [UInt8](head)
    var codec = "other"
    var channels = 0
    var preSkip = 0
    var sampleRate = 0.0
    if let r = find(bytes, Array("OpusHead".utf8)), r + 19 <= bytes.count {
      codec = "opus"
      channels = Int(bytes[r + 9])
      preSkip = Int(bytes[r + 10]) | Int(bytes[r + 11]) << 8
      sampleRate = 48000  // Opus always decodes at 48 kHz regardless of the header's input rate
    } else if find(bytes, Array("vorbis".utf8)) != nil {
      channels = bytes.count > 40 ? Int(bytes[39]) : 0
    }

    var durationMs: Int64 = 0
    if sampleRate > 0, let granule = try lastGranule(url: url, size: size), granule > preSkip {
      durationMs = Int64((Double(granule - preSkip) * 1000 / sampleRate).rounded())
    }
    return AudioProbeResult(
      durationMs: durationMs, container: "ogg", codec: codec, sampleRate: sampleRate,
      channels: channels, creationDate: nil, sizeBytes: size)
  }

  private static func find(_ hay: [UInt8], _ needle: [UInt8]) -> Int? {
    guard hay.count >= needle.count else { return nil }
    for i in 0...(hay.count - needle.count) where Array(hay[i..<i + needle.count]) == needle {
      return i
    }
    return nil
  }

  /// Granule position of the last Ogg page, scanning back from the end of the file.
  private static func lastGranule(url: URL, size: Int64) throws -> Int? {
    let window = min(size, 65_536)
    let handle: FileHandle
    do { handle = try FileHandle(forReadingFrom: url) } catch {
      throw MomoraAudioError(.ioFailed, "Cannot read file")
    }
    defer { try? handle.close() }
    do {
      try handle.seek(toOffset: UInt64(size - window))
      let tail = [UInt8](try handle.read(upToCount: Int(window)) ?? Data())
      let magic = Array("OggS".utf8)
      guard tail.count >= 27 else { return nil }
      var i = tail.count - 27
      while i >= 0 {
        if tail[i] == magic[0] && tail[i + 1] == magic[1] && tail[i + 2] == magic[2]
          && tail[i + 3] == magic[3]
        {
          var g: UInt64 = 0
          for k in 0..<8 { g |= UInt64(tail[i + 6 + k]) << (8 * UInt64(k)) }
          let signed = Int64(bitPattern: g)
          return signed >= 0 ? Int(signed) : nil
        }
        i -= 1
      }
      return nil
    } catch {
      throw MomoraAudioError(.ioFailed, "Cannot read file")
    }
  }
}
