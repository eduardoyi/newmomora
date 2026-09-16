import ExpoModulesCore
import Foundation
import ImageIO
import WidgetKit

private let momoraWidgetAppGroup = "group.com.memora.app.widgets"
private let momoraWidgetLease: TimeInterval = 168 * 60 * 60
private let momoraWidgetMaxImageBytes: Int64 = 1 * 1024 * 1024
private let momoraWidgetMaxCacheBytes: Int64 = 10 * 1024 * 1024
private let momoraWidgetMaxImageEdge = 512
private let momoraWidgetTimelineKey = "__expo_widgets_MomoraMemoryWidget_timeline"

private enum MomoraWidgetError: Error {
  case invalidManifest(String)
  case invalidFile(String)
  case staleGeneration
  case unavailable
}

private struct MomoraWidgetEntry {
  let startsAt: Date
  let memoryId: String
  let imageFilename: String?
  let excerpt: String
  let dateLabel: String
  let background: String
  let foreground: String
}

private struct MomoraWidgetManifest {
  let raw: String
  let accountId: String
  let familyId: String
  let generationId: String
  let verifiedAt: Date
  let expiresAt: Date
  let entries: [MomoraWidgetEntry]
}

private final class MomoraWidgetStore {
  private let lock = NSLock()
  private let defaults = UserDefaults(suiteName: momoraWidgetAppGroup)
  private let fileManager = FileManager.default

  private var container: URL? {
    fileManager.containerURL(forSecurityApplicationGroupIdentifier: momoraWidgetAppGroup)
  }

  func sharedDirectory() throws -> URL {
    guard let container else { throw MomoraWidgetError.unavailable }
    let root = container.appendingPathComponent("Library/Caches/momora-widget", isDirectory: true)
    try fileManager.createDirectory(at: root, withIntermediateDirectories: true)
    return root
  }

  func readManifest() -> String? {
    guard let raw = try? readActiveManifest(enforceExpiry: true) else { return nil }
    return raw
  }

  func publish(manifestJson: String, filesJson: String) throws {
    let manifest = try parseManifest(manifestJson, enforceExpiry: true)
    let files = try parseFiles(filesJson)
    let expected = Set(manifest.entries.compactMap(\.imageFilename))
    guard Set(files.keys) == expected else {
      throw MomoraWidgetError.invalidFile("files do not match the manifest")
    }

    let token = beginPublish(generationId: manifest.generationId)
    let root = try sharedDirectory()
    let stagingRoot = root.appendingPathComponent("staging", isDirectory: true)
    let generationsRoot = root.appendingPathComponent("generations", isDirectory: true)
    try fileManager.createDirectory(at: stagingRoot, withIntermediateDirectories: true)
    try fileManager.createDirectory(at: generationsRoot, withIntermediateDirectories: true)
    let stage = stagingRoot.appendingPathComponent(
      "\(manifest.generationId)-\(UUID().uuidString)",
      isDirectory: true,
    )

    do {
      try fileManager.createDirectory(at: stage, withIntermediateDirectories: true)
      var totalBytes = Int64(manifestJson.utf8.count)
      for filename in expected {
        guard let source = files[filename] else {
          throw MomoraWidgetError.invalidFile("missing image source")
        }
        let sourceURL = try safeSourceURL(source)
        let destination = stage.appendingPathComponent(filename, isDirectory: false)
        let size = try copyImage(sourceURL, to: destination)
        totalBytes += size
      }
      guard totalBytes <= momoraWidgetMaxCacheBytes else {
        throw MomoraWidgetError.invalidFile("cache exceeds size limit")
      }
      let manifestURL = stage.appendingPathComponent("manifest.json", isDirectory: false)
      guard let manifestData = manifestJson.data(using: .utf8) else {
        throw MomoraWidgetError.invalidManifest("manifest is not UTF-8")
      }
      try manifestData.write(to: manifestURL, options: [.atomic, .completeFileProtection])

      lock.lock()
      defer { lock.unlock() }
      guard isPublishCurrent(token: token, generationId: manifest.generationId) else {
        throw MomoraWidgetError.staleGeneration
      }
      let destination = generationsRoot.appendingPathComponent(manifest.generationId, isDirectory: true)
      if fileManager.fileExists(atPath: destination.path) {
        try fileManager.removeItem(at: destination)
      }
      try fileManager.moveItem(at: stage, to: destination)
      let pointer = root.appendingPathComponent("active_generation", isDirectory: false)
      try Data(manifest.generationId.utf8).write(to: pointer, options: [.atomic, .completeFileProtection])
      defaults?.removeObject(forKey: "pending_generation")
      garbageCollect(generationsRoot, activeGeneration: manifest.generationId)
    } catch {
      if fileManager.fileExists(atPath: stage.path) {
        try? fileManager.removeItem(at: stage)
      }
      lock.lock()
      if isPublishCurrent(token: token, generationId: manifest.generationId) {
        defaults?.removeObject(forKey: "pending_generation")
      }
      lock.unlock()
      throw error
    }
  }

