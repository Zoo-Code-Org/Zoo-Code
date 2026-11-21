// npx vitest src/core/assistant-message/__tests__/NativeToolCallParser-parallel-subtasks.spec.ts

import { describe, it, expect, vi } from "vitest"

import type { McpToolUse, ToolUse } from "../../../shared/tools"
import { MAX_REQUESTED_PARALLEL_SUBTASKS, NativeToolCallParser } from "../NativeToolCallParser"

const parseComplete = (args: unknown) =>
	NativeToolCallParser.parseToolCall({
		id: "call_parallel",
		name: "parallel_subtasks",
		arguments: JSON.stringify(args),
	})

/** Narrow the parser union to the native tool branch these tests exercise. */
function asToolUse(result: ToolUse<"parallel_subtasks"> | McpToolUse | null): ToolUse<"parallel_subtasks"> {
	if (!result || result.type !== "tool_use") {
		throw new Error("expected a parallel_subtasks tool_use result")
	}
	return result
}

function parsePartial(argumentsJson: string): ToolUse<"parallel_subtasks"> | null {
	const scope = NativeToolCallParser.createScope()
	NativeToolCallParser.startStreamingToolCall("call_parallel_partial", "parallel_subtasks", scope)
	const key = NativeToolCallParser.makeStreamingKey("call_parallel_partial", "parallel_subtasks")
	// The streaming parser types the name as the full union; this call started a
	// parallel_subtasks tool call, so narrow at the seam.
	return NativeToolCallParser.processStreamingChunk(key, argumentsJson, scope) as ToolUse<"parallel_subtasks"> | null
}

describe("NativeToolCallParser - parallel_subtasks", () => {
	describe("complete calls", () => {
		it("keeps mode, message and label", () => {
			const result = parseComplete({
				tasks: [
					{ label: "api-surface", mode: "code", message: "Map the task API." },
					{ label: "test-gaps", mode: "debug", message: "Find untested branches." },
				],
			})

			expect(result?.type).toBe("tool_use")
			expect(asToolUse(result).nativeArgs).toEqual({
				tasks: [
					{ label: "api-surface", mode: "code", message: "Map the task API." },
					{ label: "test-gaps", mode: "debug", message: "Find untested branches." },
				],
			})
		})

		it("treats a null label as absent", () => {
			const result = parseComplete({
				tasks: [{ label: null, mode: "code", message: "Map the task API." }],
			})

			expect(asToolUse(result).nativeArgs).toEqual({
				tasks: [{ mode: "code", message: "Map the task API." }],
			})
		})

		it("drops entries that lack a string mode or message", () => {
			const result = parseComplete({
				tasks: [
					{ label: "no-message", mode: "code" },
					{ label: "no-mode", message: "Investigate." },
					{ label: "numeric-mode", mode: 7, message: "Investigate." },
					{ label: "valid", mode: "debug", message: "Investigate." },
				],
			})

			expect(asToolUse(result).nativeArgs).toEqual({
				tasks: [{ label: "valid", mode: "debug", message: "Investigate." }],
			})
		})

		it("preserves more than six entries because the cap is enforced at spawn time", () => {
			const tasks = Array.from({ length: 7 }, (_, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))

			const result = parseComplete({ tasks })

			expect(asToolUse(result).nativeArgs).toEqual({ tasks })
		})

		it("preserves a list exactly at the requested-entry ceiling", () => {
			const tasks = Array.from({ length: MAX_REQUESTED_PARALLEL_SUBTASKS }, (_, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))

			expect(asToolUse(parseComplete({ tasks })).nativeArgs).toEqual({ tasks })
		})

		it("stops one past the ceiling so the tool can reject an oversized call", () => {
			const tasks = Array.from({ length: MAX_REQUESTED_PARALLEL_SUBTASKS + 150 }, (_, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))

			const bounded = asToolUse(parseComplete({ tasks })).nativeArgs?.tasks ?? []

			expect(bounded).toHaveLength(MAX_REQUESTED_PARALLEL_SUBTASKS + 1)
			expect(bounded[0]).toEqual(tasks[0])
			expect(bounded.at(-1)).toEqual(tasks[MAX_REQUESTED_PARALLEL_SUBTASKS])
		})

		it.each([
			["a missing task list", {}],
			["an empty task list", { tasks: [] }],
			["a task list with no qualifying entry", { tasks: [{ label: "broken" }] }],
			["a non-array task list", { tasks: "not-an-array" }],
		])("rejects %s as an invalid tool call", (_case, args) => {
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
			try {
				expect(parseComplete(args)).toBeNull()
			} finally {
				errorSpy.mockRestore()
			}
		})
	})

	describe("partial calls", () => {
		it("uses a streamed task array directly", () => {
			const partial = parsePartial('{"tasks":[{"label":"api","mode":"code","message":"Map it."}]}')

			expect(partial?.name).toBe("parallel_subtasks")
			expect(partial?.partial).toBe(true)
			expect(partial?.nativeArgs).toEqual({
				tasks: [{ label: "api", mode: "code", message: "Map it." }],
			})
		})

		it("parses a JSON-stringified task array", () => {
			const tasks = JSON.stringify([{ label: "api", mode: "code", message: "Map it." }])
			const partial = parsePartial(JSON.stringify({ tasks }))

			expect(partial?.nativeArgs).toEqual({
				tasks: [{ label: "api", mode: "code", message: "Map it." }],
			})
		})

		it("only surfaces entries that are already complete", () => {
			const partial = parsePartial(
				'{"tasks":[{"label":"api","mode":"code","message":"Map it."},{"label":"next"}]}',
			)

			expect(partial?.nativeArgs).toEqual({
				tasks: [{ label: "api", mode: "code", message: "Map it." }],
			})
		})

		it("leaves nativeArgs undefined until a task arrives", () => {
			expect(parsePartial('{"note":"filling in"}')?.nativeArgs).toBeUndefined()
			expect(parsePartial('{"tasks":[]}')?.nativeArgs).toBeUndefined()
		})

		it("bounds a streamed oversized array the same way as a complete call", () => {
			const tasks = Array.from({ length: MAX_REQUESTED_PARALLEL_SUBTASKS + 150 }, (_, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))

			const partial = parsePartial(JSON.stringify({ tasks }))

			expect(partial?.nativeArgs?.tasks).toHaveLength(MAX_REQUESTED_PARALLEL_SUBTASKS + 1)
		})
	})
})
