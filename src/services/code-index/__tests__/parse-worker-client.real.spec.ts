vi.mock("../code-index-log", () => ({
	codeIndexLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
import { copyFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { Worker } from "node:worker_threads"
import { ParseWorkerClient, type ParseReply } from "../parse-worker-client"
import { INDEX_STOP_LIMIT_MS, PARSE_TIMEOUT_MS } from "../constants"

const options = {
	content: "function example() { return 'a sufficiently long function body for indexing'; }",
	fileHash: "hash",
}
const distribution = path.resolve("dist")
const builtWorker = path.join(distribution, "workers", "codeIndexParse.js")

function within<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Did not settle within ${milliseconds} ms`)), milliseconds)
		promise.then(
			(value) => {
				clearTimeout(timer)
				resolve(value)
			},
			(error: unknown) => {
				clearTimeout(timer)
				reject(error)
			},
		)
	})
}

async function probe(): Promise<number> {
	const started = performance.now()
	await new Promise((resolve) => setTimeout(resolve, 20))
	const elapsed = performance.now() - started
	expect(elapsed).toBeLessThan(500)
	return elapsed
}

describe("ParseWorkerClient built worker", () => {
	let directory: string
	const workers: Worker[] = []

	beforeAll(async () => {
		directory = await mkdtemp(path.join(tmpdir(), "zoo-parse-worker-"))
		await copyFile(builtWorker, path.join(directory, "codeIndexParse.js"))
		await copyFile(
			path.resolve("services/code-index/__tests__/fixtures/fault-loop.wasm"),
			path.join(directory, "fault-loop.wasm"),
		)
	})

	afterEach(async () => {
		await Promise.all(workers.splice(0).map((worker) => worker.terminate()))
	})

	afterAll(async () => {
		if (directory) await rm(directory, { recursive: true, force: true })
	})

	function createWorker(fault?: string): Worker {
		const environment = { ...process.env }
		delete environment.ROO_PARSE_WORKER_FAULT
		if (fault) environment.ROO_PARSE_WORKER_FAULT = fault
		const worker = new Worker(fault ? path.join(directory, "codeIndexParse.js") : builtWorker, {
			env: environment,
			workerData: { wasmDirectory: distribution },
		})
		workers.push(worker)
		return worker
	}

	it("preserves both worker outputs without packaging the test-only fault fixture or VS Code imports", async () => {
		const filenames = await readdir(path.join(distribution, "workers"))
		expect(filenames).toContain("countTokens.js")
		expect(filenames).toContain("codeIndexParse.js")
		expect(filenames).not.toContain("fault-loop.wasm")
		expect(await readdir(distribution)).not.toContain("fault-loop.wasm")
		const bundle = await readFile(builtWorker, "utf8")
		expect(bundle).not.toMatch(/require\(["']vscode["']\)/)
	})

	it("loads the runtime and TypeScript grammar from extension dist rather than the worker directory", async () => {
		const client = new ParseWorkerClient(() => createWorker())
		try {
			const blocks = await within(client.parseFile("normal.ts", options), 5000)
			expect(blocks).toEqual([
				expect.objectContaining({
					content: options.content,
					type: "function_declaration",
					fileHash: options.fileHash,
				}),
			])
		} finally {
			client.stop()
			await within(client.stopped, INDEX_STOP_LIMIT_MS)
		}
	})

	it.each(["timeout", "stop"])(
		"physically exits a real WASM hang on %s without blocking the main loop",
		async (action) => {
			const worker = createWorker("wasm-hang")
			const entered = new Promise<void>((resolve, reject) => {
				worker.once("error", reject)
				worker.on("message", (reply: ParseReply) => {
					if (reply.diagnostic?.message === "parse worker entering wasm fault loop") resolve()
				})
			})
			const client = new ParseWorkerClient(() => worker)
			let exitObserved = false
			worker.once("exit", () => {
				exitObserved = true
			})
			const pending = client.parseFile("hang.ts", options).catch((error: unknown) => error)
			await within(entered, 5000)
			const hangProbe = await probe()
			expect(exitObserved).toBe(false)
			let stoppingAt: number
			if (action === "stop") {
				stoppingAt = performance.now()
				expect(client.stop()).toBeUndefined()
			} else {
				expect(await within(pending, PARSE_TIMEOUT_MS)).toMatchObject({ category: "parse-timeout" })
				stoppingAt = performance.now()
			}
			const stoppingProbe = probe()
			await within(client.stopped, INDEX_STOP_LIMIT_MS)
			const exitElapsed = performance.now() - stoppingAt
			expect(exitElapsed).toBeLessThan(INDEX_STOP_LIMIT_MS)
			expect(exitObserved).toBe(true)
			expect(await pending).toMatchObject(
				action === "stop" ? { name: "AbortError" } : { category: "parse-timeout" },
			)
			expect(await stoppingProbe).toBeLessThan(500)
			expect(hangProbe).toBeLessThan(500)
		},
	)

	it("contains a fatal abort and permits explicit recovery using a new worker", async () => {
		const failed = new ParseWorkerClient(() => createWorker("abort"))
		await expect(failed.parseFile("abort.ts", options)).rejects.toMatchObject({
			name: "ParserFatalError",
			category: "parser-abort",
			message: expect.stringContaining("Aborted()"),
		})
		await within(failed.stopped, INDEX_STOP_LIMIT_MS)
		const replacement = new ParseWorkerClient(() => createWorker())
		try {
			const blocks = await within(replacement.parseFile("normal.ts", options), 5000)
			expect(blocks[0].content).toBe(options.content)
		} finally {
			replacement.stop()
			await within(replacement.stopped, INDEX_STOP_LIMIT_MS)
		}
	})
})
