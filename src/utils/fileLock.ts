import * as path from "path"
import { tracePersistenceEvent } from "../core/task-persistence/persistenceTrace"
import * as lockfile from "proper-lockfile"
import * as fs from "fs/promises"

/**
 * Shared staleness window for per-file advisory locks. This module owns the
 * single advisory lock protocol used by `safeWriteJson` and by callers that
 * must serialize with it, such as task-history deletion.
 */
export const LOCK_STALE_MS = 31_000

const RECOVERY_RETRY_MS = 1000
const RECOVERY_GRACE_MS = 4000

export interface FileLockOptions {
	/** Recovery may wait out a crashed writer's staleness window without stealing a live lock. */
	waitForStaleLock?: boolean
	/** Startup scans defer locked files instead of waiting under the store mutex. */
	immediate?: boolean
}

/**
 * Canonical lock key for a path.
 *
 * proper-lockfile derives its lock file from the path it is handed, and this module
 * turns off the library's own realpath step because the file may not exist yet. Two
 * callers that reach the same file by different routes - one lexical, one through a
 * symlinked directory - would then take DIFFERENT locks and silently lose updates
 * against each other, which is exactly how a task file written through a symlinked
 * task directory ends up unlocked against a task-history delete.
 *
 * The file itself may be absent (a create), so the nearest EXISTING ancestor is
 * canonicalized and the missing components are re-appended. If nothing can be
 * canonicalized the lexical absolute path is kept: lock keys stay stable and the
 * write's own resolution still decides where content lands.
 */
/**
 * Total link hops canonicalLockPath may follow across ALL its frames. The
 * per-frame walk bound alone does not terminate: a cycle whose length does not
 * divide that bound (a 3-link cycle a -> b -> c -> a against a bound of 8)
 * makes every frame land on a different cycle member, so the recursion below
 * restarts its budget forever. This runs on the lock path - withFileLock and every
 * direct acquireFileLock caller hands it a cycle member - so an unbounded walk hangs
 * guardedWrite and safeWriteJson, not just the walker.
 */
const MAX_TOTAL_LINK_HOPS = 64

async function canonicalLockPath(filePath: string, remainingLinkHops = MAX_TOTAL_LINK_HOPS): Promise<string> {
	const absoluteFilePath = path.resolve(filePath)

	// A file symlink has to produce the same key the writer's lock uses
	// (resolveLockKey in safeWriteText). Walking readlink even when the referent is
	// temporarily absent - which is exactly the window a backup-mode commit creates -
	// keeps a raw withFileLock caller on the link path excluding the peer writing
	// through the referent; re-appending the link's basename onto the canonical
	// parent would take a different lock and the two operations would stop excluding
	// each other. The walk is bounded so a two-link cycle terminates.
	let linkCursor = absoluteFilePath
	const frameBudget = Math.min(8, remainingLinkHops)
	for (let depth = 0; depth < frameBudget; depth++) {
		const referent = await fs.readlink(linkCursor).catch(() => undefined)
		if (referent === undefined) {
			break
		}
		// A relative referent is relative to the link's REAL parent, not to the spelling the
		// caller arrived with. Under a symlinked directory `..` names the referent's parent, so
		// joining lexically produces a key for a different file and the writer through the alias
		// stops excluding the writer through the referent. When the parent itself cannot be
		// canonicalized (a dangling chain) the lexical join is the only answer available.
		const parentReal = path.isAbsolute(referent)
			? undefined
			: await fs.realpath(path.dirname(linkCursor)).catch(() => undefined)
		linkCursor = path.resolve(parentReal ?? path.dirname(linkCursor), referent)
	}
	if (linkCursor !== absoluteFilePath) {
		// Recurse with the REMAINING hop budget, not a fresh one: once the total
		// is spent the next frame walks zero hops and canonicalizes the ancestors
		// of the cycle member it stopped on, so a cycle terminates on a stable key
		// instead of recursing forever.
		return await canonicalLockPath(linkCursor, Math.max(0, remainingLinkHops - frameBudget))
	}
	const missing: string[] = []
	let cursor = absoluteFilePath
	for (;;) {
		try {
			const realPath = await fs.realpath(cursor)
			return missing.length > 0 ? path.join(realPath, ...missing.reverse()) : realPath
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? (error as { code?: string }).code
					: undefined
			// Only a missing component may be walked over. An ancestor that exists but cannot be
			// inspected (EACCES on a parent, ELOOP, EIO) means the canonical key is UNKNOWN, and a
			// lexical key is a different lock from the one a peer that reached the same file through
			// the referent holds: taking it lets both run at once. Fail closed rather than invent a
			// key - the fallback below is only for "nothing here yet".
			if (code !== "ENOENT" && code !== "ENOTDIR") throw error
			const parent = path.dirname(cursor)
			if (parent === cursor) return absoluteFilePath
			missing.push(path.basename(cursor))
			cursor = parent
		}
	}
}

/**
 * Acquire the advisory lock for one file path using the exact protocol
 * `safeWriteJson` uses, so operations that hold this lock serialize with
 * every `safeWriteJson` write to the same path. Callers must release the
 * returned function exactly once and must not acquire the same lock again
 * while holding it.
 */
/**
 * The number of times withFileLock will release and retake the lock when the canonical key
 * of the path moves underneath it. A flapping link is pathological; the bound exists so a
 * walk that keeps answering differently terminates with an error instead of spinning.
 */
