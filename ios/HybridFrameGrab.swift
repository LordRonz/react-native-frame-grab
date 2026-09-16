//
//  HybridFrameGrab.swift
//  NitroFrameGrab
//
//  video URI -> AVAssetImageGenerator -> bounded scale -> ImageIO JPEG -> rename(2)
//

// AVFoundation is a pre-concurrency framework: the iOS 15 fallback path below
// hands `AVAsynchronousKeyValueLoading` to a `@Sendable` completion handler,
// which it has no Sendable annotations for.
@preconcurrency import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ImageIO
import NitroModules
import UniformTypeIdentifiers

private let maxOutputArea = 16_777_216
private let minMaxWidth = 1
private let maxMaxWidth = 4096

/// Blocking filesystem/ImageIO work runs here so it never occupies a slot in
/// Swift's cooperative thread pool (which is sized for non-blocking work).
/// Only jobs that already hold a scheduler slot reach this queue.
private let frameGrabIOQueue = DispatchQueue(
  label: "com.lordronz.framegrab.io", qos: .userInitiated, attributes: .concurrent)

/// Pre-admission validation stats the filesystem, which must not happen on the
/// JS thread either. Serial on purpose: a burst of rejected requests should not
/// explode GCD's thread pool before any of them has a slot.
private let frameGrabIntakeQueue = DispatchQueue(
  label: "com.lordronz.framegrab.intake", qos: .userInitiated)

private func onQueue<T>(
  _ queue: DispatchQueue, _ body: @escaping @Sendable () throws -> T
) async throws -> T {
  try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
    queue.async {
      do {
        continuation.resume(returning: try body())
      } catch {
        continuation.resume(throwing: error)
      }
    }
  }
}

private func millis(since start: DispatchTime) -> Double {
  Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
}

final class HybridFrameGrab: HybridFrameGrabSpec {
  var maxConcurrency: Double {
    get { Double(FrameGrabScheduler.shared.maxConcurrency) }
    set { FrameGrabScheduler.shared.maxConcurrency = Int(newValue.rounded()) }
  }

  func extract(request: NativeFrameGrabRequest) throws -> Promise<NativeFrameGrabOutcome> {
    // Copy out of the C++-backed struct so the task captures only Swift values.
    let sourceUri = request.sourceUri
    let destinationUri = request.destinationUri
    let timeUs = request.timeUs
    let maxWidth = request.maxWidth
    let quality = request.quality
    let precise = request.precise

    return Promise.async {
      do {
        let success = try await FrameGrabJob.run(
          sourceUri: sourceUri,
          destinationUri: destinationUri,
          timeUs: timeUs,
          maxWidth: maxWidth,
          quality: quality,
          precise: precise)
        return NativeFrameGrabOutcome(result: success, error: nil)
      } catch let failure as FrameGrabFailure {
        return NativeFrameGrabOutcome(
          result: nil,
          error: NativeFrameGrabFailure(code: failure.code.rawValue, message: failure.message))
      } catch {
        return NativeFrameGrabOutcome(
          result: nil,
          error: NativeFrameGrabFailure(
            code: FrameGrabCode.internalError.rawValue,
            message: "Unexpected native failure: \(error.localizedDescription)"))
      }
    }
  }
}

// MARK: - Job

private enum FrameGrabJob {

