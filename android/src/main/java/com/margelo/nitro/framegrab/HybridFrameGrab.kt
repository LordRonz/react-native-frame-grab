package com.margelo.nitro.framegrab

import android.graphics.Bitmap
import android.graphics.Matrix
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import androidx.annotation.Keep
import com.facebook.proguard.annotations.DoNotStrip
import com.margelo.nitro.NitroModules
import com.margelo.nitro.core.Promise
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

private const val MAX_OUTPUT_AREA = 16_777_216
private const val MIN_MAX_WIDTH = 1
private const val MAX_MAX_WIDTH = 4096

/**
 * video URI -> MediaMetadataRetriever -> bounded scale -> Bitmap.compress -> rename(2)
 */
// JNI constructs this class by name; keep annotations on the spec are not inherited.
@Keep
@DoNotStrip
class HybridFrameGrab : HybridFrameGrabSpec() {
    override var maxConcurrency: Double
        get() = FrameGrabDispatcher.maxConcurrency.toDouble()
        set(value) {
            FrameGrabDispatcher.maxConcurrency = value.roundToInt()
        }

    override fun extract(request: NativeFrameGrabRequest): Promise<NativeFrameGrabOutcome> {
        val promise = Promise<NativeFrameGrabOutcome>()

        // Returns to JS immediately; nothing below runs on the JS thread.
        FrameGrabDispatcher.onIntake {
            try {
                val plan = prepare(request)
                FrameGrabDispatcher.submit(plan.reservationKey) { queueWaitMs ->
                    promise.resolve(runJob(plan, queueWaitMs))
                }
            } catch (e: FrameGrabException) {
                promise.resolve(failure(e.code, e.message ?: "Extraction failed."))
            } catch (e: Throwable) {
                promise.resolve(
                    failure(FrameGrabCode.INTERNAL, "Unexpected native failure: $e"),
                )
            }
        }

        return promise
    }

    // region Intake

    private class Plan(
        val source: FrameGrabSource,
        val destination: File,
        val reservationKey: String,
        val timeUs: Long,
        val maxWidth: Int,
        val quality: Int,
        val precise: Boolean,
    )

    /**
     * Cheap validation and path resolution. Runs before the reservation is taken
     * and before any native media object exists.
     */
    private fun prepare(request: NativeFrameGrabRequest): Plan {
        val timeUs = request.timeUs
        if (!timeUs.isFinite() || timeUs < 0 || timeUs > 9_007_199_254_740_991.0 ||
            timeUs != Math.floor(timeUs)
        ) {
            throw FrameGrabException(
                FrameGrabCode.INVALID_ARGUMENT,
                "`timeMs` is out of the representable range.",
            )
        }
        val maxWidth = request.maxWidth
        if (!maxWidth.isFinite() || maxWidth != Math.floor(maxWidth) ||
            maxWidth < MIN_MAX_WIDTH || maxWidth > MAX_MAX_WIDTH
        ) {
            throw FrameGrabException(
                FrameGrabCode.INVALID_ARGUMENT,
                "`maxWidth` must be an integer in $MIN_MAX_WIDTH..$MAX_MAX_WIDTH.",
            )
        }
        val quality = request.quality
        if (!quality.isFinite() || quality < 0.0 || quality > 1.0) {
            throw FrameGrabException(
                FrameGrabCode.INVALID_ARGUMENT,
                "`quality` must be between 0 and 1.",
            )
        }

        val source = FrameGrabPaths.resolveSource(request.sourceUri)
        val destination = FrameGrabPaths.resolveDestination(request.destinationUri)
        FrameGrabPaths.validateDestination(destination)
        FrameGrabPaths.assertDistinct(source, destination, NitroModules.applicationContext)

        if (source is FrameGrabSource.LocalFile && !source.file.isFile) {
            throw FrameGrabException(
                FrameGrabCode.SOURCE_UNREADABLE,
                "Source file does not exist: ${redact(request.sourceUri)}",
            )
        }

        return Plan(
            source = source,
            destination = destination,
            reservationKey = FrameGrabPaths.reservationKey(destination),
            timeUs = timeUs.toLong(),
            maxWidth = maxWidth.toInt(),
            quality = (quality * 100).roundToInt().coerceIn(0, 100),
            precise = request.precise,
        )
    }

