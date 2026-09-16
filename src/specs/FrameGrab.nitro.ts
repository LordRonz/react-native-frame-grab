import type { HybridObject } from 'react-native-nitro-modules'

/**
 * Internal Nitro transport. Not part of the public API surface.
 *
 * Everything here is already normalized/validated by the JavaScript facade
 * (`src/index.ts`); native re-validates only what it must in order to avoid
 * unsafe numeric conversions or filesystem operations.
 */

export interface NativeFrameGrabRequest {
  /** Source video. Absolute path, `file://`, `content://` (Android) or `http(s)://`. */
  sourceUri: string
  /** Destination JPEG. Absolute path or local `file://` only. */
  destinationUri: string
  /** Requested timestamp in microseconds. Integral, finite, `>= 0`. */
  timeUs: number
  /** Upper bound for the final *displayed* width, in pixels. Integral, `1...4096`. */
  maxWidth: number
  /** JPEG quality in `0...1`. */
  quality: number
  /** `true` => `precise` mode, `false` => `fast` mode. See README "Frame selection". */
  precise: boolean
}

/** Native phase timings, in milliseconds. Benchmark instrumentation only. */
export interface NativeFrameGrabTimings {
  /** Time spent waiting for a scheduler slot. */
  queueWaitMs: number
  /** Source/asset initialization. */
  sourceMs: number
  /** Metadata read + validation. */
  metadataMs: number
  /** Frame decode/extraction. */
  extractMs: number
  /** JPEG encode and write, combined: the encoders stream straight to the file. */
  encodeMs: number
  /** Atomic finalization. */
  finalizeMs: number
}

export interface NativeFrameGrabSuccess {
  /** Absolute `file://` URI of the finalized JPEG. */
  uri: string
  /** Actual encoded width, after display-orientation correction. */
  width: number
  /** Actual encoded height, after display-orientation correction. */
  height: number
  /** Encoded JPEG byte count. */
  size: number
  timings: NativeFrameGrabTimings
}

export interface NativeFrameGrabFailure {
  code: string
  message: string
}

/** Exactly one of `result` / `error` is present. The facade enforces that invariant. */
export interface NativeFrameGrabOutcome {
  result?: NativeFrameGrabSuccess
  error?: NativeFrameGrabFailure
}

export interface FrameGrab
  extends HybridObject<{ ios: 'swift'; android: 'kotlin' }> {
  /**
   * Module-wide bound on concurrently running native extractions.
   * Exposed for benchmarking (see IMPLEMENTATION_PLAN.md section 12).
   */
  maxConcurrency: number

  extract(request: NativeFrameGrabRequest): Promise<NativeFrameGrabOutcome>
}
