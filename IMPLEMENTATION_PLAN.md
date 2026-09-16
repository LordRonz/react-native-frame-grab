# React Native Frame Grab — Implementation Plan

## 1. Goal and scope

Build a focused Nitro module that performs:

```text
video URI → native frame extraction → bounded scaling → JPEG → atomic file replacement
```

Return only file metadata to JavaScript. Never create a video player or return image bytes through the public extraction API.

The initial app workload is one thumbnail per video:

```text
timeMs = 0
maxWidth = 480
quality = 0.6
mode = fast
```

The expected benefit is less source/player setup, fewer intermediate objects and conversions, and a direct native-to-file path. Nitro alone does not establish a performance advantage.

### First release

- One-shot asynchronous extraction.
- Local files on both platforms.
- Android `content://` sources.
- Tested native HTTP(S) source access, subject to the restrictions below.
- Orientation-correct, aspect-ratio-preserving JPEG output.
- Caller-controlled file destination.
- Atomic replacement, stable errors, deterministic resource cleanup.
- Bounded native concurrency.

### Not in the first release

Sessions, batch extraction, cancellation, playback, editing, caching, custom HTTP headers, a downloader, FFmpeg, Media3, custom decoders, additional image formats, or pixel-format experiments.

Sessions and batches are optional later work, not prerequisites for integrating the app.

---

## 2. Architecture

Implement platform operations directly in Swift and Kotlin, using Nitro-generated bindings:

| Platform | Source/frame API | Encoding |
| --- | --- | --- |
| iOS | `AVURLAsset`, `AVAssetImageGenerator` | ImageIO, directly from `CGImage` to a temporary file |
| Android | `MediaMetadataRetriever` | `Bitmap.compress` to a temporary file |

Do not put media extraction in C++. The underlying APIs are already platform-native; adding an interoperability layer does not remove decoding work.

Do not manually edit Nitrogen output.

The execution path must keep source loading, metadata access, decoding, encoding, and filesystem operations off both the JavaScript and UI threads. Returning a Promise alone does not ensure this: explicitly dispatch native work to the appropriate background execution facility.

---

## 3. Public API

Expose a small JavaScript facade over the internal Nitro HybridObject:

```ts
export type FrameMode = 'fast' | 'precise'

export interface FrameGrabOptions {
  sourceUri: string
  destinationUri: string
  timeMs?: number
  maxWidth?: number
  quality?: number
  mode?: FrameMode
}

export interface FrameGrabResult {
  uri: string
  width: number
  height: number
  size: number
  requestedTimeMs: number
}

export function extractThumbnail(
  options: FrameGrabOptions,
): Promise<FrameGrabResult>
```

Defaults:

```ts
timeMs = 0
maxWidth = 480
quality = 0.6
mode = 'fast'
```

Result meanings:

- `uri`: absolute `file://` URI for the finalized JPEG.
- `width`, `height`: actual encoded pixel dimensions, after display-orientation correction.
- `size`: encoded JPEG byte count.
- `requestedTimeMs`: the validated requested timestamp, not the selected frame's timestamp.

Do not expose `actualTimeMs`: Android MMR does not provide a reliable selected-frame timestamp through this API. Never infer it from frame rate or copy the requested timestamp into an actual-time field.

---

## 4. Frame-selection contract

Use names that describe intent rather than claiming identical decoder behavior.

| Mode | Android | iOS |
| --- | --- | --- |
| `fast` | `OPTION_CLOSEST_SYNC` | Set both requested-time tolerances to positive infinity |
| `precise` | `OPTION_CLOSEST` | Set both requested-time tolerances to zero |

Document explicitly:

- Android `fast` requests a nearby sync/keyframe.
- iOS `fast` permits AVFoundation to choose a frame using its tolerance policy; this is not a keyframe-only guarantee.
- `precise` requests higher temporal precision and may require additional decoding.
- Neither mode guarantees identical images across platforms.
- `precise` is not a promise that every arbitrary timestamp maps to an exact frame at that timestamp.
- A valid timestamp can still fail to produce an image; report extraction failure rather than silently changing modes or timestamps.

Benchmark competitors with their selection settings recorded. Do not compare permissive extraction against precise extraction as if the work were identical.

---

## 5. Validation and bounds

