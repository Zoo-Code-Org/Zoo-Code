const mocks = vi.hoisted(() => ({
	channel: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dispose: vi.fn() },
	createOutputChannel: vi.fn(),
	postMessage: vi.fn(),
	thread: { isMainThread: true },
}))
vi.mock("vscode", () => ({ window: { createOutputChannel: mocks.createOutputChannel } }))
vi.mock("node:worker_threads", () => ({
	get isMainThread() {
		return mocks.thread.isMainThread
	},
	parentPort: { postMessage: mocks.postMessage },
}))

import { codeIndexLog } from "../code-index-log"
import { initializeCodeIndexHostLogging } from "../code-index-log-host"
import { clearAllMocks } from "../../../test-utils/reset"

beforeEach(() => {
	codeIndexLog.dispose()
	clearAllMocks()
	mocks.thread.isMainThread = true
	mocks.createOutputChannel.mockReturnValue(mocks.channel)
	codeIndexLog.configure({ workspacePaths: [], secrets: [] })
	initializeCodeIndexHostLogging()
})

afterEach(() => codeIndexLog.dispose())

it("lazily uses one named log channel and prefixes every severity", () => {
	expect(mocks.createOutputChannel).not.toHaveBeenCalled()
	for (const level of ["info", "warn", "error", "debug"] as const) {
		codeIndexLog[level]("message", { source: "scan", attempt: 2 })
		expect(mocks.channel[level]).toHaveBeenCalledWith('[CodeIndex] message {"source":"scan","attempt":2}')
	}
	expect(mocks.createOutputChannel).toHaveBeenCalledExactlyOnceWith("Zoo Code Indexing", { log: true })
})

it("redacts configured secrets, headers, URL credentials and workspace roots in all fields", () => {
	codeIndexLog.configure({
		workspacePaths: ["C:\\work\\project", "/home/user/project"],
		secrets: ["private-key", "a+b"],
	})
	codeIndexLog.error("https://user:password@host/test?api-key=private-key", {
		path: "c:/work/project/src/file.ts",
		other: "C:\\work\\project\\src\\other.ts",
		error: new Error('/home/user/project/src/file.ts Authorization: Bearer private-key\napi-key="a+b"'),
		nested: { Authorization: "secret", apiKey: "secret", content: "never log file contents" },
	})
	const output = mocks.channel.error.mock.calls[0][0]
	for (const secret of [
		"user:password",
		"private-key",
		"a+b",
		"home/user",
		"work",
		"never log file contents",
		'"secret"',
	]) {
		expect(output).not.toContain(secret)
	}
	expect(output).toContain("src/file.ts")
	expect(output).toContain("[REDACTED]")
})

it("does not log SDK request bodies or arbitrary Error properties", () => {
	const error = Object.assign(new Error("request failed"), { request: { body: "file contents" }, status: 503 })
	codeIndexLog.error("failed", error)
	expect(mocks.channel.error.mock.calls[0][0]).toContain('"status":503')
	expect(mocks.channel.error.mock.calls[0][0]).not.toContain("file contents")
})

it("keeps every retry and final failure in one warning per explicit flush", () => {
	const batch = codeIndexLog.createFailureBatch({ source: "watcher", batch: 7 })
	batch.flush()
	for (const attempt of [1, 2, 3])
		batch.record({ path: "file.ts", activity: "embed", reason: "503", attempt, willRetry: attempt < 3 })
	expect(mocks.channel.warn).not.toHaveBeenCalled()
	batch.flush()
	batch.flush()
	expect(mocks.channel.warn).toHaveBeenCalledOnce()
	const output = mocks.channel.warn.mock.calls[0][0]
	const fields = JSON.parse(output.slice(output.indexOf("{")))
	expect(fields.failureCount).toBe(3)
	expect(fields.failures.map((entry: { attempt: number }) => entry.attempt)).toEqual([1, 2, 3])
	expect(fields.failures[2].willRetry).toBe(false)
	batch.record({ path: "other.ts", activity: "verify", reason: "timeout", attempt: 1, willRetry: true })
	batch.flush()
	expect(mocks.channel.warn).toHaveBeenCalledTimes(2)
})

