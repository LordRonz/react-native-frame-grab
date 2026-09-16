# react-native-frame-grab

One thing, done directly: a video frame becomes a JPEG on disk.

```text
video URI → native frame extraction → bounded scaling → JPEG → atomic file replacement
```

No player, no intermediate image objects, no image bytes crossing into
JavaScript. A [Nitro](https://nitro.margelo.com) module with Swift and Kotlin
implementations — Nitro removes bridge overhead, it does not remove decoding
work, so the speed claim is a benchmark result, not an architecture argument.

## Install

```sh
npm install react-native-frame-grab react-native-nitro-modules
cd ios && pod install
```

Remote sources need `android.permission.INTERNET` in the consuming app. This
library does not declare it for you, and does not touch your ATS or cleartext
policy.

## Usage

```ts
import { extractThumbnail } from 'react-native-frame-grab'

const { uri, width, height, size } = await extractThumbnail({
  sourceUri: videoUri,
  destinationUri: `${cacheDir}/thumb.jpg`,
  timeMs: 0,
  maxWidth: 480,
  quality: 0.6,
  mode: 'fast',
})
```

### API

```ts
function extractThumbnail(options: FrameGrabOptions): Promise<FrameGrabResult>

interface FrameGrabOptions {
  sourceUri: string
  destinationUri: string
  timeMs?: number // default 0
  maxWidth?: number // default 480
  quality?: number // default 0.6
  mode?: 'fast' | 'precise' // default 'fast'
}

interface FrameGrabResult {
  uri: string // absolute file:// URI of the finalized JPEG
  width: number // actual encoded pixels, after orientation correction
  height: number
  size: number // encoded JPEG byte count
  requestedTimeMs: number // the validated request, NOT the selected frame's time
}
```

There is deliberately no `actualTimeMs`. Android's `MediaMetadataRetriever` does
not report the selected frame's timestamp through this API, and inferring it
from the frame rate would be a guess dressed up as data.

Two more exports, for benchmarking rather than production:
`setMaxConcurrency(n)` / `getMaxConcurrency()` and
`unstable_extractThumbnailWithTimings(options)`, which additionally returns
native per-phase timings.

## Frame selection

`fast` and `precise` describe intent. They do not claim identical decoder
behaviour across platforms.

| Mode | Android | iOS |
| --- | --- | --- |
| `fast` | `OPTION_CLOSEST_SYNC` | both requested-time tolerances set to positive infinity |
| `precise` | `OPTION_CLOSEST` | both requested-time tolerances set to zero |

- Android `fast` asks for a nearby sync/keyframe.
- iOS `fast` lets AVFoundation pick a frame under its tolerance policy. That is
  not a keyframe-only guarantee.
- `precise` asks for higher temporal precision and may decode more.
- `precise` is not a promise that every arbitrary timestamp maps to an exact
  frame at that timestamp.
- Neither mode guarantees identical images across platforms.
- A valid timestamp can still fail to yield an image. That is reported as an
  extraction failure; the library will not silently change the mode or the
  timestamp behind your back.

## Sources and destinations

| Source | iOS | Android |
| --- | --- | --- |
| Absolute filesystem path | yes | yes |
| `file://` | yes | yes |
| `content://` | no | yes, via `setDataSource(context, uri)` |
| `https://` | native framework access, tested subset | same |
| `http://` | same, subject to ATS | same, subject to cleartext policy |

Relative paths are rejected. File URIs are parsed with platform URI APIs, so
percent-encoded names and spaces round-trip correctly.

Android `content://` permissions stay the caller's responsibility. This module
neither requests nor persists URI access grants.

Destinations must be an absolute path or a local `file://` URI. The parent
directory must already exist — no implicit `mkdir -p`. Directory and symlink
destinations are rejected, as is a destination that resolves to the source file
(checked by canonical path and by device/inode, so hardlinks and symlinks are
caught). Content providers can hide aliases behind a URI that no descriptor
reveals; supply an output location you control.

### Remote sources

"Remote" means the native media framework reads a remote video. It does not mean
the library downloads the file first, and there is no bound on how many bytes get
read — container layout, codec, timestamp, redirects and range support all decide
that.

Scope is progressive HTTP(S) video. Not DRM, not live, not HLS/DASH, not custom
headers.

**Timeout limitation.** `MediaMetadataRetriever` has no general-purpose way to
interrupt a running open/extract. Rejecting a JavaScript Promise would not stop
the native work, so this library does not pretend to offer a timeout. A slow
remote request occupies a native slot until the platform operation returns.

## Output

`maxWidth` bounds the final *displayed* width, not the encoded track width before
rotation.

- Display aspect ratio is preserved, within integer-pixel rounding.
- Sources already narrower than `maxWidth` are never upscaled.
- Final width never exceeds `maxWidth`.
- Pixels are written upright. No EXIF orientation tag is emitted, so nothing
  downstream has to apply one.
- `width`/`height` in the result are what was actually encoded, not what was
  requested.

Limits, enforced in JavaScript and again natively:

```text
maxWidth: 1–4096 pixels
maximum final image area: 16,777,216 pixels
```

A request over a limit is rejected, never silently clamped. These bound the
*output* allocation; they say nothing about what a platform decoder allocates
internally.

On iOS, bounds come from the track's presentation dimensions (pixel aspect ratio
and clean aperture included) with `preferredTransform` applied, and
`AVAssetImageGenerator.maximumSize` does the scaling.