Validate cheap scalar/URI arguments before initializing native media resources. Validate again at the native boundary where necessary to prevent unsafe numeric conversions or filesystem operations.

Reject:

- Empty/whitespace-only source or destination values; do not trim valid paths and thereby change filenames.
- Unknown `mode` values.
- Non-finite numeric values, including NaN and infinities.
- Negative `timeMs`.
- Non-integer `maxWidth`, or values outside the documented supported range.
- Quality outside `[0, 1]`.
- Unsupported URI schemes.
- Unsafe conversion of milliseconds into native time representations.

Normalize timestamps to microsecond resolution once, using a documented rounding rule: round `timeMs * 1000` to the nearest integer. Require the microsecond count to remain within JavaScript's safe-integer range and the native representation's range. Return the normalized request in milliseconds as `requestedTimeMs`.

Use shared documented output limits for v1:

```text
maxWidth: 1–4096 pixels
maximum final image area: 16,777,216 pixels
```

These are output-allocation safeguards, not claims about decoder-internal memory usage. Keep them as named internal constants and cover their boundaries with tests. Do not silently clamp a request that exceeds a limit.

After metadata is available:

- Require a usable video track and positive, finite dimensions.
- Reject invalid dimension/aspect calculations before integer conversion or allocation.
- If duration is known and finite, require `0 <= requestedTime < duration`.
- A timestamp equal to duration is out of range; do not silently clamp to the last frame.
- Unknown or indefinite duration is not proof that the timestamp is invalid. Let extraction determine whether a frame is available.
- A source with no usable video track is a source error, not a timestamp error.

Native errors and diagnostics must not expose signed URL query strings or credentials by default.

---

## 6. Source and destination contracts

### Sources

| Source | iOS | Android |
| --- | --- | --- |
| Absolute native filesystem path | Supported | Supported |
| `file://` | Supported | Supported |
| `content://` | Not supported | Supported using `setDataSource(context, uri)` |
| `https://` | Native-framework access, tested subset | Native-framework access, tested subset |
| `http://` | Same, subject to app transport policy | Same, subject to app transport policy |

Reject relative filesystem paths. Parse file URIs with platform URI/URL APIs; do not manipulate `file://` strings with ad hoc substring removal. Handle percent-encoded filenames and spaces correctly.

Android content URI permissions remain the caller's responsibility. The module neither requests nor persists URI access grants. Report revoked/missing access without leaking native resources.

### Destinations

- Accept absolute filesystem paths and local `file://` URIs only.
- Reject remote and `content://` destinations.
- Require the parent directory to exist; do not create directory trees implicitly.
- Replace an existing regular file only after the new JPEG is complete.
- Reject a destination directory or symbolic-link destination.
- Reject a source and destination that resolve to the same local file, including detectable filesystem aliases. Never overwrite the input video.
- For content URI sources, use file identity checks when a usable descriptor permits them. Document that arbitrary provider aliases cannot always be identified; callers must supply an independent output location.

The consuming app must own/control the output directory. This API is not a filesystem sandbox for hostile callers.

---

## 7. Remote-source contract

Remote support means allowing the native media framework to read a remote video. It does not mean that the library downloads the entire video to a temporary file before extraction.

Do not promise bounded network bytes. Container layout, codec, timestamp, redirects, range support, and platform implementation determine how much data is read.

V1 remote acceptance focuses on progressive HTTP(S) video files. Do not claim support for DRM, live streams, HLS/DASH, authenticated headers, or every container accepted by a playback library.

- HTTPS is the normal network path.
- Plain HTTP works only when the consuming application's ATS/Android cleartext policy permits it.
- Do not add broad transport-security exceptions or modify the consumer's security policy.
- Signed query-string URLs must be tested.
- Test redirects and servers with and without range support.
- Test delayed responses, HTTP errors, and unavailable sources.

### Timeout limitation

MMR has no general-purpose API to forcibly interrupt a running extraction/source-open operation. V1 must not pretend that rejecting a JS Promise stops the native work.

A slow remote request can occupy a native slot until the platform operation returns. Document this limitation and include it in the remote integration gate. Do not release a scheduler slot or native resource while its operation is still running.

If native remote behavior is unacceptable on the app's actual media host, stop the migration for that path and retain the existing app behavior. Do not silently add a downloader, weaken security, or claim unsupported timeout guarantees.

