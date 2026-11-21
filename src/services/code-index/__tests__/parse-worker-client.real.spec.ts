import * as path from "node:path"
import { Worker } from "node:worker_threads"
import { ParseWorkerClient } from "../parse-worker-client"

// Test-only worker: on the first request it reports entry, then runs an endless WASM loop.
const faultLoopSource = `
const { readFileSync } = require("node:fs")
const { parentPort, workerData } = require("node:worker_threads")
const loopModule = new WebAssembly.Module(readFileSync(workerData.wasmPath))
parentPort.on("message", () => {
	const instance = new WebAssembly.Instance(loopModule)
	parentPort.postMessage({ entered: true })
	instance.exports.loop()
})
`
const wasmPath = path.join(__dirname, "fixtures", "fault-loop.wasm")
const options = { content: "function example() { return 1 }", fileHash: "hash" }

// The exit event proves termination stopped the loop; no wall-clock bound is asserted.
// The timeout must outlast worker startup, or the worker is killed before it reports entering the loop.
function startLoopingParse(timeoutMs: number) {
	const worker = new Worker(faultLoopSource, { eval: true, workerData: { wasmPath } })
	const exited = new Promise<number>((resolve) => worker.once("exit", resolve))
	const entered = new Promise<void>((resolve, reject) => {
		worker.once("error", reject)
		worker.on("message", (message: { entered?: boolean }) => {
			if (message.entered) resolve()
		})
	})
	const client = new ParseWorkerClient(() => worker, timeoutMs)
	const controller = new AbortController()
	client.open(controller.signal)
	const pending = client.parseFile("hang.ts", options).catch((error: unknown) => error)
	return { controller, entered, exited, pending }
}

describe("ParseWorkerClient with a real worker in a WASM loop", () => {
	it("CI-PW-07: a timeout terminates the worker and its exit is observed", async () => {
		const { entered, exited, pending } = startLoopingParse(5_000)
		await entered
		expect(await pending).toMatchObject({ name: "ParserFatalError", category: "timeout", filePath: "hang.ts" })
		await exited
	})

	it("CI-PW-07: an abort during the loop terminates the worker and its exit is observed", async () => {
		const { controller, entered, exited, pending } = startLoopingParse(60_000)
		await entered
		controller.abort()
		expect(await pending).toMatchObject({ name: "AbortError" })
		await exited
	})
})