    // endregion

    // region Job

    private fun runJob(
        plan: Plan,
        queueWaitMs: Double,
    ): NativeFrameGrabOutcome {
        val temporary =
            File(
                plan.destination.absoluteFile.parentFile,
                ".framegrab-${java.util.UUID.randomUUID()}.jpg.tmp",
            )
        var committed = false
        var retriever: MediaMetadataRetriever? = null

        try {
            // 1. Source.
            val sourceStart = System.nanoTime()
            retriever = MediaMetadataRetriever()
            openSource(retriever, plan.source)
            val sourceMs = elapsedMs(sourceStart)

            // 2. Metadata + bounds.
            val metadataStart = System.nanoTime()
            val metadata = readMetadata(retriever, plan)
            val (targetWidth, targetHeight) =
                fit(metadata.orientedWidth, metadata.orientedHeight, plan.maxWidth)
            val metadataMs = elapsedMs(metadataStart)

            // 3. Extraction.
            val extractStart = System.nanoTime()
            val option =
                if (plan.precise) {
                    MediaMetadataRetriever.OPTION_CLOSEST
                } else {
                    MediaMetadataRetriever.OPTION_CLOSEST_SYNC
                }
            var bitmap = extractFrame(retriever, plan.timeUs, option, targetWidth, targetHeight)
            val extractMs = elapsedMs(extractStart)

            try {
                // 4. Orientation, then a single bounded resize if the platform
                //    handed us something larger than we asked for.
                val rotated =
                    rotateIfPlatformDidNot(
                        bitmap,
                        metadata.rotationDegrees,
                        metadata.orientedWidth,
                        metadata.orientedHeight,
                    )
                if (rotated !== bitmap) {
                    bitmap.recycle()
                    bitmap = rotated
                }

                val bounded = boundWidth(bitmap, plan.maxWidth)
                if (bounded !== bitmap) {
                    bitmap.recycle()
                    bitmap = bounded
                }

                val width = bitmap.width
                val height = bitmap.height
                if (width <= 0 || height <= 0) {
                    throw FrameGrabException(
                        FrameGrabCode.FRAME_EXTRACTION,
                        "Decoder produced an empty image.",
                    )
                }
                if (width > plan.maxWidth || width.toLong() * height > MAX_OUTPUT_AREA) {
                    throw FrameGrabException(
                        FrameGrabCode.INTERNAL,
                        "Generated image (${width}x$height) exceeds the requested bounds.",
                    )
                }

                // 5. Encode straight into the temporary sibling. `compress`
                //    streams to the stream, so encode and write are one phase.
                val encodeStart = System.nanoTime()
                BufferedOutputStream(FileOutputStream(temporary)).use { out ->
                    val ok = bitmap.compress(Bitmap.CompressFormat.JPEG, plan.quality, out)
                    if (!ok) {
                        throw FrameGrabException(
                            FrameGrabCode.ENCODE_FAILED,
                            "JPEG encoding failed.",
                        )
                    }
                    out.flush()
                }
                val byteSize = temporary.length()
                if (byteSize <= 0L) {
                    throw FrameGrabException(
                        FrameGrabCode.ENCODE_FAILED,
                        "Encoder produced an empty file.",
                    )
                }
                val encodeMs = elapsedMs(encodeStart)

                // 6. Commit. `File.renameTo` is rename(2): on the same filesystem
                //    it atomically replaces the destination. Never delete-then-move.
                val finalizeStart = System.nanoTime()
                if (!temporary.renameTo(plan.destination)) {
                    throw FrameGrabException(
                        FrameGrabCode.DESTINATION_WRITE,
                        "Could not finalize the destination file.",
                    )
                }
                committed = true
                val finalizeMs = elapsedMs(finalizeStart)

                return NativeFrameGrabOutcome(
                    result =
                        NativeFrameGrabSuccess(
                            uri = Uri.fromFile(plan.destination).toString(),
                            width = width.toDouble(),
                            height = height.toDouble(),
                            size = byteSize.toDouble(),
                            timings =
                                NativeFrameGrabTimings(
                                    queueWaitMs = queueWaitMs,
                                    sourceMs = sourceMs,
                                    metadataMs = metadataMs,
                                    extractMs = extractMs,
                                    encodeMs = encodeMs,
                                    finalizeMs = finalizeMs,
                                ),
                        ),
                    error = null,
                )
            } finally {
                bitmap.recycle()
            }
        } catch (e: FrameGrabException) {
            return failure(e.code, e.message ?: "Extraction failed.")
        } catch (e: Throwable) {
            // Guarantees the request settles even on OutOfMemoryError.
            return failure(FrameGrabCode.INTERNAL, "Unexpected native failure: $e")
        } finally {
            // Cleanup never replaces the original error, and never claims to have
            // rolled back an already committed destination.
            if (!committed) {
                runCatching { temporary.delete() }
            }
            runCatching { retriever?.release() }
        }
    }

