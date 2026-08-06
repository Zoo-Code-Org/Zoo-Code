// npx vitest run src/integrations/terminal/__tests__/CommandTrace.spec.ts

import { afterEach, describe, expect, it, vi } from "vitest"

import {
	CommandTraceBuilder,
	CommandTraceCollector,
	emitCommandTrace,
	type CommandTrace,
	type CommandTraceBuilderOptions,
	type CommandTraceListener,
} from "../CommandTrace"
import type { RooTerminalProvider } from "../types"

function makeOptions(overrides: Partial<CommandTraceBuilderOptions> = {}) {
	return {
		executionId: "exec-1",
		taskId: "task-1",
		commandLength: 42,
		commandCountInChain: 2,
		...overrides,
	}
}

describe("CommandTraceBuilder", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("initializes default sentinel values in the constructor", () => {
		const builder = new CommandTraceBuilder(makeOptions())
		const trace = builder.build()

		expect(trace.executionId).toBe("exec-1")
		expect(trace.taskId).toBe("task-1")
		expect(trace.commandLength).toBe(42)
		expect(trace.commandCountInChain).toBe(2)
		expect(trace.concurrentCommandCount).toBe(0)
		expect(trace.concurrentTerminalCreationCount).toBe(0)
		expect(trace.queueDepth).toBe(0)
		expect(trace.queueWaitMs).toBe(0)
	})

	it("build() applies safe defaults for unset optional fields", () => {
		const trace = new CommandTraceBuilder(makeOptions()).build()

		expect(trace.toolCallGeneratedAt).toBe(0)
		expect(trace.queueEnteredAt).toBe(0)
		expect(trace.queueReleasedAt).toBe(0)
		expect(trace.terminalRequestedAt).toBe(0)
		expect(trace.terminalCreatedAt).toBe(0)
		expect(trace.commandSubmittedAt).toBe(0)
		expect(trace.shellIntegrationInitiallyAvailable).toBe(false)
		expect(trace.provider).toBe("vscode")
		expect(trace.terminalReused).toBe(false)
		expect(trace.commandCountInChain).toBe(2)
		// Optional fields stay undefined
		expect(trace.modelId).toBeUndefined()
		expect(trace.processIdResolvedAt).toBeUndefined()
		expect(trace.shellIntegrationActivatedAt).toBeUndefined()
		expect(trace.shellIntegrationTimeoutAt).toBeUndefined()
		expect(trace.shellExecutionStartedAt).toBeUndefined()
		expect(trace.firstOutputAt).toBeUndefined()
		expect(trace.shellExecutionEndedAt).toBeUndefined()
		expect(trace.priorTerminalState).toBeUndefined()
		expect(trace.exitCode).toBeUndefined()
		expect(trace.errorType).toBeUndefined()
	})

	it("preserves modelId and supports chained mark calls", () => {
		const builder = new CommandTraceBuilder(makeOptions({ modelId: "model-x" }))

		const returned = builder
			.markToolCallGeneratedAt(100)
			.markQueueEnteredAt(110)
			.markQueueReleasedAt(120)
			.markQueueDepth(3)
			.markQueueWaitMs(10)

		// Mark methods return the builder for chaining
		expect(returned).toBe(builder)

		const trace = builder.build()
		expect(trace.modelId).toBe("model-x")
		expect(trace.toolCallGeneratedAt).toBe(100)
		expect(trace.queueEnteredAt).toBe(110)
		expect(trace.queueReleasedAt).toBe(120)
		expect(trace.queueDepth).toBe(3)
		expect(trace.queueWaitMs).toBe(10)
	})

	it("markTerminalCreatedAt records reuse flag and prior state", () => {
		const trace = new CommandTraceBuilder(makeOptions())
			.markTerminalRequestedAt(200)
			.markTerminalCreatedAt(210, true, "busy")
			.build()

		expect(trace.terminalRequestedAt).toBe(200)
		expect(trace.terminalCreatedAt).toBe(210)
		expect(trace.terminalReused).toBe(true)
		expect(trace.priorTerminalState).toBe("busy")
	})

	it("markProcessIdResolvedAt records the process id resolution timestamp", () => {
		const trace = new CommandTraceBuilder(makeOptions()).markProcessIdResolvedAt(250).build()

		expect(trace.processIdResolvedAt).toBe(250)
	})

	it("markShellIntegrationActivatedAt also marks initially available", () => {
		const trace = new CommandTraceBuilder(makeOptions()).markShellIntegrationActivatedAt(300).build()

		expect(trace.shellIntegrationActivatedAt).toBe(300)
		expect(trace.shellIntegrationInitiallyAvailable).toBe(true)
	})

	it("markShellIntegrationTimeoutAt records timeout timestamp", () => {
		const trace = new CommandTraceBuilder(makeOptions()).markShellIntegrationTimeoutAt(350).build()

		expect(trace.shellIntegrationTimeoutAt).toBe(350)
	})

	it("markShellExecutionEndedAt records exit code when provided", () => {
		const trace = new CommandTraceBuilder(makeOptions())
			.markCommandSubmittedAt(400)
			.markShellExecutionStartedAt(410)
			.markFirstOutputAt(415)
			.markShellExecutionEndedAt(500, 0)
			.build()

		expect(trace.commandSubmittedAt).toBe(400)
		expect(trace.shellExecutionStartedAt).toBe(410)
		expect(trace.firstOutputAt).toBe(415)
		expect(trace.shellExecutionEndedAt).toBe(500)
		expect(trace.exitCode).toBe(0)
	})

	it("markShellExecutionEndedAt leaves exitCode undefined when omitted", () => {
		const trace = new CommandTraceBuilder(makeOptions()).markShellExecutionEndedAt(500).build()

		expect(trace.shellExecutionEndedAt).toBe(500)
		expect(trace.exitCode).toBeUndefined()
	})

	it("markShellIntegrationInitiallyAvailable sets the availability flag", () => {
		const trace = new CommandTraceBuilder(makeOptions()).markShellIntegrationInitiallyAvailable(true).build()
		expect(trace.shellIntegrationInitiallyAvailable).toBe(true)

		const trace2 = new CommandTraceBuilder(makeOptions()).markShellIntegrationInitiallyAvailable(false).build()
		expect(trace2.shellIntegrationInitiallyAvailable).toBe(false)
	})

	it("markProvider records the terminal provider", () => {
		const provider: RooTerminalProvider = "execa"
		const trace = new CommandTraceBuilder(makeOptions()).markProvider(provider).build()
		expect(trace.provider).toBe("execa")
	})

	it("records concurrency counters", () => {
		const trace = new CommandTraceBuilder(makeOptions())
			.markConcurrentCommandCount(2)
			.markConcurrentTerminalCreationCount(1)
			.build()

		expect(trace.concurrentCommandCount).toBe(2)
		expect(trace.concurrentTerminalCreationCount).toBe(1)
	})

	it("markError records error type and optional exit code", () => {
		const trace = new CommandTraceBuilder(makeOptions()).markError("TIMEOUT", 1).build()
		expect(trace.errorType).toBe("TIMEOUT")
		expect(trace.exitCode).toBe(1)

		const traceNoCode = new CommandTraceBuilder(makeOptions()).markError("CANCELLED").build()
		expect(traceNoCode.errorType).toBe("CANCELLED")
		expect(traceNoCode.exitCode).toBeUndefined()
	})

	it("finalize invokes the completion callback with the built trace", () => {
		const onComplete = vi.fn()
		const builder = new CommandTraceBuilder(makeOptions({ onComplete }))
		const trace = builder.finalize()

		expect(onComplete).toHaveBeenCalledTimes(1)
		expect(onComplete).toHaveBeenCalledWith(trace)
		expect(trace.executionId).toBe("exec-1")
	})

	it("finalize is idempotent and emits only once", () => {
		const onComplete = vi.fn()
		const builder = new CommandTraceBuilder(makeOptions({ onComplete }))

		const first = builder.finalize()
		const second = builder.finalize()

		expect(onComplete).toHaveBeenCalledTimes(1)
		expect(second).toEqual(first)
	})

	it("finalize without a callback emits through the global collector", () => {
		const listener = vi.fn()
		const dispose = CommandTraceCollector.getInstance().subscribe(listener)

		const builder = new CommandTraceBuilder(makeOptions())
		const trace = builder.finalize()

		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith(trace)
		dispose()
	})

	it("finalize after build still invokes the callback exactly once", () => {
		const onComplete = vi.fn()
		const builder = new CommandTraceBuilder(makeOptions({ onComplete }))

		const built = builder.build()
		const finalized = builder.finalize()

		expect(built).toEqual(finalized)
		expect(onComplete).toHaveBeenCalledTimes(1)
	})
})

