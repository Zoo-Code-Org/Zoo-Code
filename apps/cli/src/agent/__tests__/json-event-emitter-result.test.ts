import type { ClineMessage } from "@roo-code/types"
import { Writable } from "stream"

import type { TaskCompletedEvent } from "../events.js"
import { JsonEventEmitter } from "../json-event-emitter.js"
import { AgentLoopState, type AgentStateInfo } from "../agent-state.js"

function createMockStdout(): { stdout: NodeJS.WriteStream; lines: () => Record<string, unknown>[] } {
	const chunks: string[] = []

	const writable = new Writable({
		write(chunk, _encoding, callback) {
			chunks.push(chunk.toString())
			callback()
		},
	}) as unknown as NodeJS.WriteStream // Provides the writable stream members consumed by the emitter.

	const lines = () =>
		chunks
			.join("")
			.split("\n")
			.filter((line) => line.length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>)

	return { stdout: writable, lines }
}

function emitMessage(emitter: JsonEventEmitter, message: ClineMessage): void {
	emitter["handleMessage"](message, false)
}

function emitTaskCompleted(emitter: JsonEventEmitter, event: TaskCompletedEvent): void {
	emitter["handleTaskCompleted"](event)
}

function createAskCompletionMessage(ts: number, text = ""): ClineMessage {
	return {
		ts,
		type: "ask",
		ask: "completion_result",
		partial: false,
		text,
	} as ClineMessage
}

function createCompletedStateInfo(message: ClineMessage): AgentStateInfo {
	return {
		state: AgentLoopState.IDLE,
		isWaitingForInput: true,
		isRunning: false,
		isStreaming: false,
		currentAsk: "completion_result",
		requiredAction: "start_task",
		lastMessageTs: message.ts,
		lastMessage: message,
		description: "Task completed successfully. You can provide feedback or start a new task.",
	}
}

describe("JsonEventEmitter result emission", () => {
	it("prefers current completion message content over stale cached completion text", () => {
		const { stdout, lines } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout })

		emitMessage(emitter, {
			ts: 100,
			type: "say",
			say: "completion_result",
			partial: false,
			text: "FIRST",
		} as ClineMessage)

		const firstCompletionMessage = createAskCompletionMessage(101, "")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(firstCompletionMessage),
			message: firstCompletionMessage,
		})

		const secondCompletionMessage = createAskCompletionMessage(102, "SECOND")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(secondCompletionMessage),
			message: secondCompletionMessage,
		})

		const output = lines().filter((line) => line.type === "result")
		expect(output).toHaveLength(2)
		expect(output[0]?.content).toBe("FIRST")
		expect(output[1]?.content).toBe("SECOND")
	})

	it("emits instruction_refresh_warning to JSON consumers", () => {
		const { stdout, lines } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout })

		emitMessage(emitter, {
			ts: 150,
			type: "say",
			say: "instruction_refresh_warning",
			partial: false,
			text: "/workspace/.roo/rules/a.md (EACCES)\n/workspace/AGENTS.md (UNKNOWN)",
		})

		const warnings = lines().filter((line) => line.subtype === "instruction_refresh_warning")
		expect(warnings).toHaveLength(1)
		expect(warnings[0]).toMatchObject({
			type: "assistant",
			content: "/workspace/.roo/rules/a.md (EACCES)\n/workspace/AGENTS.md (UNKNOWN)",
		})
	})

	it("clears cached completion text after each result emission", () => {
		const { stdout, lines } = createMockStdout()
		const emitter = new JsonEventEmitter({ mode: "stream-json", stdout })

		emitMessage(emitter, {
			ts: 200,
			type: "say",
			say: "completion_result",
			partial: false,
			text: "FIRST",
		} as ClineMessage)

		const firstCompletionMessage = createAskCompletionMessage(201, "")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(firstCompletionMessage),
			message: firstCompletionMessage,
		})

		const secondCompletionMessage = createAskCompletionMessage(202, "")
		emitTaskCompleted(emitter, {
			success: true,
			stateInfo: createCompletedStateInfo(secondCompletionMessage),
			message: secondCompletionMessage,
		})

		const output = lines().filter((line) => line.type === "result")
		expect(output).toHaveLength(2)
		expect(output[0]?.content).toBe("FIRST")
		expect(output[1]).not.toHaveProperty("content")
	})
})
