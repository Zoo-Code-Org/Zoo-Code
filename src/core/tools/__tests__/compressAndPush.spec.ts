import { compressAndPushToolResult } from "../compressAndPush"
import { ToolResultProcessor } from "../ToolResultProcessor"
import { DEFAULT_PROCESSOR_CONFIG } from "../ToolResultProcessorConfig"

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal Task-like mock that satisfies the fields accessed by
 * compressAndPushToolResult (toolResultProcessor and toolResultProcessorConfig).
 */
function makeTask(
	processorOverride?: Partial<ToolResultProcessor>,
	configOverride?: Partial<typeof DEFAULT_PROCESSOR_CONFIG>,
) {
	const config = { ...DEFAULT_PROCESSOR_CONFIG, ...configOverride }
	const processor = new ToolResultProcessor(null)

	// Allow tests to override individual processor methods via a plain object
	if (processorOverride) {
		Object.assign(processor, processorOverride)
	}

	return { toolResultProcessor: processor, toolResultProcessorConfig: config } as any
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("compressAndPushToolResult", () => {
	test("when shouldCompress returns false, pushToolResult is called with the raw result", async () => {
		const task = makeTask({
			shouldCompress: vi.fn().mockReturnValue(false),
		})

		const pushToolResult = vi.fn().mockResolvedValue(undefined)
		const rawResult = "raw tool output"

		await compressAndPushToolResult("read_file", rawResult, "some/path.ts", task, pushToolResult)

		expect(pushToolResult).toHaveBeenCalledTimes(1)
		expect(pushToolResult).toHaveBeenCalledWith(rawResult)
	})

	test("when shouldCompress returns true and compress succeeds, pushToolResult is called with the compressed result", async () => {
		const compressedResult = "compressed output"

		const task = makeTask({
			shouldCompress: vi.fn().mockReturnValue(true),
			compress: vi.fn().mockResolvedValue(compressedResult),
		})

		const pushToolResult = vi.fn().mockResolvedValue(undefined)
		const rawResult = "a".repeat(5000) // large raw result

		await compressAndPushToolResult("read_file", rawResult, "src/app.ts", task, pushToolResult)

		expect(pushToolResult).toHaveBeenCalledTimes(1)
		expect(pushToolResult).toHaveBeenCalledWith(compressedResult)
	})

	test("when shouldCompress returns true but compress returns raw (graceful degradation), pushToolResult is called with raw result", async () => {
		const rawResult = "a".repeat(5000)

		const task = makeTask({
			shouldCompress: vi.fn().mockReturnValue(true),
			// compress() falls back to rawResult on error (as ToolResultProcessor does)
			compress: vi.fn().mockResolvedValue(rawResult),
		})

		const pushToolResult = vi.fn().mockResolvedValue(undefined)

		await compressAndPushToolResult("read_file", rawResult, "src/app.ts", task, pushToolResult)

		expect(pushToolResult).toHaveBeenCalledTimes(1)
		expect(pushToolResult).toHaveBeenCalledWith(rawResult)
	})

	test("the context parameter is correctly passed through to compress()", async () => {
		const compressSpy = vi.fn().mockResolvedValue("compressed")
		const task = makeTask({
			shouldCompress: vi.fn().mockReturnValue(true),
			compress: compressSpy,
		})

		const pushToolResult = vi.fn().mockResolvedValue(undefined)
		const context = "the context string from tool params"

		await compressAndPushToolResult("search_files", "some results", context, task, pushToolResult)

		// The context is the third argument to compress()
		expect(compressSpy).toHaveBeenCalledWith(
			"search_files",
			"some results",
			context,
			task.toolResultProcessorConfig,
		)
	})

	test("works correctly when processor config has compression disabled (shouldCompress=false)", async () => {
		// Build a task with the real processor but compression disabled
		const task = makeTask(undefined, { enabled: false })

		const pushToolResult = vi.fn().mockResolvedValue(undefined)
		const rawResult = "a".repeat(5000)

		await compressAndPushToolResult("read_file", rawResult, "src/app.ts", task, pushToolResult)

		// shouldCompress returns false when config.enabled is false, so raw result is used
		expect(pushToolResult).toHaveBeenCalledTimes(1)
		expect(pushToolResult).toHaveBeenCalledWith(rawResult)
	})

	test("works correctly when processor config marks user as non-subscriber (shouldCompress=false)", async () => {
		// isSubscriber defaults to false in DEFAULT_PROCESSOR_CONFIG,
		// so the real processor should return false from shouldCompress
		const task = makeTask() // uses DEFAULT_PROCESSOR_CONFIG with isSubscriber=false

		const pushToolResult = vi.fn().mockResolvedValue(undefined)
		const rawResult = "a".repeat(5000)

		await compressAndPushToolResult("read_file", rawResult, "src/app.ts", task, pushToolResult)

		// shouldCompress returns false because isSubscriber=false
		expect(pushToolResult).toHaveBeenCalledTimes(1)
		expect(pushToolResult).toHaveBeenCalledWith(rawResult)
	})
})
