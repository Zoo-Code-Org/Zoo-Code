export const parseCoverageSourceLines = (lcov, lane) => {
	const sources = new Map()
	let source
	let instrumentedLines = new Set()
	let hasSummary = false

	for (const line of lcov.split(/\r?\n/)) {
		if (line.startsWith("SF:")) {
			if (source) throw new Error(`${lane} coverage contains an unfinished source record: ${source}`)
			source = line.slice(3)
			if (!source) throw new Error(`${lane} coverage contains an empty source path`)
			instrumentedLines = new Set()
			hasSummary = false
		} else if (line.startsWith("DA:")) {
			if (!source) throw new Error(`${lane} coverage contains DA outside a source record`)
			if (hasSummary) throw new Error(`${lane} coverage contains DA after LF for ${source}`)
			const lineNumber = Number(line.slice(3).split(",", 1)[0])
			if (!Number.isSafeInteger(lineNumber) || lineNumber < 1)
				throw new Error(`${lane} coverage contains invalid DA for ${source}`)
			if (instrumentedLines.has(lineNumber))
				throw new Error(`${lane} coverage contains duplicate DA for ${source}:${lineNumber}`)
			instrumentedLines.add(lineNumber)
		} else if (line.startsWith("LF:")) {
			if (!source) throw new Error(`${lane} coverage contains LF outside a source record`)
			if (sources.has(source)) throw new Error(`${lane} coverage contains duplicate source record: ${source}`)

			const linesFound = Number(line.slice(3))
			if (!Number.isSafeInteger(linesFound) || linesFound < 0 || linesFound !== instrumentedLines.size)
				throw new Error(`${lane} coverage contains invalid LF for ${source}`)
			sources.set(source, instrumentedLines)
			hasSummary = true
		} else if (line === "end_of_record") {
			if (!source || !hasSummary) throw new Error(`${lane} coverage contains an invalid record terminator`)
			source = undefined
		}
	}
	if (source) throw new Error(`${lane} coverage contains an unfinished source record: ${source}`)

	return sources
}

export const mergeCoverageSources = (expectedLanes, coverageByLane) => {
	const lanes = new Set()
	const combinedSources = new Map()
	for (const [lane, sources] of coverageByLane) {
		if (lanes.has(lane)) throw new Error(`Coverage lane is duplicated: ${lane}`)
		lanes.add(lane)
		if (sources.size === 0) throw new Error(`Coverage lane has no source records: ${lane}`)
		for (const [source, instrumentedLines] of sources) {
			const existingLines = combinedSources.get(source)
			if (
				existingLines &&
				(existingLines.size !== instrumentedLines.size ||
					[...existingLines].some((line) => !instrumentedLines.has(line)))
			)
				throw new Error(`${lane} coverage has conflicting instrumented lines for ${source}`)
			combinedSources.set(source, instrumentedLines)
		}
	}

	for (const lane of expectedLanes) if (!lanes.has(lane)) throw new Error(`Coverage lane is missing: ${lane}`)
	for (const lane of lanes) if (!expectedLanes.includes(lane)) throw new Error(`Unexpected coverage lane: ${lane}`)
	return combinedSources
}
