import { File } from 'expo-file-system'
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator'
import { createVideoPlayer, type VideoPlayer } from 'expo-video'
import { createThumbnail } from 'react-native-nitro-thumbnail'
import * as VideoThumbnails from 'expo-video-thumbnails'
import {
  unstable_extractThumbnailWithTimings,
  type FrameGrabTimings,
} from 'react-native-frame-grab'

export interface ExtractionJob {
  sourceUri: string
  destinationUri: string
  timeMs: number
  maxWidth: number
  quality: number
  mode: 'fast' | 'precise'
}

export interface ExtractionOutput {
  width: number
  height: number
  size: number
  /** Only this library reports native phase timings. */
  native?: FrameGrabTimings
}

export interface Implementation {
  id: string
  label: string
  version: string
  /**
   * The frame-selection settings actually used. Recorded so nobody compares
   * permissive extraction against precise extraction as if it were the same work.
   */
  selection: Record<'fast' | 'precise', string>
  supportsPrecise: boolean
  available: boolean
  unavailableReason?: string
  run(job: ExtractionJob): Promise<ExtractionOutput>
}

/** Every adapter writes the JPEG to `destinationUri`; disk output is part of the work. */
async function moveInto(temporaryUri: string, destinationUri: string): Promise<number> {
  const source = new File(temporaryUri)
  const destination = new File(destinationUri)
  // Non-atomic on purpose: this is what the pipelines under comparison do.
  if (destination.exists) destination.delete()
  await source.move(destination)
  return destination.size
}

/** The implementation under test. */
export const SUBJECT_ID = 'frame-grab'

/**
 * What it has to beat: the pipeline the app runs today. Named explicitly rather
 * than "whichever other row came first", because workload order is randomised.
 */
export const BASELINE_ID = 'expo-video+image-manipulator'

// region This library

const frameGrab: Implementation = {
  id: SUBJECT_ID,
  label: 'react-native-frame-grab (Nitro)',
  version: '0.0.1',
  selection: {
    fast: 'iOS: tolerance +/- infinity | Android: OPTION_CLOSEST_SYNC',
    precise: 'iOS: tolerance 0 | Android: OPTION_CLOSEST',
  },
  supportsPrecise: true,
  available: true,
  async run(job) {
    const { result, timings } = await unstable_extractThumbnailWithTimings({
      sourceUri: job.sourceUri,
      destinationUri: job.destinationUri,
      timeMs: job.timeMs,
      maxWidth: job.maxWidth,
      quality: job.quality,
      mode: job.mode,
    })
    return {
      width: result.width,
      height: result.height,
      size: result.size,
      native: timings,
    }
  },
}

// endregion

// region expo-video + expo-image-manipulator (the pipeline being replaced)

function whenReady(player: VideoPlayer): Promise<void> {
  if (player.status === 'readyToPlay') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const subscription = player.addListener('statusChange', ({ status, error }) => {
      if (status === 'readyToPlay') {
        subscription.remove()
        resolve()
      } else if (status === 'error') {
        subscription.remove()
        reject(error ?? new Error('expo-video player failed to load the source'))
      }
    })
  })
}

const expoVideoPipeline: Implementation = {
  id: BASELINE_ID,
  label: 'expo-video generateThumbnailsAsync + ImageManipulator',
  version: 'expo-video 57 / expo-image-manipulator 57',
  selection: {
    fast: 'AVAssetImageGenerator / MediaMetadataRetriever defaults (not configurable)',
    precise: 'not exposed',
  },
  supportsPrecise: false,
  available: true,
  async run(job) {
    let player: VideoPlayer | undefined
    try {
      player = createVideoPlayer({ uri: job.sourceUri })
      await whenReady(player)

      const [thumbnail] = await player.generateThumbnailsAsync([job.timeMs / 1000], {
        maxWidth: job.maxWidth,
      })
      if (!thumbnail) throw new Error('expo-video returned no thumbnail')

      const context = ImageManipulator.manipulate(thumbnail)
      if (thumbnail.width > job.maxWidth) context.resize({ width: job.maxWidth })
      const image = await context.renderAsync()
      const saved = await image.saveAsync({
        format: SaveFormat.JPEG,
        compress: job.quality,
      })

      const size = await moveInto(saved.uri, job.destinationUri)
      return { width: saved.width, height: saved.height, size }
    } finally {
      player?.release()
    }
  },
}

