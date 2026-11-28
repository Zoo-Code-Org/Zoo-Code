import type { ApiMessage } from "../../task-persistence"
import { projectEnvironmentHistory } from "../projectEnvironmentHistory"

function userEnvironment(text: string): ApiMessage {
	return { role: "user", content: [{ type: "text", text }] }
}

describe("projectEnvironmentHistory", () => {
	it("drops stale state and reminders but keeps unique terminal and file observations", () => {
		const oldEnvironment = `<environment_details>
# VSCode Visible Files
old.ts

# Recently Modified Files
changed.ts

# Actively Running Terminals
## Terminal 1 (Active)
### New Output
Build finished

# Current Time
yesterday

# Current Mode
code

====

REMINDERS

| # | Content | Status |
| 1 | Run tests | Pending |
</environment_details>`
		const latestEnvironment = `<environment_details>
# VSCode Visible Files
new.ts

# Current Time
today
</environment_details>`
		const old = userEnvironment(oldEnvironment)
		const latest = userEnvironment(latestEnvironment)
		const history: ApiMessage[] = [
			old,
			{ role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }] },
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "call-1", content: "File contents" }],
			},
			latest,
		]

		const projected = projectEnvironmentHistory(history)
		const oldText = (projected[0].content as Array<{ text: string }>)[0].text
		expect(oldText).toContain("changed.ts")
		expect(oldText).toContain("Build finished")
		expect(oldText).not.toContain("old.ts")
		expect(oldText).not.toContain("yesterday")
		expect(oldText).not.toContain("REMINDERS")
		expect(projected[2]).toBe(history[2])
		expect(projected[3]).toBe(latest)
		expect((old.content as Array<{ text: string }>)[0].text).toBe(oldEnvironment)
	})

	it("removes a stale block consisting only of recurring state without touching user text", () => {
		const userText = { type: "text" as const, text: "Please inspect the file" }
		const history: ApiMessage[] = [
			{
				role: "user",
				content: [
					userText,
					{ type: "text", text: "<environment_details>\n# Current Cost\n$1.00\n</environment_details>" },
				],
			},
			userEnvironment("<environment_details>\n# Current Cost\n$2.00\n</environment_details>"),
		]
		const projected = projectEnvironmentHistory(history)
		expect(projected[0].content).toEqual([userText])
		expect(projected[1]).toBe(history[1])
	})

	it("does not treat quoted tags or unfamiliar sections as disposable", () => {
		const quoted = { role: "user", content: "Explain <environment_details> tags" } satisfies ApiMessage
		const older = userEnvironment("<environment_details>\n# New Observation\nKeep this\n</environment_details>")
		const latest = userEnvironment("<environment_details>\n# Current Mode\ncode\n</environment_details>")
		const projected = projectEnvironmentHistory([quoted, older, latest])
		expect(projected[0]).toBe(quoted)
		expect(projected[1]).toBe(older)
	})
})
