//
//  FrameGrabSupport.swift
//  NitroFrameGrab
//
//  Error contract, module-wide scheduler, and URI/destination resolution.
//

import Foundation

// MARK: - Errors

enum FrameGrabCode: String {
  case invalidArgument = "E_INVALID_ARGUMENT"
  case unsupportedUri = "E_UNSUPPORTED_URI"
  case sourceUnreadable = "E_SOURCE_UNREADABLE"
  case timestampOutOfRange = "E_TIMESTAMP_OUT_OF_RANGE"
  case frameExtraction = "E_FRAME_EXTRACTION"
  case encodeFailed = "E_ENCODE_FAILED"
  case destinationWrite = "E_DESTINATION_WRITE"
  case destinationBusy = "E_DESTINATION_BUSY"
  case busy = "E_BUSY"
  case internalError = "E_INTERNAL"
}

struct FrameGrabFailure: Error {
  let code: FrameGrabCode
  let message: String

  init(_ code: FrameGrabCode, _ message: String) {
    self.code = code
    self.message = message
  }
}

/// Keep native error identities when bridging to JS. AVFoundation often hides
/// the useful OSStatus several levels down. Do not dump underlying userInfo:
/// it can contain signed URLs and other sensitive source details.
func frameGrabDescribe(_ error: Error) -> String {
  let ns = error as NSError
  var parts = ["\(ns.localizedDescription) [\(ns.domain) \(ns.code)]"]
  var seen: Set<ObjectIdentifier> = [ObjectIdentifier(ns)]
  var current = ns
  while let underlying = current.userInfo[NSUnderlyingErrorKey] as? NSError,
    seen.insert(ObjectIdentifier(underlying)).inserted
  {
    parts.append("underlying \(underlying.domain) \(underlying.code)")
    current = underlying
  }
  return parts.joined(separator: " — ")
}

/// Strips credentials and query strings from remote URIs before they reach a
/// log line or a JS error message. Signed URLs are secrets.
func frameGrabRedact(_ uri: String) -> String {
  guard var components = URLComponents(string: uri),
    let scheme = components.scheme?.lowercased(),
    scheme == "http" || scheme == "https"
  else {
    return uri
  }
  components.user = nil
  components.password = nil
  components.query = nil
  components.fragment = nil
  return components.string ?? "\(scheme)://<redacted>"
}

// MARK: - Scheduler

/// One module-wide bounded dispatcher.
///
/// Holds two things for the lifetime of a job:
/// - a concurrency slot (`maxConcurrency`, default 2)
/// - a destination reservation, keyed by the canonical destination path
///
/// Admission failures never leave state behind; `release` is the only exit.
final class FrameGrabScheduler: @unchecked Sendable {
  static let shared = FrameGrabScheduler()

  /// Admission control, not cancellation: beyond this we reject with `E_BUSY`.
  static let maxPending = 64

  private struct Waiter {
    let continuation: CheckedContinuation<Void, Error>
  }

  private let lock = NSLock()
  private var active = 0
  private var storedMaxConcurrency = 2
  private var pending: [Waiter] = []
  private var reservations = Set<String>()

  private init() {}

  var maxConcurrency: Int {
    get {
      lock.lock()
      defer { lock.unlock() }
      return storedMaxConcurrency
    }
    set {
      let clamped = max(1, min(16, newValue))
      var toResume: [Waiter] = []
      lock.lock()
      storedMaxConcurrency = clamped
      // Raising the bound should let queued jobs start immediately.
      while active < storedMaxConcurrency, !pending.isEmpty {
        active += 1
        toResume.append(pending.removeFirst())
      }
      lock.unlock()
      toResume.forEach { $0.continuation.resume() }
    }
  }

  /// Reserves `key` and waits for a slot. Returns the queue wait in milliseconds.
  /// Throws `E_DESTINATION_BUSY` or `E_BUSY` without reserving anything.
  func acquire(key: String) async throws -> Double {
    let start = DispatchTime.now()
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      lock.lock()

      guard reservations.insert(key).inserted else {
        lock.unlock()
        continuation.resume(
          throwing: FrameGrabFailure(
            .destinationBusy,
            "Another extraction is already pending or running for this destination."))
        return
      }

      if active < storedMaxConcurrency {
        active += 1
        lock.unlock()
        continuation.resume()
        return
      }

      if pending.count >= Self.maxPending {
        reservations.remove(key)
        lock.unlock()
        continuation.resume(
          throwing: FrameGrabFailure(
            .busy, "Too many queued extractions (limit \(Self.maxPending))."))
        return
      }

      pending.append(Waiter(continuation: continuation))
      lock.unlock()
    }
    return Double(DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
  }

  /// Releases the reservation and hands the slot to the next queued job.
  func release(key: String) {
    lock.lock()
    reservations.remove(key)
    if pending.isEmpty {
      active -= 1
      lock.unlock()
      return
    }
    let next = pending.removeFirst()
    lock.unlock()
    next.continuation.resume()
  }
}

// MARK: - URI resolution

