import ExpoModulesCore
import UIKit
import VisionKit

private let artworkScanJpegQuality: CGFloat = 0.95
private let artworkScanCacheDirectoryName = "momora-artwork-scanner"

// MARK: - Records

internal struct ArtworkScanOptions: Record {
  // iOS VisionKit has no page-limit API; JS truncates. Accepted for parity.
  // swiftlint:disable:next redundant_optional_initialization
  @Field var pageLimit: Int? = nil
}

internal struct ArtworkScanPage: Record {
  @Field var uri: String = ""
  @Field var width: Int = 0
  @Field var height: Int = 0
}

internal struct ArtworkScanResult: Record {
  @Field var status: String = "cancel"
  @Field var pages: [ArtworkScanPage] = []
}

// MARK: - Exceptions

internal final class ScannerUnavailableException: Exception {
  override var code: String { "scanner_unavailable" }
  override var reason: String { "The document scanner is not supported on this device" }
}

internal final class ScannerFailedException: Exception {
  private let detail: String

  init(_ detail: String = "The document scanner failed") {
    self.detail = detail
    super.init()
  }

  override var code: String { "scanner_failed" }
  override var reason: String { detail }
}

internal final class ScannerBusyException: Exception {
  override var code: String { "scanner_busy" }
  override var reason: String { "A scan is already in progress" }
}

// MARK: - Delegate

/**
 `VNDocumentCameraViewController.delegate` is weak, so the module keeps this
 object alive (together with the pending promise) until a callback fires.
 */
internal final class ArtworkScanDelegate: NSObject, VNDocumentCameraViewControllerDelegate {
  private let onFinish: (VNDocumentCameraViewController, VNDocumentCameraScan) -> Void
  private let onCancel: (VNDocumentCameraViewController) -> Void
  private let onFail: (VNDocumentCameraViewController, Error) -> Void

  init(
    onFinish: @escaping (VNDocumentCameraViewController, VNDocumentCameraScan) -> Void,
    onCancel: @escaping (VNDocumentCameraViewController) -> Void,
    onFail: @escaping (VNDocumentCameraViewController, Error) -> Void
  ) {
    self.onFinish = onFinish
    self.onCancel = onCancel
    self.onFail = onFail
  }

  func documentCameraViewController(
    _ controller: VNDocumentCameraViewController,
    didFinishWith scan: VNDocumentCameraScan
  ) {
    onFinish(controller, scan)
  }

  func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
    onCancel(controller)
  }

  func documentCameraViewController(
    _ controller: VNDocumentCameraViewController,
    didFailWithError error: Error
  ) {
    onFail(controller, error)
  }
}

private struct PendingArtworkScan {
  let promise: Promise
  let delegate: ArtworkScanDelegate
}

// MARK: - Module

public class MomoraArtworkScannerModule: Module {
  /// Only read or written on the main queue.
  private var pendingScan: PendingArtworkScan?

  public func definition() -> ModuleDefinition {
    Name("MomoraArtworkScanner")

    Function("isAvailable") {
      VNDocumentCameraViewController.isSupported
    }

    AsyncFunction("scan") { (_: ArtworkScanOptions, promise: Promise) in
      guard VNDocumentCameraViewController.isSupported else {
        promise.reject(ScannerUnavailableException())
        return
      }

      if pendingScan != nil {
        promise.reject(ScannerBusyException())
        return
      }

      guard let currentViewController = appContext?.utilities?.currentViewController() else {
        promise.reject(ScannerFailedException("Could not find the current view controller"))
        return
      }

      let delegate = ArtworkScanDelegate(
        onFinish: { [weak self] controller, scan in
          self?.handleFinish(controller: controller, scan: scan)
        },
        onCancel: { [weak self] controller in
          self?.handleCancel(controller: controller)
        },
        onFail: { [weak self] controller, _ in
          self?.handleFailure(controller: controller)
        }
      )

      let scanner = VNDocumentCameraViewController()
      scanner.delegate = delegate
      scanner.modalPresentationStyle = .fullScreen

      pendingScan = PendingArtworkScan(promise: promise, delegate: delegate)
      currentViewController.present(scanner, animated: true)
    }.runOnQueue(.main)
  }

  // MARK: - Delegate handling (main queue)

  private func handleCancel(controller: VNDocumentCameraViewController) {
    controller.dismiss(animated: true)
    guard let context = pendingScan else { return }
    pendingScan = nil
    context.promise.resolve(ArtworkScanResult())
  }

  private func handleFailure(controller: VNDocumentCameraViewController) {
    controller.dismiss(animated: true)
    guard let context = pendingScan else { return }
    pendingScan = nil
    context.promise.reject(ScannerFailedException())
  }

  private func handleFinish(controller: VNDocumentCameraViewController, scan: VNDocumentCameraScan) {
    controller.dismiss(animated: true)

    // Encoding full-resolution pages is slow; keep the main queue free. The
    // pending context stays set until the files are written so a second scan
    // can't start meanwhile.
    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      let outcome: Result<[ArtworkScanPage], Error>
      do {
        outcome = .success(try Self.writePages(of: scan))
      } catch {
        outcome = .failure(error)
      }

      DispatchQueue.main.async {
        guard let self, let context = self.pendingScan else { return }
        self.pendingScan = nil

        switch outcome {
        case .success(let pages):
          var result = ArtworkScanResult()
          result.status = pages.isEmpty ? "cancel" : "success"
          result.pages = pages
          context.promise.resolve(result)
        case .failure:
          context.promise.reject(ScannerFailedException())
        }
      }
    }
  }

  // MARK: - File output

  private static func writePages(of scan: VNDocumentCameraScan) throws -> [ArtworkScanPage] {
    let fileManager = FileManager.default
    guard let cachesDirectory = fileManager.urls(for: .cachesDirectory, in: .userDomainMask).first else {
      throw ScannerFailedException("Could not find the caches directory")
    }
    let outputDirectory = cachesDirectory.appendingPathComponent(
      artworkScanCacheDirectoryName,
      isDirectory: true
    )
    try fileManager.createDirectory(at: outputDirectory, withIntermediateDirectories: true)

    var written: [URL] = []
    var pages: [ArtworkScanPage] = []

    do {
      for index in 0..<scan.pageCount {
        try autoreleasepool {
          let image = scan.imageOfPage(at: index)
          guard let data = image.jpegData(compressionQuality: artworkScanJpegQuality) else {
            throw ScannerFailedException("Could not encode the scanned page")
          }

          let fileUrl = outputDirectory
            .appendingPathComponent(UUID().uuidString.lowercased())
            .appendingPathExtension("jpg")
          try data.write(to: fileUrl, options: .atomic)
          written.append(fileUrl)

          // `UIImage.size` is in points and accounts for orientation.
          let pixelWidth = Int((image.size.width * image.scale).rounded())
          let pixelHeight = Int((image.size.height * image.scale).rounded())
          pages.append(ArtworkScanPage(uri: fileUrl.absoluteString, width: pixelWidth, height: pixelHeight))
        }
      }
    } catch {
      // Don't leave a half-written batch behind.
      for fileUrl in written {
        try? fileManager.removeItem(at: fileUrl)
      }
      throw error
    }

    return pages
  }
}
