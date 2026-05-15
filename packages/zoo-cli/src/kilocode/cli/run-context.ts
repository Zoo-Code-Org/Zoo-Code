import path from "path"
import { pathToFileURL } from "url"

import { UI } from "@/cli/ui"
import { Filesystem } from "@/util/filesystem"

export type RunFilePart = { type: "file"; url: string; filename: string; mime: string }

export async function collectRunFileParts(paths: string | string[] | undefined, label: string): Promise<RunFilePart[]> {
	if (!paths) return []

	const list = Array.isArray(paths) ? paths : [paths]
	const parts: RunFilePart[] = []

	for (const filePath of list) {
		const resolvedPath = path.resolve(process.cwd(), filePath)
		if (!(await Filesystem.exists(resolvedPath))) {
			UI.error(`${label} not found: ${filePath}`)
			process.exit(1)
		}

		parts.push({
			type: "file",
			url: pathToFileURL(resolvedPath).href,
			filename: path.basename(resolvedPath),
			mime: (await Filesystem.isDir(resolvedPath)) ? "application/x-directory" : "text/plain",
		})
	}

	return parts
}
