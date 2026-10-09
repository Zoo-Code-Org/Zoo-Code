import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { Task } from "../../../task/Task"
import { ReadFilesTool } from "../ReadFilesTool"
import { ReadFileTool } from "../ReadFileTool"
import { NativeToolCallParser } from "../../../assistant-message/NativeToolCallParser"
import { extractTextFromFile } from "../../../../integrations/misc/extract-text"
import { MAX_READ_FILES_RESULT_BYTES } from "../readFileBatchBudget"
import { READ_FILES_TOOL_NAME, type ReadFilesParams } from "@roo-code/types"
import { checkAutoApproval } from "../../../auto-approval"

vi.mock("fs/promises", async () => {
	const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises")
	return { ...actual, readFile: vi.fn(actual.readFile), stat: vi.fn(actual.stat) }
})
vi.mock("../../../../integrations/misc/extract-text", async () => {
	const actual = await vi.importActual<typeof import("../../../../integrations/misc/extract-text")>(
		"../../../../integrations/misc/extract-text",
	)
	return { ...actual, extractTextFromFile: vi.fn() }
})
vi.mock("../../../../utils/pathUtils", () => ({ isPathOutsideWorkspace: (file: string) => file.includes("outside") }))

describe(`${READ_FILES_TOOL_NAME} modern batch integration`, () => {
	let cwd: string
	beforeEach(async () => {
		vi.clearAllMocks()
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "zoo-read-files-"))
		await fs.writeFile(
			path.join(cwd, "source.ts"),
			"const header = 1\nfunction example() {\n    return header\n}\nconst tail = 2",
		)
		await fs.writeFile(path.join(cwd, "test.ts"), "first\nsecond\nthird")
	})
	afterEach(async () => {
		vi.restoreAllMocks()
		await fs.rm(cwd, { recursive: true, force: true })
	})

	function setup() {
		const fileReader = new ReadFileTool()
		const tool = new ReadFilesTool(fileReader)
		const double = {
			cwd,
			api: {
				getModel: vi.fn(() => ({
					id: "test",
					info: { contextWindow: 128_000, maxTokens: 8192, supportsPromptCache: false },
				})),
			},
			apiConfiguration: {},
			getTokenUsage: vi.fn(() => ({ contextTokens: 1000 })),
			userMessageContent: [],
			abort: false,
			abandoned: false,
			didRejectTool: false,
			didToolFailInCurrentTurn: false,
			consecutiveMistakeCount: 0,
			ask: vi.fn(async (_type: string, _message: string, _partial: boolean) => ({
				response: "yesButtonClicked",
				text: "",
				images: [] as string[],
			})),
			say: vi.fn(async () => {}),
			recordToolError: vi.fn(),
			rooIgnoreController: { validateAccess: vi.fn(() => true) },
			fileContextTracker: { trackFileContext: vi.fn(async () => {}) },
			providerRef: { deref: () => ({ getState: async () => ({}) }) },
		}
		// Task owns many unrelated lifecycle fields; this double implements only the
		// reader boundary and never starts the task lifecycle or an API request.
		const task = double as unknown as Task
		const callbacks = { pushToolResult: vi.fn(), askApproval: vi.fn(), handleError: vi.fn() }
		async function run(entries: ReadFilesParams["entries"]) {
			await tool.execute({ entries }, task, callbacks)
			const result: unknown = callbacks.pushToolResult.mock.calls.at(-1)?.[0]
			if (typeof result !== "string") throw new Error("Expected a text-only batch result")
			return result
		}
		return { tool, fileReader, double, task, callbacks, run }
	}

	it("parses and executes one call with different slice/block parameters in stable order", async () => {
		const { tool, task, double, callbacks } = setup()
		const block = NativeToolCallParser.parseToolCall({
			id: "one-call",
			name: READ_FILES_TOOL_NAME,
			arguments: JSON.stringify({
				entries: [
					{ path: "test.ts", offset: 2, limit: 1 },
					{ path: "source.ts", mode: "indentation", indentation: { anchor_line: 3, include_header: false } },
				],
			}),
		})
		if (!block || block.type !== "tool_use" || block.name !== READ_FILES_TOOL_NAME)
			throw new Error("Invalid parsed batch")
		await tool.handle(task, block, callbacks)
		expect(callbacks.pushToolResult).toHaveBeenCalledTimes(1)
		const output = String(callbacks.pushToolResult.mock.calls[0][0])
		expect(output).toContain("2 | second")
		expect(output).toContain("function example()")
		expect(output).toContain("return header")
		expect(output.indexOf('Entry 1: "test.ts"')).toBeLessThan(output.indexOf('Entry 2: "source.ts"'))
		expect(double.ask).toHaveBeenCalledTimes(2)
		const asks = double.ask.mock.calls.map((call) => JSON.parse(call[1]))
		expect(asks[0]).toMatchObject({ tool: "readFile", path: "test.ts", startLine: 2 })
		expect(asks[1]).toMatchObject({ tool: "readFile", path: "source.ts", startLine: 3 })
	})

	it("preserves successes and cancels unread siblings after rejection", async () => {
		const { double, run } = setup()
		double.ask
			.mockResolvedValueOnce({ response: "yesButtonClicked", text: "", images: [] })
			.mockResolvedValueOnce({ response: "noButtonClicked", text: "do not read this", images: [] })
		const output = await run([{ path: "test.ts" }, { path: "source.ts" }, { path: "never.ts" }])
		expect(output).toMatch(
			/Entry 1:[\s\S]*Status: success[\s\S]*Entry 2:[\s\S]*Status: denied[\s\S]*Entry 3:[\s\S]*Status: cancelled/,
		)
		expect(output).toContain("do not read this")
		expect(fs.readFile).not.toHaveBeenCalledWith(path.join(cwd, "source.ts"))
		expect(fs.stat).not.toHaveBeenCalledWith(path.join(cwd, "never.ts"))
		expect(double.ask).toHaveBeenCalledTimes(2)
		expect(double.didRejectTool).toBe(true)
	})

	it("does not read files blocked by ignore rules; a missing sibling does not erase successes", async () => {
		const { double, run } = setup()
		double.rooIgnoreController.validateAccess.mockImplementation((...args: unknown[]) => args[0] !== "blocked.ts")
		const output = await run([{ path: "blocked.ts" }, { path: "missing.ts" }, { path: "test.ts" }])
		expect(output).toMatch(/Status: blocked[\s\S]*Status: error[\s\S]*Status: success/)
		expect(fs.stat).not.toHaveBeenCalledWith(path.join(cwd, "blocked.ts"))
		expect(double.ask).toHaveBeenCalledTimes(2)
		expect(double.didToolFailInCurrentTurn).toBe(true)
	})

	it("keeps unexpected entry failures local and continues reading siblings", async () => {
		const { double, run, fileReader } = setup()
		vi.spyOn(fileReader, "readEntry").mockRejectedValueOnce(new Error("Unexpected entry failure"))
		const output = await run([{ path: "source.ts" }, { path: "test.ts" }])
		expect(output).toMatch(/Status: error[\s\S]*Unexpected entry failure[\s\S]*Status: success/)
		expect(double.didToolFailInCurrentTurn).toBe(true)
		expect(double.ask).toHaveBeenCalledTimes(1)
	})

	it("cancels during approval without statting or reading the approved file", async () => {
		const { double, run } = setup()
		double.ask.mockImplementationOnce(async () => {
			double.abort = true
			return { response: "yesButtonClicked", text: "", images: [] }
		})
		const output = await run([{ path: "source.ts" }, { path: "test.ts" }])
		expect(output.match(/Status: cancelled/g)).toHaveLength(2)
		expect(fs.stat).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("stops on a withdrawn approval even before task cancellation flags propagate", async () => {
		const { double, run } = setup()
		double.ask.mockRejectedValueOnce(new Error("Approval was withdrawn"))
		const output = await run([{ path: "source.ts" }, { path: "test.ts" }])
		expect(output.match(/Status: cancelled/g)).toHaveLength(2)
		expect(double.ask).toHaveBeenCalledTimes(1)
		expect(fs.stat).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it("handles cancellation while reading without leaking that content or reading the next file", async () => {
		const { double, run } = setup()
		vi.mocked(fs.readFile).mockImplementationOnce(async () => {
			double.abort = true
			return Buffer.from("private in-flight content")
		})
		const output = await run([{ path: "source.ts" }, { path: "test.ts" }])
		expect(output.match(/Status: cancelled/g)).toHaveLength(2)
		expect(output).not.toContain("private in-flight content")
		expect(double.ask).toHaveBeenCalledTimes(1)
	})

	it("uses an independent outside-workspace approval with the ordinary policy", async () => {
		const { double, run } = setup()
		double.ask.mockImplementation(async (_type, message) => {
			const decision = await checkAutoApproval({
				ask: "tool",
				text: message,
				cwd,
				state: {
					autoApprovalEnabled: true,
					alwaysAllowReadOnly: true,
					alwaysAllowReadOnlyOutsideWorkspace: false,
				},
			})
			return {
				response: decision.decision === "approve" ? "yesButtonClicked" : "noButtonClicked",
				text: "",
				images: [],
			}
		})
		const output = await run([{ path: "test.ts" }, { path: "../outside.ts" }])
		expect(output).toMatch(/Status: success[\s\S]*Status: denied/)
		expect(JSON.parse(double.ask.mock.calls[1][1])).toMatchObject({ isOutsideWorkspace: true })
		expect(fs.stat).not.toHaveBeenCalledWith(path.resolve(cwd, "../outside.ts"))
	})

	it("bounds huge explicit limits and long lines across all ten entries", async () => {
		const { run } = setup()
		await fs.writeFile(path.join(cwd, "large.ts"), Array.from({ length: 3000 }, () => "🔥".repeat(3000)).join("\n"))
		const output = await run(
			Array.from({ length: 10 }, () => ({ path: "large.ts", limit: Number.MAX_SAFE_INTEGER })),
		)
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_READ_FILES_RESULT_BYTES)
		expect(output.match(/Entry \d+:/g)).toHaveLength(10)
		expect(output).toContain("Status: truncated")
		expect(output).toContain("Long lines clipped")
		expect(output).not.toContain("�")
	})

	it("budgets extracted document text and rejects images/binary without legacy fallback", async () => {
		const { run } = setup()
		await fs.writeFile(path.join(cwd, "document.pdf"), Buffer.from([0, 1, 2]))
		await fs.writeFile(path.join(cwd, "image.svg"), "<svg />")
		await fs.writeFile(path.join(cwd, "binary.bin"), Buffer.from([0, 1, 2]))
		vi.mocked(extractTextFromFile).mockResolvedValue(
			Array.from({ length: 4000 }, (_, i) => `document line ${i}`).join("\n"),
		)
		const output = await run([
			{ path: "document.pdf", offset: 10, limit: 2 },
			{ path: "image.svg" },
			{ path: "binary.bin" },
		])
		expect(output).toContain("10 | document line 9")
		expect(output).toContain("11 | document line 10")
		expect(output.match(/Status: unsupported/g)).toHaveLength(2)
		expect(fs.readFile).not.toHaveBeenCalledWith(path.join(cwd, "image.svg"))
		expect(fs.readFile).not.toHaveBeenCalledWith(path.join(cwd, "binary.bin"))
		vi.mocked(extractTextFromFile).mockResolvedValue("a".repeat(10000) + "\n" + "b\n".repeat(100000))
		const large = await run([{ path: "document.pdf", limit: Number.MAX_SAFE_INTEGER }, { path: "test.ts" }])
		expect(Buffer.byteLength(large)).toBeLessThanOrEqual(MAX_READ_FILES_RESULT_BYTES)
	})

	it("reports every exhausted entry without seeking approvals when context is full", async () => {
		const { double, run } = setup()
		double.getTokenUsage.mockReturnValue({ contextTokens: 127_000 })
		const output = await run([{ path: "source.ts" }, { path: "test.ts" }])
		expect(output.match(/Status: budget_exhausted/g)).toHaveLength(2)
		expect(double.ask).not.toHaveBeenCalled()
		expect(fs.readFile).not.toHaveBeenCalled()
	})

	it.each(["abort", "abandoned"] as const)("prioritizes %s cancellation over an exhausted budget", async (flag) => {
		const { double, run } = setup()
		double[flag] = true
		double.getTokenUsage.mockReturnValue({ contextTokens: 127_000 })
		const output = await run([{ path: "source.ts" }, { path: "test.ts" }])
		expect(output.match(/Status: cancelled/g)).toHaveLength(2)
		expect(output).not.toContain("Status: budget_exhausted")
		expect(double.ask).not.toHaveBeenCalled()
		expect(fs.stat).not.toHaveBeenCalled()
	})

	it("clamps both line limits without changing structural options or caller arguments", async () => {
		const { run, fileReader } = setup()
		const entry: ReadFilesParams["entries"][number] = {
			path: "source.ts",
			mode: "indentation",
			offset: 2,
			limit: 10000,
			indentation: {
				anchor_line: 3,
				max_levels: 2,
				include_header: false,
				include_siblings: true,
				max_lines: 20000,
			},
		}
		const original = structuredClone(entry)
		const readEntry = vi.spyOn(fileReader, "readEntry").mockResolvedValue({
			path: entry.path,
			status: "approved",
			nativeContent: "File: source.ts\n3 | return header",
		})
		await run([entry])
		expect(readEntry).toHaveBeenCalledWith(
			{ ...entry, limit: 2000, indentation: { ...entry.indentation, max_lines: 2000 } },
			expect.anything(),
			{ textOnly: true },
		)
		expect(entry).toEqual(original)
	})

	it("accounts for sibling results awaiting the next model request", async () => {
		const { task, double, run } = setup()
		task.userMessageContent.push({ type: "text", text: "pending output".repeat(10000) })
		const output = await run([{ path: "source.ts" }, { path: "test.ts" }])
		expect(output.match(/Status: budget_exhausted/g)).toHaveLength(2)
		expect(double.ask).not.toHaveBeenCalled()
	})

	it("rejects invalid resumed batch arguments at the executor boundary without reads", async () => {
		const { double, run } = setup()
		const output = await run(Array.from({ length: 11 }, () => ({ path: "source.ts" })))
		expect(output).toContain(`Error: ${READ_FILES_TOOL_NAME} requires`)
		expect(double.recordToolError).toHaveBeenCalledWith(READ_FILES_TOOL_NAME)
		expect(double.ask).not.toHaveBeenCalled()
		expect(fs.stat).not.toHaveBeenCalled()
	})

	it("treats duplicate paths as independent entries with independent approvals/ranges", async () => {
		const { double, run } = setup()
		const output = await run([
			{ path: "test.ts", offset: 1, limit: 1 },
			{ path: "test.ts", offset: 3, limit: 1 },
		])
		expect(output).toContain("1 | first")
		expect(output).toContain("3 | third")
		expect(double.ask).toHaveBeenCalledTimes(2)
	})

	it("compares equivalent known-path single and batch reads without a model/network benchmark", async () => {
		const { task, callbacks, run, fileReader } = setup()
		const entries = [
			{ path: "test.ts", offset: 2, limit: 1 },
			{ path: "source.ts", offset: 2, limit: 3 },
		]
		const start = performance.now()
		for (const entry of entries) await fileReader.execute(entry, task, callbacks)
		const singleMs = performance.now() - start
		const singleResults = callbacks.pushToolResult.mock.calls.map((call) => String(call[0]))
		callbacks.pushToolResult.mockClear()
		const batchStart = performance.now()
		const batch = await run(entries)
		const batchMs = performance.now() - batchStart
		for (const single of singleResults) {
			for (const line of single.split("\n").filter((line) => /^\s*\d+\s*\|/.test(line))) {
				expect(batch).toContain(line.trimStart())
			}
		}
		console.info("Known-path reader comparison (local only)", {
			single: {
				requiredToolRequestTurnsOnSingleCallProvider: entries.length,
				elapsedMs: singleMs,
				outputBytes: singleResults.reduce((n, r) => n + Buffer.byteLength(r), 0),
				repeats: 0,
				errors: 0,
			},
			batch: {
				requiredToolRequestTurnsOnSingleCallProvider: 1,
				elapsedMs: batchMs,
				outputBytes: Buffer.byteLength(batch),
				repeats: 0,
				errors: 0,
			},
		})
	})

	describe("shared single-file and legacy contracts", () => {
		it("preserves approval feedback when an approved read fails", async () => {
			const { task, double } = setup()
			double.ask.mockResolvedValueOnce({ response: "yesButtonClicked", text: "read carefully", images: [] })
			vi.mocked(fs.readFile).mockRejectedValueOnce(new Error("Read failed"))
			const result = await new ReadFileTool().readEntry({ path: "test.ts" }, task)
			expect(result).toMatchObject({
				status: "error",
				feedbackText: "read carefully",
				nativeContent: "File: test.ts\nError: Read failed",
			})
		})

		it("preserves legacy sibling results after an error and a denial", async () => {
			const { task, double, callbacks } = setup()
			double.ask
				.mockResolvedValueOnce({ response: "yesButtonClicked", text: "", images: [] })
				.mockResolvedValueOnce({ response: "noButtonClicked", text: "", images: [] })
				.mockResolvedValueOnce({ response: "yesButtonClicked", text: "", images: [] })
			await new ReadFileTool().execute(
				{ _legacyFormat: true, files: [{ path: "missing.ts" }, { path: "source.ts" }, { path: "test.ts" }] },
				task,
				callbacks,
			)
			expect(callbacks.pushToolResult.mock.calls[0][0]).toMatch(
				/File: missing.ts[\s\S]*Error:[\s\S]*File: source.ts\nStatus: Denied by user[\s\S]*File: test.ts\n1 \| first/,
			)
			expect(double.didToolFailInCurrentTurn).toBe(true)
			expect(double.didRejectTool).toBe(true)
			expect(double.ask).toHaveBeenCalledTimes(3)
		})

		it("preserves overlapping legacy ranges in request order", async () => {
			const { task, callbacks } = setup()
			await new ReadFileTool().execute(
				{
					_legacyFormat: true,
					files: [
						{
							path: "test.ts",
							lineRanges: [
								{ start: 2, end: 50 },
								{ start: 1, end: 2 },
							],
						},
					],
				},
				task,
				callbacks,
			)
			expect(callbacks.pushToolResult).toHaveBeenCalledWith(
				"File: test.ts\n2 | second\n3 | third\n1 | first\n2 | second",
			)
		})
	})
})
