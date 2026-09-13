import fs from "node:fs"
import path from "node:path"

export function assertMatchingFiles(expectedDir, actualDir, filenames, message, filesystem = fs) {
	for (const filename of filenames) {
		if (
			!filesystem
				.readFileSync(path.join(expectedDir, filename))
				.equals(filesystem.readFileSync(path.join(actualDir, filename)))
		) {
			throw new Error(`${message}: ${filename}`)
		}
	}
}
