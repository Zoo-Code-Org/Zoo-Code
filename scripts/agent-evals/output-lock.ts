import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { lockSync } from "proper-lockfile"
import path from "node:path"

// The lock lives beside the output tree and keys its real path, so aliases
// cannot run two writers. Release synchronously after the last cleanup check
// to avoid an interrupt arriving in an unprotected final await.
export async function acquireSideOutputLock(out: string): Promise<() => void> {
	// Reserve managed artifact trees even when their owner is idle. Checking
	// both spellings also prevents symlink aliases from bypassing the rule.
	const assertOutputPath = (value: string) => {
		if (value.split(path.sep).includes("artifacts"))
			throw new Error("side output cannot be inside a managed artifacts tree")
	}
	assertOutputPath(path.resolve(out))
	await fs.mkdir(out, { recursive: true })
	const canonical = await fs.realpath(out)
	assertOutputPath(canonical)
	const key = createHash("sha256").update(canonical).digest("hex")
	const lock = path.join(path.dirname(canonical), `.coding-side-${key}.lock`)
	try {
		return lockSync(canonical, { lockfilePath: lock, stale: 30_000, update: 10_000, retries: 0 })
	} catch (error) {
		throw new Error(
			`cannot acquire side output lock for ${canonical}; another side may be running; abandoned locks expire after 30 seconds (${lock})`,
			{
				cause: error,
			},
		)
	}
}
