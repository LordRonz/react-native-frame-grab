// Run on macOS:
// swiftc ios/FrameGrabSupport.swift test/FrameGrabDiagnostics.swift -o /tmp/framegrab-diagnostics && /tmp/framegrab-diagnostics
import Foundation

@main
struct FrameGrabDiagnosticsTest {
  static func main() {
    let cause = NSError(domain: NSOSStatusErrorDomain, code: -12903, userInfo: [
      NSLocalizedDescriptionKey: "https://user:secret@example.com/video?token=secret",
    ])
    let wrapper = NSError(domain: "Decoder", code: -1, userInfo: [
      NSUnderlyingErrorKey: cause,
    ])
    let error = NSError(domain: "AVFoundationErrorDomain", code: -11821, userInfo: [
      NSLocalizedDescriptionKey: "Cannot Decode",
      NSUnderlyingErrorKey: wrapper,
    ])
    assert(frameGrabDescribe(error) ==
      "Cannot Decode [AVFoundationErrorDomain -11821] — underlying Decoder -1 — underlying NSOSStatusErrorDomain -12903")

    let plain = NSError(domain: "Test", code: 42, userInfo: [
      NSLocalizedDescriptionKey: "Plain failure",
    ])
    assert(frameGrabDescribe(plain) == "Plain failure [Test 42]")
    print("FrameGrab diagnostics passed (nested causes, no underlying descriptions, plain error).")
  }
}