enum FrameGrabSource {
  case localFile(URL)
  case remote(URL)

  var url: URL {
    switch self {
    case .localFile(let url), .remote(let url): return url
    }
  }
}

enum FrameGrabPaths {
  /// `URL(string:)` returns nil for unencoded characters such as spaces.
  /// `.urlFragmentAllowed` preserves existing percent-escapes, so this is safe
  /// to run on already-encoded input.
  static func parse(_ raw: String) -> URL? {
    if let url = URL(string: raw) { return url }
    guard let encoded = raw.addingPercentEncoding(withAllowedCharacters: .urlFragmentAllowed)
    else { return nil }
    return URL(string: encoded)
  }

  static func resolveSource(_ raw: String) throws -> FrameGrabSource {
    if raw.hasPrefix("/") {
      return .localFile(URL(fileURLWithPath: raw).standardizedFileURL)
    }
    guard let url = parse(raw), let scheme = url.scheme?.lowercased() else {
      throw FrameGrabFailure(
        .unsupportedUri,
        "`sourceUri` must be an absolute path or an absolute URI with a supported scheme.")
    }
    switch scheme {
    case "file":
      guard url.isFileURL else {
        throw FrameGrabFailure(.unsupportedUri, "Malformed file URI.")
      }
      return .localFile(url.standardizedFileURL)
    case "http", "https":
      return .remote(url)
    case "content":
      throw FrameGrabFailure(
        .unsupportedUri, "`content://` sources are supported on Android only.")
    default:
      throw FrameGrabFailure(.unsupportedUri, "Unsupported source scheme \"\(scheme)\".")
    }
  }

  static func resolveDestination(_ raw: String) throws -> URL {
    if raw.hasPrefix("/") {
      return URL(fileURLWithPath: raw).standardizedFileURL
    }
    guard let url = parse(raw), let scheme = url.scheme?.lowercased() else {
      throw FrameGrabFailure(
        .unsupportedUri, "`destinationUri` must be an absolute path or a local `file://` URI.")
    }
    guard scheme == "file", url.isFileURL else {
      throw FrameGrabFailure(
        .unsupportedUri,
        "`destinationUri` must be a local file; got scheme \"\(scheme)\".")
    }
    return url.standardizedFileURL
  }

  /// Verifies the parent directory exists and the destination itself is either
  /// absent or a plain regular file. Directories and symlinks are rejected so
  /// we never follow a link out of the caller's own directory.
  static func validateDestination(_ destination: URL) throws {
    let fileManager = FileManager.default
    let parent = destination.deletingLastPathComponent()

    var parentIsDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: parent.path, isDirectory: &parentIsDirectory),
      parentIsDirectory.boolValue
    else {
      throw FrameGrabFailure(
        .destinationWrite,
        "Destination parent directory does not exist: \(parent.path)")
    }

    // `attributesOfItem` does not follow symlinks, which is exactly what we want.
    guard let attributes = try? fileManager.attributesOfItem(atPath: destination.path) else {
      return  // Destination does not exist yet: nothing more to check.
    }
    let type = attributes[.type] as? FileAttributeType
    guard type == .typeRegular else {
      throw FrameGrabFailure(
        .destinationWrite,
        "Destination exists and is not a regular file (\(type?.rawValue ?? "unknown")).")
    }
  }

  /// Rejects a source and destination that name the same file, including
  /// hardlinks and symlink aliases on the same volume.
  static func assertDistinct(source: FrameGrabSource, destination: URL) throws {
    guard case .localFile(let sourceURL) = source else { return }

    let resolvedSource = sourceURL.resolvingSymlinksInPath().standardizedFileURL.path
    let resolvedDestination = destination.resolvingSymlinksInPath().standardizedFileURL.path
    if resolvedSource == resolvedDestination {
      throw FrameGrabFailure(
        .invalidArgument, "`sourceUri` and `destinationUri` resolve to the same file.")
    }

    var sourceStat = stat()
    var destinationStat = stat()
    guard stat(resolvedSource, &sourceStat) == 0, stat(resolvedDestination, &destinationStat) == 0
    else {
      return  // One of them does not exist; the path comparison above is enough.
    }
    if sourceStat.st_dev == destinationStat.st_dev, sourceStat.st_ino == destinationStat.st_ino {
      throw FrameGrabFailure(
        .invalidArgument, "`sourceUri` and `destinationUri` resolve to the same file.")
    }
  }

  /// Canonical reservation key: resolved parent directory + destination filename.
  static func reservationKey(for destination: URL) -> String {
    let parent = destination.deletingLastPathComponent().resolvingSymlinksInPath()
      .standardizedFileURL.path
    return parent + "/" + destination.lastPathComponent
  }
}

/// Escape hatch for carrying non-`Sendable` CoreGraphics/Foundation values into
/// a `DispatchQueue` closure. Ownership is single-threaded by construction: the
/// value is produced, moved once, and never touched concurrently.
struct FrameGrabBox<T>: @unchecked Sendable {
  let value: T
  init(_ value: T) { self.value = value }
}
