import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { RooCodeEventName, type TaskEvent } from "@roo-code/types"
import { collectEvidence, smokeCode, type SmokeEvidence } from "./evidence.ts"
const fresh = (): SmokeEvidence => ({
	providerResponseSeen: false,
	completionSeen: false,
	unexpectedTool: false,
	aborted: false,
})
const usage = (
	taskId: string,
	totalTokensOut: number,
): Extract<TaskEvent, { eventName: RooCodeEventName.TaskTokenUsageUpdated }> => ({
	eventName: RooCodeEventName.TaskTokenUsageUpdated,
	payload: [taskId, { totalTokensIn: 1, totalTokensOut, totalCost: 0, contextTokens: 1 }, {}],
})
const message = (taskId: string, value: Record<string, unknown>) => ({
	eventName: RooCodeEventName.Message,
	payload: [{ taskId, action: "created", message: { ts: 1, ...value } }],
})

describe("provider smoke evidence", () => {
	it("rejects malformed and uncorrelated events, including activity before task acceptance", () => {
		const state = fresh()
		collectEvidence(state, usage("root", 5), undefined)
		collectEvidence(state, usage("other", 5), "root")
		collectEvidence(
			state,
			{ eventName: RooCodeEventName.TaskTokenUsageUpdated, payload: ["root", { totalTokensOut: "5" }, {}] },
			"root",
		)
		assert.deepEqual(state, fresh())
	})
	it("requires actual output usage; echoed task text is not provider evidence", () => {
		const state = fresh()
		collectEvidence(state, message("root", { type: "say", say: "text", text: "task prompt" }), "root")
		collectEvidence(state, usage("root", 0), "root")
		assert.equal(state.providerResponseSeen, false)
		collectEvidence(state, usage("root", 5), "root")
		assert.equal(state.providerResponseSeen, true)
	})
	it("accepts any non-empty completed response, without reviewing its meaning", () => {
		const state = fresh()
		collectEvidence(
			state,
			message("root", { type: "say", say: "completion_result", text: "any completion", partial: true }),
			"root",
		)
		assert.equal(state.completionSeen, false)
		collectEvidence(
			state,
			message("root", { type: "say", say: "completion_result", text: "any completion" }),
			"root",
		)
		assert.equal(state.completionSeen, true)
		assert.ok(!JSON.stringify(state).includes("any completion"))
	})
	it("allows the final completion dialog but rejects other tools", () => {
		const state = fresh()
		collectEvidence(state, message("root", { type: "ask", ask: "completion_result" }), "root")
		assert.equal(state.completionSeen, false)
		assert.equal(state.unexpectedTool, false)
		collectEvidence(state, message("other", { type: "ask", ask: "command", text: "ignored" }), "root")
		assert.equal(state.unexpectedTool, false)
		collectEvidence(state, message("root", { type: "ask", ask: "command", text: "never stored" }), "root")
		assert.equal(state.unexpectedTool, true)
		const noAsk = fresh()
		const attempted = usage("root", 5)
		attempted.payload[2] = { execute_command: { attempts: 1, failures: 1 } }
		collectEvidence(noAsk, attempted, "root")
		assert.equal(noAsk.unexpectedTool, true)
	})
	it("cannot pass on activation alone or ignore a lost session", () => {
		assert.equal(smokeCode(fresh(), false), "PROVIDER_TIMEOUT")
		assert.equal(smokeCode({ ...fresh(), providerResponseSeen: true }, false), "COMPLETION_MISSING")
		assert.equal(smokeCode({ ...fresh(), providerResponseSeen: true, completionSeen: true }, false), "OK")
		assert.equal(smokeCode({ ...fresh(), providerResponseSeen: true, completionSeen: true }, true), "SESSION_LOST")
		assert.equal(
			smokeCode({ ...fresh(), providerResponseSeen: true, completionSeen: true, unexpectedTool: true }, false),
			"UNEXPECTED_TOOL",
		)
	})
	it("rejects delegation and aborts on the accepted root", () => {
		const state = fresh()
		collectEvidence(state, { eventName: RooCodeEventName.TaskDelegated, payload: ["root", "child"] }, "root")
		assert.equal(state.unexpectedTool, true)
		collectEvidence(state, { eventName: RooCodeEventName.TaskAborted, payload: ["root"] }, "root")
		assert.equal(smokeCode(state, false), "SESSION_LOST")
	})
})