// endregion

// region expo-video-thumbnails (dedicated thumbnail library)

const expoVideoThumbnails: Implementation = {
  id: 'expo-video-thumbnails',
  label: 'expo-video-thumbnails',
  version: 'expo-video-thumbnails 57',
  selection: {
    fast: 'platform defaults (not configurable)',
    precise: 'not exposed',
  },
  supportsPrecise: false,
  available: true,
  async run(job) {
    const thumbnail = await VideoThumbnails.getThumbnailAsync(job.sourceUri, {
      time: job.timeMs,
      quality: job.quality,
    })

    // No width bound in its API, so the downscale + re-encode is adapter
    // overhead this library needs in order to produce a comparable output.
    const context = ImageManipulator.manipulate(thumbnail.uri)
    if (thumbnail.width > job.maxWidth) context.resize({ width: job.maxWidth })
    const image = await context.renderAsync()
    const saved = await image.saveAsync({
      format: SaveFormat.JPEG,
      compress: job.quality,
    })

    const size = await moveInto(saved.uri, job.destinationUri)
    return { width: saved.width, height: saved.height, size }
  },
}

// endregion

// region react-native-nitro-thumbnail

/**
 * The closest comparable: also Nitro, also thumbnail-specific, also
 * AVAssetImageGenerator / MediaMetadataRetriever underneath.
 *
 * Three things have to be disclosed for this comparison to be fair:
 *
 * 1. It writes into its own cache directory and returns that path, so the move
 *    to `destinationUri` below is adapter overhead this library does not pay.
 * 2. `maxHeight` defaults to 512, which would bind before `maxWidth` on a
 *    portrait source. It is raised here so width is the only constraint, matching
 *    what `extractThumbnail` does.
 * 3. `cacheName` is deliberately left unset. With it, the library short-circuits
 *    on an existing file, and the benchmark would be timing cache hits.
 *
 * It also enforces a cache-directory size cap on every call (a directory scan
 * per extraction) and buffers the encoded image in memory before writing, where
 * this library streams straight to the file. Both show up in the numbers.
 */
const nitroThumbnail: Implementation = {
  id: 'nitro-thumbnail',
  label: 'react-native-nitro-thumbnail',
  version: 'react-native-nitro-thumbnail 0.1.4',
  selection: {
    fast: 'onlySyncedFrames: true, timeToleranceMs: 2000 (its default)',
    precise: 'onlySyncedFrames: false, timeToleranceMs: 0',
  },
  supportsPrecise: true,
  available: true,
  async run(job) {
    const thumbnail = await createThumbnail({
      url: job.sourceUri,
      timeStamp: job.timeMs,
      format: 'jpeg',
      maxWidth: job.maxWidth,
      maxHeight: 4096,
      quality: job.quality,
      onlySyncedFrames: job.mode === 'fast',
      timeToleranceMs: job.mode === 'precise' ? 0 : 2000,
    })

    const size = await moveInto(thumbnail.path, job.destinationUri)
    return { width: thumbnail.width, height: thumbnail.height, size }
  },
}

// endregion

/**
 * `@mindinventory/react-native-nitro-video` is listed as a secondary reference.
 * Metro resolves `require` calls at build time, so an optional dependency
 * cannot be probed at runtime: install it, then add an adapter here.
 */
const nitroVideo: Implementation = {
  id: 'nitro-video',
  label: '@mindinventory/react-native-nitro-video',
  version: 'n/a',
  selection: { fast: 'n/a', precise: 'n/a' },
  supportsPrecise: false,
  available: false,
  unavailableReason:
    'Not installed. Add the dependency and an adapter in src/competitors.ts to include it.',
  run() {
    throw new Error('not installed')
  },
}

export const implementations: Implementation[] = [
  frameGrab,
  expoVideoPipeline,
  expoVideoThumbnails,
  nitroThumbnail,
  nitroVideo,
]
