import fs from "node:fs"
import process from "node:process"
import { fileURLToPath } from "node:url"

export function verifyLcov(content) {
	let inRecord = false
	let anyCovered = false
	let linesFound
	let linesHit

	for (const line of content.split(/\r?\n/)) {
		if (line.startsWith("SF:")) {
			if (inRecord) throw new Error("LCOV source record is not terminated")
			if (!line.slice(3)) throw new Error("LCOV source path is empty")
			inRecord = true
			linesFound = undefined
			linesHit = undefined
		} else if (line.startsWith("LF:")) {
			if (!inRecord) throw new Error("LCOV line count is outside a source record")
			if (linesFound !== undefined) throw new Error("LCOV source record has duplicate line counts")
			const found = line.slice(3)
			if (!/^\d+$/.test(found)) throw new Error("LCOV line count is not a decimal integer")
			linesFound = BigInt(found)
		} else if (line.startsWith("LH:")) {
			if (!inRecord) throw new Error("LCOV hit count is outside a source record")
			if (linesHit !== undefined) throw new Error("LCOV source record has duplicate hit counts")
			const hits = line.slice(3)
			if (!/^\d+$/.test(hits)) throw new Error("LCOV hit count is not a decimal integer")
			linesHit = BigInt(hits)
		} else if (line === "end_of_record") {
			if (!inRecord) throw new Error("LCOV terminator is outside a source record")
			if (linesFound === undefined || linesHit === undefined)
				throw new Error("LCOV source record has incomplete line summaries")
			if (linesHit > linesFound) throw new Error("LCOV hit count exceeds lines found")
			if (linesHit > 0n) anyCovered = true
			inRecord = false
		}
	}

	if (inRecord) throw new Error("LCOV source record is not terminated")
	if (!anyCovered) throw new Error("LCOV report has no covered lines")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	verifyLcov(fs.readFileSync(process.argv[2], "utf8"))
}
