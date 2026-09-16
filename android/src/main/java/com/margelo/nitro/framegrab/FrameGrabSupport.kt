package com.margelo.nitro.framegrab

import android.content.Context
import android.net.Uri
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.File
import java.util.ArrayDeque
import java.util.concurrent.Executors
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

// region Errors

internal object FrameGrabCode {
    const val INVALID_ARGUMENT = "E_INVALID_ARGUMENT"
    const val UNSUPPORTED_URI = "E_UNSUPPORTED_URI"
    const val SOURCE_UNREADABLE = "E_SOURCE_UNREADABLE"
    const val TIMESTAMP_OUT_OF_RANGE = "E_TIMESTAMP_OUT_OF_RANGE"
    const val FRAME_EXTRACTION = "E_FRAME_EXTRACTION"
    const val ENCODE_FAILED = "E_ENCODE_FAILED"
    const val DESTINATION_WRITE = "E_DESTINATION_WRITE"
    const val DESTINATION_BUSY = "E_DESTINATION_BUSY"
    const val BUSY = "E_BUSY"
    const val INTERNAL = "E_INTERNAL"
}

internal class FrameGrabException(
    val code: String,
    message: String,
) : Exception(message)

/** Strips credentials and query strings from remote URIs. Signed URLs are secrets. */
internal fun redact(uri: String): String {
    val parsed = runCatching { Uri.parse(uri) }.getOrNull() ?: return "<unparseable uri>"
    val scheme = parsed.scheme?.lowercase()
    if (scheme != "http" && scheme != "https") return uri
    return Uri.Builder()
        .scheme(parsed.scheme)
        .authority(parsed.host ?: "<redacted>")
        .path(parsed.path)
        .build()
        .toString()
}

// endregion

// region Scheduler

/**
 * One module-wide bounded dispatcher.
 *
 * A job holds a concurrency slot *and* a destination reservation from admission
 * until completion. Admission failures leave no state behind.
 */
internal object FrameGrabDispatcher {
    /** Admission control, not cancellation: beyond this we reject with `E_BUSY`. */
    private const val MAX_PENDING = 64

    private val lock = ReentrantLock()
    private var active = 0
    private var storedMaxConcurrency = 2
    private val pending = ArrayDeque<Runnable>()
    private val reservations = HashSet<String>()

    /** Gated by [storedMaxConcurrency], so this never grows past the active bound. */
    private val workers =
        ThreadPoolExecutor(
            0,
            Int.MAX_VALUE,
            60L,
            TimeUnit.SECONDS,
            SynchronousQueue<Runnable>(),
        ) { runnable ->
            Thread(runnable, "frame-grab-worker").apply { isDaemon = true }
        }

    /**
     * Argument validation and path resolution touch the filesystem, so they must
     * not run on the JS thread either. They are cheap and serialized here so the
     * destination reservation is taken before anything is queued.
     */
    private val intake =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "frame-grab-intake").apply { isDaemon = true }
        }

    var maxConcurrency: Int
        get() = lock.withLock { storedMaxConcurrency }
        set(value) {
            val clamped = value.coerceIn(1, 16)
            val toStart = ArrayList<Runnable>()
            lock.withLock {
                storedMaxConcurrency = clamped
                // Raising the bound should let queued jobs start immediately.
                while (active < storedMaxConcurrency && pending.isNotEmpty()) {
                    active += 1
                    toStart.add(pending.removeFirst())
                }
            }
            toStart.forEach { workers.execute(it) }
        }

    fun onIntake(block: () -> Unit) {
        intake.execute { block() }
    }

    /**
     * Reserves [key] and schedules [body], which receives the slot wait in
     * milliseconds. Throws [FrameGrabException] if the request is not admitted.
     */
    fun submit(
        key: String,
        body: (queueWaitMs: Double) -> Unit,
    ) {
        val queuedAt = System.nanoTime()
        val task =
            Runnable {
                try {
                    body((System.nanoTime() - queuedAt) / 1_000_000.0)
                } finally {
                    finish(key)
                }
            }

        lock.withLock {
            if (!reservations.add(key)) {
                throw FrameGrabException(
                    FrameGrabCode.DESTINATION_BUSY,
                    "Another extraction is already pending or running for this destination.",
                )
            }
            when {
                active < storedMaxConcurrency -> active += 1
                pending.size >= MAX_PENDING -> {
                    reservations.remove(key)
                    throw FrameGrabException(
                        FrameGrabCode.BUSY,
                        "Too many queued extractions (limit $MAX_PENDING).",
                    )
                }
                else -> {
                    pending.addLast(task)
                    return
                }
            }
        }
        workers.execute(task)
    }

    /** Releases the reservation and hands the slot to the next queued job. */
    private fun finish(key: String) {
        val next =
            lock.withLock {
                reservations.remove(key)
                val queued = pending.pollFirst()
                if (queued == null) active -= 1
                queued
            }
        next?.let { workers.execute(it) }
    }
}

// endregion

// region URI resolution

internal sealed class FrameGrabSource {
    data class LocalFile(val file: File) : FrameGrabSource()

    data class Content(val uri: Uri) : FrameGrabSource()

    data class Remote(val uri: String) : FrameGrabSource()
}

