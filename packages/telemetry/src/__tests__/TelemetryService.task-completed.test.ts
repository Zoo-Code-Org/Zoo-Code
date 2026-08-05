// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.task-completed.test.ts

import { TelemetryEventName, type TelemetryClient } from "@roo-code/types"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService.captureTaskCompleted", () => {
	let mockClient: TelemetryClient

	beforeEach(() => {
		mockClient = {
			setProvider: vi.fn(),
			capture: vi.fn().mockResolvedValue(undefined),
			captureException: vi.fn().mockResolvedValue(undefined),
			updateTelemetryState: vi.fn(),
			isTelemetryEnabled: vi.fn().mockReturnValue(true),
			shutdown: vi.fn().mockResolvedValue(undefined),
		}
	})

	it("captures Task Completed with the taskId and a default 'attempt_completion' completionReason when no summary is provided", () => {
		const service = new TelemetryService([mockClient])

		service.captureTaskCompleted("task_1")

		expect(mockClient.capture).toHaveBeenCalledWith({
			event: TelemetryEventName.TASK_COMPLETED,
			properties: { taskId: "task_1", completionReason: "attempt_completion" },
		})
	})

	it("includes toolsUsed and messageCount summaries when provided", () => {
		const service = new TelemetryService([mockClient])

		service.captureTaskCompleted(
			"task_1",
			{ read_file: { attempts: 3, failures: 0 }, apply_diff: { attempts: 1, failures: 1 } },
			{ user: 4, assistant: 5 },
		)

		expect(mockClient.capture).toHaveBeenCalledWith({
			event: TelemetryEventName.TASK_COMPLETED,
			properties: {
				taskId: "task_1",
				completionReason: "attempt_completion",
				toolsUsed: { read_file: { attempts: 3, failures: 0 }, apply_diff: { attempts: 1, failures: 1 } },
				messageCount: { user: 4, assistant: 5 },
			},
		})
	})

	it("includes the given completionReason for idle/shutdown installments", () => {
		const service = new TelemetryService([mockClient])

		service.captureTaskCompleted("task_1", { read_file: { attempts: 1, failures: 0 } }, undefined, "idle")

		expect(mockClient.capture).toHaveBeenCalledWith({
			event: TelemetryEventName.TASK_COMPLETED,
			properties: {
				taskId: "task_1",
				completionReason: "idle",
				toolsUsed: { read_file: { attempts: 1, failures: 0 } },
			},
		})
	})
})
