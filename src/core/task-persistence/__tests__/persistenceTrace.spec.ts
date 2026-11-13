import { describe, it, expect, vi, afterEach } from "vitest"

import { setPersistenceTraceSink, tracePersistenceEvent } from "../persistenceTrace"

function parseTraceLine(line: string): Record<string, unknown> {
	return JSON.parse(line.replace("[persistence-trace] ", "")) as Record<string, unknown>
}

describe("persistenceTrace", () => {
	afterEach(() => {
		setPersistenceTraceSink(undefined)
		vi.restoreAllMocks()
	})

	it("emits a JSON line with the timestamp, process ID, stage, and fields to the sink", () => {
		const lines: string[] = []
		setPersistenceTraceSink((line) => lines.push(line))

		tracePersistenceEvent("ui-messages-write-start", { taskId: "task-1", filePath: "/tmp/ui_messages.json" })

		expect(lines).toHaveLength(1)
		const event = parseTraceLine(lines[0])
		expect(event.stage).toBe("ui-messages-write-start")
		expect(event.taskId).toBe("task-1")
		expect(event.pid).toBe(process.pid)
		expect(typeof event.ts).toBe("string")
		expect(event.filePath).toBe("/tmp/ui_messages.json")
	})

	it("marks the marker-check result", () => {
		const lines: string[] = []
		setPersistenceTraceSink((line) => lines.push(line))

		tracePersistenceEvent("ui-messages-marker-check", { taskId: "task-2", result: "match" })

		const event = parseTraceLine(lines[0])
		expect(event.stage).toBe("ui-messages-marker-check")
		expect(event.result).toBe("match")
	})

	it("falls back to the console when no sink is installed", () => {
		const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		tracePersistenceEvent("shutdown")

		expect(consoleSpy).toHaveBeenCalledTimes(1)
		const line = String(consoleSpy.mock.calls[0]?.[0])
		expect(line).toContain("[persistence-trace]")
		expect(parseTraceLine(line).stage).toBe("shutdown")
	})

	it("never lets a failing sink break the caller", () => {
		setPersistenceTraceSink(() => {
			throw new Error("sink failed")
		})

		expect(() => tracePersistenceEvent("ui-messages-marker-check", { result: "match" })).not.toThrow()
	})
})
