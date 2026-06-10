// npx vitest run core/tools/__tests__/mcpServerRestriction.spec.ts

import type { Task } from "../../task/Task"
import { isMcpServerAllowed, getAllowedMcpServersForTask, ensureMcpServerAllowed } from "../mcpServerRestriction"

vi.mock("../../../shared/modes", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../shared/modes")>()
	return {
		...actual,
		defaultModeSlug: "code",
		getModeBySlug: vi.fn(),
	}
})

import { getModeBySlug } from "../../../shared/modes"

const toolError = (error: string) => `ERR:${error}`

function makeTask(state: any): Task {
	return {
		providerRef: {
			deref: () => ({
				getState: vi.fn().mockResolvedValue(state),
			}),
		},
		consecutiveMistakeCount: 0,
		didToolFailInCurrentTurn: false,
		recordToolError: vi.fn(),
	} as unknown as Task
}

describe("isMcpServerAllowed", () => {
	it("allows all servers when allowlist is undefined (backward compatible)", () => {
		expect(isMcpServerAllowed("any-server", undefined)).toBe(true)
	})

	it("rejects all servers when allowlist is empty", () => {
		expect(isMcpServerAllowed("any-server", [])).toBe(false)
	})

	it("allows a server present in a populated allowlist", () => {
		expect(isMcpServerAllowed("allowed", ["allowed", "other"])).toBe(true)
	})

	it("rejects a server absent from a populated allowlist", () => {
		expect(isMcpServerAllowed("disallowed", ["allowed", "other"])).toBe(false)
	})
})

describe("getAllowedMcpServersForTask", () => {
	beforeEach(() => {
		vi.mocked(getModeBySlug).mockReset()
	})

	it("returns the mode's allowedMcpServers when defined", async () => {
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code",
			roleDefinition: "",
			groups: ["mcp"],
			allowedMcpServers: ["srv-a"],
		} as any)
		const task = makeTask({ mode: "code", customModes: [] })
		await expect(getAllowedMcpServersForTask(task)).resolves.toEqual(["srv-a"])
	})

	it("returns undefined when the mode does not restrict servers", async () => {
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code",
			roleDefinition: "",
			groups: ["mcp"],
		} as any)
		const task = makeTask({ mode: "code", customModes: [] })
		await expect(getAllowedMcpServersForTask(task)).resolves.toBeUndefined()
	})

	it("returns undefined when the mode cannot be resolved", async () => {
		vi.mocked(getModeBySlug).mockReturnValue(undefined as any)
		const task = makeTask({ mode: "missing", customModes: [] })
		await expect(getAllowedMcpServersForTask(task)).resolves.toBeUndefined()
	})
})

describe("ensureMcpServerAllowed", () => {
	beforeEach(() => {
		vi.mocked(getModeBySlug).mockReset()
	})

	function mockModeAllowlist(allowedMcpServers?: string[]) {
		vi.mocked(getModeBySlug).mockReturnValue({
			slug: "code",
			name: "Code",
			roleDefinition: "",
			groups: ["mcp"],
			...(allowedMcpServers !== undefined ? { allowedMcpServers } : {}),
		} as any)
	}

	it("allows invocation when allowlist is undefined (allows all)", async () => {
		mockModeAllowlist(undefined)
		const task = makeTask({ mode: "code", customModes: [] })
		const pushToolResult = vi.fn()

		const result = await ensureMcpServerAllowed(task, "use_mcp_tool", "anything", pushToolResult, toolError)

		expect(result).toBe(true)
		expect(pushToolResult).not.toHaveBeenCalled()
		expect(task.recordToolError).not.toHaveBeenCalled()
	})

	it("allows invocation when server is in the populated allowlist", async () => {
		mockModeAllowlist(["allowed-server"])
		const task = makeTask({ mode: "code", customModes: [] })
		const pushToolResult = vi.fn()

		const result = await ensureMcpServerAllowed(task, "use_mcp_tool", "allowed-server", pushToolResult, toolError)

		expect(result).toBe(true)
		expect(pushToolResult).not.toHaveBeenCalled()
	})

	it("rejects invocation when server is NOT in the populated allowlist", async () => {
		mockModeAllowlist(["allowed-server"])
		const task = makeTask({ mode: "code", customModes: [] })
		const pushToolResult = vi.fn()

		const result = await ensureMcpServerAllowed(
			task,
			"use_mcp_tool",
			"disallowed-server",
			pushToolResult,
			toolError,
		)

		expect(result).toBe(false)
		expect(task.consecutiveMistakeCount).toBe(1)
		expect(task.didToolFailInCurrentTurn).toBe(true)
		expect(task.recordToolError).toHaveBeenCalledWith("use_mcp_tool")
		expect(pushToolResult).toHaveBeenCalledTimes(1)
		const message = (pushToolResult as any).mock.calls[0][0] as string
		expect(message).toContain("disallowed-server")
		expect(message).toContain("not allowed")
		expect(message).toContain("allowed-server")
	})

	it("rejects all invocations when allowlist is empty", async () => {
		mockModeAllowlist([])
		const task = makeTask({ mode: "code", customModes: [] })
		const pushToolResult = vi.fn()

		const result = await ensureMcpServerAllowed(
			task,
			"access_mcp_resource",
			"any-server",
			pushToolResult,
			toolError,
		)

		expect(result).toBe(false)
		expect(task.recordToolError).toHaveBeenCalledWith("access_mcp_resource")
		const message = (pushToolResult as any).mock.calls[0][0] as string
		expect(message).toContain("No MCP servers are allowed")
	})
})
