// Spike: any voice-note file -> mono PCM -> (optional trim) -> AAC .m4a + waveform peaks.
// Ogg Opus (WhatsApp) is demuxed by hand and decoded with Apple's built-in Opus
// decoder via AVAudioConverter -- no libopus. Everything else goes through AVAudioFile.

import AVFoundation
import AudioToolbox

enum PrepError: Error { case notOgg, badOgg(String), unsupported(String), converter(String) }

// MARK: - Ogg demux

struct OpusHead {
  let channels: Int
  let preSkip: Int
  let inputSampleRate: Int
  let outputGainQ8: Int16
  let mappingFamily: Int
}

struct OggOpusStream {
  let head: OpusHead
  let packets: [Data]
  let finalGranule: Int64
}

func isOgg(_ data: Data) -> Bool { data.prefix(4) == Data("OggS".utf8) }

func demuxOggOpus(_ data: Data) throws -> OggOpusStream {
  guard isOgg(data) else { throw PrepError.notOgg }
  var packets: [Data] = []
  var partial = Data()
  var offset = 0
  var serial: UInt32? = nil
  var finalGranule: Int64 = 0
  let bytes = [UInt8](data)

  func u32(_ i: Int) -> UInt32 { UInt32(bytes[i]) | UInt32(bytes[i+1]) << 8 | UInt32(bytes[i+2]) << 16 | UInt32(bytes[i+3]) << 24 }
  func i64(_ i: Int) -> Int64 { Int64(bitPattern: UInt64(u32(i)) | UInt64(u32(i+4)) << 32) }

  while offset + 27 <= bytes.count {
    guard bytes[offset] == 0x4F, bytes[offset+1] == 0x67, bytes[offset+2] == 0x67, bytes[offset+3] == 0x53 else {
      throw PrepError.badOgg("lost page sync at \(offset)")
    }
    let granule = i64(offset + 6)
    let pageSerial = u32(offset + 14)
    let segCount = Int(bytes[offset + 26])
    let tableStart = offset + 27
    guard tableStart + segCount <= bytes.count else { throw PrepError.badOgg("truncated segment table") }
    var bodyOffset = tableStart + segCount
    // Only the first logical stream is read (voice notes are never multiplexed).
    let ours = serial == nil || serial == pageSerial
    if serial == nil { serial = pageSerial }
    for s in 0..<segCount {
      let len = Int(bytes[tableStart + s])
      guard bodyOffset + len <= bytes.count else { throw PrepError.badOgg("truncated page body") }
      if ours {
        partial.append(contentsOf: bytes[bodyOffset..<bodyOffset+len])
        if len < 255 { packets.append(partial); partial = Data() }
      }
      bodyOffset += len
    }
    if ours && granule >= 0 { finalGranule = granule }
    offset = bodyOffset
  }

  guard packets.count >= 2, packets[0].prefix(8) == Data("OpusHead".utf8) else { throw PrepError.badOgg("no OpusHead") }
  let h = [UInt8](packets[0])
  guard h.count >= 19 else { throw PrepError.badOgg("short OpusHead") }
  let head = OpusHead(
    channels: Int(h[9]),
    preSkip: Int(UInt16(h[10]) | UInt16(h[11]) << 8),
    inputSampleRate: Int(UInt32(h[12]) | UInt32(h[13]) << 8 | UInt32(h[14]) << 16 | UInt32(h[15]) << 24),
    outputGainQ8: Int16(bitPattern: UInt16(h[16]) | UInt16(h[17]) << 8),
    mappingFamily: Int(h[18]))
  // packets[1] is OpusTags.
  return OggOpusStream(head: head, packets: Array(packets.dropFirst(2)), finalGranule: finalGranule)
}

/// Samples (at 48 kHz, per channel) in one Opus packet, from its TOC byte (RFC 6716 §3.1).
func opusPacketFrames(_ p: Data) -> Int {
  guard let toc = p.first else { return 0 }
  let config = Int(toc >> 3)
  let frameSize: Int
  if config < 12 { frameSize = [480, 960, 1920, 2880][config & 3] }        // SILK
  else if config < 16 { frameSize = [480, 960][config & 1] }               // Hybrid
  else { frameSize = [120, 240, 480, 960][config & 3] }                    // CELT
  let count: Int
  switch toc & 3 {
  case 0: count = 1
  case 1, 2: count = 2
  default: count = p.count > 1 ? Int(p[p.startIndex + 1] & 0x3F) : 0
  }
  return frameSize * count
}

