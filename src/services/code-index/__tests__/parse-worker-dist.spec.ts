import { copyFile, mkdtemp, rm, stat, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Worker } from "node:worker_threads"
import { build } from "esbuild"
import { ParseWorkerClient } from "../parse-worker-client"
import { ParserLoadError } from "../processors/parser"

// Runs in the dist lane after `bundle`; paths are relative to the src/ package root.
const distDirectory = path.resolve("dist")
const builtWorker = path.join(distDirectory, "workers", "codeIndexParse.js")
const content = "function example() { return 'a sufficiently long function body for indexing'; }"

function clientFor(wasmDirectory: string) {
	const workers: Worker[] = []
	const client = new ParseWorkerClient(() => {
		const worker = new Worker(builtWorker, { workerData: { wasmDirectory } })
		workers.push(worker)
		return worker
	})
	const controller = new AbortController()
	client.open(controller.signal)
	return { client, close: () => controller.abort(), workers }
}

describe("built code-index parse worker", () => {
	let missingGrammarDirectory: string

	beforeAll(async () => {
		missingGrammarDirectory = await mkdtemp(path.join(tmpdir(), "zoo-parse-worker-"))
		await copyFile(
			path.join(distDirectory, "tree-sitter.wasm"),
			path.join(missingGrammarDirectory, "tree-sitter.wasm"),
		)
	})

	afterAll(async () => {
		if (missingGrammarDirectory) await rm(missingGrammarDirectory, { recursive: true, force: true })
	})

	it("CI-PW-08: parses a TypeScript file into blocks with the WASMs in dist", async () => {
		const { client, close } = clientFor(distDirectory)
		try {
			const blocks = await client.parseFile("example.ts", { content, fileHash: "hash" })
			expect(blocks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ type: "function_declaration", content, fileHash: "hash" }),
				]),
			)
		} finally {
			close()
		}
	})

	it("CI-PW-08: a missing grammar WASM arrives as ParserLoadError and the session stays usable", async () => {
		const { client, close, workers } = clientFor(missingGrammarDirectory)
		try {
			const failure = await client
				.parseFile("example.ts", { content, fileHash: "hash" })
				.catch((error: unknown) => error)
			expect(failure).toBeInstanceOf(ParserLoadError)
			const blocks = await client.parseFile("notes.txt", { content, fileHash: "hash" })
			expect(blocks).toHaveLength(1)
			expect(workers).toHaveLength(1)
		} finally {
			close()
		}
	})

	it("CI-PW-08: the worker's inputs exclude telemetry, i18n and the ignore controller", async () => {
		const result = await build({
			entryPoints: ["workers/codeIndexParse.ts"],
			bundle: true,
			platform: "node",
			format: "cjs",
			write: false,
			metafile: true,
			logLevel: "silent",
		})
		const inputs = Object.keys(result.metafile.inputs).map((input) => input.replaceAll("\\", "/"))
		expect(inputs).toContain("services/code-index/processors/parser.ts")
		const hostOnly = /packages\/telemetry\/|(^|\/)src\/i18n\/|^i18n\/|core\/ignore\//
		expect(inputs.filter((input) => hostOnly.test(input))).toEqual([])
	})

	it("CI-PW-08: the built worker stays small and does not require vscode", async () => {
		// Guards against pulling a large host graph in; @roo-code/types is expected for two constants.
		expect((await stat(builtWorker)).size).toBeLessThan(4 * 1024 * 1024)
		expect(await readFile(builtWorker, "utf8")).not.toMatch(/require\(["']vscode["']\)/)
	})
})
