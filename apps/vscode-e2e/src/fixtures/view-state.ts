import type { ChatCompletionRequest, ChatMessage, LLMock } from "@copilotkit/aimock"

const TASKS = ["A", "B", "C"] as const
const ROUNDS = 10

const MODE_SEQUENCES: Record<(typeof TASKS)[number], string[]> = {
	A: ["ask", "debug", "architect", "orchestrator", "code", "ask", "debug", "architect", "orchestrator", "code"],
	B: ["debug", "architect", "orchestrator", "code", "ask", "debug", "architect", "orchestrator", "code", "ask"],
	C: ["architect", "orchestrator", "code", "ask", "debug", "architect", "orchestrator", "code", "ask", "debug"],
}

const markerFor = (taskName: (typeof TASKS)[number]) => `FOLLOWUP_MODE_ISOLATION_${taskName}`
const answerFor = (taskName: (typeof TASKS)[number], round: number) => `${taskName} follow-up round ${round}`
const callIdFor = (taskName: (typeof TASKS)[number], round: number) =>
	`call_followup_mode_${taskName.toLowerCase()}_${String(round).padStart(2, "0")}`

const lastToolResultContains = (req: ChatCompletionRequest, toolCallId: string, expected: string[]) => {
	const messages = Array.isArray(req?.messages) ? req.messages : []
	const toolMessage = messages.filter((message: ChatMessage) => message?.role === "tool").at(-1)
	const content = toolMessage?.content

	return (
		toolMessage?.tool_call_id === toolCallId &&
		typeof content === "string" &&
		expected.every((text) => content.includes(text))
	)
}

const followupToolCall = (taskName: (typeof TASKS)[number], round: number) => ({
	name: "ask_followup_question",
	arguments: JSON.stringify({
		question: `Task ${taskName}: choose mode for round ${round}`,
		follow_up: [
			{
				text: answerFor(taskName, round),
				mode: MODE_SEQUENCES[taskName][round - 1],
			},
		],
	}),
	id: callIdFor(taskName, round),
})

export const getFollowupModeIsolationPlan = () =>
	TASKS.map((taskName) => ({
		taskName,
		marker: markerFor(taskName),
		rounds: MODE_SEQUENCES[taskName].map((mode, index) => ({
			round: index + 1,
			answer: answerFor(taskName, index + 1),
			mode,
		})),
	}))

export function addViewStateFixtures(mock: InstanceType<typeof LLMock>) {
	for (const taskName of TASKS) {
		mock.addFixture({
			match: {
				userMessage: markerFor(taskName),
			},
			response: {
				toolCalls: [followupToolCall(taskName, 1)],
			},
		})

		for (let round = 1; round < ROUNDS; round++) {
			mock.addFixture({
				match: {
					predicate: (req) =>
						lastToolResultContains(req, callIdFor(taskName, round), [answerFor(taskName, round)]),
				},
				response: {
					toolCalls: [followupToolCall(taskName, round + 1)],
				},
			})
		}

		mock.addFixture({
			match: {
				predicate: (req) =>
					lastToolResultContains(req, callIdFor(taskName, ROUNDS), [answerFor(taskName, ROUNDS)]),
			},
			response: {
				toolCalls: [
					{
						name: "attempt_completion",
						arguments: JSON.stringify({
							result: `Task ${taskName} completed ${ROUNDS} follow-up mode switches.`,
						}),
						id: `call_followup_mode_${taskName.toLowerCase()}_complete`,
					},
				],
			},
		})
	}
}
