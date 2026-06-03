/**
 * Tests for CRT ResolveRef Orchestrator — src/core/tools/ref/index.ts
 *
 * Covers:
 * - resolveRef: single ref dispatch, multi_ref, transform pipeline,
 *   confidence calculation, error handling
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import * as fs from "fs"
import * as path from "path"

// ---------------------------------------------------------------------------
// Mock fs module
// ---------------------------------------------------------------------------
vi.mock("fs", async (importActual) => {
	const actual = await importActual<any>()
	return {
		...actual,
		appendFileSync: vi.fn(),
	}
})

// ---------------------------------------------------------------------------
// Mock all source resolvers
// ---------------------------------------------------------------------------
vi.mock("../sources/chat", () => ({
	resolveChatSource: vi.fn(),
}))

vi.mock("../sources/file", () => ({
	resolveFileSource: vi.fn(),
}))

vi.mock("../sources/terminal", () => ({
	resolveTerminalSource: vi.fn(),
}))

vi.mock("../sources/tool", () => ({
	resolveToolSource: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Mock transform module
// ---------------------------------------------------------------------------
vi.mock("../transform", () => ({
	applyMultiTransform: vi.fn((contents: string[]) => ({ contents })),
}))

// ---------------------------------------------------------------------------
// Mock superDebug — default logCrt returns silently (no-op)
// ---------------------------------------------------------------------------
vi.mock("../superDebug", () => ({
	logCrt: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	callCrt: vi.fn(),
	successCrt: vi.fn(),
	executeCrt: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------
import { resolveChatSource } from "../sources/chat"
import { resolveFileSource } from "../sources/file"
import { resolveTerminalSource } from "../sources/terminal"
import { resolveToolSource } from "../sources/tool"
import { applyMultiTransform } from "../transform"
import { logCrt } from "../superDebug"
import { resolveRef, resolveInlineRefs, resolveInlineRefsInObject, logCrtDebug } from "../index"
import type { ContentRefParams, ContentRef } from "../../../../shared/tools"
import type { SelectorResult } from "../selector"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockTask(overrides: Partial<any> = {}): any {
	return {
		taskId: "test-task-001",
		cwd: "/workspace/project",
		providerRef: {
			deref: () => ({
				context: {
					globalStorageUri: {
						fsPath: "/tmp/global-storage",
					},
				},
			}),
		},
		assistantMessageContent: [],
		userMessageContent: [],
		...overrides,
	}
}

function makeSelectorResult(overrides: Partial<SelectorResult> = {}): SelectorResult {
	return {
		sourceId: "test-source",
		content: "test content",
		startOffset: 0,
		endOffset: 12,
		confidence: 1.0,
		method: "exact",
		...overrides,
	}
}

function makeRef(source: "chat" | "file" | "terminal" | "tool", ref: string): ContentRef {
	return { source, ref }
}

// ===========================================================================
// resolveRef — Orchestrator
// ===========================================================================

describe("resolveRef", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Default: applyMultiTransform returns contents as-is
		vi.mocked(applyMultiTransform).mockImplementation((contents: string[]) => ({ contents }))
	})

	describe("single ref dispatch", () => {
		it("dispatches to resolveChatSource for source=chat", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "chat content" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
			}

			const result = await resolveRef(refMeta, task)

			expect(resolveChatSource).toHaveBeenCalledWith(makeRef("chat", "-1"), task)
			expect(result.content).toBe("chat content")
			expect(result.resolved).toHaveLength(1)
		})

		it("dispatches to resolveFileSource for source=file", async () => {
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file:///path", content: "file content" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("file", "src/index.ts"),
			}

			const result = await resolveRef(refMeta, task)

			expect(resolveFileSource).toHaveBeenCalledWith(makeRef("file", "src/index.ts"), task)
			expect(result.content).toBe("file content")
		})

		it("dispatches to resolveTerminalSource for source=terminal", async () => {
			vi.mocked(resolveTerminalSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "terminal://cmd.txt", content: "terminal output" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("terminal", "cmd-abc.txt"),
			}

			const result = await resolveRef(refMeta, task)

			expect(resolveTerminalSource).toHaveBeenCalledWith(makeRef("terminal", "cmd-abc.txt"), task)
			expect(result.content).toBe("terminal output")
		})

		it("dispatches to resolveToolSource for source=tool", async () => {
			vi.mocked(resolveToolSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "tool:read_file:id1", content: "tool result" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("tool", "read_file"),
			}

			const result = await resolveRef(refMeta, task)

			expect(resolveToolSource).toHaveBeenCalledWith(makeRef("tool", "read_file"), task)
			expect(result.content).toBe("tool result")
		})
	})

	describe("multi_ref resolution", () => {
		it("resolves all refs in multi_ref", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "chat msg" }),
			)
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file:///path", content: "file content" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "src/index.ts")],
			}

			const result = await resolveRef(refMeta, task)

			expect(resolveChatSource).toHaveBeenCalledTimes(1)
			expect(resolveFileSource).toHaveBeenCalledTimes(1)
			expect(result.resolved).toHaveLength(2)
			expect(result.content).toBe("chat msg") // first fragment
		})

		it("resolves mixed source types in multi_ref", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(makeSelectorResult({ sourceId: "chat:-1", content: "chat" }))
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file://path", content: "file" }),
			)
			vi.mocked(resolveTerminalSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "terminal://cmd", content: "term" }),
			)
			vi.mocked(resolveToolSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "tool:x:id", content: "tool" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [
					makeRef("chat", "-1"),
					makeRef("file", "a.ts"),
					makeRef("terminal", "cmd.txt"),
					makeRef("tool", "read_file"),
				],
			}

			const result = await resolveRef(refMeta, task)

			expect(result.resolved).toHaveLength(4)
			expect(resolveChatSource).toHaveBeenCalled()
			expect(resolveFileSource).toHaveBeenCalled()
			expect(resolveTerminalSource).toHaveBeenCalled()
			expect(resolveToolSource).toHaveBeenCalled()
		})
	})

	describe("transform pipeline", () => {
		it("applies transform to resolved contents", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "hello world" }),
			)
			vi.mocked(applyMultiTransform).mockReturnValue({
				contents: ["HELLO WORLD"],
			})

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
				transform: {
					replace: { from: "hello", to: "HELLO" },
				},
			}

			const result = await resolveRef(refMeta, task)

			expect(applyMultiTransform).toHaveBeenCalledWith(["hello world"], refMeta.transform)
			expect(result.content).toBe("HELLO WORLD")
		})

		it("applies join_with transform for multi_ref", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "first" }),
			)
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file://path", content: "second" }),
			)
			vi.mocked(applyMultiTransform).mockReturnValue({
				contents: ["first", "second"],
				joined: "first\n---\nsecond",
			})

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "a.ts")],
				transform: {
					join_with: "\n---\n",
				},
			}

			const result = await resolveRef(refMeta, task)

			expect(result.joined).toBe("first\n---\nsecond")
			expect(result.content).toBe("first\n---\nsecond") // joined takes priority
		})

		it("passes undefined transform when none specified", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(makeSelectorResult({ sourceId: "chat:-1", content: "raw" }))

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
			}

			await resolveRef(refMeta, task)

			expect(applyMultiTransform).toHaveBeenCalledWith(["raw"], undefined)
		})
	})

	describe("confidence calculation", () => {
		it("returns 1.0 when all fragments have confidence 1.0", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(makeSelectorResult({ confidence: 1.0 }))

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
			}

			const result = await resolveRef(refMeta, task)

			expect(result.confidence).toBe(1.0)
		})

		it("returns the minimum confidence across all resolved fragments", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(makeSelectorResult({ confidence: 0.9 }))
			vi.mocked(resolveFileSource).mockResolvedValue(makeSelectorResult({ confidence: 0.7 }))

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "a.ts")],
			}

			const result = await resolveRef(refMeta, task)

			expect(result.confidence).toBe(0.7)
		})

		it("returns the minimum confidence even when one is 1.0", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(makeSelectorResult({ confidence: 1.0 }))
			vi.mocked(resolveFileSource).mockResolvedValue(makeSelectorResult({ confidence: 0.95 }))
			vi.mocked(resolveToolSource).mockResolvedValue(makeSelectorResult({ confidence: 0.8 }))

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "a.ts"), makeRef("tool", "read_file")],
			}

			const result = await resolveRef(refMeta, task)

			expect(result.confidence).toBe(0.8)
		})
	})

	describe("error cases", () => {
		it("throws when neither ref nor multi_ref is specified", async () => {
			const task = createMockTask()
			const refMeta: ContentRefParams = {}

			await expect(resolveRef(refMeta, task)).rejects.toThrow("No ref or multi_ref specified in refMeta.")
		})

		it("throws when multi_ref is an empty array", async () => {
			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [],
			}

			await expect(resolveRef(refMeta, task)).rejects.toThrow("No ref or multi_ref specified in refMeta.")
		})

		it("throws on unknown source type", async () => {
			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: { source: "unknown" as any, ref: "test" },
			}

			await expect(resolveRef(refMeta, task)).rejects.toThrow("Unknown content source: unknown")
		})

		it("propagates errors from source resolvers", async () => {
			vi.mocked(resolveChatSource).mockRejectedValue(new Error("Chat message index -5 out of bounds"))

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-5"),
			}

			await expect(resolveRef(refMeta, task)).rejects.toThrow("Chat message index -5 out of bounds")
		})
	})

	describe("result structure", () => {
		it("returns correct result structure for single ref", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({
					sourceId: "chat:-1",
					content: "hello",
					startOffset: 0,
					endOffset: 5,
					confidence: 1.0,
					method: "exact",
				}),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
			}

			const result = await resolveRef(refMeta, task)

			expect(result).toEqual({
				content: "hello",
				joined: undefined,
				resolved: [
					{
						sourceId: "chat:-1",
						content: "hello",
						startOffset: 0,
						endOffset: 5,
						confidence: 1.0,
						method: "exact",
					},
				],
				confidence: 1.0,
			})
		})

		it("returns correct result structure for multi_ref with join", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "a", confidence: 1.0 }),
			)
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file://path", content: "b", confidence: 0.9 }),
			)
			vi.mocked(applyMultiTransform).mockReturnValue({
				contents: ["a", "b"],
				joined: "a | b",
			})

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "a.ts")],
				transform: { join_with: " | " },
			}

			const result = await resolveRef(refMeta, task)

			expect(result.content).toBe("a | b")
			expect(result.joined).toBe("a | b")
			expect(result.resolved).toHaveLength(2)
			expect(result.confidence).toBe(0.9)
		})
	})

	describe("resolveInlineRefs", () => {
		it("returns text unchanged if no markers are present", async () => {
			const task = createMockTask()
			const result = await resolveInlineRefs("hello world", task)
			expect(result).toBe("hello world")
		})

		it("resolves single inline ref marker", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "resolved-content", confidence: 1.0 }),
			)
			const task = createMockTask()
			const result = await resolveInlineRefs("text {{ref:source=chat,ref=-1}} end", task)
			expect(result).toBe("text resolved-content end")
		})

		it("resolves multiple inline ref markers", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "content-1", confidence: 1.0 }),
			)
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file://a.ts", content: "content-2", confidence: 1.0 }),
			)
			const task = createMockTask()
			const result = await resolveInlineRefs(
				"start {{ref:source=chat,ref=-1}} mid {{ref:source=file,ref=a.ts}} end",
				task,
			)
			expect(result).toBe("start content-1 mid content-2 end")
		})
	})

	describe("resolveInlineRefsInObject", () => {
		it("resolves markers inside nested objects and arrays", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "resolved", confidence: 1.0 }),
			)
			const task = createMockTask()
			const obj = {
				stringProp: "normal",
				refProp: "has {{ref:source=chat,ref=-1}} marker",
				nested: {
					arrayProp: ["item1", "item {{ref:source=chat,ref=-1}} 2"],
				},
			}

			const result = await resolveInlineRefsInObject(obj, task)

			expect(result.stringProp).toBe("normal")
			expect(result.refProp).toBe("has resolved marker")
			expect(result.nested.arrayProp[0]).toBe("item1")
			expect(result.nested.arrayProp[1]).toBe("item resolved 2")
		})
	})

	describe("logCrtDebug", () => {
		it("writes diagnostic logs to crt-debug.log in task.cwd", () => {
			// logCrtDebug first calls logCrt() from superDebug. Since superDebug is mocked
			// by vi.mock("../superDebug") above, its logCrt throws by default (mock
			// fn returns undefined — logCrt called without await is not a function error).
			// We force the fallback path by making logCrt throw.
			vi.mocked(logCrt).mockImplementationOnce(() => {
				throw new Error("[mock] superDebug logCrt unavailable")
			})

			const appendFileSpy = vi.mocked(fs.appendFileSync)
			const task = createMockTask({ cwd: "/workspace/project" })

			logCrtDebug(task, "test debug message")

			expect(appendFileSpy).toHaveBeenCalled()
			const [logPath, logMessage] = appendFileSpy.mock.calls[appendFileSpy.mock.calls.length - 1] as [
				string,
				string,
			]
			expect(logPath).toBe(path.join("/workspace/project", "crt-debug.log"))
			expect(logMessage).toContain("test debug message")
			expect(logMessage).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] test debug message\n$/)
		})
	})

	// ===========================================================================
	// Graceful fallback — partial failure in multi_ref
	// ===========================================================================

	describe("graceful fallback — partial failure in multi_ref", () => {
		it("succeeds when some refs fail but at least one resolves", async () => {
			vi.mocked(resolveChatSource).mockRejectedValue(new Error("chat error"))
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file://a.ts", content: "file content" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "a.ts")],
			}

			const result = await resolveRef(refMeta, task)

			expect(result.content).toBe("file content")
			expect(result.resolved).toHaveLength(1)
		})

		it("throws when all refs fail", async () => {
			vi.mocked(resolveChatSource).mockRejectedValue(new Error("chat error"))
			vi.mocked(resolveFileSource).mockRejectedValue(new Error("file error"))

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "a.ts")],
			}

			await expect(resolveRef(refMeta, task)).rejects.toThrow("All 2 ref(s) failed to resolve")
		})

		it("partial failure: returns results from successful refs and skips failed", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "chat content" }),
			)
			vi.mocked(resolveFileSource).mockRejectedValue(new Error("file not found"))
			vi.mocked(resolveToolSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "tool:read_file", content: "tool result" }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				multi_ref: [makeRef("chat", "-1"), makeRef("file", "missing.ts"), makeRef("tool", "read_file")],
			}

			const result = await resolveRef(refMeta, task)

			expect(result.resolved).toHaveLength(2)
			expect(result.content).toBe("chat content") // first fragment
		})
	})

	// ===========================================================================
	// Simultaneous ref + multi_ref
	// ===========================================================================

	describe("resolveRef \u2014 simultaneous ref + multi_ref", () => {
		beforeEach(() => {
			vi.clearAllMocks()
			vi.mocked(applyMultiTransform).mockImplementation((contents: string[]) => ({ contents }))
		})

		it("resolves both ref and multi_ref together", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "from single ref", confidence: 1.0 }),
			)
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file://a.ts", content: "from multi_ref", confidence: 1.0 }),
			)

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
				multi_ref: [makeRef("file", "a.ts")],
			}

			const result = await resolveRef(refMeta, task)

			expect(result.resolved).toHaveLength(2)
			expect(result.content).toBe("from single ref") // first fragment (ref)
			expect(resolveChatSource).toHaveBeenCalledTimes(1)
			expect(resolveFileSource).toHaveBeenCalledTimes(1)
		})

		it("applies join_with to combined ref + multi_ref results", async () => {
			vi.mocked(resolveChatSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "chat:-1", content: "first", confidence: 1.0 }),
			)
			vi.mocked(resolveFileSource).mockResolvedValue(
				makeSelectorResult({ sourceId: "file://a.ts", content: "second", confidence: 1.0 }),
			)
			vi.mocked(applyMultiTransform).mockReturnValue({
				contents: ["first", "second"],
				joined: "first ||| second",
			})

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
				multi_ref: [makeRef("file", "a.ts")],
				transform: { join_with: " ||| " },
			}

			const result = await resolveRef(refMeta, task)

			expect(result.content).toBe("first ||| second")
			expect(result.resolved).toHaveLength(2)
		})

		it("throws when both ref and all multi_ref fail", async () => {
			vi.mocked(resolveChatSource).mockRejectedValue(new Error("chat error"))
			vi.mocked(resolveFileSource).mockRejectedValue(new Error("file error"))

			const task = createMockTask()
			const refMeta: ContentRefParams = {
				ref: makeRef("chat", "-1"),
				multi_ref: [makeRef("file", "a.ts")],
			}

			await expect(resolveRef(refMeta, task)).rejects.toThrow("All 2 ref(s) failed to resolve")
		})
	})
})
