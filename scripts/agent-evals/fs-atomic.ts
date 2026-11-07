import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

// Publishes one file atomically. The content lands in a temp file in the
// target's own directory and is renamed into place, so readers never observe
// a partial write and a failed write never destroys the previous file. The
// temp name is unique per process and call, so concurrent writers cannot
// collide.
export async function writeFileAtomic(filePath: string, data: string): Promise<void> {
	const directory = path.dirname(filePath)
	const temp = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`)
	try {
		await fs.writeFile(temp, data)
		await fs.rename(temp, filePath)
	} catch (error) {
		await fs.rm(temp, { force: true }).catch(() => {})
		throw error
	}
}

// Serializes one value to JSON and publishes it atomically. Serialization
// failures throw before any file is touched.
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
	await writeFileAtomic(filePath, JSON.stringify(value, null, 2))
}
