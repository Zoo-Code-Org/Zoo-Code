// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.consecutive-mistake.test.ts

import { TelemetryEventName, type TelemetryClient } from "@roo-code/types"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService.captureConsecutiveMistakeError", () => {
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

	it.each(["no_tools_used", "tool_repetition"] as const)(
		"sends reason, count and limit for %s without a separate exception",
		(reason) => {
			const service = new TelemetryService([mockClient])

			service.captureConsecutiveMistakeError("task_1", reason, 3, 5)

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.CONSECUTIVE_MISTAKE_ERROR,
				properties: {
					taskId: "task_1",
					reason,
					consecutiveMistakeCount: 3,
					consecutiveMistakeLimit: 5,
				},
			})
			expect(mockClient.captureException).not.toHaveBeenCalled()
		},
	)
})
