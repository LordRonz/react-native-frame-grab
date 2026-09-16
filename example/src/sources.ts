import { Directory, File, Paths } from 'expo-file-system'
import * as MediaLibrary from 'expo-media-library'
import { Platform } from 'react-native'

import { APP_MEDIA_HOST_URL, REMOTE_ENDPOINTS } from './remote'

export interface BenchSource {
  id: string
  label: string
  /** Passed straight to every implementation under test. */
  uri: string
  /** Free-form provenance so benchmark output stays reproducible. */
  note?: string
  /** Known duration, when the source came from somewhere that reports one. */
  durationMs?: number
}

/** Everything this app writes lives here, so a run can be wiped in one call. */
export const outputDirectory = new Directory(Paths.cache, 'frame-grab-bench')

/** Drop fixture videos here (see README) and they show up automatically. */
export const fixtureDirectory = new Directory(Paths.document, 'fixtures')

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.3gp']

export function ensureDirectories(): void {
  for (const directory of [outputDirectory, fixtureDirectory]) {
    if (!directory.exists) directory.create({ intermediates: true })
  }
}

export function resetOutputDirectory(): void {
  if (outputDirectory.exists) outputDirectory.delete()
  outputDirectory.create({ intermediates: true })
}

export function outputFile(name: string): File {
  return new File(outputDirectory, name)
}

/**
 * Fixture videos pushed onto the device.
 *
 * Deliberately not bundled: a repository is the wrong place for 4K HEVC test
 * media, and the acceptance matrix needs device-specific codec coverage anyway.
 */
export function listFixtureSources(): BenchSource[] {
  if (!fixtureDirectory.exists) return []
  return fixtureDirectory
    .list()
    .filter(
      (entry): entry is File =>
        entry instanceof File &&
        VIDEO_EXTENSIONS.some((extension) =>
          entry.name.toLowerCase().endsWith(extension)
        )
    )
    .map((file) => ({
      id: `fixture:${file.name}`,
      label: file.name,
      uri: file.uri,
      note: 'pushed fixture',
    }))
}

/**
 * Videos from the device's media library — the real-world path.
 *
 * `getInfo().uri` resolves to a concrete `file://` URL on both platforms. On
 * Android the asset's own id *is* a `content://` URI, so it is listed as a
 * second source: that is the only way to exercise the provider path.
 */
export async function listLibrarySources(limit = 8): Promise<BenchSource[]> {
  const permission = await MediaLibrary.requestPermissionsAsync()
  if (!permission.granted) return []

  const assets = await new MediaLibrary.Query()
    .eq(MediaLibrary.AssetField.MEDIA_TYPE, MediaLibrary.MediaType.VIDEO)
    .orderBy({ key: MediaLibrary.AssetField.CREATION_TIME, ascending: false })
    .limit(limit)
    .exe()

  const sources: BenchSource[] = []
  for (const asset of assets) {
    let info: Awaited<ReturnType<typeof asset.getInfo>>
    try {
      info = await asset.getInfo()
    } catch {
      continue // iCloud-only or otherwise unresolvable.
    }
    const durationMs = info.duration ?? undefined
    const shape = `${info.width}x${info.height}`
    const seconds = durationMs != null ? `, ${Math.round(durationMs / 1000)}s` : ''

    if (!info.uri.startsWith('ph://')) {
      sources.push({
        id: `library:${asset.id}`,
        label: `${info.filename} (${shape}${seconds})`,
        uri: info.uri,
        note: `media library file, ${Platform.OS}`,
        durationMs,
      })
    }
    if (Platform.OS === 'android' && asset.id.startsWith('content://')) {
      sources.push({
        id: `content:${asset.id}`,
        label: `${info.filename} via content:// (${shape}${seconds})`,
        uri: asset.id,
        note: 'media library content provider',
        durationMs,
      })
    }
  }
  return sources
}

/**
 * A deliberately broken MP4. Every implementation must reject it rather than
 * produce a file, and must not leak native resources doing so.
 */
export function corruptSource(): BenchSource {
  const file = new File(outputDirectory, 'corrupt.mp4')
  if (file.exists) file.delete()
  file.create()
  // Valid ftyp box header followed by garbage: enough to get past a sniff, not
  // enough to decode.
  const bytes = new Uint8Array(4096)
  bytes.set([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
  for (let index = 12; index < bytes.length; index += 1) {
    bytes[index] = (index * 31) % 251
  }
  file.write(bytes)
  return {
    id: 'synthetic:corrupt',
    label: 'corrupt.mp4 (truncated/garbage)',
    uri: file.uri,
    note: 'generated at runtime',
  }
}

/**
 * Remote videos, for benchmarking the network path.
 *
 * Only the endpoints that are expected to decode are listed — the failure cases
 * belong to the remote acceptance matrix, not to a latency benchmark.
 */
export function listRemoteSources(): BenchSource[] {
  const sources = REMOTE_ENDPOINTS.filter(
    (endpoint) => endpoint.expect === 'success'
  ).map((endpoint) => ({
    id: `remote:${endpoint.id}`,
    label: `${endpoint.label} (remote)`,
    uri: endpoint.url,
    note: endpoint.thirdParty ? 'third-party sample' : 'remote',
  }))

  if (APP_MEDIA_HOST_URL) {
    sources.unshift({
      id: 'remote:app-host',
      label: 'Your app media host (remote)',
      uri: APP_MEDIA_HOST_URL,
      note: 'the host the migration decision depends on',
    })
  }
  return sources
}

export function missingSource(): BenchSource {
  return {
    id: 'synthetic:missing',
    label: 'missing.mp4 (does not exist)',
    uri: new File(outputDirectory, 'definitely-not-here.mp4').uri,
    note: 'generated at runtime',
  }
}
