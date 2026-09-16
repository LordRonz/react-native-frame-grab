/**
 * The public contract and everything that can be decided without touching
 * native code: option validation, normalization, and the native-outcome
 * envelope. Kept free of React Native imports so it is directly testable.
 */
import type {
  NativeFrameGrabOutcome,
  NativeFrameGrabRequest,
  NativeFrameGrabTimings,
} from './specs/FrameGrab.nitro'

export type FrameGrabTimings = NativeFrameGrabTimings

export type FrameMode = 'fast' | 'precise'

export interface FrameGrabOptions {
  /**
   * Video to read from.
   *
   * - absolute filesystem path, or `file://` URI — iOS + Android
   * - `content://` URI — Android only
   * - `http://` / `https://` — both, subject to the app's ATS / cleartext policy
   */
  sourceUri: string
  /** Absolute filesystem path or local `file://` URI for the JPEG. Parent directory must exist. */
  destinationUri: string
  /** Timestamp to grab, in milliseconds. Default `0`. */
  timeMs?: number
  /** Upper bound on the final *displayed* width, in pixels. Default `480`. */
  maxWidth?: number
  /** JPEG quality, `0`–`1`. Default `0.6`. */
  quality?: number
  /** Frame-selection intent. Default `'fast'`. See README, "Frame selection". */
  mode?: FrameMode
}

export interface FrameGrabResult {
  /** Absolute `file://` URI of the finalized JPEG. */
  uri: string
  /** Actual encoded width, after display-orientation correction. */
  width: number
  /** Actual encoded height, after display-orientation correction. */
  height: number
  /** Encoded JPEG byte count. */
  size: number
  /**
   * The validated, normalized *requested* timestamp in milliseconds.
   * This is **not** the timestamp of the frame the decoder actually selected —
   * that value is not reliably available on Android.
   */
  requestedTimeMs: number
}

export interface FrameGrabDiagnostics {
  result: FrameGrabResult
  timings: FrameGrabTimings
}

export const FRAME_GRAB_ERROR_CODES = [
  'E_INVALID_ARGUMENT',
  'E_UNSUPPORTED_URI',
  'E_SOURCE_UNREADABLE',
  'E_TIMESTAMP_OUT_OF_RANGE',
  'E_FRAME_EXTRACTION',
  'E_ENCODE_FAILED',
  'E_DESTINATION_WRITE',
  'E_DESTINATION_BUSY',
  'E_BUSY',
  'E_INTERNAL',
] as const

export type FrameGrabErrorCode = (typeof FRAME_GRAB_ERROR_CODES)[number]

export class FrameGrabError extends Error {
  readonly code: FrameGrabErrorCode

  constructor(code: FrameGrabErrorCode, message: string) {
    super(message)
    this.name = 'FrameGrabError'
    this.code = code
    // Keep `instanceof` working when the library is down-compiled to ES5.
    Object.setPrototypeOf(this, FrameGrabError.prototype)
  }
}

/** Shared output-allocation safeguards. Mirrored by both native implementations. */
export const FRAME_GRAB_LIMITS = {
  minMaxWidth: 1,
  maxMaxWidth: 4096,
  /** Upper bound on `width * height` of the encoded JPEG. */
  maxOutputArea: 16_777_216,
} as const

export const FRAME_GRAB_DEFAULTS = {
  timeMs: 0,
  maxWidth: 480,
  quality: 0.6,
  mode: 'fast',
} as const satisfies Required<Omit<FrameGrabOptions, 'sourceUri' | 'destinationUri'>>

const ERROR_CODE_SET: ReadonlySet<string> = new Set(FRAME_GRAB_ERROR_CODES)

function invalid(message: string): never {
  throw new FrameGrabError('E_INVALID_ARGUMENT', message)
}

function requireNonBlankString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    invalid(`\`${field}\` must be a string.`)
  }
  // Reject blank input, but never hand a trimmed value to the filesystem:
  // trailing spaces are legal in filenames.
  if (value.trim().length === 0) {
    invalid(`\`${field}\` must not be empty or whitespace-only.`)
  }
  return value
}