---

## 8. Scaling and orientation

`maxWidth` always refers to the final displayed image, not encoded-track width before rotation.

Requirements:

- Preserve display aspect ratio, allowing normal integer-pixel rounding.
- Do not upscale sources already narrower than `maxWidth`.
- Final width must not exceed `maxWidth`.
- Computed dimensions must be at least one pixel and within the output-area limit.
- Report actual encoded dimensions, not requested bounds.
- Encode upright pixels; do not rely on the image consumer applying JPEG orientation metadata.

Use oriented/presentation dimensions rather than blindly trusting raw encoded width and height. Account for platform-provided track transforms and non-square-pixel presentation information where available. If an unusual presentation cannot be handled correctly, report a documented limitation rather than stretch the output.

### Android orientation spike — required before freezing the algorithm

Use visibly asymmetric fixtures marked TOP/LEFT, including 0°, 90°, 180°, and 270° metadata rotations, plus square portrait/rotation fixtures.

Verify MMR's returned bitmap orientation and dimensions on physical devices for both scaled extraction and any supported fallback. Record the selected platform behavior and transformation rule in implementation notes/tests.

Do not infer orientation solely from bitmap dimensions: that cannot resolve 180° or square-frame cases. Do not blindly rotate every bitmap with nonzero rotation metadata; an already oriented bitmap would be rotated twice.

If a tested platform requires an additional transform, apply it exactly once under an evidence-backed rule. Do not introduce speculative OEM heuristics.

### Scaling guarantee boundary

Scaled extraction constrains the bitmap/image delivered to the module. It does not prove that the platform decoder never internally allocates full-resolution surfaces. Measure process/native memory; avoid claims of guaranteed reduced-resolution decoding.

---

## 9. Android implementation

Use `MediaMetadataRetriever` only; no additional media framework.

Within a background job:

1. Acquire the destination reservation and scheduler slot according to section 12.
2. Initialize the retriever and select the correct source overload.
3. Read required metadata and validate timestamp/dimensions.
4. Compute safe display-oriented output bounds.
5. On API 27+, use `getScaledFrameAtTime` with the selected mode.
6. If older Android versions are actually supported, use `getFrameAtTime` followed by one bounded aspect-preserving resize. Otherwise omit this unreachable compatibility branch.
7. Apply only the orientation/post-scaling corrections established by the platform spike.
8. Encode directly to the temporary output stream.
9. Check `Bitmap.compress`'s boolean result; false is `E_ENCODE_FAILED`.
10. Close the stream, collect actual dimensions/size, and atomically finalize output.
11. Release resources and reservations in `finally`.

Treat null extracted bitmaps as extraction failures. Do not silently retry at full resolution after a scaled extraction failure; that could amplify memory pressure and mask unsupported media.

Quality conversion: `round(quality * 100)` after validation.

Avoid retaining multiple full-resolution bitmaps. If scaling returns the same bitmap instance, do not recycle it as though it were an independent intermediate. Never access a bitmap after releasing/recycling it.

Cleanup failures must not replace the original operation error. If cleanup alone fails, report/log it safely according to the public-result settlement rules, without pretending an already finalized destination was rolled back.

---

## 10. iOS implementation

Use `AVURLAsset` and `AVAssetImageGenerator`.

- Load metadata asynchronously using deployment-target-compatible APIs.
- Set `appliesPreferredTrackTransform = true`.
- Calculate bounds from display/presentation dimensions.
- Set `maximumSize` before image generation.
- Set both time tolerances explicitly according to the selected mode.
- Prefer `image(at:)` where available; use the asynchronous callback API when required by the supported deployment target.
- Do not build new extraction code around deprecated synchronous `copyCGImage` calls.

Encode the resulting `CGImage` directly to a temporary file using ImageIO:

```text
CGImage → CGImageDestination → temporary JPEG
```

Check destination creation and `CGImageDestinationFinalize` success. Avoid `UIImage` and intermediate JPEG `Data` when not required.

Be explicit about executor placement: after an asynchronous extraction callback completes, encoding and filesystem work must still occur off the main actor/UI thread.

Release per-request image, generator, and asset references promptly. Ensure callback continuations and Nitro Promises settle exactly once on success or failure.

---

## 11. Atomic output and file ownership

