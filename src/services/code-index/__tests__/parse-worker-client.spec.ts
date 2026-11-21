vi.mock("@roo-code/telemetry", () => ({ TelemetryService: { instance: { captureEvent: vi.fn() } } }))
const readFile = vi.hoisted(() => vi.fn<(filePath: string, encoding: string) => Promise<string>>())
vi.mock("node:fs/promises", () => ({ readFile }))

import { EventEmitter } from "node:events"
import { TelemetryService } from "@roo-code/telemetry"
import type { CodeBlock } from "../interfaces"
import { ParseWorkerClient, type ParseRequest, type ParseWorker } from "../parse-worker-client"
import { ParserFatalError } from "../parser-errors"
import { ParserLoadError } from "../processors/parser"

class MockWorker extends EventEmitter {
	requests: ParseRequest[] = []
	terminate = vi.fn<ParseWorker["terminate"]>().mockResolvedValue(0)
	postMessage(request: ParseRequest): void {
		this.requests.push(request)
	}
	reply(index: number, blocks: CodeBlock[] = []): void {
		this.emit("message", { id: this.requests[index].id, blocks })
	}
	replyError(index: number, name: string, message: string): void {
		this.emit("message", { id: this.requests[index].id, error: { name, message } })
	}
}

const options = { content: "function example() { return 1 }", fileHash: "hash" }
const block: CodeBlock = {
	file_path: "a.ts",
	identifier: "example",
	type: "function_declaration",
	start_line: 1,
	end_line: 1,
	content: options.content,
	fileHash: "hash",
	segmentHash: "segment",
}

function setup(timeoutMs?: number) {
	const workers: MockWorker[] = []
	const factory = vi.fn(() => {
		const worker = new MockWorker()
		workers.push(worker)
		return worker
	})
	const client = new ParseWorkerClient(factory, timeoutMs)
	const controller = new AbortController()
	client.open(controller.signal)
	const parse = (filePath: string) => client.parseFile(filePath, options).catch((error: unknown) => error)
	return { client, controller, factory, workers, parse }
}