  func clear(scopeJson: String?, generationId: String?) throws -> Bool {
    let requestedScope = parseScope(scopeJson)
    let token = beginClear()
    let root = try sharedDirectory()
    lock.lock()
    defer { lock.unlock() }
    guard token == mutationEpoch() else { return false }
    if let active = try? readActiveSnapshot(enforceExpiry: false) {
      if let requestedScope,
         active.accountId != requestedScope.accountId || active.familyId != requestedScope.familyId {
        return false
      }
      if let generationId, active.generationId != generationId {
        return false
      }
    }
    let pointer = root.appendingPathComponent("active_generation", isDirectory: false)
    try? fileManager.removeItem(at: pointer)
    let generations = root.appendingPathComponent("generations", isDirectory: true)
    let staging = root.appendingPathComponent("staging", isDirectory: true)
    if let children = try? fileManager.contentsOfDirectory(at: generations, includingPropertiesForKeys: nil) {
      for child in children { try? fileManager.removeItem(at: child) }
    }
    if let children = try? fileManager.contentsOfDirectory(at: staging, includingPropertiesForKeys: nil) {
      for child in children { try? fileManager.removeItem(at: child) }
    }
    // expo-widgets persists its isolated timeline separately from this cache.
    // Replace it while the scope/generation fence is held so a killed app
    // cannot leave the previous family's private text or image on screen.
    defaults?.set([
      [
        "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        "props": ["kind": "neutral", "deepLink": "momora://widget"],
      ],
    ], forKey: momoraWidgetTimelineKey)
    return true
  }

  private func readActiveManifest(enforceExpiry: Bool) throws -> String {
    let snapshot = try readActiveSnapshot(enforceExpiry: enforceExpiry)
    return snapshot.raw
  }

  private func readActiveSnapshot(enforceExpiry: Bool) throws -> MomoraWidgetManifest {
    let root = try sharedDirectory()
    let pointer = root.appendingPathComponent("active_generation", isDirectory: false)
    let generationId = try String(contentsOf: pointer, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    guard Self.safeFilename(generationId) else {
      throw MomoraWidgetError.invalidManifest("active generation is unsafe")
    }
    let manifestURL = root
      .appendingPathComponent("generations", isDirectory: true)
      .appendingPathComponent(generationId, isDirectory: true)
      .appendingPathComponent("manifest.json", isDirectory: false)
    let raw = try String(contentsOf: manifestURL, encoding: .utf8)
    return try parseManifest(raw, enforceExpiry: enforceExpiry)
  }

  private func beginPublish(generationId: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    let next = mutationEpoch() + 1
    defaults?.set(next, forKey: "mutation_epoch")
    defaults?.set(generationId, forKey: "pending_generation")
    return next
  }

  private func beginClear() -> Int {
    lock.lock()
    defer { lock.unlock() }
    let next = mutationEpoch() + 1
    defaults?.set(next, forKey: "mutation_epoch")
    defaults?.removeObject(forKey: "pending_generation")
    return next
  }

  private func mutationEpoch() -> Int {
    defaults?.integer(forKey: "mutation_epoch") ?? 0
  }

  private func isPublishCurrent(token: Int, generationId: String) -> Bool {
    token == mutationEpoch() && defaults?.string(forKey: "pending_generation") == generationId
  }

  private func parseScope(_ raw: String?) -> (accountId: String, familyId: String)? {
    guard let raw, let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let accountId = object["accountId"] as? String, !accountId.isEmpty,
          let familyId = object["familyId"] as? String, !familyId.isEmpty else {
      return nil
    }
    return (accountId, familyId)
  }

  private func parseFiles(_ raw: String) throws -> [String: String] {
    guard let data = raw.data(using: .utf8),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw MomoraWidgetError.invalidFile("files are not valid JSON")
    }
    var files: [String: String] = [:]
    for (filename, value) in object {
      guard Self.safeFilename(filename), !filename.contains(".."),
            let uri = value as? String, !uri.isEmpty else {
        throw MomoraWidgetError.invalidFile("unsafe widget filename")
      }
      files[filename] = uri
    }
    return files
  }

