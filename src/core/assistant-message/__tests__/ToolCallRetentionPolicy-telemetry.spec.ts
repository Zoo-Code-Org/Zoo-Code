// npx vitest run core/assistant-message/__tests__/ToolCallRetentionPolicy-telemetry.spec.ts

import { describe, it, expect, beforeEach, vi } from "vitest"
import type { Mock } from "vitest"

// Mock TelemetryService before importing the module under test.
vi.mock("@roo-code/telemetry", () => ({
	TelemetryService: {
		hasInstance: vi.fn(() => true),
		instance: {
			captureToolCallPolicyResolution: vi.fn(),
			captureToolCallEnforcement: vi.fn(),
		},
	},
}))

import { TelemetryService } from "@roo-code/telemetry"
import {
	emitGhostDropTelemetry,
	emitMaxOneEnforcementTelemetry,
} from "../ToolCallRetentionPolicy"

const mockCaptureToolCallEnforcement = TelemetryService.instance.captureToolCallEnforcement as unknown as Mock
const mockHasInstance = TelemetryService.hasInstance as unknown as Mock

describe("Tool-call policy telemetry helpers", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("emitGhostDropTelemetry", () => {
		it("calls captureToolCallEnforcement with counts and metadata only", () => {
			emitGhostDropTelemetry({
				taskId: "task-001",
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "provider-and-local",
				callCount: 2,
				ghostDroppedCount: 1,
				errorResultCount: 0,
				parallelToolCallsRequested: false,
			})

			expect(TelemetryService.instance.captureToolCallEnforcement).toHaveBeenCalledTimes(1)
			const args = mockCaptureToolCallEnforcement.mock.calls[0]
			expect(args[0]).toBe("task-001")
			expect(args[1]).toEqual({
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "provider-and-local",
				callCount: 2,
				ghostDroppedCount: 1,
				errorResultCount: 0,
				parallelToolCallsRequested: false,
			})
		})

		it("does NOT include call ID, tool name, arguments, commands, or paths", () => {
			emitGhostDropTelemetry({
				taskId: "task-002",
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "local",
				callCount: 1,
				ghostDroppedCount: 1,
				errorResultCount: 0,
				parallelToolCallsRequested: false,
			})

			const args = mockCaptureToolCallEnforcement.mock.calls[0][1] as Record<string, unknown>
			// Verify no raw data fields are present
			expect(args).not.toHaveProperty("callId")
			expect(args).not.toHaveProperty("toolName")
			expect(args).not.toHaveProperty("arguments")
			expect(args).not.toHaveProperty("command")
			expect(args).not.toHaveProperty("cwd")
			expect(args).not.toHaveProperty("path")
			expect(args).not.toHaveProperty("fileContent")
			expect(args).not.toHaveProperty("apiKey")
			expect(args).not.toHaveProperty("token")
		})

		it("includes parallelToolCallsSent when provided", () => {
			emitGhostDropTelemetry({
				taskId: "task-003",
				provider: "openai",
				model: "gpt-4",
				policySource: "model-capability",
				maxCallsPerTurn: "unbounded",
				enforcement: "provider",
				callCount: 3,
				ghostDroppedCount: 1,
				errorResultCount: 0,
				parallelToolCallsRequested: true,
				parallelToolCallsSent: true,
			})

			const args = mockCaptureToolCallEnforcement.mock.calls[0][1] as Record<string, unknown>
			expect(args.parallelToolCallsSent).toBe(true)
		})

		it("skips emission when TelemetryService has no instance", () => {
			mockHasInstance.mockReturnValueOnce(false)
			emitGhostDropTelemetry({
				taskId: "task-004",
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "local",
				callCount: 1,
				ghostDroppedCount: 1,
				errorResultCount: 0,
				parallelToolCallsRequested: false,
			})

			expect(TelemetryService.instance.captureToolCallEnforcement).not.toHaveBeenCalled()
		})
	})

	describe("emitMaxOneEnforcementTelemetry", () => {
		it("calls captureToolCallEnforcement with rejection counts", () => {
			emitMaxOneEnforcementTelemetry({
				taskId: "task-005",
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "provider-and-local",
				callCount: 2,
				ghostDroppedCount: 0,
				errorResultCount: 2,
				parallelToolCallsRequested: false,
			})

			expect(TelemetryService.instance.captureToolCallEnforcement).toHaveBeenCalledTimes(1)
			const args = mockCaptureToolCallEnforcement.mock.calls[0]
			expect(args[0]).toBe("task-005")
			expect(args[1]).toEqual({
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "provider-and-local",
				callCount: 2,
				ghostDroppedCount: 0,
				errorResultCount: 2,
				parallelToolCallsRequested: false,
			})
		})

		it("does NOT include call ID, tool name, arguments, commands, or paths", () => {
			emitMaxOneEnforcementTelemetry({
				taskId: "task-006",
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "local",
				callCount: 2,
				ghostDroppedCount: 0,
				errorResultCount: 2,
				parallelToolCallsRequested: false,
			})

			const args = mockCaptureToolCallEnforcement.mock.calls[0][1] as Record<string, unknown>
			expect(args).not.toHaveProperty("callId")
			expect(args).not.toHaveProperty("toolName")
			expect(args).not.toHaveProperty("arguments")
			expect(args).not.toHaveProperty("command")
			expect(args).not.toHaveProperty("cwd")
			expect(args).not.toHaveProperty("path")
			expect(args).not.toHaveProperty("fileContent")
			expect(args).not.toHaveProperty("apiKey")
			expect(args).not.toHaveProperty("token")
		})

		it("skips emission when TelemetryService has no instance", () => {
			mockHasInstance.mockReturnValueOnce(false)
			emitMaxOneEnforcementTelemetry({
				taskId: "task-007",
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "local",
				callCount: 2,
				ghostDroppedCount: 0,
				errorResultCount: 2,
				parallelToolCallsRequested: false,
			})

			expect(TelemetryService.instance.captureToolCallEnforcement).not.toHaveBeenCalled()
		})
	})

	describe("privacy verification — cardinality bounds", () => {
		it("telemetry properties only contain allowed metadata keys", () => {
			const allowedKeys = new Set([
				"taskId",
				"provider",
				"model",
				"policySource",
				"maxCallsPerTurn",
				"enforcement",
				"callCount",
				"ghostDroppedCount",
				"errorResultCount",
				"parallelToolCallsRequested",
				"parallelToolCallsSent",
			])

			emitGhostDropTelemetry({
				taskId: "task-priv-001",
				provider: "mimo",
				model: "mimo-v2.5-pro",
				policySource: "model-capability",
				maxCallsPerTurn: 1,
				enforcement: "local",
				callCount: 1,
				ghostDroppedCount: 1,
				errorResultCount: 0,
				parallelToolCallsRequested: false,
			})

			const args = mockCaptureToolCallEnforcement.mock.calls[0][1] as Record<string, unknown>
			for (const key of Object.keys(args)) {
				expect(allowedKeys.has(key)).toBe(true)
			}
		})
	})
})