async function drain(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

describe("ParseWorkerClient", () => {
	afterEach(() => vi.useRealTimers())

	it("CI-PW-01: runs requests one at a time in order and settles replies by id", async () => {
		const { client, workers, factory } = setup()
		const first = client.parseFile("a.ts", options)
		const second = client.parseFile("b.ts", options)
		await drain()
		const [worker] = workers
		expect(worker.requests.map((request) => request.filePath)).toEqual(["a.ts"])
		expect(worker.requests[0]).toMatchObject({ content: options.content, fileHash: "hash" })
		worker.emit("message", { id: -1, blocks: [] })
		worker.reply(0, [block])
		await expect(first).resolves.toEqual([block])
		expect(worker.requests.map((request) => request.filePath)).toEqual(["a.ts", "b.ts"])
		worker.reply(1)
		await expect(second).resolves.toEqual([])
		expect(factory).toHaveBeenCalledOnce()
	})

	it("CI-PW-01: ignores a late reply after the session closes", async () => {
		const { controller, workers, parse } = setup()
		const pending = parse("a.ts")
		await drain()
		controller.abort()
		expect(await pending).toMatchObject({ name: "AbortError" })
		expect(() => workers[0].reply(0, [block])).not.toThrow()
	})

	it("CI-PW-02: a parse with no reply for 10 s fails with timeout and stops the session", async () => {
		vi.useFakeTimers()
		const { workers, parse } = setup()
		const active = parse("hung.ts")
		const queued = parse("queued.ts")
		await drain()
		await vi.advanceTimersByTimeAsync(9_999)
		expect(workers[0].terminate).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		const failure = await active
		expect(failure).toBeInstanceOf(ParserFatalError)
		expect(failure).toMatchObject({ category: "timeout", filePath: "hung.ts" })
		expect(await queued).toMatchObject({ name: "AbortError" })
		expect(workers[0].terminate).toHaveBeenCalledOnce()
		expect(workers[0].requests).toHaveLength(1)
	})

	it("CI-PW-02: the deadline starts when a request is posted, not when it is queued", async () => {
		vi.useFakeTimers()
		const { workers, parse } = setup(100)
		const first = parse("a.ts")
		const second = parse("b.ts")
		await drain()
		await vi.advanceTimersByTimeAsync(90)
		workers[0].reply(0)
		expect(await first).toEqual([])
		await vi.advanceTimersByTimeAsync(90)
		workers[0].reply(1)
		expect(await second).toEqual([])
		expect(workers[0].terminate).not.toHaveBeenCalled()
	})

	it.each([
		["a RuntimeError reply", "crash", (worker: MockWorker) => worker.replyError(0, "RuntimeError", "unreachable")],
		["an isParserAbort reply", "crash", (worker: MockWorker) => worker.replyError(0, "Error", "Aborted()")],
		["an error event", "crash", (worker: MockWorker) => worker.emit("error", new Error("worker crashed"))],
		["an exit while open", "exit", (worker: MockWorker) => worker.emit("exit", 1)],
	])("CI-PW-03: %s fails the parse as %s and the next session uses a new worker", async (_label, category, fault) => {
		const { client, factory, workers, parse } = setup()
		const active = parse("bad.ts")
		const queued = parse("queued.ts")
		await drain()
		fault(workers[0])
		expect(await active).toMatchObject({ name: "ParserFatalError", category, filePath: "bad.ts" })
		expect(await queued).toMatchObject({ name: "AbortError" })
		expect(await parse("later.ts")).toMatchObject({ name: "AbortError" })
		expect(workers[0].terminate).toHaveBeenCalledOnce()
		expect(workers[0].requests).toHaveLength(1)
		expect(factory).toHaveBeenCalledOnce()

		client.open(new AbortController().signal)
		const retried = parse("bad.ts")
		await drain()
		expect(factory).toHaveBeenCalledTimes(2)
		workers[1].reply(0)
		expect(await retried).toEqual([])
		expect(TelemetryService.instance.captureEvent).not.toHaveBeenCalled()
	})

	it("CI-PW-04: abort rejects active and queued parses at once without awaiting termination", async () => {
		const { controller, workers, parse } = setup()
		const active = parse("active.ts")
		const queued = parse("queued.ts")
		await drain()
		workers[0].terminate.mockReturnValue(new Promise(() => {}))
		controller.abort()
		expect(workers[0].terminate).toHaveBeenCalledOnce()
		expect(await active).toMatchObject({ name: "AbortError" })
		expect(await queued).toMatchObject({ name: "AbortError" })
		workers[0].emit("exit", 1)
		expect(workers[0].terminate).toHaveBeenCalledOnce()
	})

	it("CI-PW-04: a parse on a session opened with an aborted signal rejects without a worker", async () => {
		const factory = vi.fn<() => ParseWorker>()
		const client = new ParseWorkerClient(factory)
		const controller = new AbortController()
		controller.abort()
		client.open(controller.signal)
		await expect(client.parseFile("a.ts", options)).rejects.toMatchObject({ name: "AbortError" })
		await expect(new ParseWorkerClient(factory).parseFile("a.ts", options)).rejects.toMatchObject({
			name: "AbortError",
		})
		expect(factory).not.toHaveBeenCalled()
	})

	it("CI-PW-05: a ParserLoadError reply is rethrown as ParserLoadError and the session stays open", async () => {
		const { factory, workers, parse } = setup()
		const failed = parse("missing.ts")
		const ordinary = parse("ordinary.ts")
		const next = parse("next.ts")
		await drain()
		workers[0].replyError(0, "ParserLoadError", "Failed to load the language parser for ts files")
		const failure = await failed
		expect(failure).toBeInstanceOf(ParserLoadError)
		expect(failure).toMatchObject({ extension: "ts" })
		workers[0].replyError(1, "TypeError", "bad input")
		expect(await ordinary).toMatchObject({ name: "TypeError", message: "bad input" })
		workers[0].reply(2, [block])
		expect(await next).toEqual([block])
		expect(workers[0].terminate).not.toHaveBeenCalled()
		expect(factory).toHaveBeenCalledOnce()
	})

	it("CI-PW-11: a parse bound to an earlier session's signal rejects without touching the current session", async () => {
		const { client, controller, factory, workers } = setup()
		const next = new AbortController()
		client.open(next.signal)
		const stale = client.parseFile("old.ts", { ...options, signal: controller.signal })
		await expect(stale).rejects.toMatchObject({ name: "AbortError" })
		expect(factory).not.toHaveBeenCalled()

		const current = client.parseFile("new.ts", { ...options, signal: next.signal })
		await drain()
		expect(workers[0].requests.map((request) => request.filePath)).toEqual(["new.ts"])
		workers[0].reply(0, [block])
		expect(await current).toEqual([block])
		expect(workers[0].terminate).not.toHaveBeenCalled()
	})

	it("CI-PW-11: a host read that finishes after a restart rejects without touching the new session", async () => {
		const { client, controller, factory, workers } = setup()
		let finishRead!: (content: string) => void
		readFile.mockReturnValueOnce(new Promise<string>((resolve) => (finishRead = resolve)))
		// No signal: only the session captured before the read can reject this stale parse.
		const stale = client.parseFile("old.ts").catch((error: unknown) => error)
		await drain()
		expect(readFile).toHaveBeenCalledWith("old.ts", "utf8")

		controller.abort()
		const next = new AbortController()
		client.open(next.signal)
		finishRead(options.content)
		expect(await stale).toMatchObject({ name: "AbortError" })
		expect(factory).not.toHaveBeenCalled()

		const current = client.parseFile("new.ts", { ...options, signal: next.signal })
		await drain()
		expect(workers[0].requests.map((request) => request.filePath)).toEqual(["new.ts"])
		workers[0].reply(0, [block])
		expect(await current).toEqual([block])
		expect(workers[0].terminate).not.toHaveBeenCalled()
	})

	it.each([
		["exit", (worker: MockWorker) => worker.emit("exit", 1)],
		["error", (worker: MockWorker) => worker.emit("error", new Error("idle crash"))],
	])("CI-PW-10: an idle worker %s keeps the session and the next parse spawns a worker", async (_label, fault) => {
		const { factory, workers, parse } = setup()
		const first = parse("a.ts")
		await drain()
		workers[0].reply(0)
		expect(await first).toEqual([])
		fault(workers[0])
		const next = parse("b.ts")
		await drain()
		expect(factory).toHaveBeenCalledTimes(2)
		workers[0].emit("exit", 1)
		workers[1].reply(0, [block])
		expect(await next).toEqual([block])
	})
})