  private func parseManifest(_ raw: String, enforceExpiry: Bool) throws -> MomoraWidgetManifest {
    guard let data = raw.data(using: .utf8),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let schema = root["schemaVersion"] as? Int, schema == 1,
          let accountId = boundedString(root["accountId"], max: 128),
          let familyId = boundedString(root["familyId"], max: 128),
          let generationId = boundedString(root["generationId"], max: 128),
          Self.safeFilename(generationId),
          let timezone = boundedString(root["timezone"], max: 128), !timezone.isEmpty,
          let verifiedAt = parseDate(root["verifiedAt"]),
          let expiresAt = parseDate(root["expiresAt"]),
          let entries = root["entries"] as? [[String: Any]], entries.count <= 7 else {
      throw MomoraWidgetError.invalidManifest("manifest fields are invalid")
    }
    _ = timezone
    guard expiresAt.timeIntervalSince(verifiedAt) == momoraWidgetLease else {
      throw MomoraWidgetError.invalidManifest("manifest lease is not 168 hours")
    }
    if enforceExpiry && expiresAt <= Date() {
      throw MomoraWidgetError.invalidManifest("manifest lease has expired")
    }

    var parsedEntries: [MomoraWidgetEntry] = []
    var previousStart: Date?
    for entry in entries {
      guard let kind = boundedString(entry["kind"], max: 32),
            ["illustration", "photo", "video", "audio", "text", "neutral"].contains(kind),
            let memoryId = boundedString(entry["memoryId"], max: 128),
            let memoryDate = boundedString(entry["memoryDate"], max: 10),
            Self.safeDate(memoryDate),
            let dateLabel = boundedString(entry["dateLabel"], max: 80),
            let excerpt = boundedString(entry["excerpt"], max: 500),
            let startsAt = parseDate(entry["startsAt"]),
            parseDate(entry["sourceUpdatedAt"]) != nil,
            let colors = entry["colors"] as? [String: Any],
            let background = boundedString(colors["background"], max: 9),
            let foreground = boundedString(colors["foreground"], max: 9),
            Self.safeColor(background), Self.safeColor(foreground) else {
        throw MomoraWidgetError.invalidManifest("manifest entry is invalid")
      }
      if let mediaIndexValue = entry["mediaIndex"] {
        guard let mediaIndex = mediaIndexValue as? NSNumber,
              mediaIndex.doubleValue.rounded() == mediaIndex.doubleValue,
              (0...9).contains(mediaIndex.intValue) else {
          throw MomoraWidgetError.invalidManifest("manifest media index is invalid")
        }
      }
      if let accent = colors["accent"] as? String, !Self.safeColor(accent) {
        throw MomoraWidgetError.invalidManifest("manifest accent color is invalid")
      }
      let imageFilename: String?
      if let image = entry["imageFilename"] {
        guard let filename = boundedString(image, max: 180), Self.safeFilename(filename), !filename.contains("..") else {
          throw MomoraWidgetError.invalidManifest("manifest image filename is unsafe")
        }
        imageFilename = filename
      } else {
        imageFilename = nil
      }
      guard startsAt >= verifiedAt, startsAt < expiresAt,
            previousStart == nil || startsAt > previousStart! else {
        throw MomoraWidgetError.invalidManifest("manifest entries are outside the lease")
      }
      previousStart = startsAt
      parsedEntries.append(MomoraWidgetEntry(
        startsAt: startsAt,
        memoryId: memoryId,
        imageFilename: imageFilename,
        excerpt: excerpt,
        dateLabel: dateLabel,
        background: background,
        foreground: foreground,
      ))
    }

    return MomoraWidgetManifest(
      raw: raw,
      accountId: accountId,
      familyId: familyId,
      generationId: generationId,
      verifiedAt: verifiedAt,
      expiresAt: expiresAt,
      entries: parsedEntries,
    )
  }