  static func run(
    sourceUri: String,
    destinationUri: String,
    timeUs: Double,
    maxWidth: Double,
    quality: Double,
    precise: Bool
  ) async throws -> NativeFrameGrabSuccess {

    // 1. Re-validate scalars at the native boundary before any conversion.
    guard timeUs.isFinite, timeUs >= 0, timeUs <= 9_007_199_254_740_991,
      timeUs.rounded() == timeUs
    else {
      throw FrameGrabFailure(.invalidArgument, "`timeMs` is out of the representable range.")
    }
    guard maxWidth.isFinite, maxWidth.rounded() == maxWidth,
      Int(maxWidth) >= minMaxWidth, Int(maxWidth) <= maxMaxWidth
    else {
      throw FrameGrabFailure(
        .invalidArgument, "`maxWidth` must be an integer in \(minMaxWidth)...\(maxMaxWidth).")
    }
    guard quality.isFinite, quality >= 0, quality <= 1 else {
      throw FrameGrabFailure(.invalidArgument, "`quality` must be between 0 and 1.")
    }
    let timeUsInt = Int64(timeUs)
    let widthBound = Int(maxWidth)

    // 2. Cheap URI + destination checks, off the cooperative pool.
    let source = try FrameGrabPaths.resolveSource(sourceUri)
    let destination = try FrameGrabPaths.resolveDestination(destinationUri)
    try await onQueue(frameGrabIntakeQueue) {
      try FrameGrabPaths.validateDestination(destination)
      try FrameGrabPaths.assertDistinct(source: source, destination: destination)
      if case .localFile(let url) = source,
        !FileManager.default.fileExists(atPath: url.path)
      {
        throw FrameGrabFailure(
          .sourceUnreadable, "Source file does not exist: \(frameGrabRedact(sourceUri))")
      }
    }

    // 3. Reserve the destination and take a slot. Nothing native is opened before this.
    let key = FrameGrabPaths.reservationKey(for: destination)
    let queueWaitMs = try await FrameGrabScheduler.shared.acquire(key: key)
    defer { FrameGrabScheduler.shared.release(key: key) }

    let temporaryURL = destination.deletingLastPathComponent()
      .appendingPathComponent(".framegrab-\(UUID().uuidString).jpg.tmp")
    var committed = false
    defer {
      if !committed {
        try? FileManager.default.removeItem(at: temporaryURL)
      }
    }

    // 4. Source + metadata.
    let sourceStart = DispatchTime.now()
    let asset = AVURLAsset(url: source.url)
    let sourceMs = millis(since: sourceStart)

    let metadataStart = DispatchTime.now()
    let (track, duration) = try await loadVideoTrack(asset, sourceUri: sourceUri)
    let display = try await displaySize(of: track)

    guard display.width.isFinite, display.height.isFinite,
      display.width >= 1, display.height >= 1
    else {
      throw FrameGrabFailure(
        .sourceUnreadable, "Video track reports unusable dimensions.")
    }

    // A timestamp equal to the duration is out of range. An unknown or
    // indefinite duration is not proof of anything: let extraction decide.
    let durationSeconds = CMTimeGetSeconds(duration)
    if duration.isValid, !duration.isIndefinite, durationSeconds.isFinite, durationSeconds > 0 {
      let durationUs = durationSeconds * 1_000_000
      if Double(timeUsInt) >= durationUs {
        throw FrameGrabFailure(
          .timestampOutOfRange,
          "Requested \(Double(timeUsInt) / 1000) ms but the source is \(durationUs / 1000) ms long.")
      }
    }

    let (targetWidth, targetHeight) = try fit(
      width: display.width, height: display.height, maxWidth: widthBound)
    let metadataMs = millis(since: metadataStart)

    // 5. Extraction.
    let extractStart = DispatchTime.now()
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.apertureMode = .cleanAperture
    generator.maximumSize = CGSize(width: targetWidth, height: targetHeight)
    let tolerance: CMTime = precise ? .zero : .positiveInfinity
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance

    let requestedTime = CMTime(value: timeUsInt, timescale: 1_000_000)
    let image = try await generateImage(generator: generator, at: requestedTime)
    let extractMs = millis(since: extractStart)

    guard image.width > 0, image.height > 0 else {
      throw FrameGrabFailure(.frameExtraction, "Decoder produced an empty image.")
    }

    // 6. Encode straight to the temporary sibling; the encoder streams to disk,
    //    so encode and write are one measurement.
    let encodeStart = DispatchTime.now()
    let boxedImage = FrameGrabBox(image)
    let boxedTemporary = FrameGrabBox(temporaryURL)
    let encoded = try await onQueue(frameGrabIOQueue) { () -> (Int, Int, UInt64) in
      let final = try bound(boxedImage.value, maxWidth: widthBound)
      guard final.width * final.height <= maxOutputArea else {
        throw FrameGrabFailure(
          .internalError,
          "Generated image (\(final.width)x\(final.height)) exceeds the output area limit.")
      }
      try encodeJPEG(final, to: boxedTemporary.value, quality: quality)
      let attributes = try FileManager.default.attributesOfItem(
        atPath: boxedTemporary.value.path)
      guard let size = (attributes[.size] as? NSNumber)?.uint64Value, size > 0 else {
        throw FrameGrabFailure(.encodeFailed, "Encoder produced an empty file.")
      }
      return (final.width, final.height, size)
    }
    let (width, height, byteSize) = encoded
    let encodeMs = millis(since: encodeStart)

    // 7. Commit. After this point the old destination is gone and we never
    //    fail the request for bookkeeping reasons.
    let finalizeStart = DispatchTime.now()
    let boxedDestination = FrameGrabBox(destination)
    try await onQueue(frameGrabIOQueue) {
      try atomicReplace(from: boxedTemporary.value, to: boxedDestination.value)
    }
    committed = true
    let finalizeMs = millis(since: finalizeStart)

    return NativeFrameGrabSuccess(
      uri: destination.absoluteString,
      width: Double(width),
      height: Double(height),
      size: Double(byteSize),
      timings: NativeFrameGrabTimings(
        queueWaitMs: queueWaitMs,
        sourceMs: sourceMs,
        metadataMs: metadataMs,
        extractMs: extractMs,
        encodeMs: encodeMs,
        finalizeMs: finalizeMs))
  }

