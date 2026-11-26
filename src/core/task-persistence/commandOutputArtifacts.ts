import * as fs from "node:fs/promises"
import * as path from "node:path"
import { constants } from "node:fs"

import { getErrorCode } from "../../utils/errorCode"

const pending = new Map<string, Set<Promise<string>>>()
const shortName = /^output-([1-9]\d*)\.txt$/
const legacyName = /^cmd-\d+\.txt$/

export function artifactFileName(id: string): string | undefined {
	if (legacyName.test(id) || shortName.test(id)) return id
	if (/^output-[1-9]\d*$/.test(id)) return `${id}.txt`
	return undefined
}

/** Reserve a short, task-local name atomically, without replacing another output. */
export function registerCommandOutput(
	outputDir: string,
	source: { file: string } | { content: string },
): Promise<string> {
	const directory = path.resolve(outputDir)
	const operation = (async () => {
		await fs.mkdir(directory, { recursive: true })
		const files = await fs.readdir(directory)
		let next = files.reduce((max, file) => Math.max(max, Number(shortName.exec(file)?.[1] ?? 0)), 0) + 1
		while (Number.isSafeInteger(next)) {
			const id = `output-${next}`
			const target = path.join(directory, `${id}.txt`)
			try {
				if ("content" in source) {
					await fs.writeFile(target, source.content, { flag: "wx" })
				} else {
					try {
						// The old filename remains readable; both names share the same disk data.
						await fs.link(source.file, target)
					} catch (error) {
						if (!["ENOTSUP", "EPERM", "EXDEV"].includes(getErrorCode(error) ?? "")) throw error
						await fs.copyFile(source.file, target, constants.COPYFILE_EXCL)
					}
				}
				return id
			} catch (error) {
				if (getErrorCode(error) !== "EEXIST") throw error
				next++
			}
		}
		throw new Error("Command output reference range exhausted")
	})()
	const operations = pending.get(directory) ?? new Set<Promise<string>>()
	pending.set(directory, operations)
	operations.add(operation)
	const release = () => {
		operations.delete(operation)
		if (operations.size === 0) pending.delete(directory)
	}
	void operation.then(release, release)
	return operation
}

/** Disposal drains pending registrations; saved output belongs to the task directory, not the live Task. */
export async function flushArtifactRegistrations(outputDir: string): Promise<void> {
	const directory = path.resolve(outputDir)
	while (pending.has(directory)) {
		const operations = pending.get(directory)
		if (!operations) break
		const results = await Promise.allSettled(operations)
		const failure = results.find((result) => result.status === "rejected")
		if (failure?.status === "rejected") throw failure.reason
	}
}

export async function listCommandOutputs(outputDir: string): Promise<string[]> {
	try {
		const files = await fs.readdir(outputDir)
		const short = files
			.filter((file) => shortName.test(file))
			.sort((a, b) => Number(shortName.exec(a)?.[1]) - Number(shortName.exec(b)?.[1]))
		// Prioritize simple references. Legacy names are still accepted for saved conversations.
		return short.length
			? short.map((file) => file.slice(0, -4))
			: files.filter((file) => legacyName.test(file)).sort()
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return []
		throw error
	}
}
