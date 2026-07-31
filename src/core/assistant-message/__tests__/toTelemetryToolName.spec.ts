// npx vitest src/core/assistant-message/__tests__/toTelemetryToolName.spec.ts

import { describe, it, expect, vi } from "vitest"

vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn((toolName: string) =>
		["read_file", "write_to_file", "ask_followup_question", "attempt_completion", "use_mcp_tool"].includes(
			toolName,
		),
	),
}))

import { toTelemetryToolName } from "../presentAssistantMessage"

describe("toTelemetryToolName", () => {
	it("maps a known static tool to its own name", () => {
		expect(toTelemetryToolName("read_file", false, undefined)).toBe("read_file")
	})

	it("maps a registered custom tool to custom_tool", () => {
		expect(toTelemetryToolName("my_custom_tool", true, undefined)).toBe("custom_tool")
	})

	it("maps a valid dynamic mcp_ tool name to use_mcp_tool", () => {
		expect(toTelemetryToolName("mcp_my_server_do_thing", false, undefined)).toBe("use_mcp_tool")
	})

	it("maps a malformed mcp_ tool name to use_mcp_tool", () => {
		expect(toTelemetryToolName("mcp_", false, undefined)).toBe("use_mcp_tool")
	})

	it("maps an arbitrary unknown tool name to invalid_tool_call", () => {
		expect(toTelemetryToolName("drop_table_users", false, undefined)).toBe("invalid_tool_call")
	})

	it("never returns the raw name for an unrecognized tool", () => {
		const raw = "'; DROP TABLE users; --"
		const result = toTelemetryToolName(raw, false, undefined)
		expect(result).not.toBe(raw)
		expect(result).toBe("invalid_tool_call")
	})
})