Generate a uniquely named temporary sibling in the destination directory. The temporary file belongs exclusively to that request.

```text
extract → encode temporary file → finish encoder → close stream
        → validate nonempty output → atomic finalize → resolve
```

Use a platform operation that atomically replaces an existing file on the same filesystem, or atomically renames the new file when no destination exists. Verify the chosen operation's platform semantics and check its return/error value.

Never implement overwrite as:

```text
delete destination → move temporary file
```

That loses the existing file if the move fails.

Before finalization, an error must leave the previous destination untouched and remove only this request's temporary file. Once finalization succeeds, treat it as the commit point: do not subsequently reject for best-effort bookkeeping or cleanup while claiming the old destination remains intact.

Gather result metadata before the commit point wherever possible. The encoded image must have valid dimensions and positive byte size; encoder success is mandatory. Tests must reopen/decode the JPEG, but production need not decode every output a second time merely for validation.

The guarantee is atomic visibility of a complete file, not survival of sudden power loss. Do not add file/directory fsync machinery or market crash durability without a separate requirement.

Process termination can leave an orphan temporary file. Normal success/failure paths must clean theirs up; do not add a cache/directory scanner to this library. Document the temporary-file naming convention for caller-owned cleanup.

---

## 12. Concurrency and destination collisions

Use one module-wide bounded native scheduler on each platform. Start with two active jobs; benchmark one, two, and four before choosing the published default.

A job includes source initialization, metadata, extraction, encoding, and finalization. Do not load unlimited native sources before acquiring a slot.

Acquire a process-wide destination reservation before queueing, keyed by the canonical parent directory plus destination filename. Reject another pending/running request for the same normalized destination with `E_DESTINATION_BUSY`.

Hold the reservation through completion and release it on every exit path. Keep the registry native/module-wide rather than per HybridObject, so creating multiple facade instances cannot bypass it.

Use a finite pending queue, initially 64 jobs. Reject overflow with `E_BUSY`; this is admission control, not cancellation. A request rejected at admission must leave no native media object, temp file, or destination reservation behind.

Do not block the JS/main thread while waiting for a slot. Do not implement waiting by occupying all workers in the same pool needed to execute jobs and release permits. Prefer a small dispatcher with an explicit pending queue.

These collision guarantees cover this module's requests within one process, not arbitrary external writers or filesystem aliases a provider conceals. Callers must not externally replace output files while relying on returned metadata.

Retain the app's current higher-level single-flight and concurrency controls during initial integration. Measure native queue wait separately from extraction time.

---

## 13. Stable error contract

Public errors must be JavaScript `Error` instances with a stable `code`:

```text
E_INVALID_ARGUMENT
E_UNSUPPORTED_URI
E_SOURCE_UNREADABLE
E_TIMESTAMP_OUT_OF_RANGE
E_FRAME_EXTRACTION
E_ENCODE_FAILED
E_DESTINATION_WRITE
E_DESTINATION_BUSY
E_BUSY
E_INTERNAL
```

Do not expose cancellation/session codes before those APIs exist.

Do not assume arbitrary Swift/Kotlin exception properties survive Nitro. Use a small explicit internal result envelope for expected operation failures, then let the JavaScript facade construct the public Error:

```ts
interface NativeFailure {
  code: string
  message: string
}

interface NativeExtractionOutcome {
  result?: FrameGrabResult
  error?: NativeFailure
}
```

Exactly one field must be present. The wrapper validates this invariant, validates the error code, and maps malformed/unexpected native failures to `E_INTERNAL`. This envelope remains internal; callers still receive `Promise<FrameGrabResult>` or a rejected Error.

Verify the envelope/spec with Nitrogen and a real Swift/Kotlin round-trip test before implementing all failure paths. Keep the transport minimal; do not build a general error framework.

Translate platform failures at the stage where their meaning is known. Do not label every native exception a decode failure. Preserve safe diagnostic context, but redact source credentials and signed query strings.

---

## 14. Resource invariants

Every accepted request must eventually settle once the underlying native operation completes, and then:

- Release its retriever/generator/asset references.
- Close streams and owned file descriptors.
- Release temporary bitmap/image references.
- Remove its uncommitted temporary file.
- Release its scheduler slot and destination reservation.