### Android orientation

`MediaMetadataRetriever` reports *encoded* width/height plus a separate rotation
key, and is expected to hand back a display-oriented bitmap. The library corrects
exactly the one case it can actually detect: a 90°/270° source whose returned
bitmap still carries the encoded aspect orientation. That rotation is applied
once, never twice.

Dimensions cannot resolve a 180° rotation or a square frame — there is no
asymmetry to read. Those are left to the platform rather than guessed at, and no
OEM-specific heuristics are added. The example app's fixture set exists to catch
a device where that assumption fails; run it before trusting rotated output on
unfamiliar hardware.

## Atomicity

```text
extract → encode to a temporary sibling → close → check non-empty
        → atomic replace → resolve
```

The temporary file is `.framegrab-<uuid>.jpg.tmp`, created in the destination's
own directory, and belongs to exactly one request. Finalization is `rename(2)`
(`File.renameTo` on Android), which atomically replaces an existing file on the
same filesystem. Never delete-then-move: that loses the old file if the move
fails.

Before the rename, any failure leaves the previous destination untouched and
removes only this request's temporary file. After it, the request is committed —
no rejection for bookkeeping reasons.

The guarantee is atomic *visibility* of a complete file, not survival of sudden
power loss. There is no fsync machinery here and no crash-durability claim.
Process termination can orphan a temporary file; normal success and failure paths
clean up their own, and the naming convention above is documented so you can
sweep for the rest.

## Concurrency

One module-wide bounded scheduler per platform, default two concurrent jobs. A
job covers source init, metadata, extraction, encoding and finalization; no
native source is opened before a slot is held.

A destination reservation — canonical parent directory plus filename — is taken
before queueing. A second pending or running request for the same destination is
rejected with `E_DESTINATION_BUSY`. The registry is module-wide, so creating more
facade instances cannot route around it.

The pending queue holds 64 jobs; overflow is rejected with `E_BUSY`. That is
admission control, not cancellation: a rejected request leaves no native object,
no temporary file and no reservation behind. Nothing blocks the JavaScript or UI
thread while waiting.

These guarantees cover this module's requests inside one process. They do not
cover other writers or provider aliases the filesystem conceals.

## Errors

Rejections are `Error` instances with a stable `code`:

```text
E_INVALID_ARGUMENT        E_ENCODE_FAILED
E_UNSUPPORTED_URI         E_DESTINATION_WRITE
E_SOURCE_UNREADABLE       E_DESTINATION_BUSY
E_TIMESTAMP_OUT_OF_RANGE  E_BUSY
E_FRAME_EXTRACTION        E_INTERNAL
```

```ts
import { FrameGrabError } from 'react-native-frame-grab'

try {
  await extractThumbnail(options)
} catch (error) {
  if (error instanceof FrameGrabError && error.code === 'E_TIMESTAMP_OUT_OF_RANGE') {
    // ...
  }
}
```

Native never throws across the bridge for an expected failure; it returns a small
internal `{ result? , error? }` envelope, and the JavaScript facade validates the
invariant and builds the public `Error`. An unknown or malformed native failure
becomes `E_INTERNAL`. Credentials and signed query strings are stripped from
error messages.

## Not in this release

Sessions, batch extraction, cancellation, playback, editing, caching, custom HTTP
headers, a downloader, FFmpeg, Media3, custom decoders, other image formats.

## Development

```sh
npm install
npm run specs      # regenerate Nitro bindings after editing src/specs
npm test           # argument contract + outcome envelope (node --test)
npm run typecheck
```

`nitrogen/generated` is committed and must never be hand-edited.

Everything that needs a real decoder lives in [`example/`](example): the
acceptance matrix and the benchmark. See [`example/README.md`](example/README.md).

## License

MIT