/// Splits a (possibly multi-frame) Opus packet into single-frame code-0 packets (RFC 6716 §3.2),
/// so every packet handed to Apple's decoder carries exactly one frame.
func splitOpusPacket(_ packet: Data) throws -> [Data] {
  let p = [UInt8](packet)
  guard let toc = p.first else { return [] }
  let toc0 = toc & 0xFC
  func wrap(_ frame: ArraySlice<UInt8>) -> Data { Data([toc0]) + Data(frame) }
  func readLen(_ i: inout Int) throws -> Int {
    guard i < p.count else { throw PrepError.badOgg("opus length") }
    let b = Int(p[i]); i += 1
    if b < 252 { return b }
    guard i < p.count else { throw PrepError.badOgg("opus length") }
    let v = b + 4 * Int(p[i]); i += 1; return v
  }
  switch toc & 3 {
  case 0: return [packet]
  case 1:
    let n = (p.count - 1) / 2
    return [wrap(p[1..<1+n]), wrap(p[1+n..<1+2*n])]
  case 2:
    var i = 1
    let n1 = try readLen(&i)
    guard i + n1 <= p.count else { throw PrepError.badOgg("opus code 2") }
    return [wrap(p[i..<i+n1]), wrap(p[(i+n1)...])]
  default:
    guard p.count >= 2 else { throw PrepError.badOgg("opus code 3") }
    let vbr = p[1] & 0x80 != 0, padded = p[1] & 0x40 != 0, m = Int(p[1] & 0x3F)
    var i = 2, padding = 0
    if padded {
      while true {
        guard i < p.count else { throw PrepError.badOgg("opus padding") }
        let b = Int(p[i]); i += 1
        padding += b == 255 ? 254 : b
        if b != 255 { break }
      }
    }
    var lens: [Int] = []
    if vbr { for _ in 0..<max(0, m - 1) { lens.append(try readLen(&i)) } }
    let remaining = p.count - i - padding - lens.reduce(0, +)
    guard remaining >= 0, m > 0 else { throw PrepError.badOgg("opus code 3 sizes") }
    if vbr { lens.append(remaining) } else { lens = Array(repeating: remaining / m, count: m) }
    var frames: [Data] = []
    for len in lens { frames.append(wrap(p[i..<i+len])); i += len }
    return frames
  }
}

// MARK: - Decode

let appleOpusDecoderDelay = 120

