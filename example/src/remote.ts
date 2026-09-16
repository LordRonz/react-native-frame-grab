/**
 * Remote endpoints for the section 7 / section 16 remote matrix.
 *
 * Remote support means the native media framework reads a remote video. It does
 * not mean the library downloads it first, and nothing here bounds how many
 * bytes get read — container layout, codec, timestamp, redirects and range
 * support decide that.
 */

export interface RemoteEndpoint {
  id: string
  label: string
  url: string
  /**
   * What extraction should do. `failure` lists the acceptable error codes.
   * `either` means both outcomes are correct and the run only records which —
   * use it where the answer depends on the consuming app's policy, not on this
   * library.
   */
  expect: 'success' | 'failure' | 'either'
  acceptableCodes?: string[]
  /** Which row of the remote matrix this covers. */
  covers: string
  /** Third-party endpoints can go down; that is not a library failure. */
  thirdParty?: boolean
}

/**
 * **Point this at your own media host.** The migration gate for the remote path
 * depends on the real host, not on public samples: if native behaviour is
 * unacceptable there, the plan says stop and keep the existing app pipeline for
 * remote sources rather than adding a downloader.
 *
 * Use a signed URL if that is how your app serves video — signed query strings
 * are their own test case.
 */
export const APP_MEDIA_HOST_URL: string | null = null

/**
 * Verified reachable on 2026-09-16. Public sample endpoints rot — the Google
 * `gtv-videos-bucket` URLs that used to be the standard choice now return 403
 * `AccessDenied`. If one of these dies the probe reports it as unreachable
 * rather than as a library failure, but it is still worth re-checking.
 */
const SINTEL = 'https://media.w3.org/2010/05/sintel/trailer.mp4'

export const REMOTE_ENDPOINTS: RemoteEndpoint[] = [
  {
    id: 'https-progressive',
    label: 'HTTPS progressive MP4',
    url: SINTEL,
    expect: 'success',
    covers: 'the baseline remote case: HTTPS, range-supported, fast-start',
    thirdParty: true,
  },
  {
    id: 'https-large',
    label: 'HTTPS larger MP4 (1080p, ~30 MB)',
    url: 'https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/1080/Big_Buck_Bunny_1080_10s_30MB.mp4',
    expect: 'success',
    covers: 'how much gets read when the file is big and the frame is at t=0',
    thirdParty: true,
  },
  {
    id: 'https-no-range',
    label: 'HTTPS without range support',
    // Answers a ranged request with 200 and the whole body, so the framework
    // cannot seek and has to read from the start.
    url: 'https://filesamples.com/samples/video/mp4/sample_640x360.mp4',
    expect: 'success',
    covers: 'a server that ignores Range — the plan asks for both variants',
    thirdParty: true,
  },
  {
    id: 'https-redirect',
    label: 'HTTPS 302 redirect',
    url: `https://httpbin.org/redirect-to?url=${encodeURIComponent(SINTEL)}`,
    expect: 'success',
    covers: 'the framework following a redirect to the real media',
    thirdParty: true,
  },
  {
    id: 'http-cleartext',
    label: 'Plain HTTP (cleartext)',
    url: SINTEL.replace('https://', 'http://'),
    // Both outcomes are correct, so this only records which happened. The host
    // answers cleartext with a 301 to HTTPS, so it succeeds where the app's ATS
    // / cleartext policy permits the initial plain connection, and fails cleanly
    // where it does not. The library must never weaken that policy to make this
    // go green.
    expect: 'either',
    covers: "the consuming app's transport-security policy, not the library's",
    thirdParty: true,
  },
  {
    id: 'http-404',
    label: 'HTTP 404',
    url: 'https://httpbingo.org/status/404',
    expect: 'failure',
    acceptableCodes: ['E_SOURCE_UNREADABLE', 'E_FRAME_EXTRACTION'],
    covers: 'an HTTP error surfaces as a source failure, not a decode failure',
    thirdParty: true,
  },
  {
    id: 'unresolvable-host',
    label: 'Unresolvable host',
    url: 'https://this-host-does-not-exist.invalid/video.mp4',
    expect: 'failure',
    acceptableCodes: ['E_SOURCE_UNREADABLE', 'E_FRAME_EXTRACTION'],
    covers: 'DNS failure is reported, and the scheduler slot is released',
  },
  {
    id: 'delayed-response',
    label: 'Delayed response (10s)',
    url: 'https://httpbingo.org/delay/10',
    expect: 'failure',
    acceptableCodes: ['E_SOURCE_UNREADABLE', 'E_FRAME_EXTRACTION'],
    covers:
      'the documented timeout limitation: measure how long the slot stays occupied',
    thirdParty: true,
  },
]

export interface EndpointProbe {
  reachable: boolean
  status?: number
  /** `bytes` means the server advertises range support. */
  acceptRanges?: string
  contentLength?: number
  contentType?: string
  elapsedMs: number
  error?: string
}

/**
 * Checks the endpoint over plain HTTP before extraction runs.
 *
 * Two reasons: network behaviour has to be measured separately from decoding,
 * and a third-party endpoint being down must read as "endpoint unreachable"
 * rather than as a library defect.
 */
export async function probeEndpoint(url: string): Promise<EndpointProbe> {
  const startedAt = performance.now()
  try {
    // Some CDNs reject HEAD; a 0-0 range GET works everywhere and also tells us
    // whether range requests are honoured.
    const response = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-0' },
    })
    const elapsedMs = performance.now() - startedAt
    const contentRange = response.headers.get('content-range')
    return {
      reachable: true,
      status: response.status,
      // 206 means the range request was honoured even if Accept-Ranges is absent.
      acceptRanges:
        response.headers.get('accept-ranges') ??
        (response.status === 206 ? 'bytes (inferred from 206)' : 'none'),
      contentLength: contentRange
        ? Number(contentRange.split('/')[1])
        : Number(response.headers.get('content-length')) || undefined,
      contentType: response.headers.get('content-type') ?? undefined,
      elapsedMs,
    }
  } catch (error) {
    return {
      reachable: false,
      elapsedMs: performance.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
