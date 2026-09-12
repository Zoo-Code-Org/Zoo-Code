import fs from "node:fs"
import process from "node:process"
import { fileURLToPath } from "node:url"

export function verifyLcov(content) {
	let inRecord = false
	let anyCovered = false
	let hasLinesFound = false
	let hasLinesHit = false

	for (const line of content.split(/\r?\n/)) {
		if (line.startsWith("SF:")) {
			if (inRecord) throw new Error("LCOV source record is not terminated")
			inRecord = true
			hasLinesFound = false
			hasLinesHit = false
		} else if (line.startsWith("LF:")) {
			if (!inRecord) throw new Error("LCOV line count is outside a source record")
			if (!/^\d+$/.test(line.slice(3))) throw new Error("LCOV line count is not a decimal integer")
			hasLinesFound = true
		} else if (line.startsWith("LH:")) {
			if (!inRecord) throw new Error("LCOV hit count is outside a source record")
			const hits = line.slice(3)
			if (!/^\d+$/.test(hits)) throw new Error("LCOV hit count is not a decimal integer")
			if (BigInt(hits) > 0n) anyCovered = true
			hasLinesHit = true
		} else if (line === "end_of_record") {
			if (!inRecord) throw new Error("LCOV terminator is outside a source record")
			if (!hasLinesFound || !hasLinesHit) throw new Error("LCOV source record has incomplete line summaries")
			inRecord = false
		}
	}

	if (inRecord) throw new Error("LCOV source record is not terminated")
	if (!anyCovered) throw new Error("LCOV report has no covered lines")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	verifyLcov(fs.readFileSync(process.argv[2], "utf8"))
}
