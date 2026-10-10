import AVFoundation
import CoreMedia
import Foundation

struct AudioRenderResult {
  var uri: String
  var durationMs: Int64
  var sizeBytes: Int64

  var dictionary: [String: Any] {
    ["uri": uri, "durationMs": durationMs, "sizeBytes": sizeBytes]
  }
}

enum AudioRender {
  /// Always 48 kHz. The spike showed AAC-LC rejects 64 kbps at a 16 kHz source rate,
  /// and 96 kbps mono needs a rate the encoder accepts for every input (8/16/22.05/
  /// 44.1/48 kHz voice notes), so every output is resampled to one known-good rate.
  static let outputSampleRate = 48_000

  /// Decodes only [startMs, endMs) of the source, mono-downmixes, resamples to 48 kHz
  /// and encodes AAC-LC mono into an .m4a, one ~1 s chunk at a time (never the whole
  /// file in memory; a 30 min source is ~170 MB of float PCM). Partial output is
  /// deleted on any failure.
  static func render(
    inputURL: URL, outputURL: URL, startMs: Int64, endMs: Int64, bitrate: Int
  ) throws -> AudioRenderResult {
    guard startMs >= 0, endMs > startMs, bitrate > 0 else {
      throw MomoraAudioError(.decodeFailed, "Invalid selection")
    }
    if inputURL.standardizedFileURL.path == outputURL.standardizedFileURL.path {
      throw MomoraAudioError(.ioFailed, "Output must differ from input")
    }

    let source = try AudioDecoder.openSource(inputURL)
    let rate = source.sampleRate
    if Double(source.estimatedFrames) * 1000 / rate > Double(AudioDecoder.maxDurationMs) {
      throw MomoraAudioError(.tooLong, "Audio is longer than 30 minutes")
    }

    let fm = FileManager.default
    do {
      try fm.createDirectory(
        at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
      // AVAssetWriter refuses to overwrite.
      if fm.fileExists(atPath: outputURL.path) { try fm.removeItem(at: outputURL) }
    } catch {
      throw MomoraAudioError(.ioFailed, "Cannot prepare output file")
    }

    var writer: AACFileWriter?
    do {
      let w = try AACFileWriter(url: outputURL, bitrate: bitrate)
      writer = w
      let startFrame = Int64((Double(startMs) * rate / 1000).rounded())
      let endFrame = Int64((Double(endMs) * rate / 1000).rounded())
      try source.seek(toFrame: startFrame)
      var remaining = endFrame - startFrame
      let chunk = AudioDecoder.chunkFrames(forSampleRate: rate)

      // Bounded reader: stops at endFrame or end of file, whichever comes first.
      let pull: () throws -> [Float] = {
        if remaining <= 0 { return [] }
        let samples = try source.readMono(maxFrames: Int(min(Int64(chunk), remaining)))
        remaining -= Int64(samples.count)
        return samples
      }

      if Int(rate.rounded()) == outputSampleRate {
        while true {
          let samples = try pull()
          if samples.isEmpty { break }
          try w.append(samples)
        }
      } else {
        let resampler = try StreamingResampler(from: rate, to: Double(outputSampleRate))
        try resampler.run(pull: pull) { try w.append($0) }
      }

      let frames = try w.finish()
      guard frames > 0 else { throw MomoraAudioError(.decodeFailed, "Selection contains no audio") }
      let size = try AudioDecoder.fileSize(outputURL)
      let durationMs = Int64((Double(frames) * 1000 / Double(outputSampleRate)).rounded())
      return AudioRenderResult(uri: outputURL.absoluteString, durationMs: durationMs, sizeBytes: size)
    } catch {
      writer?.cancel()
      try? fm.removeItem(at: outputURL)
      throw MomoraAudioError.from(error)
    }
  }
}

/// Pull-based streaming sample-rate converter (mono Float32). The converter asks for
/// input only when it needs it, so memory stays at about two 1 s buffers.
final class StreamingResampler {
  private let converter: AVAudioConverter
  private let inFormat: AVAudioFormat
  private let outFormat: AVAudioFormat
  private let outBuffer: AVAudioPCMBuffer

  init(from inRate: Double, to outRate: Double) throws {
    guard
      let inFmt = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: inRate, channels: 1, interleaved: false),
      let outFmt = AVAudioFormat(
        commonFormat: .pcmFormatFloat32, sampleRate: outRate, channels: 1, interleaved: false),
      let conv = AVAudioConverter(from: inFmt, to: outFmt),
      let out = AVAudioPCMBuffer(pcmFormat: outFmt, frameCapacity: AVAudioFrameCount(outRate))
    else {
      throw MomoraAudioError(.decodeFailed, "Cannot create resampler")
    }
    // Highest quality: voice notes are short and quality matters more than the
    // few extra milliseconds of CPU.
    conv.sampleRateConverterQuality = AVAudioQuality.max.rawValue
    inFormat = inFmt
    outFormat = outFmt
    converter = conv
    outBuffer = out
  }