Never release a running native object's resources concurrently from an unrelated timeout/disposal path. Runtime teardown must not call into an invalid JS runtime; follow Nitro's supported lifetime mechanisms and verify teardown behavior in the harness.

Failure before file commit preserves the previous destination. Failure of one job must not stop dispatching later queued jobs.

---

## 15. Application migration

Integration point:

```text
app/models/video-cache-store/video-cache-store.ts
ensureThumbnailCached
```

Current extraction block creates an Expo player, waits for readiness, generates a frame, uses ImageManipulator to save JPEG, then moves the file.

Replace only that block with:

```ts
const result = await extractThumbnail({
  sourceUri: cachedLocalUri || videoUrl,
  destinationUri: destFile.uri,
  timeMs: 0,
  maxWidth: 480,
  quality: 0.6,
  mode: 'fast',
})
```

The library already writes the destination; do not move the file again.

Preserve cache keys, disk hits, single-flight deduplication, entry recording, eviction, and app concurrency controls. Remove obsolete imports/readiness helpers only after confirming they have no remaining callers.

Do not migrate remote fallback until the actual media host has passed the remote tests. Compare the selected frame at time zero with the old pipeline; do not assume default frame-selection settings are equivalent.

Keep existing video-cache-store tests passing and add a boundary test that verifies correct source/destination/options and failure behavior with the new extractor mocked.

---

## 16. Test harness and acceptance matrix

Use a minimal real-device harness that invokes the exported API, verifies files, and records timing/memory. JavaScript mocks cannot validate decoding, orientation, atomic replacement, or thread placement.

### Deterministic fixtures

- H.264 landscape and portrait.
- Asymmetric 0°, 90°, 180°, 270° rotation fixtures, including square frames.
- 4K H.264 and HEVC where the device supports them.
- Long-GOP, variable-frame-rate, and very short videos.
- Source smaller than requested width.
- Extreme aspect ratio and invalid/unsupported video metadata.
- Corrupt/truncated video and audio-only source.
- Visible frame-number/timecode fixtures for selection checks.

Record unsupported device codecs as such; a library must reject safely, not guarantee hardware codec support it does not control.

### API and file tests

- Defaults and explicit modes.
- NaN, infinity, negative time, invalid quality/width, rounding and conversion bounds.
- Time zero, non-keyframe, near end, equal to duration, beyond duration.
- Paths containing spaces, Unicode, and percent-encoded file URIs.
- Missing file, revoked content URI access, unsupported schemes.
- Missing parent, unwritable destination, directory destination, source/destination alias.
- Existing destination preserved on source/decode/encode/write/finalize failure.
- Existing destination replaced on success.
- Same-destination overlapping jobs rejected; reservation released after failure.
- Queue overflow rejects cleanly; a failed job does not stall the queue.
- No output bytes in the public JS result.
- Swift and Kotlin errors arrive as the documented JS `Error.code`.

Introduce narrow test seams for encoder/finalize failures where physical failure reproduction is unreliable. Do not create a broad native abstraction layer just for mocks.

Every successful test output must decode as JPEG, have correct orientation, preserve aspect ratio within pixel rounding, respect width/area limits, and match returned metadata.

### Remote tests

Run against controlled endpoints and the app's media host:

- HTTPS, signed URLs, redirects.
- Range-supported and range-unsupported responses.
- Fast-start and metadata-at-end MP4 layouts.
- HTTP failure, delayed/unavailable response.
- App-policy-blocked HTTP.

Measure network behavior separately from local decoding. Document native timeout limitations rather than marking an unsupported hard-cancellation guarantee as passing.

---

## 17. Benchmark plan

### Initial comparison

Benchmark the existing Expo Video + ImageManipulator app pipeline first, then this implementation. Include an existing dedicated thumbnail library and `@mindinventory/react-native-nitro-video` as secondary references when their supported APIs/builds permit a fair comparison.

A broad competitor tournament is not a prerequisite for the first useful implementation. Pin and record each tested competitor/API in benchmark results; skip unavailable/incompatible candidates with a stated reason.

### Workloads

- Primary: local video, time zero, 480px width, quality 0.6, fast mode.
- Precise extraction at a non-keyframe timestamp.
- Widths 160, 480, and 1080.
- Single extraction and eight-request bursts.
- 100 and 500 sequential operations for steady-state behavior.
- Repeated failed source loads, corrupt sources, and failed output writes.

