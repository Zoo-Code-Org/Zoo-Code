// npx vitest run core/task/__tests__/Task.duplicate-tool-result-reporting.spec.ts

import { TelemetryService } from "@roo-code/telemetry"

import { Task } from "../Task"
import { DuplicateToolResultIdError } from "../mergeConsecutiveApiMessages"

vi.mock("../../../i18n", () => ({
	t: (key: string, args?: Record<string, unknown>) => `${key}|${JSON.stringify(args ?? {})}`,
}))

type DuplicateReportingAccess = {
	reportDroppedDuplicateToolResults(droppedDuplicateToolUseIds: string[]): Promise<void>
}

const getAccess = (task: Task) => task as unknown as DuplicateReportingAccess

function createTask() {
	const task = Object.create(Task.prototype) as Task
	Object.assign(task, {
		taskId: "task-1",
		say: vi.fn().mockResolvedValue(undefined),
		reportedDuplicateToolUseIds: new Set<string>(),
	})
	return task
}

describe("Task duplicate tool_result reporting", () => {
	beforeEach(() => {
		if (!TelemetryService.hasInstance()) {
			TelemetryService.createInstance([])
		}

		vi.spyOn(TelemetryService.instance, "captureException").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("says nothing when no duplicates were dropped", async () => {
		const task = createTask()

		await getAccess(task).reportDroppedDuplicateToolResults([])

		expect(task.say).not.toHaveBeenCalled()
		expect(TelemetryService.instance.captureException).not.toHaveBeenCalled()
	})

	it("reports a dropped duplicate once, naming the tool_use_id and drop count", async () => {
		const task = createTask()

		await getAccess(task).reportDroppedDuplicateToolResults(["tooluse_abc", "tooluse_abc"])

		expect(task.say).toHaveBeenCalledTimes(1)
		expect(task.say).toHaveBeenCalledWith(
			"error",
			`tools:duplicateToolResultDropped|${JSON.stringify({ toolUseId: "tooluse_abc", droppedCount: 2 })}`,
		)
	})

	it("does not repeat the report when the same history is merged again", async () => {
		const task = createTask()

		await getAccess(task).reportDroppedDuplicateToolResults(["tooluse_abc"])
		await getAccess(task).reportDroppedDuplicateToolResults(["tooluse_abc"])

		expect(task.say).toHaveBeenCalledTimes(1)
		expect(TelemetryService.instance.captureException).toHaveBeenCalledTimes(1)
	})

	it("reports a newly duplicated id even after an earlier one was reported", async () => {
		const task = createTask()

		await getAccess(task).reportDroppedDuplicateToolResults(["tooluse_abc"])
		await getAccess(task).reportDroppedDuplicateToolResults(["tooluse_abc", "tooluse_def"])

		expect(task.say).toHaveBeenCalledTimes(2)
		expect(task.say).toHaveBeenLastCalledWith(
			"error",
			`tools:duplicateToolResultDropped|${JSON.stringify({ toolUseId: "tooluse_def", droppedCount: 1 })}`,
		)
	})

	it("captures a DuplicateToolResultIdError for telemetry", async () => {
		const task = createTask()

		await getAccess(task).reportDroppedDuplicateToolResults(["tooluse_abc", "tooluse_def"])

		expect(TelemetryService.instance.captureException).toHaveBeenCalledTimes(1)
		const [error, properties] = vi.mocked(TelemetryService.instance.captureException).mock.calls[0]
		expect(error).toBeInstanceOf(DuplicateToolResultIdError)
		expect((error as DuplicateToolResultIdError).droppedToolUseIds).toEqual(["tooluse_abc", "tooluse_def"])
		expect(properties).toEqual({
			taskId: "task-1",
			duplicateToolUseIds: ["tooluse_abc", "tooluse_def"],
			droppedCount: 2,
		})
	})
})