internal object FrameGrabPaths {
    fun resolveSource(raw: String): FrameGrabSource {
        if (raw.startsWith("/")) return FrameGrabSource.LocalFile(File(raw))

        val uri =
            runCatching { Uri.parse(raw) }.getOrNull()
                ?: throw FrameGrabException(
                    FrameGrabCode.UNSUPPORTED_URI,
                    "`sourceUri` could not be parsed as a URI.",
                )

        return when (uri.scheme?.lowercase()) {
            "file" -> {
                // `Uri.getPath()` returns the decoded path, so percent-encoded
                // filenames and spaces survive the round trip intact.
                val path =
                    uri.path
                        ?: throw FrameGrabException(
                            FrameGrabCode.UNSUPPORTED_URI,
                            "Malformed file URI.",
                        )
                FrameGrabSource.LocalFile(File(path))
            }
            "content" -> FrameGrabSource.Content(uri)
            "http", "https" -> FrameGrabSource.Remote(raw)
            null ->
                throw FrameGrabException(
                    FrameGrabCode.UNSUPPORTED_URI,
                    "`sourceUri` must be an absolute path or an absolute URI.",
                )
            else ->
                throw FrameGrabException(
                    FrameGrabCode.UNSUPPORTED_URI,
                    "Unsupported source scheme \"${uri.scheme}\".",
                )
        }
    }

    fun resolveDestination(raw: String): File {
        if (raw.startsWith("/")) return File(raw)

        val uri =
            runCatching { Uri.parse(raw) }.getOrNull()
                ?: throw FrameGrabException(
                    FrameGrabCode.UNSUPPORTED_URI,
                    "`destinationUri` could not be parsed as a URI.",
                )

        val scheme = uri.scheme?.lowercase()
        if (scheme != "file") {
            throw FrameGrabException(
                FrameGrabCode.UNSUPPORTED_URI,
                "`destinationUri` must be a local file; got scheme \"${uri.scheme ?: "none"}\".",
            )
        }
        return File(
            uri.path
                ?: throw FrameGrabException(
                    FrameGrabCode.UNSUPPORTED_URI,
                    "Malformed destination file URI.",
                ),
        )
    }

    /**
     * The parent directory must already exist; we never create directory trees.
     * A directory or symlink destination is rejected so we cannot be redirected
     * out of the caller's own folder.
     */
    fun validateDestination(destination: File) {
        val parent =
            destination.absoluteFile.parentFile
                ?: throw FrameGrabException(
                    FrameGrabCode.DESTINATION_WRITE,
                    "`destinationUri` has no parent directory.",
                )
        if (!parent.isDirectory) {
            throw FrameGrabException(
                FrameGrabCode.DESTINATION_WRITE,
                "Destination parent directory does not exist: ${parent.path}",
            )
        }

        val stat = lstatOrNull(destination.absolutePath) ?: return
        if (OsConstants.S_ISLNK(stat.st_mode)) {
            throw FrameGrabException(
                FrameGrabCode.DESTINATION_WRITE,
                "Destination is a symbolic link.",
            )
        }
        if (!OsConstants.S_ISREG(stat.st_mode)) {
            throw FrameGrabException(
                FrameGrabCode.DESTINATION_WRITE,
                "Destination exists and is not a regular file.",
            )
        }
    }

    /**
     * Never overwrite the input video.
     *
     * Content providers can hide arbitrary aliases behind a URI; we identify what
     * a descriptor lets us identify and document the rest.
     */
    fun assertDistinct(
        source: FrameGrabSource,
        destination: File,
        context: Context?,
    ) {
        val destinationStat = statOrNull(destination.absolutePath) ?: return

        when (source) {
            is FrameGrabSource.LocalFile -> {
                val samePath =
                    runCatching {
                        source.file.canonicalPath == destination.canonicalPath
                    }.getOrDefault(false)
                val sourceStat = statOrNull(source.file.absolutePath)
                val sameNode =
                    sourceStat != null &&
                        sourceStat.st_dev == destinationStat.st_dev &&
                        sourceStat.st_ino == destinationStat.st_ino
                if (samePath || sameNode) {
                    throw FrameGrabException(
                        FrameGrabCode.INVALID_ARGUMENT,
                        "`sourceUri` and `destinationUri` resolve to the same file.",
                    )
                }
            }
            is FrameGrabSource.Content -> {
                var sameNode = false
                runCatching {
                    context?.contentResolver?.openFileDescriptor(source.uri, "r")?.use { descriptor ->
                        val sourceStat = Os.fstat(descriptor.fileDescriptor)
                        sameNode =
                            sourceStat.st_dev == destinationStat.st_dev &&
                            sourceStat.st_ino == destinationStat.st_ino
                    }
                }
                if (sameNode) {
                    throw FrameGrabException(
                        FrameGrabCode.INVALID_ARGUMENT,
                        "`sourceUri` and `destinationUri` resolve to the same file.",
                    )
                }
            }
            is FrameGrabSource.Remote -> Unit
        }
    }

    /** Canonical reservation key: resolved parent directory + destination filename. */
    fun reservationKey(destination: File): String {
        val absolute = destination.absoluteFile
        val parent =
            runCatching { absolute.parentFile?.canonicalPath }.getOrNull()
                ?: absolute.parent
                ?: ""
        return "$parent/${absolute.name}"
    }

    private fun statOrNull(path: String): StructStat? =
        try {
            Os.stat(path)
        } catch (_: ErrnoException) {
            null
        }

    private fun lstatOrNull(path: String): StructStat? =
        try {
            Os.lstat(path)
        } catch (_: ErrnoException) {
            null
        }
}

// endregion
