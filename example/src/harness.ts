/**
 * Device acceptance matrix (IMPLEMENTATION_PLAN.md section 16).
 *
 * JavaScript mocks cannot validate decoding, orientation, atomic replacement or
 * thread placement, so these checks run against the real native module on a real
 * device. Orientation still needs a human: the checks record output URIs and the
 * UI renders them.
 */
import { Directory, File } from 'expo-file-system'
import { ImageManipulator } from 'expo-image-manipulator'
import {
  extractThumbnail,
  setMaxConcurrency,
  type FrameGrabErrorCode,
} from 'react-native-frame-grab'

import { APP_MEDIA_HOST_URL, probeEndpoint, REMOTE_ENDPOINTS } from './remote'
import { outputDirectory, outputFile, resetOutputDirectory, type BenchSource } from './sources'

export interface Check {
  id: string
  passed: boolean
  detail: string
  /** Rendered by the UI so orientation and aspect can be eyeballed. */
  imageUri?: string
}

/** Runs `run` and returns the `FrameGrabError` code, or `null` if it succeeded. */
async function errorCodeOf(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? String(error)
  }
}

async function expectCode(
  id: string,
  expected: FrameGrabErrorCode,
  run: () => Promise<unknown>
): Promise<Check> {
  try {
    await run()
    return { id, passed: false, detail: `expected ${expected}, but the call succeeded` }
  } catch (error) {
    const code = (error as { code?: string }).code
    return {
      id,
      passed: code === expected,
      detail: code === expected ? expected : `expected ${expected}, got ${code ?? error}`,
    }
  }
}

/** Reopening the file is the only proof that what we wrote is a decodable JPEG. */
async function decoded(uri: string): Promise<{ width: number; height: number }> {
  const image = await ImageManipulator.manipulate(uri).renderAsync()
  return { width: image.width, height: image.height }
}

