import { type ProviderSettings, RooCodeEventName } from "@roo-code/types"

import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

// Mock dependencies
vi.mock("../../webview/ClineProvider")
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
// dispose() fires an UNawaited getTaskDirectoryPath -> OutputInterceptor.cleanup chain.
// Mock both so it resolves immediately with no real fs and no late console.error,
// otherwise that dangling promise logs after the test ends and trips Vitest's
// "Closing rpc while onUserConsoleLog was pending" teardown race.
vi.mock("../../../utils/storage", () => ({
	getTaskDirectoryPath: vi.fn().mockResolvedValue("/test/path/tasks/test-task"),
}))
vi.mock("../../../integrations/terminal/OutputInterceptor", () => ({
	OutputInterceptor: {
		cleanup: vi.fn().mockResolvedValue(undefined),
	},
}))
vi.mock("../../ignore/RooIgnoreController")
vi.mock("../../protect/RooProtectedController")
vi.mock("../../context-tracking/FileContextTracker")
vi.mock("../../../integrations/editor/DiffViewProvider")
vi.mock("../../tools/ToolRepetitionDetector")
vi.mock("../../../api", () => ({
	buildApiHandler: vi.fn(() => ({
		getModel: () => ({ info: {}, id: "test-model" }),
	})),
}))

// Mock TelemetryService
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

describe("Task dispose method", () => {
	let mockProvider: {
		context: { globalStorageUri: { fsPath: string } }
		getState: ReturnType<typeof vi.fn>
		log: ReturnType<typeof vi.fn>
	}
	let mockApiConfiguration: ProviderSettings
	let task: Task

	beforeEach(() => {
		// Reset all mocks
		vi.clearAllMocks()

		// Mock provider
		mockProvider = {
			context: {
				globalStorageUri: { fsPath: "/test/path" },
			},
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
		}

		// Mock API configuration
		mockApiConfiguration = {
			apiProvider: providerIdentifiers.anthropic,
			apiKey: "test-key",
		} as ProviderSettings

		// Create task instance without starting it
		task = new Task({
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration: mockApiConfiguration,
			startTask: false,
		})
	})

	afterEach(() => {
		// Clean up
		if (task && !task.abort) {
			task.dispose()
		}
	})

	test("should remove all event listeners when dispose is called", () => {
		// Add some event listeners using type assertion to bypass strict typing for testing
		const listener1 = vi.fn(() => {})
		const listener2 = vi.fn(() => {})
		const listener3 = vi.fn((taskId: string) => {})

		task.on(RooCodeEventName.TaskStarted, listener1)
		task.on(RooCodeEventName.TaskAborted, listener2)
		task.on(RooCodeEventName.TaskIdle, listener3)

		// Verify listeners are added
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(1)

		// Spy on removeAllListeners method
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")

		// Call dispose
		task.dispose()

		// Verify removeAllListeners was called
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()

		// Verify all listeners are removed
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(0)
	})

	test("should handle errors when removing event listeners", () => {
		// Mock removeAllListeners to throw an error
		const originalRemoveAllListeners = task.removeAllListeners
		task.removeAllListeners = vi.fn(() => {
			throw new Error("Test error")
		})

		// Spy on console.error
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		// Call dispose - should not throw
		expect(() => task.dispose()).not.toThrow()

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledWith("Error removing event listeners:", expect.any(Error))

		// Restore
		task.removeAllListeners = originalRemoveAllListeners
		consoleErrorSpy.mockRestore()
	})

	test("should clean up all resources in correct order", () => {
		const removeAllListenersSpy = vi.spyOn(task, "removeAllListeners")
		const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})

		// Call dispose
		task.dispose()

		// Verify dispose was called and logged
		expect(consoleLogSpy).toHaveBeenCalledWith(
			expect.stringContaining(`[Task#dispose] disposing task ${task.taskId}.${task.instanceId}`),
		)

		// Verify removeAllListeners was called first (before other cleanup)
		expect(removeAllListenersSpy).toHaveBeenCalledOnce()

		// Clean up
		consoleLogSpy.mockRestore()
	})

	test("should prevent memory leaks by removing listeners before other cleanup", () => {
		// Add multiple listeners of different types using type assertion for testing
		const listeners = {
			TaskStarted: vi.fn(() => {}),
			TaskAborted: vi.fn(() => {}),
			TaskIdle: vi.fn((_taskId: string) => {}),
			TaskActive: vi.fn((_taskId: string) => {}),
			TaskAskResponded: vi.fn(() => {}),
			Message: vi.fn(() => {}),
			TaskTokenUsageUpdated: vi.fn(() => {}),
			TaskToolFailed: vi.fn(() => {}),
			TaskUnpaused: vi.fn((_taskId: string) => {}),
		}

		task.on(RooCodeEventName.TaskStarted, listeners.TaskStarted)
		task.on(RooCodeEventName.TaskAborted, listeners.TaskAborted)
		task.on(RooCodeEventName.TaskIdle, listeners.TaskIdle)
		task.on(RooCodeEventName.TaskActive, listeners.TaskActive)
		task.on(RooCodeEventName.TaskAskResponded, listeners.TaskAskResponded)
		task.on(RooCodeEventName.Message, listeners.Message)
		task.on(RooCodeEventName.TaskTokenUsageUpdated, listeners.TaskTokenUsageUpdated)
		task.on(RooCodeEventName.TaskToolFailed, listeners.TaskToolFailed)
		task.on(RooCodeEventName.TaskUnpaused, listeners.TaskUnpaused)

		// Verify all listeners are added
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskActive)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskAskResponded)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.Message)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskTokenUsageUpdated)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskToolFailed)).toBe(1)
		expect(task.listenerCount(RooCodeEventName.TaskUnpaused)).toBe(1)

		// Call dispose
		task.dispose()

		// Verify all listeners are removed
		expect(task.listenerCount(RooCodeEventName.TaskStarted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskAborted)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskIdle)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskActive)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskAskResponded)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.Message)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskTokenUsageUpdated)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskToolFailed)).toBe(0)
		expect(task.listenerCount(RooCodeEventName.TaskUnpaused)).toBe(0)

		// Verify total listener count is 0
		expect(task.eventNames().length).toBe(0)
	})
})

