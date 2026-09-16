/**
 * Runs with `node --test` (type stripping). No native code, no React Native:
 * this covers the argument contract and the native-outcome envelope only.
 *
 * Decoding, orientation, atomic replacement and thread placement are only
 * verifiable on a device — see `example/src/harness.ts`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  FrameGrabError,
  FRAME_GRAB_LIMITS,
  normalizeOptions,
  settleOutcome,
} from '../src/contract.ts'

const base = { sourceUri: '/videos/a.mp4', destinationUri: '/cache/a.jpg' }

function codeOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof FrameGrabError, 'expected a FrameGrabError')
    assert.ok(error instanceof Error, 'FrameGrabError must be an Error')
    return error.code
  }
  throw new Error('expected a throw')
}

test('applies the documented defaults', () => {
  const { request, requestedTimeMs } = normalizeOptions(base)
  assert.deepEqual(request, {
    sourceUri: '/videos/a.mp4',
    destinationUri: '/cache/a.jpg',
    timeUs: 0,
    maxWidth: 480,
    quality: 0.6,
    precise: false,
  })
  assert.equal(requestedTimeMs, 0)
})

test('maps mode to the precise flag', () => {
  assert.equal(normalizeOptions({ ...base, mode: 'precise' }).request.precise, true)
  assert.equal(normalizeOptions({ ...base, mode: 'fast' }).request.precise, false)
  assert.equal(codeOf(() => normalizeOptions({ ...base, mode: 'quick' as never })), 'E_INVALID_ARGUMENT')
})

test('rounds timeMs to the nearest microsecond and echoes it back', () => {
  const { request, requestedTimeMs } = normalizeOptions({ ...base, timeMs: 1.00049 })
  assert.equal(request.timeUs, 1000)
  assert.equal(requestedTimeMs, 1)
  assert.equal(normalizeOptions({ ...base, timeMs: 0.0005 }).request.timeUs, 1)
})

test('rejects non-finite, negative and unrepresentable timestamps', () => {
  for (const timeMs of [NaN, Infinity, -Infinity, -1, -0.0001, Number.MAX_VALUE]) {
    assert.equal(
      codeOf(() => normalizeOptions({ ...base, timeMs })),
      'E_INVALID_ARGUMENT',
      `timeMs=${timeMs}`
    )
  }
  // Largest timestamp whose microsecond value is still a safe integer.
  const safeMs = Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  assert.equal(normalizeOptions({ ...base, timeMs: safeMs }).request.timeUs, safeMs * 1000)
})

test('enforces the maxWidth boundaries exactly', () => {
  const { minMaxWidth, maxMaxWidth } = FRAME_GRAB_LIMITS
  assert.equal(normalizeOptions({ ...base, maxWidth: minMaxWidth }).request.maxWidth, 1)
  assert.equal(normalizeOptions({ ...base, maxWidth: maxMaxWidth }).request.maxWidth, 4096)
  for (const maxWidth of [0, -1, maxMaxWidth + 1, 480.5, NaN, Infinity]) {
    assert.equal(
      codeOf(() => normalizeOptions({ ...base, maxWidth })),
      'E_INVALID_ARGUMENT',
      `maxWidth=${maxWidth}`
    )
  }
})

test('enforces the quality boundaries exactly', () => {
  assert.equal(normalizeOptions({ ...base, quality: 0 }).request.quality, 0)
  assert.equal(normalizeOptions({ ...base, quality: 1 }).request.quality, 1)
  for (const quality of [-0.01, 1.01, NaN, Infinity]) {
    assert.equal(
      codeOf(() => normalizeOptions({ ...base, quality })),
      'E_INVALID_ARGUMENT',
      `quality=${quality}`
    )
  }
})

test('rejects blank URIs without trimming valid ones', () => {
  assert.equal(codeOf(() => normalizeOptions({ ...base, sourceUri: '   ' })), 'E_INVALID_ARGUMENT')
  assert.equal(codeOf(() => normalizeOptions({ ...base, destinationUri: '' })), 'E_INVALID_ARGUMENT')
  // A trailing space is a legal filename; it must survive untouched.
  assert.equal(
    normalizeOptions({ ...base, destinationUri: '/cache/a .jpg' }).request.destinationUri,
    '/cache/a .jpg'
  )
})

const success = {
  uri: 'file:///cache/a.jpg',
  width: 480,
  height: 270,
  size: 12_345,
  timings: {
    queueWaitMs: 1,
    sourceMs: 2,
    metadataMs: 3,
    extractMs: 4,
    encodeMs: 5,
    finalizeMs: 6,
  },
}

test('unwraps a successful envelope and stamps requestedTimeMs', () => {
  const { result, timings } = settleOutcome({ result: success, error: undefined }, 250)
  assert.deepEqual(result, {
    uri: 'file:///cache/a.jpg',
    width: 480,
    height: 270,
    size: 12_345,
    requestedTimeMs: 250,
  })
  assert.equal(timings.extractMs, 4)
  // No image bytes may ever reach JS.
  assert.deepEqual(Object.keys(result).sort(), [
    'height',
    'requestedTimeMs',
    'size',
    'uri',
    'width',
  ])
})

test('turns a known native code into a FrameGrabError', () => {
  assert.equal(
    codeOf(() =>
      settleOutcome(
        { result: undefined, error: { code: 'E_DESTINATION_BUSY', message: 'taken' } },
        0
      )
    ),
    'E_DESTINATION_BUSY'
  )
})

test('maps unknown and malformed native failures to E_INTERNAL', () => {
  assert.equal(
    codeOf(() =>
      settleOutcome({ result: undefined, error: { code: 'E_WAT', message: 'nope' } }, 0)
    ),
    'E_INTERNAL'
  )
  // Both fields present, or neither: the envelope invariant is violated.
  assert.equal(
    codeOf(() =>
      settleOutcome({ result: success, error: { code: 'E_BUSY', message: 'x' } }, 0)
    ),
    'E_INTERNAL'
  )
  assert.equal(
    codeOf(() => settleOutcome({ result: undefined, error: undefined }, 0)),
    'E_INTERNAL'
  )
  assert.equal(
    codeOf(() => settleOutcome(undefined as never, 0)),
    'E_INTERNAL'
  )
})
