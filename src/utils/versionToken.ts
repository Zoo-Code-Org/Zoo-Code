import { stat } from "fs/promises"
import type { Stats } from "fs"

/**
 * Version token for the compare-and-swap write guard (upstream epic #1375, phase A1).
 *
 * A token is a pure function of a file's on-disk state, derived from a single
 * `fs.stat`, so every process that observes the same file state (a second VS Code
 * window, the CLI, the user's own editor tooling) computes the same token. The
 * downstream guard phases (A2/A3) compare the token observed at read time with the
 * token recomputed just before a write to detect "the file changed since the read"
 * (stale) or "the file was replaced by a different file" (dev/ino change).
 *
 * Format: `dev:ino:size:mtimeNs:ctimeNs`
 *
 * Resolution note: Node exposes modification/change times as float milliseconds,
 * so the ns fields are derived as `Math.round(mtimeMs * 1e6)`. The integer-to-double
 * conversion is correctly rounded, so the derivation is deterministic across
 * processes, but it is quantized by double precision (~256 ns at the current epoch).
 * Two file states whose timestamps differ by less than the quantum derive the same
 * ns field; in practice distinct states differ by at least the OS clock resolution
 * (and no write workload produces mtimes closer than that), so the guard contract
 * holds: same disk state → same token; changed state → a different token in all
 * realistic cases. dev, ino and size are exact integers, so any size or file
 * identity change is always detected regardless of the timestamp quantum.
 */

/** Derive an ns-scale field from Node's float milliseconds (see module docs). */
function nsFromMs(ms: number): string {
	return Math.round(ms * 1e6).toString()
}

/**
 * Build the version token from an already-fetched `Stats` — no I/O.
 *
 * Exported separately from {@link computeVersionToken} so tests can pin the exact
 * format against synthetic stats.
 */
export function versionTokenOfStat(stats: Stats): string {
	return [
		stats.dev.toString(),
		stats.ino.toString(),
		stats.size.toString(),
		nsFromMs(stats.mtimeMs),
		nsFromMs(stats.ctimeMs),
	].join(":")
}

/**
 * Compute the version token for a file (one `fs.stat`).
 *
 * Rejects with the underlying ENOENT (or equivalent) error when the file is absent;
 * how an unobservable target is treated is decided by the guard layer (A3).
 */
export async function computeVersionToken(filePath: string): Promise<string> {
	return versionTokenOfStat(await stat(filePath))
}
