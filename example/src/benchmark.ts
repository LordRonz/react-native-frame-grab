import { Platform } from 'react-native'
import { setMaxConcurrency, type FrameGrabTimings } from 'react-native-frame-grab'

import {
  BASELINE_ID,
  implementations,
  SUBJECT_ID,
  type ExtractionJob,
  type Implementation,
} from './competitors'
import {
  corruptSource,
  missingSource,
  outputFile,
  resetOutputDirectory,
  type BenchSource,
} from './sources'

/* -------------------------------------------------------------------------- */
/* Workloads (IMPLEMENTATION_PLAN.md section 17)                               */
/* -------------------------------------------------------------------------- */

export type SourceKind = 'primary' | 'corrupt' | 'missing' | 'unwritable'

export interface Workload {
  id: string
  label: string
  timeMs: number
  maxWidth: number
  quality: number
  mode: 'fast' | 'precise'
  iterations: number
  /** In-flight requests. `1` measures latency; `8` measures burst behaviour. */
  concurrency: number
  sourceKind: SourceKind
  /** Failure workloads assert that nothing succeeds and nothing leaks. */
  expectFailure?: boolean
  /** Skipped for implementations that do not expose the selection mode. */
  requiresPrecise?: boolean
}

const DEFAULTS = { timeMs: 0, maxWidth: 480, quality: 0.6, mode: 'fast' } as const

function workload(partial: Partial<Workload> & Pick<Workload, 'id' | 'label'>): Workload {
  return {
    ...DEFAULTS,
    iterations: 30,
    concurrency: 1,
    sourceKind: 'primary',
    ...partial,
  }
}

/**
 * `nonKeyframeTimeMs` should land between keyframes for the chosen fixture;
 * the caller picks it because only they know the GOP structure.
 */
export function defaultWorkloads(nonKeyframeTimeMs = 3_500): Workload[] {
  return [
    workload({ id: 'primary', label: 'time 0, 480px, q0.6, fast' }),
    workload({
      id: 'precise-nonkeyframe',
      label: `precise @ ${nonKeyframeTimeMs} ms (non-keyframe)`,
      timeMs: nonKeyframeTimeMs,
      mode: 'precise',
      requiresPrecise: true,
    }),
    workload({ id: 'width-160', label: '160px wide', maxWidth: 160 }),
    workload({ id: 'width-480', label: '480px wide', maxWidth: 480 }),
    workload({ id: 'width-1080', label: '1080px wide', maxWidth: 1080 }),
    workload({ id: 'burst-8', label: '8-request burst', concurrency: 8, iterations: 40 }),
    workload({ id: 'steady-100', label: '100 sequential', iterations: 100 }),
    workload({ id: 'steady-500', label: '500 sequential', iterations: 500 }),
    workload({
      id: 'fail-missing-source',
      label: 'repeated failed source loads',
      iterations: 25,
      sourceKind: 'missing',
      expectFailure: true,
    }),
    workload({
      id: 'fail-corrupt-source',
      label: 'corrupt source',
      iterations: 25,
      sourceKind: 'corrupt',
      expectFailure: true,
    }),
    workload({
      id: 'fail-destination-write',
      label: 'failed output writes (missing parent directory)',
      iterations: 25,
      sourceKind: 'unwritable',
      expectFailure: true,
    }),
  ]
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                     */
/* -------------------------------------------------------------------------- */

export interface WorkloadReport {
  implementationId: string
  workloadId: string
  skipped?: string
  /** Samples kept after warm-up. */
  samples: number
  errors: number
  errorCodes: Record<string, number>
  /** First measured call after launch; excluded from the percentiles below. */
  coldMs: number | null
  p50Ms: number | null
  p95Ms: number | null
  minMs: number | null
  maxMs: number | null
  /** Mean of each native phase, this library only. */
  nativeMs: Record<keyof FrameGrabTimings, number> | null
  output: { width: number; height: number; size: number } | null
  /** JS-thread frames per second observed while the workload ran. */
  uiFps: number | null
}

export interface BenchmarkReport {
  startedAt: string
  device: Record<string, unknown>
  source: BenchSource
  maxConcurrency: number
  warmupIterations: number
  cooldownMs: number
  workloads: Workload[]
  results: WorkloadReport[]
  caveats: string[]
}

const CAVEATS = [
  'Peak process/native memory, file descriptors and thermal state are not readable from JS. Record them with Xcode Instruments or Android Studio Profiler during the same run.',
  'Warm results only. Neither a fresh launch nor a cold start proves the OS page cache is cold.',
  'Equal numeric JPEG quality does not mean equal visual quality: compare the images and the byte sizes, not just the settings.',
  'Competitors that do not expose frame-selection settings were run at their defaults; that is not the same work as an explicit precise request.',
  'Run release builds on a physical device. Debug builds and simulators do not measure the same thing.',
]

/* -------------------------------------------------------------------------- */
/* Runner                                                                      */
/* -------------------------------------------------------------------------- */

function percentile(sorted: number[], fraction: number): number {
  // Nearest-rank, so small sample counts stay honest.
  const rank = Math.max(1, Math.ceil(fraction * sorted.length))
  return sorted[rank - 1]!
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap]!, copy[index]!]
  }
  return copy
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Counts JS-thread frames so a workload's effect on UI responsiveness is visible. */
function startFpsProbe(): () => number | null {
  let frames = 0
  let running = true
  const startedAt = performance.now()
  const tick = () => {
    if (!running) return
    frames += 1
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
  return () => {
    running = false
    const seconds = (performance.now() - startedAt) / 1000
    return seconds > 0 ? frames / seconds : null
  }
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    return String((error as { code: unknown }).code)
  }
  return error instanceof Error ? error.name : 'UnknownError'
}