    private fun openSource(
        retriever: MediaMetadataRetriever,
        source: FrameGrabSource,
    ) {
        try {
            when (source) {
                is FrameGrabSource.LocalFile -> retriever.setDataSource(source.file.absolutePath)
                is FrameGrabSource.Content -> {
                    val context =
                        NitroModules.applicationContext
                            ?: throw FrameGrabException(
                                FrameGrabCode.INTERNAL,
                                "No React application context available for `content://` access.",
                            )
                    retriever.setDataSource(context, source.uri)
                }
                is FrameGrabSource.Remote ->
                    retriever.setDataSource(source.uri, HashMap<String, String>())
            }
        } catch (e: FrameGrabException) {
            throw e
        } catch (e: Throwable) {
            throw FrameGrabException(
                FrameGrabCode.SOURCE_UNREADABLE,
                "Could not open source: ${e.javaClass.simpleName}",
            )
        }
    }

    private class Metadata(
        val orientedWidth: Int,
        val orientedHeight: Int,
        val rotationDegrees: Int,
    )

    private fun readMetadata(
        retriever: MediaMetadataRetriever,
        plan: Plan,
    ): Metadata {
        fun key(id: Int): String? =
            try {
                retriever.extractMetadata(id)
            } catch (e: Throwable) {
                throw FrameGrabException(
                    FrameGrabCode.SOURCE_UNREADABLE,
                    "Could not read source metadata: ${e.javaClass.simpleName}",
                )
            }

        if (key(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) != "yes") {
            throw FrameGrabException(
                FrameGrabCode.SOURCE_UNREADABLE,
                "Source has no usable video track.",
            )
        }

        // These report the *encoded* dimensions; rotation is a separate key.
        val encodedWidth = key(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull()
        val encodedHeight = key(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull()
        if (encodedWidth == null || encodedHeight == null ||
            encodedWidth <= 0 || encodedHeight <= 0
        ) {
            throw FrameGrabException(
                FrameGrabCode.SOURCE_UNREADABLE,
                "Source reports unusable video dimensions.",
            )
        }

        val rawRotation =
            key(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
        val rotation = ((rawRotation % 360) + 360) % 360

        // A timestamp equal to the duration is out of range. An unknown duration
        // is not proof of anything: let extraction decide.
        val durationMs = key(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
        if (durationMs != null && durationMs > 0 && durationMs < Long.MAX_VALUE / 1000) {
            if (plan.timeUs >= durationMs * 1000L) {
                throw FrameGrabException(
                    FrameGrabCode.TIMESTAMP_OUT_OF_RANGE,
                    "Requested ${plan.timeUs / 1000.0} ms but the source is $durationMs ms long.",
                )
            }
        }

        val swap = rotation == 90 || rotation == 270
        return Metadata(
            orientedWidth = if (swap) encodedHeight else encodedWidth,
            orientedHeight = if (swap) encodedWidth else encodedHeight,
            rotationDegrees = rotation,
        )
    }

    private fun extractFrame(
        retriever: MediaMetadataRetriever,
        timeUs: Long,
        option: Int,
        targetWidth: Int,
        targetHeight: Int,
    ): Bitmap {
        val bitmap =
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
                    // Scaled extraction: the platform never hands us more pixels
                    // than we asked for. It is a bound, not a guarantee about how
                    // the decoder allocates internally.
                    retriever.getScaledFrameAtTime(timeUs, option, targetWidth, targetHeight)
                } else {
                    // minSdk is 23, so this branch is reachable. One bounded
                    // resize happens later, based on the bitmap we actually got.
                    retriever.getFrameAtTime(timeUs, option)
                }
            } catch (e: Throwable) {
                throw FrameGrabException(
                    FrameGrabCode.FRAME_EXTRACTION,
                    "Frame extraction failed: ${e.javaClass.simpleName}",
                )
            }

        // Never retry at full resolution: that amplifies memory pressure and
        // hides genuinely unsupported media.
        return bitmap
            ?: throw FrameGrabException(
                FrameGrabCode.FRAME_EXTRACTION,
                "No frame available at the requested timestamp.",
            )
    }

    // endregion

    // region Scaling / orientation

    /** Fits the oriented display size inside [maxWidth] without ever upscaling. */
    private fun fit(
        width: Int,
        height: Int,
        maxWidth: Int,
    ): Pair<Int, Int> {
        val scale = min(1.0, maxWidth.toDouble() / width.toDouble())
        val targetWidth = max(1, min((width * scale).roundToInt(), maxWidth))
        val targetHeight = max(1, (height * scale).roundToInt())
        if (targetWidth.toLong() * targetHeight > MAX_OUTPUT_AREA) {
            throw FrameGrabException(
                FrameGrabCode.INVALID_ARGUMENT,
                "Output would be ${targetWidth}x$targetHeight, over the $MAX_OUTPUT_AREA pixel limit.",
            )
        }
        return targetWidth to targetHeight
    }

    /**
     * `MediaMetadataRetriever` is expected to return display-oriented bitmaps.
     * We only correct the one case we can actually detect: a 90/270 source whose
     * returned bitmap still has the *encoded* aspect orientation.
     *
     * Dimensions cannot resolve 180-degree or square frames, so those are left to
     * the platform rather than guessed at. See README, "Android orientation".
     *
     * This rests on one AOSP assumption: `METADATA_KEY_VIDEO_WIDTH`/`_HEIGHT`
     * report *encoded* dimensions, with rotation carried separately in
     * `METADATA_KEY_VIDEO_ROTATION`. A device that pre-swapped those keys *and*
     * returned an oriented bitmap would be rotated twice here. That is what the
     * TOP/LEFT fixture set in `example/` exists to catch; run it on unfamiliar
     * hardware before trusting rotated output.
     */
    private fun rotateIfPlatformDidNot(
        bitmap: Bitmap,
        rotationDegrees: Int,
        orientedWidth: Int,
        orientedHeight: Int,
    ): Bitmap {
        if (rotationDegrees != 90 && rotationDegrees != 270) return bitmap
        if (bitmap.width == bitmap.height || orientedWidth == orientedHeight) return bitmap
        if ((bitmap.width > bitmap.height) == (orientedWidth > orientedHeight)) return bitmap

        val matrix = Matrix().apply { postRotate(rotationDegrees.toFloat()) }
        return Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
    }

    /** Single bounded, aspect-preserving resize based on the bitmap we actually got. */
    private fun boundWidth(
        bitmap: Bitmap,
        maxWidth: Int,
    ): Bitmap {
        if (bitmap.width <= maxWidth) return bitmap
        val scale = maxWidth.toDouble() / bitmap.width.toDouble()
        val height = max(1, (bitmap.height * scale).roundToInt())
        return Bitmap.createScaledBitmap(bitmap, maxWidth, height, true)
    }

    // endregion

    private fun elapsedMs(startNanos: Long): Double = (System.nanoTime() - startNanos) / 1_000_000.0
}

private fun failure(
    code: String,
    message: String,
): NativeFrameGrabOutcome =
    NativeFrameGrabOutcome(
        result = null,
        error = NativeFrameGrabFailure(code = code, message = message),
    )