it.each(["info", "warn", "error", "debug"] as const)(
	"forwards redacted worker %s diagnostics without invoking the host sink",
	(level) => {
		mocks.thread.isMainThread = false
		codeIndexLog.configure({ workspacePaths: ["/workspace"], secrets: ["configured-secret"] })
		codeIndexLog[level]("api-key=hidden", {
			path: "/workspace/file.ts",
			reason: "configured-secret",
			content: "file contents",
			nested: { token: "hidden" },
		})
		expect(mocks.createOutputChannel).not.toHaveBeenCalled()
		expect(mocks.channel[level]).not.toHaveBeenCalled()
		expect(mocks.postMessage).toHaveBeenCalledExactlyOnceWith({
			id: 0,
			diagnostic: {
				level,
				message: "api-key=[REDACTED]",
				fields: {
					path: "file.ts",
					reason: "[REDACTED]",
					content: "[REDACTED]",
					nested: { token: "[REDACTED]" },
				},
			},
		})
	},
)

it("initializes idempotently and recreates the channel after disposal", () => {
	codeIndexLog.info("first")
	initializeCodeIndexHostLogging()
	codeIndexLog.info("second")
	expect(mocks.createOutputChannel).toHaveBeenCalledTimes(1)
	expect(mocks.channel.dispose).not.toHaveBeenCalled()
	codeIndexLog.dispose()
	expect(mocks.channel.dispose).toHaveBeenCalledTimes(1)
	codeIndexLog.info("third")
	expect(mocks.createOutputChannel).toHaveBeenCalledTimes(2)
})

it("disposes the previous channel when replacing the host sink", () => {
	codeIndexLog.info("first")
	const replacement = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), dispose: vi.fn() }
	codeIndexLog.setHostSinkFactory(() => replacement)
	expect(mocks.channel.dispose).toHaveBeenCalledOnce()
	codeIndexLog.info("second")
	expect(replacement.info).toHaveBeenCalledExactlyOnceWith("[CodeIndex] second")
})

it("handles cycles and configuration replacement", () => {
	const fields: Record<string, unknown> = {}
	fields.circular = fields
	codeIndexLog.info("cycle", fields)
	expect(mocks.channel.info.mock.calls[0][0]).toContain("[Circular]")
	codeIndexLog.configure({ secrets: ["old"] })
	codeIndexLog.configure({ secrets: ["new"] })
	codeIndexLog.info("old new")
	expect(mocks.channel.info).toHaveBeenLastCalledWith("[CodeIndex] old [REDACTED]")
})

it("matches a reference redactor and scales across a 1/2/4/8 input ladder", () => {
	codeIndexLog.configure({ workspacePaths: ["/workspace/project"], secrets: ["configured-secret"] })
	const unit =
		'failed /workspace/project/src/file.ts https://user:password@host/path api-key="token" configured-secret\n'
	const expectedUnit = 'failed src/file.ts https://[REDACTED]@host/path api-key="[REDACTED]" [REDACTED]\n'
	let captured = ""
	mocks.channel.debug.mockImplementation((message: string) => {
		captured = message
	})
	const samples: number[] = []
	for (const multiplier of [1, 2, 4, 8]) {
		const input = unit.repeat(500 * multiplier)
		const expected = `[CodeIndex] ${expectedUnit.repeat(500 * multiplier)}`
		codeIndexLog.debug(input)
		expect(captured).toBe(expected)
		const timings: number[] = []
		for (let sampleNumber = 0; sampleNumber < 5; sampleNumber++) {
			const started = performance.now()
			for (let iteration = 0; iteration < 15; iteration++) codeIndexLog.debug(input)
			timings.push(performance.now() - started)
		}
		samples.push(timings.sort((left, right) => left - right)[2])
	}
	console.log(`codeIndexLog redaction ladder ms: ${samples.map((sample) => sample.toFixed(2)).join(" / ")}`)
	expect(samples[2] / samples[0]).toBeLessThan(8)
	expect(samples[3] / samples[0]).toBeLessThan(16)
})
