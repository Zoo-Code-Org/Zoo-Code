vi.mock("../code-index-log", () => ({
	codeIndexLog: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
import { codeIndexLog } from "../code-index-log"
import { EventEmitter } from "node:events"
import { ParseWorkerClient, type ParseRequest, type ParseWorker } from "../parse-worker-client"

class MockWorker extends EventEmitter {
	requests: ParseRequest[] = []
	terminate = vi.fn<ParseWorker["terminate"]>().mockResolvedValue(0)
	postMessage(request: ParseRequest): void {
		this.requests.push(request)
	}
}

const options = {
	content: "function example() { return 'a sufficiently long function body for indexing'; }",
	fileHash: "hash",
}

async function drain(): Promise<void> {
	for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

describe("ParseWorkerClient", () => {
	afterEach(() => vi.useRealTimers())

	it("settles stopped immediately when stopped before creating a worker", async () => {
		const factory = vi.fn<() => ParseWorker>()
		const client = new ParseWorkerClient(factory)
		expect(client.stop()).toBeUndefined()
		await client.stopped
		expect(factory).not.toHaveBeenCalled()
	})

	it.each(["resolved", "rejected", "pending"])(
		"waits for physical exit with a %s termination promise and logs the parent's timeout once",
		async (termination) => {
			vi.useFakeTimers()
			const log = vi.spyOn(codeIndexLog, "info").mockImplementation(() => {})
			try {
				const worker = new MockWorker()
				if (termination === "rejected") worker.terminate.mockRejectedValue(new Error("termination failed"))
				if (termination === "pending") worker.terminate.mockReturnValue(new Promise(() => {}))
				const client = new ParseWorkerClient(() => worker)
				let exited = false
				void client.stopped.then(() => {
					exited = true
				})
				const pending = client.parseFile("active.ts", options).catch((error: unknown) => error)
				await drain()
				expect(client.stop()).toBeUndefined()
				expect(await pending).toMatchObject({ name: "AbortError" })
				await vi.advanceTimersByTimeAsync(2000)
				expect(exited).toBe(false)
				client.logStopTimeout()
				client.logStopTimeout()
				expect(log).toHaveBeenCalledExactlyOnceWith("parse worker exit not observed within stop limit")
				worker.emit("exit", 1)
				await client.stopped
				expect(exited).toBe(true)
				expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/^parse worker exited after \d+ ms$/))
				client.logStopTimeout()
				expect(log).toHaveBeenCalledTimes(2)
			} finally {
				log.mockRestore()
			}
		},
	)

	it("observes an unexpected physical exit even when terminate never settles", async () => {
		const worker = new MockWorker()
		worker.terminate.mockReturnValue(new Promise(() => {}))
		const client = new ParseWorkerClient(() => worker)
		const pending = client.parseFile("active.ts", options).catch((error: unknown) => error)
		await drain()
		worker.emit("exit", 1)
		expect(await pending).toMatchObject({ name: "ParserFatalError" })
		await client.stopped
		expect(worker.terminate).not.toHaveBeenCalled()
	})

	it("forwards diagnostics without completing or interrupting the active parse", async () => {
		const worker = new MockWorker()
		const client = new ParseWorkerClient(() => worker)
		const pending = client.parseFile("active.ts", options)
		await drain()
		worker.emit("message", {
			id: 0,
			diagnostic: {
				level: "warn",
				message: "parser warning",
				fields: { path: "active.ts" },
			},
		})
		expect(codeIndexLog.warn).toHaveBeenLastCalledWith("parser warning", { path: "active.ts" })
		expect(worker.terminate).not.toHaveBeenCalled()
		worker.emit("message", { id: worker.requests[0].id, blocks: [] })
		await expect(pending).resolves.toEqual([])
		client.stop()
	})

	it("dispatches FIFO and starts each deadline at dispatch, not enqueue", async () => {
		vi.useFakeTimers()
		const worker = new MockWorker()
		const client = new ParseWorkerClient(() => worker, 100)
		const first = client.parseFile("first.ts", options)
		const second = client.parseFile("second.ts", options)
		await drain()
		expect(worker.requests.map((request) => request.filePath)).toEqual(["first.ts"])
		await vi.advanceTimersByTimeAsync(90)
		worker.emit("message", { id: worker.requests[0].id, blocks: [] })
		await first
		await vi.advanceTimersByTimeAsync(90)
		expect(worker.terminate).not.toHaveBeenCalled()
		worker.emit("message", { id: worker.requests[1].id, blocks: [] })
		await second
		client.stop()
	})

	it("uses the ten-second watchdog without granting a queued request its own failed-worker attempt", async () => {
		vi.useFakeTimers()
		const worker = new MockWorker()
		const client = new ParseWorkerClient(() => worker)
		const pending = client.parseFile("hung.ts", options).catch((error: unknown) => error)
		await drain()
		await vi.advanceTimersByTimeAsync(9999)
		expect(worker.terminate).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(await pending).toMatchObject({ category: "parse-timeout", filePath: "hung.ts" })
		expect(worker.terminate).toHaveBeenCalledOnce()
	})

	it("rejects an ordinary parse error without preventing the next file from completing", async () => {
		const worker = new MockWorker()
		const client = new ParseWorkerClient(() => worker)
		const failed = client.parseFile("bad.ts", options).catch((error: unknown) => error)
		const next = client.parseFile("good.ts", options)
		await drain()
		worker.emit("message", { id: worker.requests[0].id, error: { message: "invalid source", fatal: false } })
		expect(await failed).toMatchObject({ message: "invalid source", name: "Error" })
		expect(worker.terminate).not.toHaveBeenCalled()
		worker.emit("message", { id: worker.requests[1].id, blocks: [] })
		await expect(next).resolves.toEqual([])
		client.stop()
	})

	it("ignores mismatched replies and performs fallback chunking only when requested", async () => {
		const worker = new MockWorker()
		const client = new ParseWorkerClient(() => worker)
		const pending = client.parseFile("source.ts", options)
		await drain()
		worker.emit("message", { id: -1, error: { message: "Aborted()", fatal: true } })
		expect(worker.terminate).not.toHaveBeenCalled()
		worker.emit("message", { id: worker.requests[0].id, fallback: true })
		await expect(pending).resolves.toEqual([
			expect.objectContaining({ file_path: "source.ts", content: options.content, fileHash: options.fileHash }),
		])
		client.stop()
	})

	it.each(["Aborted()", "memory access out of bounds", "error", "exit", "hang"])(
		"contains %s and terminally rejects queued work",
		async (failure) => {
			vi.useFakeTimers()
			const worker = new MockWorker()
			const client = new ParseWorkerClient(() => worker, 100)
			const active = client.parseFile("bad.ts", options).catch((error: unknown) => error)
			const queued = client.parseFile("queued.ts", options).catch((error: unknown) => error)
			await drain()
			if (failure === "hang") await vi.advanceTimersByTimeAsync(100)
			else if (failure === "error") worker.emit("error", new Error("crash"))
			else if (failure === "exit") worker.emit("exit", 1)
			else worker.emit("message", { id: worker.requests[0].id, error: { message: failure, fatal: false } })
			expect(await active).toMatchObject({
				name: "ParserFatalError",
				filePath: "bad.ts",
				category: failure === "hang" ? "parse-timeout" : "parser-abort",
			})
			expect(await queued).toMatchObject({ name: "AbortError" })
			await expect(client.parseFile("later.md", options)).rejects.toMatchObject({ name: "AbortError" })
			expect(worker.requests).toHaveLength(1)
			expect(worker.terminate).toHaveBeenCalledTimes(failure === "exit" ? 0 : 1)
		},
	)

	it("removes a cancelled queue entry without stopping another caller", async () => {
		const worker = new MockWorker()
		const client = new ParseWorkerClient(() => worker)
		const controller = new AbortController()
		const first = client.parseFile("first.ts", options)
		const cancelled = client
			.parseFile("cancelled.ts", { ...options, signal: controller.signal })
			.catch((error: unknown) => error)
		const last = client.parseFile("last.ts", options)
		await drain()
		controller.abort()
		expect(await cancelled).toMatchObject({ name: "AbortError" })
		worker.emit("message", { id: worker.requests[0].id, blocks: [] })
		await first
		expect(worker.requests[1].filePath).toBe("last.ts")
		worker.emit("message", { id: worker.requests[1].id, blocks: [] })
		await last
		client.stop()
	})

	it.each(["stop", "abort"])(
		"%s synchronously settles active and queued requests without waiting for termination",
		async (action) => {
			const worker = new MockWorker()
			worker.terminate.mockReturnValue(new Promise(() => {}))
			const client = new ParseWorkerClient(() => worker)
			const controller = new AbortController()
			const active = client
				.parseFile("active.ts", { ...options, signal: controller.signal })
				.catch((error: unknown) => error)
			const queued = client.parseFile("queued.ts", options).catch((error: unknown) => error)
			await drain()
			if (action === "stop") client.stop()
			else controller.abort()
			expect(await active).toMatchObject({ name: "AbortError" })
			expect(await queued).toMatchObject({ name: "AbortError" })
			client.stop()
			expect(worker.terminate).toHaveBeenCalledTimes(1)
		},
	)

	it.each(["error", "exit"])("reports an idle worker %s as a parser failure on the next parse", async (failure) => {
		const worker = new MockWorker()
		const client = new ParseWorkerClient(() => worker)
		const first = client.parseFile("first.ts", options)
		await drain()
		worker.emit("message", { id: worker.requests[0].id, blocks: [] })
		await first
		if (failure === "error") worker.emit("error", new Error("crash"))
		else worker.emit("exit", 1)
		await expect(client.parseFile("next.ts", options)).rejects.toMatchObject({ name: "ParserFatalError" })
	})

	it("keeps independent workspaces isolated and a replacement usable", async () => {
		const failedWorker = new MockWorker()
		const otherWorker = new MockWorker()
		const failed = new ParseWorkerClient(() => failedWorker)
		const other = new ParseWorkerClient(() => otherWorker)
		const failure = failed.parseFile("bad.ts", options).catch((error: unknown) => error)
		const success = other.parseFile("good.ts", options)
		await drain()
		failedWorker.emit("exit", 1)
		await failure
		otherWorker.emit("message", { id: otherWorker.requests[0].id, blocks: [] })
		await expect(success).resolves.toEqual([])
		expect(otherWorker.terminate).not.toHaveBeenCalled()
		other.stop()
	})
})
