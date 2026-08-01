// npx vitest src/core/assistant-message/__tests__/toTelemetryToolName.spec.ts

import { describe, it, expect, vi } from "vitest"

// Only validateToolUse itself needs mocking (unused by toTelemetryToolName,
// but imported by the same module). isValidToolName is left as the real
// implementation: it has its own independent mcp_ prefix carve-out, and a
// hand-rolled mock allowlist here would mask a regression where
// toTelemetryToolName's ordering relative to isValidToolName changes.
vi.mock("../../tools/validateToolUse", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../tools/validateToolUse")>()
	return {
		...actual,
		validateToolUse: vi.fn(),
	}
})

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

	it("maps mcp_ names to use_mcp_tool against the real isValidToolName, not a mock allowlist", () => {
		// isValidToolName is unmocked in this file (see the vi.mock factory above),
		// so this exercises the real mcp_ prefix carve-out ordering rather than one
		// a hand-rolled mock could silently keep agreeing with after a regression.
		expect(toTelemetryToolName("mcp_my_server_do_thing", false, undefined)).toBe("use_mcp_tool")
	})
})
