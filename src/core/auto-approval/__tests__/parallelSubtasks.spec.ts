// npx vitest run src/core/auto-approval/__tests__/parallelSubtasks.spec.ts

import { checkAutoApproval } from ".."

import { CWD, baseState } from "./fixtures"

const parallelSubtasksAsk = JSON.stringify({
	tool: "parallelSubtasks",
	tasks: [{ label: "api-surface", mode: "code", message: "Map the public API." }],
})

describe("alwaysAllowSubtasks covers parallelSubtasks", () => {
	it("approves the fan-out when the subtask switch is on", async () => {
		await expect(
			checkAutoApproval({
				state: { ...baseState, alwaysAllowSubtasks: true },
				cwd: CWD,
				ask: "tool",
				text: parallelSubtasksAsk,
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it("asks when the subtask switch is off", async () => {
		await expect(
			checkAutoApproval({ state: baseState, cwd: CWD, ask: "tool", text: parallelSubtasksAsk }),
		).resolves.toEqual({
			decision: "ask",
		})
	})
})

describe("alwaysAllowSubtasks mapping for newTask and finishTask", () => {
	it.each(["newTask", "finishTask"])("approves %s when the switch is on", async (tool) => {
		await expect(
			checkAutoApproval({
				state: { ...baseState, alwaysAllowSubtasks: true },
				cwd: CWD,
				ask: "tool",
				text: JSON.stringify({ tool }),
			}),
		).resolves.toEqual({ decision: "approve" })
	})

	it.each(["newTask", "finishTask"])("asks for %s when the switch is off", async (tool) => {
		await expect(
			checkAutoApproval({ state: baseState, cwd: CWD, ask: "tool", text: JSON.stringify({ tool }) }),
		).resolves.toEqual({ decision: "ask" })
	})
})

describe("scope of the subtask switch", () => {
	it("does not approve an unrelated file read", async () => {
		await expect(
			checkAutoApproval({
				state: { ...baseState, alwaysAllowSubtasks: true },
				cwd: CWD,
				ask: "tool",
				text: JSON.stringify({ tool: "readFile", path: "src/index.ts" }),
			}),
		).resolves.toEqual({ decision: "ask" })
	})

	it("asks for the fan-out when auto-approval is disabled entirely", async () => {
		await expect(
			checkAutoApproval({
				state: { ...baseState, autoApprovalEnabled: false, alwaysAllowSubtasks: true },
				cwd: CWD,
				ask: "tool",
				text: parallelSubtasksAsk,
			}),
		).resolves.toEqual({ decision: "ask" })
	})
})
