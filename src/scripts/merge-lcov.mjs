import { readFileSync, writeFileSync } from "node:fs"
import process from "node:process"

const parseCount = (value, description) => {
	const count = Number(value)
	if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Invalid ${description}: ${value}`)
	return count
}

const mergeCount = (records, key, count) => records.set(key, Math.max(records.get(key) ?? 0, count))

const parseLcov = (lcov, label) => {
	const sources = new Map()
	let record

	for (const line of lcov.split(/\r?\n/)) {
		if (!line || line.startsWith("TN:")) continue
		if (line.startsWith("SF:")) {
			if (record) throw new Error(`${label} contains an unfinished source record: ${record.source}`)
			const source = line.slice(3)
			if (!source) throw new Error(`${label} contains an empty source path`)
			record = {
				source,
				functions: new Map(),
				functionCounts: new Map(),
				branches: new Map(),
				lines: new Map(),
			}
		} else if (line === "end_of_record") {
			if (!record) throw new Error(`${label} contains a record terminator outside a source record`)
			if (sources.has(record.source))
				throw new Error(`${label} contains duplicate source record: ${record.source}`)
			sources.set(record.source, record)
			record = undefined
		} else if (record && line.startsWith("FN:")) {
			const separator = line.indexOf(",")
			if (separator < 4) throw new Error(`${label} contains invalid FN for ${record.source}`)
			const name = line.slice(separator + 1)
			const location = line.slice(3, separator)
			const existing = record.functions.get(name)
			if (existing && existing !== location)
				throw new Error(`${label} contains conflicting FN for ${record.source}:${name}`)
			record.functions.set(name, location)
		} else if (record && line.startsWith("FNDA:")) {
			const [count, ...name] = line.slice(5).split(",")
			if (name.length === 0) throw new Error(`${label} contains invalid FNDA for ${record.source}`)
			mergeCount(record.functionCounts, name.join(","), parseCount(count, `FNDA for ${record.source}`))
		} else if (record && line.startsWith("BRDA:")) {
			const [lineNumber, block, branch, taken] = line.slice(5).split(",")
			const key = `${lineNumber},${block},${branch}`
			const count = taken === "-" ? 0 : parseCount(taken, `BRDA for ${record.source}`)
			mergeCount(record.branches, key, count)
		} else if (record && line.startsWith("DA:")) {
			const [lineNumber, count, checksum] = line.slice(3).split(",")
			const key = parseCount(lineNumber, `DA line for ${record.source}`)
			if (key < 1) throw new Error(`${label} contains invalid DA line for ${record.source}`)
			const existing = record.lines.get(key)
			if (existing?.checksum && checksum && existing.checksum !== checksum)
				throw new Error(`${label} contains conflicting DA checksum for ${record.source}:${key}`)
			record.lines.set(key, {
				count: Math.max(existing?.count ?? 0, parseCount(count, `DA count for ${record.source}`)),
				checksum: existing?.checksum ?? checksum,
			})
		} else if (record && !/^(?:FNF|FNH|BRF|BRH|LF|LH):/.test(line)) {
			throw new Error(`${label} contains unsupported LCOV data for ${record.source}: ${line}`)
		} else if (!record) {
			throw new Error(`${label} contains data outside a source record: ${line}`)
		}
	}

	if (record) throw new Error(`${label} contains an unfinished source record: ${record.source}`)
	return sources
}

export const mergeLcov = (reports) => {
	const merged = new Map()
	for (const [label, lcov] of reports) {
		for (const [source, incoming] of parseLcov(lcov, label)) {
			const record = merged.get(source) ?? {
				source,
				functions: new Map(),
				functionCounts: new Map(),
				branches: new Map(),
				lines: new Map(),
			}
			for (const [name, location] of incoming.functions) {
				const existing = record.functions.get(name)
				if (existing && existing !== location) throw new Error(`Conflicting FN for ${source}:${name}`)
				record.functions.set(name, location)
			}
			for (const [name, count] of incoming.functionCounts) mergeCount(record.functionCounts, name, count)
			for (const [key, count] of incoming.branches) mergeCount(record.branches, key, count)
			for (const [line, value] of incoming.lines) {
				const existing = record.lines.get(line)
				if (existing?.checksum && value.checksum && existing.checksum !== value.checksum)
					throw new Error(`Conflicting DA checksum for ${source}:${line}`)
				record.lines.set(line, {
					count: Math.max(existing?.count ?? 0, value.count),
					checksum: existing?.checksum ?? value.checksum,
				})
			}
			merged.set(source, record)
		}
	}

	return [...merged.values()]
		.sort((a, b) => a.source.localeCompare(b.source))
		.flatMap((record) => {
			const functions = [...record.functions].sort(([a], [b]) => a.localeCompare(b))
			const functionCounts = [...record.functionCounts].sort(([a], [b]) => a.localeCompare(b))
			const branches = [...record.branches].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
			const lines = [...record.lines].sort(([a], [b]) => a - b)
			return [
				`SF:${record.source}`,
				...functions.map(([name, location]) => `FN:${location},${name}`),
				...functionCounts.map(([name, count]) => `FNDA:${count},${name}`),
				`FNF:${functions.length}`,
				`FNH:${functionCounts.filter(([, count]) => count > 0).length}`,
				...branches.map(([key, count]) => `BRDA:${key},${count || "-"}`),
				`BRF:${branches.length}`,
				`BRH:${branches.filter(([, count]) => count > 0).length}`,
				...lines.map(([line, { count, checksum }]) => `DA:${line},${count}${checksum ? `,${checksum}` : ""}`),
				`LF:${lines.length}`,
				`LH:${lines.filter(([, { count }]) => count > 0).length}`,
				"end_of_record",
			]
		})
		.join("\n")
}

if (process.argv[1] === import.meta.filename) {
	const [output, ...inputs] = process.argv.slice(2)
	if (!output || inputs.length < 1) throw new Error("Usage: merge-lcov.mjs <output> <input...>")
	writeFileSync(output, `${mergeLcov(inputs.map((input) => [input, readFileSync(input, "utf8")]))}\n`)
}