export async function runHarness(
  source: BenchSource,
  durationMs: number | null
): Promise<Check[]> {
  resetOutputDirectory()
  setMaxConcurrency(2)
  const checks: Check[] = []
  const add = (check: Check) => checks.push(check)

  // region Happy path

  const primary = outputFile('primary.jpg')
  const result = await extractThumbnail({
    sourceUri: source.uri,
    destinationUri: primary.uri,
  })
  const primaryDecoded = await decoded(result.uri)
  add({
    id: 'defaults produce a decodable JPEG',
    passed:
      primaryDecoded.width === result.width &&
      primaryDecoded.height === result.height &&
      result.size > 0 &&
      primary.exists,
    detail: `reported ${result.width}x${result.height} / ${result.size} B, decoded ${primaryDecoded.width}x${primaryDecoded.height}`,
    imageUri: result.uri,
  })
  add({
    id: 'width bound respected and never upscaled',
    passed: result.width <= 480,
    detail: `width ${result.width} <= 480`,
  })
  add({
    id: 'result carries no image bytes',
    passed:
      JSON.stringify(Object.keys(result).sort()) ===
      JSON.stringify(['height', 'requestedTimeMs', 'size', 'uri', 'width']),
    detail: Object.keys(result).sort().join(', '),
  })
  add({
    id: 'requestedTimeMs echoes the normalized request',
    passed: result.requestedTimeMs === 0,
    detail: `${result.requestedTimeMs}`,
  })

  const smallWidth = outputFile('w160.jpg')
  const small = await extractThumbnail({
    sourceUri: source.uri,
    destinationUri: smallWidth.uri,
    maxWidth: 160,
  })
  const aspectDrift = Math.abs(
    small.width / small.height - result.width / result.height
  )
  add({
    id: 'aspect ratio preserved across widths',
    passed: small.width <= 160 && aspectDrift < 0.02,
    detail: `${small.width}x${small.height} vs ${result.width}x${result.height}, drift ${aspectDrift.toFixed(4)}`,
    imageUri: small.uri,
  })

  const precise = outputFile('precise.jpg')
  add({
    id: 'precise mode succeeds at a non-keyframe timestamp',
    passed: await extractThumbnail({
      sourceUri: source.uri,
      destinationUri: precise.uri,
      timeMs: Math.min(3_500, Math.max(0, (durationMs ?? 4_000) - 1_000)),
      mode: 'precise',
    })
      .then(() => true)
      .catch(() => false),
    detail: 'see the rendered frame',
    imageUri: precise.uri,
  })

  // endregion

  // region Arguments

  const base = { sourceUri: source.uri, destinationUri: outputFile('args.jpg').uri }
  for (const [id, options] of [
    ['NaN timeMs', { timeMs: NaN }],
    ['infinite timeMs', { timeMs: Infinity }],
    ['negative timeMs', { timeMs: -1 }],
    ['zero maxWidth', { maxWidth: 0 }],
    ['oversized maxWidth', { maxWidth: 4097 }],
    ['fractional maxWidth', { maxWidth: 480.5 }],
    ['quality above 1', { quality: 1.5 }],
    ['quality below 0', { quality: -0.1 }],
    ['unknown mode', { mode: 'turbo' as never }],
    ['blank source', { sourceUri: '   ' }],
  ] as const) {
    add(
      await expectCode(id, 'E_INVALID_ARGUMENT', () =>
        extractThumbnail({ ...base, ...options })
      )
    )
  }

  add(
    await expectCode('unsupported source scheme', 'E_UNSUPPORTED_URI', () =>
      extractThumbnail({ ...base, sourceUri: 'ftp://example.com/a.mp4' })
    )
  )
  add(
    await expectCode('relative source path', 'E_UNSUPPORTED_URI', () =>
      extractThumbnail({ ...base, sourceUri: 'videos/a.mp4' })
    )
  )
  add(
    await expectCode('remote destination', 'E_UNSUPPORTED_URI', () =>
      extractThumbnail({ ...base, destinationUri: 'https://example.com/a.jpg' })
    )
  )

  // endregion

  // region Timestamps

  add(
    await expectCode('timestamp far beyond duration', 'E_TIMESTAMP_OUT_OF_RANGE', () =>
      extractThumbnail({ ...base, timeMs: 10 * 60 * 60 * 1000 })
    )
  )
  if (durationMs != null && durationMs > 0) {
    // Deliberately not asserting that `timeMs === durationMs` is rejected.
    //
    // The duration here comes from the media library — `PHAsset.duration` run
    // through `Int(seconds * 1000)` on iOS, the MediaStore `DURATION` column on
    // Android. The library validates against `AVURLAsset.duration` /
    // `MediaMetadataRetriever`. Those are different subsystems and neither
    // promises the other's value; the iOS truncation alone puts the reported
    // figure below the real one, so the "equal" timestamp is usually a valid
    // in-range request that must succeed.
    //
    // What the contract actually promises is that running off the end is
    // *rejected* rather than silently clamped to the last frame. So find the
    // boundary and check it sits near the reported duration.
    let rejectedAtOffset: number | null = null
    let unexpectedCode: string | null = null
    for (const offset of [0, 40, 100, 250, 500, 1000]) {
      const code = await errorCodeOf(() =>
        extractThumbnail({ ...base, timeMs: durationMs + offset })
      )
      if (code == null) continue
      if (code === 'E_TIMESTAMP_OUT_OF_RANGE') {
        rejectedAtOffset = offset
      } else {
        unexpectedCode = code
      }
      break
    }
    add({
      id: 'past-the-end timestamps are rejected, not clamped to the last frame',
      passed: rejectedAtOffset != null,
      detail:
        unexpectedCode != null
          ? `expected E_TIMESTAMP_OUT_OF_RANGE, got ${unexpectedCode}`
          : rejectedAtOffset != null
            ? `rejected at +${rejectedAtOffset} ms past the reported ${durationMs} ms duration`
            : `still succeeding 1000 ms past the reported ${durationMs} ms duration`,
    })

    const nearEnd = outputFile('near-end.jpg')
    add({
      id: 'timestamp just before the end succeeds',
      passed: await extractThumbnail({
        sourceUri: source.uri,
        destinationUri: nearEnd.uri,
        timeMs: Math.max(0, durationMs - 100),
      })
        .then(() => true)
        .catch(() => false),
      detail: `${Math.max(0, durationMs - 100)} ms of ${durationMs} ms`,
      imageUri: nearEnd.uri,
    })
  }

  // endregion

  // region Paths

  const unicodeName = 'ünïcødé frame — 测试.jpg'
  const unicode = outputFile(unicodeName)
  const unicodeResult = await extractThumbnail({
    sourceUri: source.uri,
    destinationUri: unicode.uri,
  })
  add({
    id: 'unicode, spaces and percent-encoding in the destination',
    passed: unicodeResult.size > 0 && new File(unicode.uri).exists,
    detail: unicodeName,
  })

  add(
    await expectCode('missing source file', 'E_SOURCE_UNREADABLE', () =>
      extractThumbnail({ ...base, sourceUri: outputFile('nope.mp4').uri })
    )
  )
  add(
    await expectCode('missing parent directory', 'E_DESTINATION_WRITE', () =>
      extractThumbnail({ ...base, destinationUri: outputFile('nope/deep/a.jpg').uri })
    )
  )

  const directoryDestination = new Directory(outputDirectory, 'a-directory')
  if (!directoryDestination.exists) directoryDestination.create()
  add(
    await expectCode('directory destination', 'E_DESTINATION_WRITE', () =>
      extractThumbnail({ ...base, destinationUri: directoryDestination.uri })
    )
  )
  // Aim both at a local file that exists.
  //
  // Reusing `source.uri` for both only works when the selected source is a local
  // file. A `content://` or `https://` source is a valid *source* but an
  // unsupported *destination*, so the destination scheme is rejected first and
  // the result is E_UNSUPPORTED_URI — correct, but not what this check is about.
  const identityTarget =
    source.uri.startsWith('file://') || source.uri.startsWith('/')
      ? source.uri
      : primary.uri
  add(
    await expectCode('source and destination are the same file', 'E_INVALID_ARGUMENT', () =>
      extractThumbnail({ sourceUri: identityTarget, destinationUri: identityTarget })
    )
  )

  // endregion

  // region Atomic replacement

  const replaced = outputFile('replaced.jpg')
  const before = await extractThumbnail({
    sourceUri: source.uri,
    destinationUri: replaced.uri,
    maxWidth: 160,
  })
  const beforeSize = new File(replaced.uri).size

  try {
    await extractThumbnail({
      sourceUri: outputFile('nope.mp4').uri,
      destinationUri: replaced.uri,
    })
  } catch {
    // Expected.
  }
  add({
    id: 'existing destination survives a failed extraction',
    passed: new File(replaced.uri).exists && new File(replaced.uri).size === beforeSize,
    detail: `${beforeSize} B before, ${new File(replaced.uri).size} B after`,
  })

  const after = await extractThumbnail({
    sourceUri: source.uri,
    destinationUri: replaced.uri,
    maxWidth: 320,
  })
  add({
    id: 'existing destination is replaced on success',
    passed: after.width !== before.width && new File(replaced.uri).size === after.size,
    detail: `${before.width}px -> ${after.width}px`,
    imageUri: after.uri,
  })

  const temporaries = outputDirectory
    .list()
    .filter((entry) => entry.name.startsWith('.framegrab-'))
  add({
    id: 'no temporary files left behind',
    passed: temporaries.length === 0,
    detail: temporaries.map((entry) => entry.name).join(', ') || 'none',
  })

  // endregion

  // region Concurrency

  const shared = outputFile('contended.jpg')
  const contended = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      extractThumbnail({ sourceUri: source.uri, destinationUri: shared.uri })
    )
  )
  const busyRejections = contended.filter(
    (outcome) =>
      outcome.status === 'rejected' &&
      (outcome.reason as { code?: string }).code === 'E_DESTINATION_BUSY'
  ).length
  add({
    id: 'overlapping jobs for one destination are rejected',
    passed: busyRejections === contended.length - 1,
    detail: `${busyRejections} of ${contended.length} rejected with E_DESTINATION_BUSY`,
  })

  const afterContention = outputFile('after-contention.jpg')
  add({
    id: 'destination reservation is released after contention',
    passed: await extractThumbnail({
      sourceUri: source.uri,
      destinationUri: afterContention.uri,
    })
      .then(() => true)
      .catch(() => false),
    detail: 'a later request for a fresh destination still succeeds',
  })

  const flood = await Promise.allSettled(
    Array.from({ length: 400 }, (_, index) =>
      extractThumbnail({
        sourceUri: source.uri,
        destinationUri: outputFile(`flood-${index}.jpg`).uri,
      })
    )
  )
  const overflow = flood.filter(
    (outcome) =>
      outcome.status === 'rejected' && (outcome.reason as { code?: string }).code === 'E_BUSY'
  ).length
  const unexpected = flood.filter(
    (outcome) =>
      outcome.status === 'rejected' &&
      !['E_BUSY'].includes((outcome.reason as { code?: string }).code ?? '')
  )
  add({
    id: 'queue overflow rejects cleanly',
    // Not every device will actually overflow a 64-slot queue with 400 jobs;
    // what must hold is that nothing fails for any *other* reason.
    passed: unexpected.length === 0,
    detail:
      `${overflow} rejected with E_BUSY, ${unexpected.length} unexpected failures` +
      (overflow === 0 ? ' (queue never filled: informational only)' : ''),
  })

  const afterFlood = outputFile('after-flood.jpg')
  add({
    id: 'the queue keeps dispatching after failures',
    passed: await extractThumbnail({
      sourceUri: source.uri,
      destinationUri: afterFlood.uri,
    })
      .then(() => true)
      .catch(() => false),
    detail: 'a request issued after the flood still completes',
  })

  // endregion

  return checks
}