const MAX_LOCK_KEY_RETARGETS = 3

/**
 * Take the advisory lock for a key that is already canonical.
 *
 * Split out of acquireFileLock so withFileLock can retake the lock for a re-derived key
 * without re-running the canonicalization inside the acquire step: that is what lets it prove
 * the lock it holds while running the callback is the lock a peer reaching the same file
 * through any other spelling would take.
 */
async function _lockCanonicalKey(absoluteFilePath: string, options?: FileLockOptions): Promise<() => Promise<void>> {
	try {
		return await lockfile.lock(absoluteFilePath, {
			stale: LOCK_STALE_MS,
			update: 10000, // Update mtime every 10 seconds to prevent staleness if operation is long
			realpath: false, // the file may not exist yet, which is acceptable
			retries: options?.immediate
				? 0
				: options?.waitForStaleLock
					? {
							retries: Math.ceil((LOCK_STALE_MS + RECOVERY_GRACE_MS) / RECOVERY_RETRY_MS),
							factor: 1,
							minTimeout: RECOVERY_RETRY_MS,
							maxTimeout: RECOVERY_RETRY_MS,
						}
					: {
							// Configuration for retrying lock acquisition
							retries: 5, // Number of retries after the initial attempt
							factor: 2, // Exponential backoff factor (e.g., 100ms, 200ms, 400ms, ...)
							minTimeout: 100, // Minimum time to wait before the first retry (in ms)
							maxTimeout: 1000, // Maximum time to wait for any single retry (in ms)
						},
			onCompromised: (err) => {
				console.error(`Lock at ${absoluteFilePath} was compromised:`, err)
				throw err
			},
		})
	} catch (lockError) {
		console.error(`Failed to acquire lock for ${absoluteFilePath}:`, lockError)
		throw lockError
	}
}

export async function acquireFileLock(filePath: string, options?: FileLockOptions): Promise<() => Promise<void>> {
	const absoluteFilePath = await canonicalLockPath(filePath)
	if (options?.waitForStaleLock) tracePersistenceEvent("json-lock-wait", { filePath: absoluteFilePath })
	return _lockCanonicalKey(absoluteFilePath, options)
}

/**
 * Run one operation while holding the advisory lock for a file path.
 * Callers must not acquire this lock again from inside `operation`, and
 * they must keep the documented lock order when combining this helper
 * with other locks to prevent deadlock.
 */
export async function withFileLock<T>(
	filePath: string,
	operation: (absoluteFilePath: string) => Promise<T>,
	options?: FileLockOptions,
): Promise<T> {
	// The operation receives the caller's own resolved path. On Windows realpath can answer
	// with the 8.3 short form (C:\Users\RUNNER~1\... for a temp dir under
	// C:\Users\runneradmin\...), and the operation's own file calls (e.g. the task-history
	// unlink) must keep the caller's alias semantics: unlinking the referent instead of the
	// alias would delete a different directory entry.
	const operationPath = path.resolve(filePath)
	// The LOCK key is canonical - the same one safeWriteJson computes - so a caller that
	// reaches the file through a symlinked directory and one that reaches it lexically
	// contend for ONE lock file. Locking the raw path here would let a deletion through this
	// helper run concurrently with a safeWriteJson read-modify-write on the referent, breaking
	// the compound atomicity the deletion contract promises. The canonicalization runs inside
	// acquireFileLock, so the walk happens once and direct acquireFileLock callers (safeWriteJson
	// passes an already-canonical key, jsonFileRecovery and the specs pass raw paths) are all
	// covered by the same rule.
	let lockKey = await canonicalLockPath(operationPath)
	if (options?.waitForStaleLock) tracePersistenceEvent("json-lock-wait", { filePath: lockKey })

	for (let attempt = 0; ; attempt++) {
		const releaseLock = await _lockCanonicalKey(lockKey, options)

		// A directory component on this path can be swapped while this call waits for the lock,
		// so the key acquired above may no longer be the canonical key of the path the callback
		// is about to mutate: the mutation would then run while holding a lock no peer is
		// contending for, and a concurrent merge could recreate what the callback deletes. Re-derive
		// the key under the same rules before running anything, and on a change release, retake the
		// lock for the new key, and only then run the callback.
		const currentKey = await canonicalLockPath(operationPath).catch(() => lockKey)
		if (currentKey !== lockKey) {
			await releaseLock().catch(() => undefined)
			if (attempt >= MAX_LOCK_KEY_RETARGETS) {
				throw new Error(
					`Lock key for ${operationPath} kept moving across ${MAX_LOCK_KEY_RETARGETS} retargets -- the operation was not run.`,
				)
			}
			lockKey = currentKey
			continue
		}

		let result: T
		try {
			result = await operation(operationPath)
		} catch (operationError) {
			// The operation error is the primary failure. Release without
			// reporting a secondary release error over it.
			try {
				await releaseLock()
			} catch (releaseError) {
				console.error(`Failed to release lock for ${operationPath}:`, releaseError)
			}
			throw operationError
		}

		try {
			await releaseLock()
		} catch (releaseError) {
			// The operation already succeeded, so a release failure is only
			// logged, matching how `safeWriteJson` handles release failures.
			console.error(`Failed to release lock for ${operationPath}:`, releaseError)
		}
		return result
	}
}
