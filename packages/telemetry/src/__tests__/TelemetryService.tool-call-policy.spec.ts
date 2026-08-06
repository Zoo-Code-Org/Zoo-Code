// pnpm --filter @roo-code/telemetry test src/__tests__/TelemetryService.tool-call-policy.spec.ts

import { TelemetryEventName, type TelemetryClient } from "@roo-code/types"

import { TelemetryService } from "../TelemetryService"

describe("TelemetryService tool-call policy events", () => {
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

	describe("captureToolCallPolicyResolution", () => {
		it("forwards the task id and full metadata to the telemetry client", () => {
			const service = new TelemetryService([mockClient])

			service.captureToolCallPolicyResolution("task_policy_1", {
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "local",
				parallelToolCallsRequested: false,
			})

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TOOL_CALL_POLICY_RESOLUTION,
				properties: {
					taskId: "task_policy_1",
					provider: "mimo",
					model: "mimo-v2.5-pro",
					policySource: "model-capability",
					maxCallsPerTurn: 1,
					enforcement: "local",
					parallelToolCallsRequested: false,
				},
			})
		})

		it("forwards the optional parallelToolCallsSent flag when provided", () => {
			const service = new TelemetryService([mockClient])

			service.captureToolCallPolicyResolution("task_policy_2", {
				provider: "openai",
				model: "gpt-4o",
				policySource: "provider-default",
				maxCallsPerTurn: "unbounded",
				enforcement: "provider",
				parallelToolCallsRequested: true,
				parallelToolCallsSent: true,
			})

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TOOL_CALL_POLICY_RESOLUTION,
				properties: {
					taskId: "task_policy_2",
					provider: "openai",
					model: "gpt-4o",
					policySource: "provider-default",
					maxCallsPerTurn: "unbounded",
					enforcement: "provider",
					parallelToolCallsRequested: true,
					parallelToolCallsSent: true,
				},
			})
		})
	})

	describe("captureToolCallEnforcement", () => {
		it("forwards enforcement counts and metadata to the telemetry client", () => {
			const service = new TelemetryService([mockClient])

			service.captureToolCallEnforcement("task_enforce_1", {
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "local",
				callCount: 3,
				ghostDroppedCount: 1,
				errorResultCount: 0,
				parallelToolCallsRequested: false,
			})

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TOOL_CALL_ENFORCEMENT,
				properties: {
					taskId: "task_enforce_1",
					provider: "mimo",
					model: "mimo-v2.5-pro",
					policySource: "model-capability",
					maxCallsPerTurn: 1,
					enforcement: "local",
					callCount: 3,
					ghostDroppedCount: 1,
					errorResultCount: 0,
					parallelToolCallsRequested: false,
				},
			})
		})

		it("forwards the optional parallelToolCallsSent flag when provided", () => {
			const service = new TelemetryService([mockClient])

			service.captureToolCallEnforcement("task_enforce_2", {
				provider: "anthropic",
				model: "claude-3-5-sonnet",
				policySource: "model-capability",
				maxCallsPerTurn: "unbounded",
				enforcement: "provider",
				callCount: 5,
				ghostDroppedCount: 0,
				errorResultCount: 1,
				parallelToolCallsRequested: true,
				parallelToolCallsSent: false,
			})

			expect(mockClient.capture).toHaveBeenCalledWith({
				event: TelemetryEventName.TOOL_CALL_ENFORCEMENT,
				properties: {
					taskId: "task_enforce_2",
					provider: "anthropic",
					model: "claude-3-5-sonnet",
					policySource: "model-capability",
					maxCallsPerTurn: "unbounded",
					enforcement: "provider",
					callCount: 5,
					ghostDroppedCount: 0,
					errorResultCount: 1,
					parallelToolCallsRequested: true,
					parallelToolCallsSent: false,
				},
			})
		})
	})
})
