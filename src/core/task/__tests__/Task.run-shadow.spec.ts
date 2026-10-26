// npx vitest run core/task/__tests__/Task.run-shadow.spec.ts

import * as vscode from "vscode"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"
import { TelemetryEventName } from "@roo-code/types"
import { TelemetryService } from "@roo-code/telemetry"

import { makeExtensionContext, makeUri } from "../../../test-utils/vscode"
import { Task } from "../Task"
import { ClineProvider } from "../../webview/ClineProvider"
import { initialRunState } from "../run-state/runState"

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("../../ignore/RooIgnoreController")

function makeTask(extensionMode = vscode.ExtensionMode.Production): Task {
	const provider = {
		log: vi.fn(),
		context: makeExtensionContext({
			globalStorageUri: makeUri("/mock/global-storage"),
			extensionMode,
		}),
	}
	// Double cast: the constructor reads only these provider members.
	return new Task({
		provider: provider as unknown as ClineProvider,
		apiConfiguration: { apiProvider: providerIdentifiers.anthropic, apiKey: "test-api-key" },
		task: "test task",
		startTask: false,
	})
}

describe("Task run-state write helpers", () => {
	let task: Task

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		task = makeTask()
	})

	it("starts with the initial run state and no rejections", () => {
		expect(task.runState).toEqual(initialRunState)
		expect(task.runRejections).toEqual([])
	})

	it("sets the field and drives the event for each stream and phase helper", () => {
		task.markInitialized()
		task.markStreamStarted()
		task.markStreamCleanupFinished()

		expect(task.isInitialized).toBe(true)
		expect(task.isStreaming).toBe(true)
		expect(task.didFinishAbortingStream).toBe(true)
		expect(task.runState.phase).toBe("running")
		expect(task.runState.stream).toEqual({ tag: "live", generation: 1, cleanupFinished: true })

		task.markStreamEnded()
		expect(task.isStreaming).toBe(false)
		expect(task.runState.stream).toEqual({ tag: "none" })
		expect(task.runRejections).toEqual([])
	})

	it("keeps the cancelTask order: reason, abort, then abandon, with no rejections", async () => {
		task.setAbortReason("user_cancelled")
		await task.abortTask()
		task.requestAbandon()

		expect(task.runRejections).toEqual([])
		expect(task.runState.latches).toEqual({
			abort: true,
			abandoned: true,
			disposed: true,
			reason: "user_cancelled",
		})
	})

	it("drives disposeRequested from dispose and keeps the reason", async () => {
		task.setAbortReason("user_cancelled")
		await task.dispose()

		expect(task.abort).toBe(true)
		expect(task.runState.latches.disposed).toBe(true)
		expect(task.runState.latches.reason).toBe("user_cancelled")
		expect(task.runRejections).toEqual([])
	})

	it("keeps a stale didFinishAbortingStream on the next stream so the kernel mismatch shows race R-1", () => {
		task.markInitialized()
		task.markStreamStarted()
		task.markStreamCleanupFinished()
		task.markStreamEnded()
		task.markStreamStarted()

		expect(task.didFinishAbortingStream).toBe(true)
		expect(task.runState.stream).toEqual({ tag: "live", generation: 2, cleanupFinished: false })
	})

	it("requestAbort(false) sets abort only", () => {
		task.requestAbort(false)

		expect([task.abort, task.abandoned]).toEqual([true, false])
		expect(task.runState.latches).toMatchObject({ abort: true, abandoned: false })
	})

	it("requestAbort(true) sets abort and abandoned", () => {
		task.requestAbort(true)

		expect([task.abort, task.abandoned]).toEqual([true, true])
		expect(task.runState.latches).toMatchObject({ abort: true, abandoned: true })
	})

	it("requestAbandon sets abandoned after an abort", () => {
		task.requestAbort(false)
		task.requestAbandon()

		expect(task.abandoned).toBe(true)
		expect(task.runState.latches.abandoned).toBe(true)
		expect(task.runRejections).toEqual([])
	})

	it("requestDispose sets abort and the disposed latch", () => {
		task.requestDispose()

		expect(task.abort).toBe(true)
		expect(task.runState.latches).toMatchObject({ abort: true, disposed: true })
	})

	it("drives the ask events", () => {
		task.markInitialized()
		task.markAskStarted({ tag: "approval", askTs: 10 })
		expect(task.runState.ask).toEqual({ tag: "approval", askTs: 10 })

		task.markAskSettled(10)
		expect(task.runState.ask).toEqual({ tag: "none" })

		task.markAskStarted({ tag: "completion", askTs: 20 })
		task.markCompletionAccepted(20)
		expect(task.runState.phase).toBe("completed")
		expect(task.runRejections).toEqual([])
	})

	it("keeps the field write and records the event when the kernel rejects it", () => {
		task.requestAbandon()

		expect(task.abandoned).toBe(true)
		expect(task.runState.latches.abandoned).toBe(false)
		expect(task.runRejections).toEqual([{ event: { tag: "abandonRequested" }, state: initialRunState }])
	})

	it("keeps the first abort reason in the field and in the kernel", () => {
		task.setAbortReason("user_cancelled")
		task.setAbortReason("streaming_failed")

		expect(task.abortReason).toBe("user_cancelled")
		expect(task.runState.latches.reason).toBe("user_cancelled")
		expect(task.runRejections).toEqual([])
	})
})

