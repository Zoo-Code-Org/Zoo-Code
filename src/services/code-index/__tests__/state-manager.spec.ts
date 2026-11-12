import { CodeIndexStateManager } from "../state-manager"
import { codeIndexLog } from "../code-index-log"
import { clearAllMocks } from "../../../test-utils/reset"

vi.mock("../code-index-log", () => ({ codeIndexLog: { info: vi.fn() } }))
vi.mock("vscode", () => ({
	EventEmitter: class {
		event = vi.fn()
		// Prototype methods give each vi.spyOn a fresh spy instead of an instance mock with earlier calls.
		fire(): void {}
		dispose(): void {}
	},
}))

beforeEach(() => clearAllMocks())

describe("CodeIndexStateManager", () => {
	it("logs changed state and messages with diagnostic context only", () => {
		const state = new CodeIndexStateManager()
		state.setDiagnosticContext({ source: "manager", attempt: 12 })
		state.setSystemState("Indexing", "Starting", "start-request")
		expect(codeIndexLog.info).toHaveBeenLastCalledWith("State transition", {
			oldState: "Standby",
			newState: "Indexing",
			message: "Starting",
			source: "start-request",
			attempt: 12,
		})
		state.setSystemState("Indexing", "Starting")
		expect(codeIndexLog.info).toHaveBeenCalledOnce()
		state.setSystemState("Standby")
		expect(codeIndexLog.info).toHaveBeenLastCalledWith("State transition", {
			oldState: "Indexing",
			newState: "Standby",
			message: "Ready.",
			source: "manager",
			attempt: 12,
		})
		expect(state.getCurrentStatus()).not.toHaveProperty("attempt")
	})

	it.each(["blocks", "files"] as const)("logs entry but not each %s progress update", (unit) => {
		const state = new CodeIndexStateManager()
		state.setDiagnosticContext({ source: "manager", attempt: "attempt-2" })
		const progress = (processed: number) => {
			if (unit === "blocks") state.reportBlockIndexingProgress(processed, 3, "scan")
			else state.reportFileQueueProgress(processed, 3, "file.ts", "scan")
		}
		progress(1)
		progress(2)
		expect(state.getCurrentStatus()).toMatchObject({
			systemStatus: "Indexing",
			processedItems: 2,
			totalItems: 3,
			currentItemUnit: unit,
		})
		expect(codeIndexLog.info).toHaveBeenCalledExactlyOnceWith(
			"State transition",
			expect.objectContaining({
				oldState: "Standby",
				newState: "Indexing",
				source: "scan",
				attempt: "attempt-2",
			}),
		)
		state.setSystemState("Standby")
		expect(codeIndexLog.info).toHaveBeenLastCalledWith(
			"State transition",
			expect.objectContaining({ source: "manager", attempt: "attempt-2" }),
		)
	})

	it.each([
		["Error", "blocks"],
		["Error", "files"],
		["Stopping", "blocks"],
		["Stopping", "files"],
	] as const)("does not let %s be overwritten by %s progress", (systemStatus, unit) => {
		const state = new CodeIndexStateManager()
		state.reportBlockIndexingProgress(1, 3)
		state.setSystemState(systemStatus, "Preserved message")
		const before = state.getCurrentStatus()
		const fire = vi.spyOn(state["_progressEmitter"], "fire")
		vi.mocked(codeIndexLog.info).mockClear()
		if (unit === "blocks") state.reportBlockIndexingProgress(3, 10)
		else state.reportFileQueueProgress(3, 10, "late.ts")
		expect(state.getCurrentStatus()).toEqual(before)
		expect(fire).not.toHaveBeenCalled()
		expect(codeIndexLog.info).not.toHaveBeenCalled()
	})

	it.each(["Error", "Stopping"] as const)("allows an explicit restart from %s", (systemStatus) => {
		const state = new CodeIndexStateManager()
		state.setSystemState(systemStatus, "Previous attempt")
		state.setSystemState("Indexing", "New attempt")
		state.reportBlockIndexingProgress(1, 2)
		expect(state.getCurrentStatus()).toMatchObject({ systemStatus: "Indexing", processedItems: 1, totalItems: 2 })
	})

	it("does not emit duplicate progress and resets counters on completion", () => {
		const state = new CodeIndexStateManager()
		state.reportBlockIndexingProgress(1, 2)
		const fire = vi.spyOn(state["_progressEmitter"], "fire")
		state.reportBlockIndexingProgress(1, 2)
		expect(fire).not.toHaveBeenCalled()
		state.setSystemState("Indexed")
		expect(state.getCurrentStatus()).toMatchObject({
			systemStatus: "Indexed",
			message: "Index up-to-date.",
			processedItems: 0,
			totalItems: 0,
		})
	})
})