/**
 * Remote acceptance matrix (plan sections 7 and 16).
 *
 * Run separately from the local matrix: network behaviour has to be measured on
 * its own, and a third-party sample endpoint going down is not a library
 * failure. Every endpoint is probed over plain HTTP first so the two are
 * distinguishable in the results.
 */
export async function runRemoteHarness(): Promise<Check[]> {
  resetOutputDirectory()
  setMaxConcurrency(2)
  const checks: Check[] = []

  const endpoints = [...REMOTE_ENDPOINTS]
  if (APP_MEDIA_HOST_URL) {
    endpoints.unshift({
      id: 'app-media-host',
      label: 'Your app media host',
      url: APP_MEDIA_HOST_URL,
      expect: 'success',
      covers: 'the host the remote migration decision actually depends on',
    })
  } else {
    checks.push({
      id: 'app media host configured',
      passed: false,
      detail:
        'APP_MEDIA_HOST_URL is null in src/remote.ts. Public samples cannot clear ' +
        'the remote gate — point it at your real host, signed URL included.',
    })
  }

  for (const endpoint of endpoints) {
    const probe = await probeEndpoint(endpoint.url)

    if (!probe.reachable) {
      checks.push({
        id: `${endpoint.label}: endpoint reachable`,
        // A dead third-party sample is an inconclusive run, not a defect. Your
        // own host being unreachable is a real finding.
        passed: endpoint.thirdParty === true,
        detail: `${endpoint.thirdParty ? 'third-party endpoint' : 'endpoint'} unreachable (${probe.error}) — extraction not attempted`,
      })
      continue
    }

    const destination = outputFile(`remote-${endpoint.id}.jpg`)
    const startedAt = performance.now()
    const code = await errorCodeOf(() =>
      extractThumbnail({ sourceUri: endpoint.url, destinationUri: destination.uri })
    )
    const elapsedMs = performance.now() - startedAt

    // Server capability, recorded separately from extraction (plan section 17).
    const network =
      `HTTP ${probe.status}, ranges: ${probe.acceptRanges}` +
      (probe.contentLength ? `, ${(probe.contentLength / 1_000_000).toFixed(1)} MB` : '') +
      `, first byte in ${probe.elapsedMs.toFixed(0)} ms`

    if (endpoint.expect === 'either') {
      checks.push({
        id: `${endpoint.label}: outcome recorded`,
        passed: true,
        detail:
          (code == null
            ? `succeeded in ${elapsedMs.toFixed(0)} ms`
            : `blocked with ${code} after ${elapsedMs.toFixed(0)} ms`) +
          ` — ${endpoint.covers} — ${network}`,
      })
    } else if (endpoint.expect === 'success') {
      const decodedSize = code == null ? await decoded(destination.uri) : null
      checks.push({
        id: `${endpoint.label}: extracts`,
        passed: code == null && decodedSize != null,
        detail:
          code == null
            ? `${decodedSize?.width}x${decodedSize?.height} in ${elapsedMs.toFixed(0)} ms — ${network}`
            : `failed with ${code} after ${elapsedMs.toFixed(0)} ms — ${network}`,
        imageUri: code == null ? destination.uri : undefined,
      })
    } else {
      const acceptable = endpoint.acceptableCodes ?? []
      checks.push({
        id: `${endpoint.label}: fails cleanly`,
        // Must fail with a documented code, and must not leave a file behind.
        passed: code != null && acceptable.includes(code) && !destination.exists,
        detail:
          code == null
            ? `unexpectedly succeeded after ${elapsedMs.toFixed(0)} ms — ${network}`
            : `${code} after ${elapsedMs.toFixed(0)} ms` +
              (destination.exists ? ' — LEFT A FILE BEHIND' : '') +
              ` — ${network}`,
      })
    }

    if (endpoint.id === 'delayed-response') {
      checks.push({
        id: 'documented limitation: a slow host occupies a native slot',
        // Informational. There is no way to interrupt a running MMR operation,
        // so this records the cost rather than asserting a cancellation the
        // library does not offer.
        passed: true,
        detail: `the scheduler slot stayed occupied for ${elapsedMs.toFixed(0)} ms; no timeout is claimed`,
      })
    }
  }

  const leftovers = outputDirectory
    .list()
    .filter((entry) => entry.name.startsWith('.framegrab-'))
  checks.push({
    id: 'no temporary files left behind by remote failures',
    passed: leftovers.length === 0,
    detail: leftovers.map((entry) => entry.name).join(', ') || 'none',
  })

  return checks
}