describe("CommandTraceCollector", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("getInstance returns the same singleton instance", () => {
		expect(CommandTraceCollector.getInstance()).toBe(CommandTraceCollector.getInstance())
	})

	it("dispatches emitted traces to all subscribers", () => {
		const listenerA: CommandTraceListener = vi.fn()
		const listenerB: CommandTraceListener = vi.fn()
		const collector = CommandTraceCollector.getInstance()

		const disposeA = collector.subscribe(listenerA)
		const disposeB = collector.subscribe(listenerB)

		const trace: CommandTrace = {
			executionId: "exec-2",
			taskId: "task-2",
			toolCallGeneratedAt: 1,
			queueEnteredAt: 2,
			queueReleasedAt: 3,
			terminalRequestedAt: 4,
			terminalCreatedAt: 5,
			commandSubmittedAt: 6,
			shellIntegrationInitiallyAvailable: false,
			provider: "vscode",
			terminalReused: false,
			concurrentCommandCount: 0,
			concurrentTerminalCreationCount: 0,
			commandLength: 10,
			commandCountInChain: 1,
			queueDepth: 0,
			queueWaitMs: 0,
		}

		collector.emit(trace)

		expect(listenerA).toHaveBeenCalledTimes(1)
		expect(listenerA).toHaveBeenCalledWith(trace)
		expect(listenerB).toHaveBeenCalledTimes(1)
		expect(listenerB).toHaveBeenCalledWith(trace)

		disposeA()
		disposeB()
	})

	it("dispose removes the listener so it stops receiving events", () => {
		const listener: CommandTraceListener = vi.fn()
		const collector = CommandTraceCollector.getInstance()

		const dispose = collector.subscribe(listener)
		collector.emit({ executionId: "e1", taskId: "t1" })
		expect(listener).toHaveBeenCalledTimes(1)

		dispose()
		collector.emit({ executionId: "e2", taskId: "t2" })
		expect(listener).toHaveBeenCalledTimes(1)
	})

	it("swallows listener exceptions without affecting other subscribers", () => {
		const throwingListener: CommandTraceListener = () => {
			throw new Error("listener boom")
		}
		const healthyListener: CommandTraceListener = vi.fn()
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		const collector = CommandTraceCollector.getInstance()
		const disposeThrowing = collector.subscribe(throwingListener)
		const disposeHealthy = collector.subscribe(healthyListener)

		collector.emit({ executionId: "e3", taskId: "t3" })

		expect(consoleErrorSpy).toHaveBeenCalledTimes(1)
		expect(healthyListener).toHaveBeenCalledTimes(1)

		disposeThrowing()
		disposeHealthy()
	})

	it("emit is safe when no listeners are registered", () => {
		expect(() => {
			CommandTraceCollector.getInstance().emit({ executionId: "e4", taskId: "t4" })
		}).not.toThrow()
	})
})

describe("emitCommandTrace", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("forwards partial traces to the global collector", () => {
		const listener: CommandTraceListener = vi.fn()
		const dispose = CommandTraceCollector.getInstance().subscribe(listener)

		emitCommandTrace({ executionId: "e5", taskId: "t5", errorType: "WATCHDOG" })

		expect(listener).toHaveBeenCalledTimes(1)
		expect(listener).toHaveBeenCalledWith({ executionId: "e5", taskId: "t5", errorType: "WATCHDOG" })
		dispose()
	})
})