func decodeOggOpus(_ stream: OggOpusStream) throws -> AVAudioPCMBuffer {
  let stream = OggOpusStream(head: stream.head, packets: try stream.packets.flatMap(splitOpusPacket), finalGranule: stream.finalGranule)
  let ch = stream.head.channels
  guard stream.head.mappingFamily == 0, (1...2).contains(ch) else {
    throw PrepError.unsupported("opus mapping family \(stream.head.mappingFamily), \(ch) ch")
  }
  var asbd = AudioStreamBasicDescription(
    mSampleRate: 48000, mFormatID: kAudioFormatOpus, mFormatFlags: 0, mBytesPerPacket: 0,
    mFramesPerPacket: UInt32(stream.packets.first.map(opusPacketFrames) ?? 960), mBytesPerFrame: 0, mChannelsPerFrame: UInt32(ch), mBitsPerChannel: 0, mReserved: 0)
  guard let inFormat = AVAudioFormat(streamDescription: &asbd) else { throw PrepError.converter("opus input format") }
  let outFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: AVAudioChannelCount(ch), interleaved: false)!
  guard let converter = AVAudioConverter(from: inFormat, to: outFormat) else { throw PrepError.converter("no opus decoder") }

  let totalFrames = stream.packets.reduce(0) { $0 + opusPacketFrames($1) }
  guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(totalFrames + 5760)) else {
    throw PrepError.converter("alloc")
  }
  let maxPacket = stream.packets.map(\.count).max() ?? 1
  let chunk = 64
  var next = 0
  var convError: NSError?
  // Decode in slices so the output buffer can be filled progressively.
  let slice = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(chunk * 5760))!
  while true {
    slice.frameLength = 0
    let status = converter.convert(to: slice, error: &convError) { _, inStatus in
      if next >= stream.packets.count { inStatus.pointee = .endOfStream; return nil }
      let end = min(next + chunk, stream.packets.count)
      let buf = AVAudioCompressedBuffer(format: inFormat, packetCapacity: AVAudioPacketCount(end - next), maximumPacketSize: maxPacket)
      var byteOffset = 0
      for (i, p) in stream.packets[next..<end].enumerated() {
        p.withUnsafeBytes { raw in
          (buf.data + byteOffset).copyMemory(from: raw.baseAddress!, byteCount: p.count)
        }
        buf.packetDescriptions![i] = AudioStreamPacketDescription(
          mStartOffset: Int64(byteOffset), mVariableFramesInPacket: UInt32(opusPacketFrames(p)), mDataByteSize: UInt32(p.count))
        byteOffset += p.count
      }
      buf.packetCount = AVAudioPacketCount(end - next)
      buf.byteLength = UInt32(byteOffset)
      next = end
      inStatus.pointee = .haveData
      return buf
    }
    if status == .error { throw PrepError.converter(convError?.localizedDescription ?? "convert") }
    if slice.frameLength > 0 {
      for c in 0..<ch {
        (out.floatChannelData![c] + Int(out.frameLength)).update(from: slice.floatChannelData![c], count: Int(slice.frameLength))
      }
      out.frameLength += slice.frameLength
    }
    if status == .endOfStream || (status == .inputRanDry && next >= stream.packets.count && slice.frameLength == 0) { break }
  }

  // Pre-skip at the front, final granule at the end (RFC 7845 §4.2–4.5), output gain.
  // Apple's Opus decoder already swallows 120 samples (2.5 ms) of priming itself,
  // so only the rest of the stream's pre-skip is dropped here (measured against libopus).
  let preSkip = min(max(0, stream.head.preSkip - appleOpusDecoderDelay), Int(out.frameLength))
  let length = max(0, min(Int(out.frameLength) - preSkip, Int(stream.finalGranule) - stream.head.preSkip))
  let gain = Float(pow(10.0, Double(stream.head.outputGainQ8) / (20.0 * 256.0)))
  let trimmed = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: AVAudioFrameCount(max(length, 1)))!
  for c in 0..<ch {
    let src = out.floatChannelData![c] + preSkip
    let dst = trimmed.floatChannelData![c]
    for i in 0..<length { dst[i] = src[i] * gain }
  }
  trimmed.frameLength = AVAudioFrameCount(length)
  return trimmed
}

func decodeWithAVAudioFile(_ url: URL) throws -> AVAudioPCMBuffer {
  let file = try AVAudioFile(forReading: url, commonFormat: .pcmFormatFloat32, interleaved: false)
  let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
  try file.read(into: buf)
  return buf
}

func decodeAny(_ url: URL) throws -> AVAudioPCMBuffer {
  let head = try FileHandle(forReadingFrom: url).read(upToCount: 4) ?? Data()
  if isOgg(head) { return try decodeOggOpus(try demuxOggOpus(try Data(contentsOf: url))) }
  return try decodeWithAVAudioFile(url)
}

// MARK: - Mono + trim + peaks + encode

func monoSlice(_ buf: AVAudioPCMBuffer, startSec: Double?, endSec: Double?) -> AVAudioPCMBuffer {
  let sr = buf.format.sampleRate
  let total = Int(buf.frameLength)
  let s = max(0, min(total, Int((startSec ?? 0) * sr)))
  let e = max(s, min(total, endSec.map { Int($0 * sr) } ?? total))
  let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sr, channels: 1, interleaved: false)!
  let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(max(e - s, 1)))!
  let ch = Int(buf.format.channelCount)
  let dst = out.floatChannelData![0]
  for i in 0..<(e - s) {
    var sum: Float = 0
    for c in 0..<ch { sum += buf.floatChannelData![c][s + i] }
    dst[i] = sum / Float(ch)
  }
  out.frameLength = AVAudioFrameCount(e - s)
  return out
}

