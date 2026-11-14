import { type ProviderSettings } from "@roo-code/types"

import { Task } from "../Task"
import { ObservationRegistry } from "../observationRegistry"
import type { ClineProvider } from "../../webview/ClineProvider"
import { providerIdentifiers } from "@roo-code/types/provider-identifiers"

// Real-Task isolation proof for the observationRegistry field this PR adds to
// Task. The unit spec covers the registry's own semantics; this one pins the
// ownership contract the field exists for: every Task owns its registry, so a
// parent's observations never authorize a subtask's writes (and vice versa).
// The construction boilerplate mirrors Task.dispose.test.ts.
vi.mock("../../webview/ClineProvider")
vi.mock("../../../integrations/terminal/TerminalRegistry", () => ({
	TerminalRegistry: {
		releaseTerminalsForTask: vi.fn(),
	},
}))
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
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureTaskCreated: vi.fn(),
			captureTaskRestarted: vi.fn(),
		},
	},
}))

describe("Task observation registry ownership", () => {
	const makeProvider = () => ({
		context: { globalStorageUri: { fsPath: "/test/path" } },
		getState: vi.fn().mockResolvedValue({ mode: "code" }),
		log: vi.fn(),
		flushPostStateToWebviewThrottled: vi.fn().mockResolvedValue(undefined),
	})
	const apiConfiguration = {
		apiProvider: providerIdentifiers.anthropic,
		apiKey: "test-key",
	} as ProviderSettings

	it("gives every real Task its own registry, isolated from every other", async () => {
		const taskA = new Task({
			provider: makeProvider() as unknown as ClineProvider,
			apiConfiguration,
			startTask: false,
		})
		const taskB = new Task({
			provider: makeProvider() as unknown as ClineProvider,
			apiConfiguration,
			startTask: false,
		})

		try {
			expect(taskA.observationRegistry).toBeInstanceOf(ObservationRegistry)
			expect(taskB.observationRegistry).toBeInstanceOf(ObservationRegistry)
			// Two real Tasks, two registries: a shared or static field fails here.
			expect(taskA.observationRegistry).not.toBe(taskB.observationRegistry)

			taskA.observationRegistry.observe("/tmp/observed-by-a.json", "version-a")

			expect(taskA.observationRegistry.get("/tmp/observed-by-a.json")?.version).toBe("version-a")
			// The other task's registry must not contain the observation: an
			// observation earned by one task cannot authorize the other's writes.
			expect(taskB.observationRegistry.get("/tmp/observed-by-a.json")).toBeUndefined()
			expect(taskB.observationRegistry.has("/tmp/observed-by-a.json")).toBe(false)
			expect(taskB.observationRegistry.size).toBe(0)
		} finally {
			await taskA.dispose().catch(() => {})
			await taskB.dispose().catch(() => {})
		}
	})
})
