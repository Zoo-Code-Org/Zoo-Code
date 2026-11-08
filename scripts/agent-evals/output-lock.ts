import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import { rmdirSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// The lock lives outside the output tree and keys its real path, so aliases
// cannot run two writers. Release synchronously after the last cleanup check
// to avoid an interrupt arriving in an unprotected final await.
export async function acquireSideOutputLock(out: string): Promise<() => void> {
	await fs.mkdir(out, { recursive: true })
	const canonical = await fs.realpath(out)
	const key = createHash("sha256").update(canonical).digest("hex")
	const lock = path.join(os.tmpdir(), `coding-side-${key}.lock`)
	try {
		await fs.mkdir(lock, { mode: 0o700 })
	} catch (error) {
		throw new Error(`cannot acquire side output lock for ${canonical}; another side may be running`, {
			cause: error,
		})
	}
	return () => rmdirSync(lock)
}