describe("Task run-state divergence report", () => {
	let warn: ReturnType<typeof vi.spyOn>
	let captureEvent: ReturnType<typeof vi.spyOn>

	const divergenceMetrics = () =>
		captureEvent.mock.calls.filter(
			([name]: unknown[]) =>
				name === TelemetryEventName.RUN_STATE_DIVERGENCE || name === TelemetryEventName.RUN_STATE_KNOWN_RACE,
		)

	const divergenceWarnings = () =>
		warn.mock.calls.filter(([message]: unknown[]) => message === "[RunState] divergence")

	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}
		warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		captureEvent = vi.spyOn(TelemetryService.instance, "captureEvent").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("logs and counts a rejected event once when the check is enabled", () => {
		const task = makeTask(vscode.ExtensionMode.Test)

		task.markStreamEnded()

		expect(divergenceWarnings()).toHaveLength(1)
		expect(divergenceWarnings()[0][1]).toMatchObject({
			taskId: task.taskId,
			kind: "rejection",
			event: { tag: "streamEnded" },
			state: initialRunState,
			mismatched: [],
		})
		expect(divergenceMetrics()).toEqual([
			[
				TelemetryEventName.RUN_STATE_DIVERGENCE,
				expect.objectContaining({ taskId: task.taskId, kind: "rejection", eventTag: "streamEnded" }),
			],
		])
	})

	it("reports a repeated rejection of the same event once per task", () => {
		const task = makeTask(vscode.ExtensionMode.Test)

		task.markStreamEnded()
		task.markStreamEnded()

		expect(task.runRejections).toHaveLength(2)
		expect(divergenceWarnings()).toHaveLength(1)
		expect(divergenceMetrics()).toHaveLength(1)
	})

	it("reports a rejection and an abandoned mismatch when abandon comes before abort", () => {
		const task = makeTask(vscode.ExtensionMode.Test)

		task.requestAbandon()

		const reports = divergenceWarnings().map(([, report]: unknown[]) => report)
		expect(reports).toHaveLength(2)
		expect(reports).toContainEqual(expect.objectContaining({ kind: "rejection", mismatched: [] }))
		expect(reports).toContainEqual(expect.objectContaining({ kind: "mismatch", mismatched: ["abandoned"] }))
	})

	it("stays silent for a production build on the stable channel", () => {
		const task = makeTask(vscode.ExtensionMode.Production)

		task.requestAbandon()

		expect(task.runRejections).toHaveLength(1)
		expect(divergenceWarnings()).toHaveLength(0)
		expect(divergenceMetrics()).toHaveLength(0)
	})
})
