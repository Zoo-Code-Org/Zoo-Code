// The side owns this cache in fresh private scratch. Evaluated hosts receive
// independent copies, never the reusable download. Verify both source and
// copy against the first download before returning an executable.
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { downloadVSCodeIsolated } from "./launcher.ts"

async function digestTree(root: string): Promise<string> {
	const hash = createHash("sha256")
	const visit = async (relative: string): Promise<void> => {
		const full = path.join(root, relative)
		const stat = await fs.lstat(full)
		hash.update(JSON.stringify([relative, stat.mode]))
		if (stat.isSymbolicLink()) {
			const target = await fs.readlink(full)
			const resolved = path.resolve(path.dirname(full), target)
			if (path.isAbsolute(target) || !resolved.startsWith(root + path.sep))
				throw new Error("VS Code cache symlink escapes cache")
			hash.update(JSON.stringify(target))
		} else if (stat.isDirectory()) {
			for (const name of (await fs.readdir(full)).sort()) await visit(path.join(relative, name))
		} else if (stat.isFile()) {
			hash.update(JSON.stringify(stat.size))
			hash.update(await fs.readFile(full))
		} else throw new Error("unsupported VS Code cache entry")
	}
	await visit("")
	return hash.digest("hex")
}

export function createPrivateVSCodeDownloader(
	cacheRoot: string,
	downloader: (options: { version: string; cachePath: string }) => Promise<string> = downloadVSCodeIsolated,
): (options: { version: string; cachePath: string }) => Promise<string> {
	const downloads = new Map<string, Promise<{ source: string; relative: string; digest: string }>>()
	return async ({ version, cachePath }) => {
		let download = downloads.get(version)
		if (!download) {
			download = (async () => {
				await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 })
				const source = await fs.mkdtemp(path.join(cacheRoot, "download-"))
				const executable = await downloader({ version, cachePath: source })
				const relative = path.relative(source, executable)
				if (relative.startsWith("..") || path.isAbsolute(relative))
					throw new Error("VS Code executable outside cache")
				return { source, relative, digest: await digestTree(source) }
			})().catch((error: unknown) => {
				downloads.delete(version)
				throw error
			})
			downloads.set(version, download)
		}
		const cached = await download
		if ((await digestTree(cached.source)) !== cached.digest) throw new Error("VS Code cache integrity mismatch")
		await fs.cp(cached.source, cachePath, { recursive: true, verbatimSymlinks: true })
		if ((await digestTree(cachePath)) !== cached.digest) throw new Error("VS Code cache copy integrity mismatch")
		return path.join(cachePath, cached.relative)
	}
}
