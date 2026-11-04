import fs from "fs/promises"
import path from "path"
import { glob } from "glob"

interface Snapshot {
	snapshot: { meta: { node_fields: string[]; node_types: Array<string | string[]> } }
	nodes: number[]
	strings: string[]
}
interface Measurement {
	variant: string
	workload: string
	repeat: number
	stages: Record<"empty" | "loaded" | "switched", { usedSize: number }>
}

async function outputRetention(file: string) {
	const snapshot = JSON.parse(await fs.readFile(file, "utf8")) as Snapshot
	const fields = snapshot.snapshot.meta.node_fields
	const typeIndex = fields.indexOf("type")
	const nameIndex = fields.indexOf("name")
	const sizeIndex = fields.indexOf("self_size")
	const types = snapshot.snapshot.meta.node_types[typeIndex]
	if (!Array.isArray(types) || nameIndex < 0 || sizeIndex < 0) throw new Error(`Unsupported snapshot: ${file}`)
	let count = 0
	let bytes = 0
	for (let offset = 0; offset < snapshot.nodes.length; offset += fields.length) {
		const type = snapshot.nodes[offset + typeIndex]
		const name = snapshot.nodes[offset + nameIndex]
		const size = snapshot.nodes[offset + sizeIndex]
		if (type === undefined || name === undefined || size === undefined) throw new Error(`Malformed node in ${file}`)
		if (types[type] === "string" && snapshot.strings[name]?.startsWith("heap-tool-output-")) {
			count++
			bytes += size
		}
	}
	return { count, bytes }
}

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	const upper = sorted[middle]
	if (upper === undefined) throw new Error("Cannot take the median of an empty sample")
	return sorted.length % 2 ? upper : ((sorted[middle - 1] ?? upper) + upper) / 2
}
const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(2)

async function main() {
	const results = process.env.HEAP_BENCHMARK_DIR ?? path.resolve(__dirname, "../../heap-results")
	const rows = []
	for (const file of await glob("runs/**/measurement.json", { cwd: results, absolute: true })) {
		const measurement = JSON.parse(await fs.readFile(file, "utf8")) as Measurement
		const loadedOutputs = await outputRetention(path.join(path.dirname(file), "loaded.heapsnapshot"))
		const switchedOutputs = await outputRetention(path.join(path.dirname(file), "switched.heapsnapshot"))
		rows.push({ ...measurement, loadedOutputs, switchedOutputs })
	}
	if (!rows.length) throw new Error("No heap measurements found")
	const lines = [
		"# VS Code webview heap comparison",
		"",
		"Forced-GC renderer heap, measured through CDP on the Zoo Code webview target. The extension host is held constant. Both builds omit source maps. The workload is a deterministic persisted transcript, not a recording of a human session.",
		"",
		"Each transcript contains 602 messages: 300 command/output pairs with roughly 17 KiB outputs. Repeated uses 32 distinct outputs; unique uses 300. Snapshots are taken after task-history hydration and after switching to a small task. Values below are medians across fresh VS Code sessions.",
		"",
		"| Workload | Variant | Runs | Empty MiB | Loaded MiB | Loaded − empty MiB | Switched MiB | Output string nodes loaded / switched |",
		"| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
	]
	for (const workload of ["repeated", "unique"]) {
		for (const variant of ["base", "candidate"]) {
			const group = rows.filter((row) => row.workload === workload && row.variant === variant)
			if (!group.length) continue
			lines.push(
				`| ${workload} | ${variant} | ${group.length} | ${mib(median(group.map((r) => r.stages.empty.usedSize)))} | ${mib(median(group.map((r) => r.stages.loaded.usedSize)))} | ${mib(median(group.map((r) => r.stages.loaded.usedSize - r.stages.empty.usedSize)))} | ${mib(median(group.map((r) => r.stages.switched.usedSize)))} | ${median(group.map((r) => r.loadedOutputs.count))} / ${median(group.map((r) => r.switchedOutputs.count))} |`,
			)
		}
	}
	lines.push(
		"",
		"Raw per-run measurements and string-node counts are in summary.json. The matching .heapsnapshot files can be loaded in Chrome DevTools. These are renderer-isolate measurements, not whole-process RSS or extension-host heap. String-node counts are diagnostic evidence; inspect retaining paths before attributing surviving strings to a particular cache.",
		"",
	)
	await fs.writeFile(path.join(results, "summary.json"), JSON.stringify(rows, null, 2))
	await fs.writeFile(path.join(results, "summary.md"), lines.join("\n"))
	console.log(lines.join("\n"))
}
void main().catch((error: unknown) => {
	console.error(error)
	process.exitCode = 1
})