### Metrics

- End-to-end p50/p95 latency and sample count.
- Queue wait and native phase timings.
- Peak process/native memory and steady-state memory trend.
- Actual output dimensions, byte size, and visual correctness.
- Error rate, file descriptors, temporary-file count.
- UI frame drops during a repeatable interaction.
- Remote bytes/time to first result in separate tests.

Instrument source setup, metadata, extraction, encoding/write, and finalization. Do not pretend streaming JPEG encoding and file writes are separately measurable if the chosen encoder combines them.

Use release builds and physical iOS/Android devices. Record device, OS, codec, fixture, timestamp, selection mode, versions, output dimensions, quality, iterations, and warm-up procedure.

Separate first-after-launch from warmed results; neither proves OS caches are cold. Randomize implementation order where practical and account for thermal throttling.

Equal numeric JPEG quality does not guarantee equal visual quality across encoders. Compare images and output bytes as well as settings. An ArrayBuffer-returning competitor needs its file-writing cost included for the disk-output workload, with any adapter overhead disclosed.

### Success gate

For the app's primary workload, target at least 20% lower p50 latency, or a meaningful measured improvement in p95, peak memory, or UI responsiveness, with no correctness/reliability regression.

Do not require beating every competitor before the app can benefit. Do not publish “fastest” claims without reproducible evidence. If no meaningful app benefit is demonstrated, keep the current app pipeline.

---

## 18. Implementation sequence

### Phase 0 — Baseline and critical platform spikes

- Record the current app baseline.
- Verify Nitro outcome/error transport on both platforms.
- Establish Android rotation/scaled-extraction behavior with fixtures.
- Select and test actual atomic replacement operations.
- Confirm the supported iOS asynchronous API path.

Resolve failed assumptions before implementing around them.

### Phase 1 — Correct local one-shot extraction

Implement the public facade, native extraction, validation, timestamp modes, scaling/orientation, direct JPEG output, atomic finalization, stable errors, cleanup, and bounded scheduler together.

Correctness/resource safety are part of this phase, not deferred hardening. Pass the local correctness and failure matrix before adding source types.

### Phase 2 — Android content URIs

Add provider/permission handling, descriptor cleanup, and content URI tests. Preserve the same file-output contract.

### Phase 3 — Remote sources

Implement native HTTP(S) access and run the remote matrix, including the actual app host. Document platform limitations. Stop rather than add an implicit downloader or false timeout guarantee.

### Phase 4 — App integration and decision

Replace only the extraction block, preserve cache behavior, run targeted app tests, benchmark on devices, and evaluate the success gate.

### Phase 5 — Optional optimization

Only after profiling identifies a useful next target, investigate sessions/batches or other narrow optimizations. Do not expand the public API merely to match competitor feature lists.

---

## 19. Deferred session/batch design constraints

This section records constraints for a later proposal, not work required by this plan.

If repeated extraction from the same source proves important:

- Reuse one initialized MMR or asset/generator per session.
- Serialize all operations on a session; no concurrent mutable generator configuration.
- `release()` is idempotent, marks closing immediately, rejects new work, waits for accepted work to finish, then releases resources.
- Specify an explicit `SessionThumbnailOptions` type before exposing the API.
- Account for idle open sessions: an active-job semaphore alone does not bound retained sources.
- Avoid holding a global extraction permit for an idle session or reacquiring the same permit recursively.
- Benchmark actual reuse benefits; do not claim MMR guarantees decoder-state reuse.

If adding batches:

- Validate the complete request list before starting.
- Reject duplicate destinations.
- Bound request count and return results in input order.
- Use a single initialized source and release generated images promptly.
- Define nontransactional failure behavior: stop at first failure, preserve already finalized outputs, identify the failed request and completed outputs.
- Do not delete pre-existing caller files to simulate rollback.
- Handle duplicate timestamps without losing request-to-destination mapping.
- Keep timestamp sorting only if measured benefits justify it.

Cancellation needs its own later contract. In particular, cancelling all generation on a shared iOS generator affects multiple pending requests; Android MMR cannot be treated as forcibly cancellable.

---

## 20. Final principle

Optimize the least work necessary to produce a correct file. Keep the API narrow, platform differences explicit, memory bounded, and claims tied to measurements.