/// RMS per bucket -> dBFS -> [-50, 0] dB mapped to 0...1 -> normalized to the loudest bucket -> 0...255.
func peaks(_ mono: AVAudioPCMBuffer, buckets: Int) -> [UInt8] {
  let n = Int(mono.frameLength)
  guard n > 0 else { return Array(repeating: 0, count: buckets) }
  let x = mono.floatChannelData![0]
  var levels = [Double](repeating: 0, count: buckets)
  for b in 0..<buckets {
    let lo = b * n / buckets, hi = max(lo + 1, (b + 1) * n / buckets)
    var acc = 0.0
    for i in lo..<min(hi, n) { acc += Double(x[i]) * Double(x[i]) }
    let rms = (acc / Double(hi - lo)).squareRoot()
    let db = 20 * log10(max(rms, 1e-9))
    levels[b] = min(1, max(0, (db + 50) / 50))
  }
  let top = levels.max() ?? 0
  return levels.map { top > 0 ? UInt8(min(255, ($0 / top * 255).rounded())) : 0 }
}

func resample(_ buf: AVAudioPCMBuffer, to rate: Double) throws -> AVAudioPCMBuffer {
  if buf.format.sampleRate == rate { return buf }
  let fmt = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: buf.format.channelCount, interleaved: false)!
  guard let conv = AVAudioConverter(from: buf.format, to: fmt) else { throw PrepError.converter("resampler") }
  conv.sampleRateConverterQuality = AVAudioQuality.high.rawValue
  let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: AVAudioFrameCount(Double(buf.frameLength) * rate / buf.format.sampleRate) + 1024)!
  var fed = false
  var err: NSError?
  let status = conv.convert(to: out, error: &err) { _, st in
    if fed { st.pointee = .endOfStream; return nil }
    fed = true; st.pointee = .haveData; return buf
  }
  if status == .error { throw PrepError.converter(err?.localizedDescription ?? "resample") }
  return out
}

func encodeM4A(_ mono: AVAudioPCMBuffer, to url: URL, bitrate: Int) throws {
  try? FileManager.default.removeItem(at: url)
  let settings: [String: Any] = [
    AVFormatIDKey: kAudioFormatMPEG4AAC,
    AVSampleRateKey: mono.format.sampleRate,
    AVNumberOfChannelsKey: 1,
    AVEncoderBitRateKey: bitrate,
  ]
  let file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
  try file.write(from: mono)
}

func writeWav(_ buf: AVAudioPCMBuffer, to url: URL) throws {
  try? FileManager.default.removeItem(at: url)
  let file = try AVAudioFile(forWriting: url, settings: buf.format.settings, commonFormat: .pcmFormatFloat32, interleaved: false)
  try file.write(from: buf)
}

// MARK: - CLI

let args = CommandLine.arguments
guard args.count >= 3 else { print("usage: prep <in> <out.m4a> [startSec endSec] [--wav pcm.wav]"); exit(2) }
let inURL = URL(fileURLWithPath: args[1]), outURL = URL(fileURLWithPath: args[2])
let start = args.count > 4 ? Double(args[3]) : nil, end = args.count > 4 ? Double(args[4]) : nil
let wavPath = args.firstIndex(of: "--wav").map { args[$0 + 1] }
do {
  let t0 = Date()
  let pcm = try decodeAny(inURL)
  let mono = try resample(monoSlice(pcm, startSec: start, endSec: end), to: 48000)
  if let wavPath { try writeWav(mono, to: URL(fileURLWithPath: wavPath)) }
  let p = peaks(mono, buckets: 52)
  try encodeM4A(mono, to: outURL, bitrate: 64000)
  let ms = Int(Date().timeIntervalSince(t0) * 1000)
  print("ok in=\(inURL.lastPathComponent) sr=\(Int(pcm.format.sampleRate)) ch=\(pcm.format.channelCount) frames=\(pcm.frameLength) dur=\(String(format: "%.3f", Double(mono.frameLength) / mono.format.sampleRate))s time=\(ms)ms")
  print("peaks=\(p.map(String.init).joined(separator: ","))")
} catch {
  print("FAIL in=\(inURL.lastPathComponent) \(error)"); exit(1)
}