/** Validates and normalizes public options into the internal native request. */
export function normalizeOptions(options: FrameGrabOptions): {
  request: NativeFrameGrabRequest
  requestedTimeMs: number
} {
  if (options == null || typeof options !== 'object') {
    invalid('`options` must be an object.')
  }

  const sourceUri = requireNonBlankString(options.sourceUri, 'sourceUri')
  const destinationUri = requireNonBlankString(
    options.destinationUri,
    'destinationUri'
  )

  const mode = options.mode ?? FRAME_GRAB_DEFAULTS.mode
  if (mode !== 'fast' && mode !== 'precise') {
    invalid(`\`mode\` must be 'fast' or 'precise', got ${JSON.stringify(mode)}.`)
  }

  const timeMs = options.timeMs ?? FRAME_GRAB_DEFAULTS.timeMs
  if (typeof timeMs !== 'number' || !Number.isFinite(timeMs)) {
    invalid('`timeMs` must be a finite number.')
  }
  if (timeMs < 0) {
    invalid('`timeMs` must not be negative.')
  }
  // Single documented rounding rule: nearest integer microsecond.
  const timeUs = Math.round(timeMs * 1000)
  if (!Number.isSafeInteger(timeUs)) {
    invalid(
      '`timeMs` is too large: the microsecond value exceeds the safe-integer range.'
    )
  }

  const maxWidth = options.maxWidth ?? FRAME_GRAB_DEFAULTS.maxWidth
  if (typeof maxWidth !== 'number' || !Number.isInteger(maxWidth)) {
    invalid('`maxWidth` must be an integer.')
  }
  if (
    maxWidth < FRAME_GRAB_LIMITS.minMaxWidth ||
    maxWidth > FRAME_GRAB_LIMITS.maxMaxWidth
  ) {
    invalid(
      `\`maxWidth\` must be between ${FRAME_GRAB_LIMITS.minMaxWidth} and ${FRAME_GRAB_LIMITS.maxMaxWidth}, got ${maxWidth}.`
    )
  }

  const quality = options.quality ?? FRAME_GRAB_DEFAULTS.quality
  if (typeof quality !== 'number' || !Number.isFinite(quality)) {
    invalid('`quality` must be a finite number.')
  }
  if (quality < 0 || quality > 1) {
    invalid(`\`quality\` must be between 0 and 1, got ${quality}.`)
  }

  return {
    request: {
      sourceUri,
      destinationUri,
      timeUs,
      maxWidth,
      quality,
      precise: mode === 'precise',
    },
    // Report back exactly what we asked native for.
    requestedTimeMs: timeUs / 1000,
  }
}

/**
 * Enforces the "exactly one of result/error" invariant and turns the internal
 * envelope into either a public result or a thrown `FrameGrabError`.
 */
export function settleOutcome(
  outcome: NativeFrameGrabOutcome,
  requestedTimeMs: number
): FrameGrabDiagnostics {
  if (outcome == null || typeof outcome !== 'object') {
    throw new FrameGrabError('E_INTERNAL', 'Native returned no outcome.')
  }

  const hasResult = outcome.result != null
  const hasError = outcome.error != null
  if (hasResult === hasError) {
    throw new FrameGrabError(
      'E_INTERNAL',
      'Native outcome must carry exactly one of `result` or `error`.'
    )
  }

  if (hasError) {
    const failure = outcome.error!
    const known = ERROR_CODE_SET.has(failure.code)
    const code: FrameGrabErrorCode = known
      ? (failure.code as FrameGrabErrorCode)
      : 'E_INTERNAL'
    const message =
      typeof failure.message === 'string' && failure.message.length > 0
        ? failure.message
        : 'Native extraction failed without a message.'
    throw new FrameGrabError(
      code,
      known ? message : `${message} (unmapped native code: ${failure.code})`
    )
  }

  const success = outcome.result!
  return {
    result: {
      uri: success.uri,
      width: success.width,
      height: success.height,
      size: success.size,
      requestedTimeMs,
    },
    timings: success.timings,
  }
}