interface Sample {
  ms: number
  ok: boolean
  code?: string
  output?: { width: number; height: number; size: number }
  native?: FrameGrabTimings
}

async function runOnce(
  implementation: Implementation,
  job: ExtractionJob
): Promise<Sample> {
  const startedAt = performance.now()
  try {
    const output = await implementation.run(job)
    return {
      ms: performance.now() - startedAt,
      ok: true,
      output: { width: output.width, height: output.height, size: output.size },
      native: output.native,
    }
  } catch (error) {
    return { ms: performance.now() - startedAt, ok: false, code: errorCodeOf(error) }
  }
}

function jobFor(
  implementation: Implementation,
  work: Workload,
  source: BenchSource,
  sequence: number,
  synthetic: { corrupt: BenchSource; missing: BenchSource }
): ExtractionJob {
  const sourceUri =
    work.sourceKind === 'corrupt'
      ? synthetic.corrupt.uri
      : work.sourceKind === 'missing'
        ? synthetic.missing.uri
        : source.uri

  // A unique destination per in-flight job: same-destination overlap is a
  // rejected request by design, not a benchmark case.
  const name = `${implementation.id}-${work.id}-${sequence}.jpg`
  const destinationUri =
    work.sourceKind === 'unwritable'
      ? outputFile(`no-such-directory/${name}`).uri
      : outputFile(name).uri

  return {
    sourceUri,
    destinationUri,
    timeMs: work.timeMs,
    maxWidth: work.maxWidth,
    quality: work.quality,
    mode: work.mode,
  }
}

async function runWorkload(
  implementation: Implementation,
  work: Workload,
  source: BenchSource,
  warmupIterations: number,
  synthetic: { corrupt: BenchSource; missing: BenchSource },
  isFirstOfRun: boolean
): Promise<WorkloadReport> {
  const empty: WorkloadReport = {
    implementationId: implementation.id,
    workloadId: work.id,
    samples: 0,
    errors: 0,
    errorCodes: {},
    coldMs: null,
    p50Ms: null,
    p95Ms: null,
    minMs: null,
    maxMs: null,
    nativeMs: null,
    output: null,
    uiFps: null,
  }

  if (!implementation.available) {
    return { ...empty, skipped: implementation.unavailableReason ?? 'unavailable' }
  }
  if (work.requiresPrecise && !implementation.supportsPrecise) {
    return { ...empty, skipped: 'does not expose a precise frame-selection mode' }
  }

  let sequence = 0
  const nextJob = () =>
    jobFor(implementation, work, source, sequence++, synthetic)

  // Warm-up runs are discarded: they measure first-use setup, not steady state.
  for (let index = 0; index < warmupIterations; index += 1) {
    await runOnce(implementation, nextJob())
  }

  const stopFps = startFpsProbe()
  const samples: Sample[] = []
  let remaining = work.iterations

  while (remaining > 0) {
    const batchSize = Math.min(work.concurrency, remaining)
    const batch = await Promise.all(
      Array.from({ length: batchSize }, () => runOnce(implementation, nextJob()))
    )
    samples.push(...batch)
    remaining -= batchSize
  }

  const uiFps = stopFps()

  const errorCodes: Record<string, number> = {}
  for (const sample of samples) {
    if (!sample.ok) errorCodes[sample.code ?? 'Unknown'] = (errorCodes[sample.code ?? 'Unknown'] ?? 0) + 1
  }

  const successful = samples.filter((sample) => sample.ok)
  const timed = work.expectFailure ? samples : successful
  // The very first measured call after launch is reported separately.
  const cold = isFirstOfRun && timed.length > 0 ? timed[0]!.ms : null
  const measured = cold != null ? timed.slice(1) : timed
  const sorted = measured.map((sample) => sample.ms).sort((a, b) => a - b)

  const withNative = successful.filter((sample) => sample.native)
  const nativeMs = withNative.length
    ? (Object.fromEntries(
        (
          [
            'queueWaitMs',
            'sourceMs',
            'metadataMs',
            'extractMs',
            'encodeMs',
            'finalizeMs',
          ] as const
        ).map((key) => [
          key,
          withNative.reduce((total, sample) => total + sample.native![key], 0) /
            withNative.length,
        ])
      ) as Record<keyof FrameGrabTimings, number>)
    : null

  return {
    implementationId: implementation.id,
    workloadId: work.id,
    samples: sorted.length,
    errors: samples.length - successful.length,
    errorCodes,
    coldMs: cold,
    p50Ms: sorted.length ? percentile(sorted, 0.5) : null,
    p95Ms: sorted.length ? percentile(sorted, 0.95) : null,
    minMs: sorted.length ? sorted[0]! : null,
    maxMs: sorted.length ? sorted[sorted.length - 1]! : null,
    nativeMs,
    output: successful[0]?.output ?? null,
    uiFps,
  }
}

