import { getSharedToolUseSection } from "../tool-use"
import type { EffectiveToolPolicy } from "../../tools/effective-tool-policy"

describe("getSharedToolUseSection", () => {
	it("should include native tool-calling instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("provider-native tool-calling mechanism")
		expect(section).toContain("Do not include XML markup or examples")
	})

	it("allows a top-level answer without a tool while retaining explicit delegated handoff", () => {
		const section = getSharedToolUseSection()

		expect(section).toContain("A top-level task can finish with a plain-text answer")
		expect(section).toContain("Delegated tasks must use attempt_completion")
		expect(section).not.toContain("You must call at least one tool per assistant response")
		expect(section).toContain("Prefer calling as many tools as are reasonably needed")
	})

	it("should NOT include single tool per message restriction", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("You must use exactly one tool call per assistant response")
		expect(section).not.toContain("Do not call zero tools or more than one tool")
	})

	it("should NOT include XML formatting instructions", () => {
		const section = getSharedToolUseSection()

		expect(section).not.toContain("<actual_tool_name>")
		expect(section).not.toContain("</actual_tool_name>")
	})

	it("does not advertise a disabled completion tool", () => {
		const policy: EffectiveToolPolicy = {
			tools: new Set(),
			hasMcpGroup: false,
			hasMcpTools: false,
			hasMcpResources: false,
		}
		const section = getSharedToolUseSection(policy)
		expect(section).toContain("plain-text answer")
		expect(section).not.toContain("attempt_completion")
	})
})
