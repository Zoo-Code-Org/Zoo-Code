import { stat } from "fs/promises"
import type { BigIntStats } from "fs"

/**
 * Version token for the compare-and-swap write guard (upstream epic #1375, phase A1).
 *
 * A token is a pure function of a file's on-disk state, derived from a single
 * `fs.stat(path, { bigint: true })`, so every process that observes the same file
 * state (a second VS Code window, the CLI, the user's own editor tooling) computes
 * the same token. The downstream guard phases (A2/A3) compare the token observed at
 * read time with the token recomputed just before a write to detect "the file
 * changed since the read" (stale) or "the file was replaced by a different file"
 * (dev/ino change).
 *
 * Format: `dev:ino:size:mtimeNs:ctimeNs`
 *
 * Precision: the stat is fetched in `bigint` mode, so all five fields are exact
 * `BigInt` values rendered as decimal strings — no float is involved anywhere.
 * There is therefore no precision loss for large sizes or inodes (a Windows file ID
 * exceeds 2^53 and is still exact), and the ns timestamps are the kernel's exact
 * nanosecond values rather than a ms→ns derivation (no ~256 ns double-precision
 * quantum). Guarantee: same disk state → same token, deterministic across
 * processes; any change to size, file identity, or mtime/ctime → a different token.
 *
 * Platform note: on POSIX `ctime` is the last file-status change; on Windows it is
 * the file creation time. The token only requires it to move when the file's
 * metadata is replaced, which holds on both.
 */

/**
 * Build the version token from an already-fetched `BigIntStats` — no I/O.
 *
 * Exported separately from {@link computeVersionToken} so tests can pin the exact
 * format against synthetic stats.
 */
export function versionTokenOfStat(stats: BigIntStats): string {
	return [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].map((value) => value.toString()).join(":")
}

/**
 * Compute the version token for a file (one `fs.stat` in bigint mode).
 *
 * Rejects with the underlying ENOENT (or equivalent) error when the file is absent;
 * how an unobservable target is treated is decided by the guard layer (A3).
 */
export async function computeVersionToken(filePath: string): Promise<string> {
	return versionTokenOfStat(await stat(filePath, { bigint: true }))
}