export interface BenchmarkOptions {
  source: BenchSource
  workloads?: Workload[]
  implementationIds?: string[]
  /** Native scheduler bound under test. Plan section 12 asks for 1, 2 and 4. */
  maxConcurrency?: number
  warmupIterations?: number
  /** Idle gap between workloads, to take some heat out of the device. */
  cooldownMs?: number
  onProgress?: (line: string) => void
}

export async function runBenchmark(
  options: BenchmarkOptions
): Promise<BenchmarkReport> {
  const {
    source,
    workloads = defaultWorkloads(),
    implementationIds,
    maxConcurrency = 2,
    warmupIterations = 3,
    cooldownMs = 1_500,
    onProgress = () => {},
  } = options

  resetOutputDirectory()
  const synthetic = { corrupt: corruptSource(), missing: missingSource() }
  setMaxConcurrency(maxConcurrency)

  const selected = implementations.filter(
    (implementation) =>
      !implementationIds || implementationIds.includes(implementation.id)
  )

  const results: WorkloadReport[] = []
  let first = true

  for (const work of workloads) {
    // Randomised order per workload, so a warming or throttling trend does not
    // land on the same implementation every time.
    for (const implementation of shuffle(selected)) {
      onProgress(`${work.label} — ${implementation.label}`)
      const report = await runWorkload(
        implementation,
        work,
        source,
        warmupIterations,
        synthetic,
        first
      )
      first = false
      results.push(report)
      await sleep(cooldownMs)
    }
  }

  return {
    startedAt: new Date().toISOString(),
    device: {
      os: Platform.OS,
      version: Platform.Version,
      ...(Platform.constants as unknown as Record<string, unknown>),
      isTesting: __DEV__ ? 'DEBUG BUILD — results are not comparable' : 'release',
    },
    source,
    maxConcurrency,
    warmupIterations,
    cooldownMs,
    workloads,
    results,
    caveats: CAVEATS,
  }
}

/** Writes the raw report next to the generated thumbnails, for later diffing. */
export function saveReport(report: BenchmarkReport): string {
  const file = outputFile(`report-${report.maxConcurrency}x-${Date.now()}.json`)
  file.create({ overwrite: true })
  file.write(JSON.stringify(report, null, 2))
  return file.uri
}

export function formatReport(report: BenchmarkReport): string {
  const lines: string[] = []
  for (const work of report.workloads) {
    lines.push(`\n## ${work.label}`)
    const rows = report.results.filter((result) => result.workloadId === work.id)
    const baseline = rows.find((row) => row.implementationId === BASELINE_ID)?.p50Ms
    for (const row of rows) {
      if (row.skipped) {
        lines.push(`  ${row.implementationId}: skipped — ${row.skipped}`)
        continue
      }
      const delta =
        baseline && row.p50Ms && row.implementationId === SUBJECT_ID
          ? ` (${Math.round((1 - row.p50Ms / baseline) * 100)}% vs ${BASELINE_ID})`
          : ''
      lines.push(
        `  ${row.implementationId}: p50 ${row.p50Ms?.toFixed(1) ?? '-'} ms, ` +
          `p95 ${row.p95Ms?.toFixed(1) ?? '-'} ms, n=${row.samples}, ` +
          `errors=${row.errors}${delta}`
      )
      if (row.output) {
        lines.push(
          `      output ${row.output.width}x${row.output.height}, ${row.output.size} B` +
            (row.uiFps ? `, UI ${row.uiFps.toFixed(0)} fps` : '')
        )
      }
      if (row.nativeMs) {
        lines.push(
          `      native queue ${row.nativeMs.queueWaitMs.toFixed(1)} / ` +
            `source ${row.nativeMs.sourceMs.toFixed(1)} / ` +
            `meta ${row.nativeMs.metadataMs.toFixed(1)} / ` +
            `extract ${row.nativeMs.extractMs.toFixed(1)} / ` +
            `encode+write ${row.nativeMs.encodeMs.toFixed(1)} / ` +
            `finalize ${row.nativeMs.finalizeMs.toFixed(1)} ms`
        )
      }
      if (row.coldMs != null) {
        lines.push(`      first-after-launch ${row.coldMs.toFixed(1)} ms (excluded above)`)
      }
      if (Object.keys(row.errorCodes).length) {
        lines.push(`      codes ${JSON.stringify(row.errorCodes)}`)
      }
    }
  }
  return lines.join('\n')
}