  func run(pull: () throws -> [Float], push: ([Float]) throws -> Void) throws {
    var finished = false
    var pullError: Error?

    try withoutActuallyEscaping(pull) { pull in
      while true {
        outBuffer.frameLength = 0
        var convError: NSError?
        let status = converter.convert(to: outBuffer, error: &convError) { _, inStatus in
          if finished {
            inStatus.pointee = .endOfStream
            return nil
          }
          do {
            let samples = try pull()
            if samples.isEmpty {
              finished = true
              inStatus.pointee = .endOfStream
              return nil
            }
            // A fresh buffer per pull: the converter may still reference the previous one.
            guard
              let buf = AVAudioPCMBuffer(
                pcmFormat: self.inFormat, frameCapacity: AVAudioFrameCount(samples.count))
            else {
              finished = true
              pullError = MomoraAudioError(.decodeFailed, "Cannot allocate resample buffer")
              inStatus.pointee = .endOfStream
              return nil
            }
            samples.withUnsafeBufferPointer { src in
              buf.floatChannelData![0].update(from: src.baseAddress!, count: samples.count)
            }
            buf.frameLength = AVAudioFrameCount(samples.count)
            inStatus.pointee = .haveData
            return buf
          } catch {
            finished = true
            pullError = error
            inStatus.pointee = .endOfStream
            return nil
          }
        }
        if let pullError { throw pullError }
        if status == .error {
          throw MomoraAudioError.from(convError ?? NSError(domain: "MomoraAudio", code: -1))
        }
        let n = Int(outBuffer.frameLength)
        if n > 0 {
          try push(Array(UnsafeBufferPointer(start: outBuffer.floatChannelData![0], count: n)))
        }
        if status == .endOfStream || (n == 0 && finished) { break }
      }
    }
  }
}

/// AAC-LC .m4a writer over AVAssetWriter, fed with mono 48 kHz Float32 chunks.
///
/// AVAssetWriter (rather than AVAudioFile) because it writes the MP4 edit list and
/// encoder priming correctly: the file reports the exact trimmed duration and players
/// skip the ~44 ms of AAC priming instead of playing it as a leading gap.
final class AACFileWriter {
  private let writer: AVAssetWriter
  private let input: AVAssetWriterInput
  private let formatDescription: CMAudioFormatDescription
  private var framesWritten: Int64 = 0

  init(url: URL, bitrate: Int) throws {
    var asbd = AudioStreamBasicDescription(
      mSampleRate: Double(AudioRender.outputSampleRate), mFormatID: kAudioFormatLinearPCM,
      mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
      mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 1, mBitsPerChannel: 32,
      mReserved: 0)
    var fd: CMAudioFormatDescription?
    let status = CMAudioFormatDescriptionCreate(
      allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
      magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &fd)
    guard status == noErr, let fd else {
      throw MomoraAudioError(.ioFailed, "Cannot create encoder format (OSStatus \(status))")
    }
    formatDescription = fd

    do {
      writer = try AVAssetWriter(outputURL: url, fileType: .m4a)
    } catch {
      throw MomoraAudioError(.ioFailed, "Cannot create output file")
    }
    let settings: [String: Any] = [
      AVFormatIDKey: kAudioFormatMPEG4AAC,
      AVSampleRateKey: AudioRender.outputSampleRate,
      AVNumberOfChannelsKey: 1,
      AVEncoderBitRateKey: bitrate,
    ]
    input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings, sourceFormatHint: fd)
    input.expectsMediaDataInRealTime = false
    guard writer.canAdd(input) else {
      throw MomoraAudioError(.ioFailed, "Encoder rejected settings")
    }
    writer.add(input)
    guard writer.startWriting() else { throw failure("Cannot start encoder") }
    writer.startSession(atSourceTime: .zero)
  }

  private func failure(_ what: String) -> MomoraAudioError {
    let code = (writer.error as NSError?)?.code ?? 0
    return MomoraAudioError(.ioFailed, "\(what) (code \(code))")
  }

  func append(_ samples: [Float]) throws {
    guard !samples.isEmpty else { return }
    // Offline encode: block until the encoder wants more instead of buffering the
    // whole clip. We run on a background queue, so a short sleep is harmless.
    while !input.isReadyForMoreMediaData {
      if writer.status == .failed || writer.status == .cancelled { throw failure("Encoder failed") }
      Thread.sleep(forTimeInterval: 0.002)
    }

    let byteCount = samples.count * MemoryLayout<Float>.size
    var block: CMBlockBuffer?
    var status = CMBlockBufferCreateWithMemoryBlock(
      allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: byteCount,
      blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
      dataLength: byteCount, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
    guard status == noErr, let block else {
      throw MomoraAudioError(.ioFailed, "Encoder buffer failed (OSStatus \(status))")
    }
    status = samples.withUnsafeBytes {
      CMBlockBufferReplaceDataBytes(
        with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: byteCount)
    }
    guard status == noErr else {
      throw MomoraAudioError(.ioFailed, "Encoder buffer failed (OSStatus \(status))")
    }

    var sample: CMSampleBuffer?
    status = CMAudioSampleBufferCreateReadyWithPacketDescriptions(
      allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: formatDescription,
      sampleCount: samples.count,
      presentationTimeStamp: CMTime(
        value: framesWritten, timescale: CMTimeScale(AudioRender.outputSampleRate)),
      packetDescriptions: nil, sampleBufferOut: &sample)
    guard status == noErr, let sample else {
      throw MomoraAudioError(.ioFailed, "Encoder sample failed (OSStatus \(status))")
    }
    guard input.append(sample) else { throw failure("Encoder failed") }
    framesWritten += Int64(samples.count)
  }

  /// Finalises the file and returns the number of 48 kHz frames written.
  func finish() throws -> Int64 {
    input.markAsFinished()
    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else { throw failure("Encoder failed") }
    return framesWritten
  }

  func cancel() {
    if writer.status == .writing { writer.cancelWriting() }
  }
}
