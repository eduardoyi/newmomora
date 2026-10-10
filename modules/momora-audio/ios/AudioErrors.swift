import Foundation

/// Stable error codes shared with the Android module and the TS wrapper
/// (`modules/momora-audio/src/index.ts`). Callers branch on these strings.
///
/// Messages must never contain file names or paths: they surface in Sentry and
/// logs, and voice notes of children are PII. System errors are therefore
/// reported as an OSStatus number only, never via `localizedDescription`
/// (Foundation puts the file name in it).
enum MomoraAudioErrorCode: String {
  case unsupportedFormat = "unsupported_format"
  case decodeFailed = "decode_failed"
  case tooLong = "too_long"
  case ioFailed = "io_failed"
}

struct MomoraAudioError: Error {
  let code: MomoraAudioErrorCode
  let message: String

  init(_ code: MomoraAudioErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }

  /// Maps an arbitrary system error to a stable code without leaking its text.
  static func from(_ error: Error, fallback: MomoraAudioErrorCode = .decodeFailed) -> MomoraAudioError {
    if let own = error as? MomoraAudioError { return own }
    let ns = error as NSError
    // AudioFile/AudioConverter OSStatus values arrive as NSOSStatusErrorDomain or
    // AVFoundation errors wrapping them. Four-char codes: 'typ?' / 'fmt?' mean
    // "not a format we can read"; anything else ('dta?' malformed, 'wht?' unspecified)
    // is treated as a decode failure.
    let status = ns.code
    switch status {
    case 1954115647 /* 'typ?' */, 1718449215 /* 'fmt?' */:
      return MomoraAudioError(.unsupportedFormat, "Unsupported audio format (OSStatus \(status))")
    case NSFileReadNoSuchFileError, NSFileNoSuchFileError, NSFileReadNoPermissionError,
      NSFileWriteOutOfSpaceError, NSFileWriteNoPermissionError, NSFileWriteUnknownError:
      if ns.domain == NSCocoaErrorDomain {
        return MomoraAudioError(.ioFailed, "File access failed (code \(status))")
      }
    default:
      break
    }
    return MomoraAudioError(fallback, "Audio error (domain \(ns.domain), code \(status))")
  }
}