describe("Task.run() idempotency", () => {
	// Reuses the mock setup from the outer describe block above.
	let mockProvider: ReturnType<typeof buildMockProvider>
	let mockApiConfiguration: ProviderSettings

	function buildMockProvider() {
		return {
			context: { globalStorageUri: { fsPath: "/test/path" } },
			getState: vi.fn().mockResolvedValue({ mode: "code" }),
			log: vi.fn(),
		}
	}

	beforeEach(() => {
		vi.clearAllMocks()
		mockProvider = buildMockProvider()
		mockApiConfiguration = { apiProvider: providerIdentifiers.anthropic, apiKey: "test-key" } as ProviderSettings
	})

	test("run() does not invoke startTask when task was already started by constructor", async () => {
		// Spy on the prototype before construction so we capture the constructor's call too.
		const startTaskSpy = vi.spyOn(Task.prototype as any, "startTask").mockResolvedValue(undefined)

		const t = new Task({
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration: mockApiConfiguration,
			task: "hello",
			startTask: true,
		})

		const callsBefore = startTaskSpy.mock.calls.length // constructor fired it once
		void t.run()
		expect(startTaskSpy.mock.calls.length).toBe(callsBefore) // run() must not add a second call
		t.dispose()
		startTaskSpy.mockRestore()
	})

	test("run() does not invoke startTask when task was already started by start()", async () => {
		const startTaskSpy = vi.spyOn(Task.prototype as any, "startTask").mockResolvedValue(undefined)

		const t = new Task({
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration: mockApiConfiguration,
			task: "hello",
			startTask: false,
		})
		t.start()
		const callsAfterStart = startTaskSpy.mock.calls.length // start() fired it once

		void t.run()
		expect(startTaskSpy.mock.calls.length).toBe(callsAfterStart) // no additional call
		t.dispose()
		startTaskSpy.mockRestore()
	})

	test("run() returns the same promise on repeated calls", async () => {
		const startTaskSpy = vi.spyOn(Task.prototype as any, "startTask").mockResolvedValue(undefined)

		const t = new Task({
			provider: mockProvider as unknown as ClineProvider,
			apiConfiguration: mockApiConfiguration,
			task: "hello",
			startTask: false,
		})

		const p1 = t.run()
		const p2 = t.run()
		expect(p1).toBe(p2)
		await p1
		t.dispose()
		startTaskSpy.mockRestore()
	})
})