  // MARK: Metadata

  private static func loadVideoTrack(
    _ asset: AVURLAsset, sourceUri: String
  ) async throws -> (AVAssetTrack, CMTime) {
    if #available(iOS 16.0, tvOS 16.0, visionOS 1.0, *) {
      do {
        async let durationTask = asset.load(.duration)
        async let tracksTask = asset.loadTracks(withMediaType: .video)
        let (duration, tracks) = try await (durationTask, tracksTask)
        guard let track = tracks.first else {
          throw FrameGrabFailure(
            .sourceUnreadable, "No usable video track in \(frameGrabRedact(sourceUri)).")
        }
        return (track, duration)
      } catch let failure as FrameGrabFailure {
        throw failure
      } catch {
        throw FrameGrabFailure(
          .sourceUnreadable,
          "Could not read \(frameGrabRedact(sourceUri)): \(error.localizedDescription)")
      }
    }
    try await loadLegacyValues(asset, keys: ["duration", "tracks"], sourceUri: sourceUri)
    guard let track = asset.tracks(withMediaType: .video).first else {
      throw FrameGrabFailure(
        .sourceUnreadable, "No usable video track in \(frameGrabRedact(sourceUri)).")
    }
    return (track, asset.duration)
  }

  private static func displaySize(of track: AVAssetTrack) async throws -> CGSize {
    let naturalSize: CGSize
    let transform: CGAffineTransform
    let formats: [CMFormatDescription]

    if #available(iOS 16.0, tvOS 16.0, visionOS 1.0, *) {
      do {
        let loaded = try await track.load(.naturalSize, .preferredTransform, .formatDescriptions)
        naturalSize = loaded.0
        transform = loaded.1
        formats = loaded.2
      } catch {
        throw FrameGrabFailure(
          .sourceUnreadable, "Could not read track properties: \(error.localizedDescription)")
      }
    } else {
      try await loadLegacyValues(
        track, keys: ["naturalSize", "preferredTransform", "formatDescriptions"],
        sourceUri: "")
      naturalSize = track.naturalSize
      transform = track.preferredTransform
      // The legacy accessor is an untyped `NSArray`. Cast the array, not each
      // element: a per-element `as?` to a CoreFoundation type is a hard error
      // ("will always succeed"), because CF types bridge unconditionally.
      formats = track.formatDescriptions as? [CMFormatDescription] ?? []
    }

    // Prefer presentation dimensions: they fold in the pixel aspect ratio and
    // clean aperture, which `naturalSize` alone ignores.
    var base = naturalSize
    if let format = formats.first {
      // Returns CMVideoDimensions (Int32), not a CGSize.
      let presentation = CMVideoFormatDescriptionGetPresentationDimensions(
        format, usePixelAspectRatio: true, useCleanAperture: true)
      if presentation.width > 0, presentation.height > 0 {
        base = CGSize(
          width: CGFloat(presentation.width), height: CGFloat(presentation.height))
      }
    }

    // `preferredTransform` carries the display rotation; take the bounding box.
    let rotated = CGRect(origin: .zero, size: base).applying(transform)
    return CGSize(width: abs(rotated.width), height: abs(rotated.height))
  }

  @available(iOS, deprecated: 16.0)
  private static func loadLegacyValues(
    _ object: AVAsynchronousKeyValueLoading, keys: [String], sourceUri: String
  ) async throws {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      object.loadValuesAsynchronously(forKeys: keys) {
        for key in keys {
          var error: NSError?
          let status = object.statusOfValue(forKey: key, error: &error)
          guard status == .loaded else {
            continuation.resume(
              throwing: FrameGrabFailure(
                .sourceUnreadable,
                "Could not load \"\(key)\" \(sourceUri.isEmpty ? "" : "for \(frameGrabRedact(sourceUri)) ")"
                  + "(\(error?.localizedDescription ?? "status \(status.rawValue)"))."))
            return
          }
        }
        continuation.resume()
      }
    }
  }

  // MARK: Scaling

  /// Fits the display size inside `maxWidth` without ever upscaling.
  private static func fit(width: CGFloat, height: CGFloat, maxWidth: Int) throws -> (Int, Int) {
    let scale = min(1.0, Double(maxWidth) / Double(width))
    let scaledWidth = Int((Double(width) * scale).rounded())
    let scaledHeight = Int((Double(height) * scale).rounded())
    let targetWidth = max(1, min(scaledWidth, maxWidth))
    let targetHeight = max(1, scaledHeight)
    guard targetWidth * targetHeight <= maxOutputArea else {
      throw FrameGrabFailure(
        .invalidArgument,
        "Output would be \(targetWidth)x\(targetHeight), over the \(maxOutputArea) pixel limit.")
    }
    return (targetWidth, targetHeight)
  }

  // MARK: Extraction

  private static func generateImage(
    generator: AVAssetImageGenerator, at time: CMTime
  ) async throws -> CGImage {
    if #available(iOS 16.0, tvOS 16.0, visionOS 1.0, *) {
      do {
        return try await generator.image(at: time).image
      } catch let failure as FrameGrabFailure {
        throw failure
      } catch {
        throw FrameGrabFailure(
          .frameExtraction, "Frame extraction failed: \(error.localizedDescription)")
      }
    }
    return try await withCheckedThrowingContinuation {
      (continuation: CheckedContinuation<CGImage, Error>) in
      // With a single requested time this handler runs exactly once.
      generator.generateCGImagesAsynchronously(forTimes: [NSValue(time: time)]) {
        _, image, _, result, error in
        switch result {
        case .succeeded:
          if let image {
            continuation.resume(returning: image)
          } else {
            continuation.resume(
              throwing: FrameGrabFailure(.frameExtraction, "Decoder returned no image."))
          }
        case .failed:
          continuation.resume(
            throwing: FrameGrabFailure(
              .frameExtraction,
              "Frame extraction failed: \(error?.localizedDescription ?? "unknown error")"))
        case .cancelled:
          continuation.resume(
            throwing: FrameGrabFailure(.frameExtraction, "Frame extraction was cancelled."))
        @unknown default:
          continuation.resume(
            throwing: FrameGrabFailure(.internalError, "Unknown image generation result."))
        }
      }
    }
  }

  /// Single bounded, aspect-preserving redraw, based on the image we actually got.
  ///
  /// `maximumSize` should already have handled this, and normally this is a
  /// no-op. The contract says the final width never exceeds `maxWidth`, so if the
  /// generator ever rounds the other way we honour the contract instead of
  /// failing an otherwise valid request.
  private static func bound(_ image: CGImage, maxWidth: Int) throws -> CGImage {
    guard image.width > maxWidth else { return image }

    let scale = Double(maxWidth) / Double(image.width)
    let height = max(1, Int((Double(image.height) * scale).rounded()))
    guard
      let context = CGContext(
        data: nil,
        width: maxWidth,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(),
        // JPEG has no alpha channel; dropping it here avoids a needless convert.
        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
    else {
      throw FrameGrabFailure(.encodeFailed, "Could not allocate a scaling context.")
    }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: maxWidth, height: height))
    guard let scaled = context.makeImage() else {
      throw FrameGrabFailure(.encodeFailed, "Scaling the extracted frame failed.")
    }
    return scaled
  }

  // MARK: Encode + commit

  private static func encodeJPEG(_ image: CGImage, to url: URL, quality: Double) throws {
    guard
      let destination = CGImageDestinationCreateWithURL(
        url as CFURL, UTType.jpeg.identifier as CFString, 1, nil)
    else {
      throw FrameGrabFailure(
        .destinationWrite, "Could not open a temporary file for writing in the destination folder.")
    }
    // Pixels are already upright (appliesPreferredTrackTransform), so no EXIF
    // orientation tag is written: consumers get what they see.
    CGImageDestinationAddImage(
      destination, image,
      [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
    guard CGImageDestinationFinalize(destination) else {
      throw FrameGrabFailure(.encodeFailed, "JPEG encoding failed.")
    }
  }

  /// `rename(2)` on the same filesystem is atomic and replaces an existing
  /// destination in one step. The temporary file is a sibling, so EXDEV
  /// cannot happen. Never delete-then-move: that loses the old file on failure.
  private static func atomicReplace(from temporary: URL, to destination: URL) throws {
    var savedErrno: Int32 = 0
    let ok = temporary.path.withCString { source in
      destination.path.withCString { target -> Bool in
        if rename(source, target) == 0 { return true }
        savedErrno = errno
        return false
      }
    }
    guard ok else {
      throw FrameGrabFailure(
        .destinationWrite,
        "Could not finalize the destination file: \(String(cString: strerror(savedErrno)))")
    }
  }
}
