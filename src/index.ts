import { NitroModules } from 'react-native-nitro-modules'
import {
  FrameGrabError,
  normalizeOptions,
  settleOutcome,
  type FrameGrabDiagnostics,
  type FrameGrabOptions,
  type FrameGrabResult,
} from './contract'
import type { FrameGrab, NativeFrameGrabOutcome } from './specs/FrameGrab.nitro'

export {
  FrameGrabError,
  FRAME_GRAB_DEFAULTS,
  FRAME_GRAB_ERROR_CODES,
  FRAME_GRAB_LIMITS,
} from './contract'
export type {
  FrameGrabDiagnostics,
  FrameGrabErrorCode,
  FrameGrabOptions,
  FrameGrabResult,
  FrameGrabTimings,
  FrameMode,
} from './contract'

let hybrid: FrameGrab | undefined

function getHybrid(): FrameGrab {
  hybrid ??= NitroModules.createHybridObject<FrameGrab>('FrameGrab')
  return hybrid
}

async function run(options: FrameGrabOptions): Promise<FrameGrabDiagnostics> {
  const { request, requestedTimeMs } = normalizeOptions(options)

  let outcome: NativeFrameGrabOutcome
  try {
    outcome = await getHybrid().extract(request)
  } catch (cause) {
    // A real native throw, as opposed to the expected failure envelope, means
    // we hit something the native side did not classify.
    throw new FrameGrabError(
      'E_INTERNAL',
      cause instanceof Error ? cause.message : String(cause)
    )
  }

  return settleOutcome(outcome, requestedTimeMs)
}

/**
 * Extracts one frame from `sourceUri` and writes it to `destinationUri` as a
 * JPEG, atomically replacing any existing file there.
 *
 * Rejects with a {@link FrameGrabError} carrying a stable `code`.
 */
export async function extractThumbnail(
  options: FrameGrabOptions
): Promise<FrameGrabResult> {
  return (await run(options)).result
}

/**
 * Same as {@link extractThumbnail}, but also returns native per-phase timings.
 *
 * Benchmark instrumentation only — the shape of `timings` is not covered by
 * semver.
 */
export async function unstable_extractThumbnailWithTimings(
  options: FrameGrabOptions
): Promise<FrameGrabDiagnostics> {
  return run(options)
}

/**
 * Module-wide bound on concurrently running native extractions (default `2`).
 * Exposed so the benchmark can compare 1 / 2 / 4; not a per-call knob.
 */
export function setMaxConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new FrameGrabError(
      'E_INVALID_ARGUMENT',
      '`maxConcurrency` must be an integer between 1 and 16.'
    )
  }
  getHybrid().maxConcurrency = value
}

export function getMaxConcurrency(): number {
  return getHybrid().maxConcurrency
}
