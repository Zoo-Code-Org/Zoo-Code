import { expect, test } from "bun:test"

import { formatAgentListJSON } from "../../src/cli/cmd/agent"
import type { Agent } from "../../src/agent/agent"

test("formats agent list as stable curated JSON", () => {
	const agents: Agent.Info[] = [
		{
			name: "architect",
			displayName: "Architect",
			description: "Plan changes",
			mode: "primary",
			native: true,
			hidden: false,
			variant: "high",
			permission: [{ permission: "edit", pattern: "*", action: "deny" }],
			prompt: "large system prompt should not be printed",
			options: { privateOption: true },
		},
		{
			name: "reviewer",
			description: "Review code",
			mode: "subagent",
			permission: [{ permission: "read", pattern: "*", action: "allow" }],
			options: {},
		},
	]

	const parsed = JSON.parse(formatAgentListJSON(agents))

	expect(parsed).toEqual([
		{
			name: "architect",
			displayName: "Architect",
			description: "Plan changes",
			mode: "primary",
			native: true,
			hidden: false,
			variant: "high",
			permission: [{ permission: "edit", pattern: "*", action: "deny" }],
		},
		{
			name: "reviewer",
			description: "Review code",
			mode: "subagent",
			permission: [{ permission: "read", pattern: "*", action: "allow" }],
		},
	])
	expect(parsed[0].prompt).toBeUndefined()
	expect(parsed[0].options).toBeUndefined()
})
