import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { lockSync } from "proper-lockfile"
import path from "node:path"

// Validate existing ancestors before mkdir so rejected symlink aliases cannot
// create directories inside another generation's managed artifacts.
export async function prepareOutputDirectory(out: string, kind: "side" | "comparison"): Promise<string> {
	const assertOutputPath = (value: string) => {
		if (value.split(path.sep).includes("artifacts"))
			throw new Error(`${kind} output cannot be inside a managed artifacts tree`)
	}
	const resolved = path.resolve(out)
	assertOutputPath(resolved)
	let ancestor = resolved
	const missing: string[] = []
	while (true) {
		try {
			const canonical = await fs.realpath(ancestor)
			assertOutputPath(path.join(canonical, ...missing))
			break
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
			missing.unshift(path.basename(ancestor))
			ancestor = path.dirname(ancestor)
		}
	}
	await fs.mkdir(resolved, { recursive: true })
	const canonical = await fs.realpath(resolved)
	assertOutputPath(canonical)
	return canonical
}

// The lock lives beside the output tree and keys its real path, so aliases
// cannot run two writers. Release synchronously after the last cleanup check
// to avoid an interrupt arriving in an unprotected final await.
export async function acquireSideOutputLock(out: string, waitMs = 0): Promise<() => void> {
	const canonical = await prepareOutputDirectory(out, "side")
	const key = createHash("sha256").update(canonical).digest("hex")
	const lock = path.join(path.dirname(canonical), `.coding-side-${key}.lock`)
	const deadline = Date.now() + waitMs
	while (true) {
		try {
			return lockSync(canonical, { lockfilePath: lock, stale: 30_000, update: 10_000, retries: 0 })
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ELOCKED" && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, Math.min(250, deadline - Date.now())))
				continue
			}
			throw new Error(
				`cannot acquire side output lock for ${canonical}; another side may be running; abandoned locks expire after 30 seconds (${lock})`,
				{
					cause: error,
				},
			)
		}
	}
}