  private func parseDate(_ value: Any?) -> Date? {
    guard let value = value as? String, value.count <= 40 else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }

  private func boundedString(_ value: Any?, max: Int) -> String? {
    guard let value = value as? String, !value.isEmpty, value.count <= max,
          !value.unicodeScalars.contains(where: { $0.value == 0 }) else { return nil }
    return value
  }

  private func safeSourceURL(_ raw: String) throws -> URL {
    guard let url = URL(string: raw), url.isFileURL else {
      throw MomoraWidgetError.invalidFile("image source must be local")
    }
    let source = url.standardizedFileURL
    let roots = [
      fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first,
      fileManager.urls(for: .documentDirectory, in: .userDomainMask).first,
      fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first,
      fileManager.temporaryDirectory,
    ].compactMap { $0?.standardizedFileURL }
    guard roots.contains(where: { source.path == $0.path || source.path.hasPrefix($0.path + "/") }) else {
      throw MomoraWidgetError.invalidFile("image source is outside app storage")
    }
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: source.path, isDirectory: &isDirectory), !isDirectory.boolValue else {
      throw MomoraWidgetError.invalidFile("image source is unavailable")
    }
    return source
  }

  private func copyImage(_ source: URL, to destination: URL) throws -> Int64 {
    let attributes = try fileManager.attributesOfItem(atPath: source.path)
    guard let size = attributes[.size] as? NSNumber, size.int64Value > 0,
          size.int64Value <= momoraWidgetMaxImageBytes else {
      throw MomoraWidgetError.invalidFile("image exceeds size limit")
    }
    guard let imageSource = CGImageSourceCreateWithURL(source as CFURL, nil),
          CGImageSourceGetCount(imageSource) > 0,
          let properties = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [String: Any],
          let width = properties[kCGImagePropertyPixelWidth as String] as? NSNumber,
          let height = properties[kCGImagePropertyPixelHeight as String] as? NSNumber,
          width.intValue > 0,
          height.intValue > 0,
          max(width.intValue, height.intValue) <= momoraWidgetMaxImageEdge else {
      throw MomoraWidgetError.invalidFile("image is not decodable")
    }
    try fileManager.copyItem(at: source, to: destination)
    return size.int64Value
  }

  private func garbageCollect(_ generations: URL, activeGeneration: String) {
    guard let children = try? fileManager.contentsOfDirectory(at: generations, includingPropertiesForKeys: nil) else {
      return
    }
    for child in children where child.lastPathComponent != activeGeneration {
      try? fileManager.removeItem(at: child)
    }
  }

  private static func safeFilename(_ value: String) -> Bool {
    guard !value.isEmpty, value.count <= 180,
          value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]*$", options: .regularExpression) != nil else {
      return false
    }
    return true
  }

  private static func safeColor(_ value: String) -> Bool {
    value.range(of: "^#(?:[0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$", options: .regularExpression) != nil
  }

  private static func safeDate(_ value: String) -> Bool {
    value.range(of: "^\\d{4}-\\d{2}-\\d{2}$", options: .regularExpression) != nil
  }
}

public class MomoraWidgetModule: Module {
  private let store = MomoraWidgetStore()

  public func definition() -> ModuleDefinition {
    Name("MomoraWidget")

    Function("getCapabilities") { [store] in
      let sharedDirectory = try? store.sharedDirectory().path
      var capabilities: [String: Any] = [
        "supported": sharedDirectory != nil,
        "enabled": sharedDirectory != nil,
        "platform": "ios",
        "supportsSystemSmall": true,
        "supportsAndroidTall": false,
      ]
      if let sharedDirectory {
        capabilities["sharedDirectory"] = sharedDirectory
      }
      return capabilities
    }

    AsyncFunction("readManifest") { [store] in
      store.readManifest()
    }

    AsyncFunction("publishManifest") { [store] (manifestJson: String, filesJson: String) in
      try store.publish(manifestJson: manifestJson, filesJson: filesJson)
      WidgetCenter.shared.reloadAllTimelines()
    }

    AsyncFunction("clearManifest") { [store] (scopeJson: String?, generationId: String?) in
      let cleared = try store.clear(scopeJson: scopeJson, generationId: generationId)
      WidgetCenter.shared.reloadAllTimelines()
      return cleared
    }

    Function("reload") {
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
}
