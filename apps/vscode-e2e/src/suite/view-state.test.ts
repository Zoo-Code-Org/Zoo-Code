import * as assert from "assert"

import { isSecretStateKey, RooCodeEventName, type ClineMessage, type GlobalState } from "@roo-code/types"

import { getFollowupModeIsolationPlan } from "../fixtures/view-state"
import { sleep, waitFor, waitUntilCompleted } from "./utils"
import { setDefaultSuiteTimeout } from "./test-utils"

const findSecretStatePath = (value: unknown, path: string[] = []): string | undefined => {
	if (!value || typeof value !== "object") {
		return undefined
	}

	for (const [key, nestedValue] of Object.entries(value)) {
		const nextPath = [...path, key]

		if (isSecretStateKey(key)) {
			return nextPath.join(".")
		}

		const nestedSecretPath = findSecretStatePath(nestedValue, nextPath)
		if (nestedSecretPath) {
			return nestedSecretPath
		}
	}

	return undefined
}

suite("Roo Code View State", function () {
	setDefaultSuiteTimeout(this)

	teardown(async () => {
		try {
			await globalThis.api.cancelCurrentTask()
		} catch {
			// Task might not be running.
		}
	})

	test("sidebar and tab panel keep mode isolated through the real ContextProxy singleton", async () => {
		const modeEvents: Array<{ taskId: string; mode: string }> = []
		const completionHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "ask" && message.ask === "completion_result") {
				void globalThis.api.approveTaskAsk(taskId)
			}
		}

		const modeHandler = (taskId: string, mode: string) => modeEvents.push({ taskId, mode })

		globalThis.api.on(RooCodeEventName.TaskModeSwitched, modeHandler)
		globalThis.api.on(RooCodeEventName.Message, completionHandler)

		try {
			const sidebarTaskId = await globalThis.api.startNewTask({
				configuration: {
					mode: "code",
					alwaysAllowModeSwitch: true,
					autoApprovalEnabled: true,
					apiKey: "sidebar-secret-must-not-persist",
				},
				text: "Use the `switch_mode` tool to switch to ask mode.",
			})
			await waitUntilCompleted({ api: globalThis.api, taskId: sidebarTaskId })

			const tabTaskId = await globalThis.api.startNewTask({
				configuration: {
					mode: "code",
					alwaysAllowModeSwitch: true,
					autoApprovalEnabled: true,
					apiKey: "tab-secret-must-not-persist",
				},
				text: "Use the `switch_mode` tool to switch to debug mode.",
				newTab: true,
			})
			await waitUntilCompleted({ api: globalThis.api, taskId: tabTaskId })

			// Each task's switch must be attributed to its own taskId only.
			assert.deepStrictEqual(
				modeEvents.filter((event) => event.taskId === sidebarTaskId).map((event) => event.mode),
				["ask"],
			)
			assert.deepStrictEqual(
				modeEvents.filter((event) => event.taskId === tabTaskId).map((event) => event.mode),
				["debug"],
			)

			// The tab panel's switch must not overwrite the sidebar's own state.
			// api.getConfiguration() always reads the sidebar provider.
			assert.strictEqual(globalThis.api.getConfiguration().mode, "ask")

			// Both per-view writes are awaited through the serialized view-state write queue
			// before the tasks complete, but a just-resolved globalState write can momentarily
			// lag a synchronous globalState.get in the extension host. Poll until both
			// persisted selections are visible before asserting on them. The 30s budget
			// matches the suite's other waits (waitUntilCompleted, follow-up polling) so a
			// slow memento flush under CI load cannot turn a correct write into a flake.
			await waitFor(
				() => {
					const persisted = globalThis.api.getGlobalState("viewStates") as GlobalState["viewStates"]
					if (!persisted) {
						return false
					}

					const entries = Object.entries(persisted)

					return (
						entries.length >= 2 &&
						entries.some(([, entry]) => entry.mode === "ask") &&
						entries.some(([, entry]) => entry.mode === "debug")
					)
				},
				{ timeout: 30_000 },
			)

			const viewStates = globalThis.api.getGlobalState("viewStates") as GlobalState["viewStates"]
			assert.ok(viewStates, "Expected persisted viewStates to exist")

			const persistedEntries = Object.entries(viewStates)
			assert.ok(persistedEntries.length >= 2, "Expected at least sidebar and tab persisted view state entries")
			assert.ok(
				persistedEntries.some(([, entry]) => entry.mode === "ask"),
				"Expected one persisted view state entry for the sidebar ask mode",
			)
			assert.ok(
				persistedEntries.some(([, entry]) => entry.mode === "debug"),
				"Expected one persisted view state entry for the tab debug mode",
			)

			for (const [viewStateId, entry] of persistedEntries) {
				const secretStatePath = findSecretStatePath(entry)
				assert.strictEqual(
					secretStatePath,
					undefined,
					`Persisted viewStates.${viewStateId} leaked secret state at ${secretStatePath}`,
				)
			}
		} finally {
			globalThis.api.off(RooCodeEventName.TaskModeSwitched, modeHandler)
			globalThis.api.off(RooCodeEventName.Message, completionHandler)
		}
	})
	test("three panels keep follow-up option mode switches isolated across ten staggered rounds", async () => {
		const plan = getFollowupModeIsolationPlan()
		const rounds = plan.reduce((max, taskPlan) => Math.max(max, taskPlan.rounds.length), 0)
		const modeEvents: Array<{ taskId: string; mode: string }> = []
		const deliveryFailures: string[] = []
		const taskIds = new Map<string, string>()
		const pendingSuggestions = new Map<string, { answer: string; mode?: string }>()
		const answeredSuggestions = new Set<string>()
		const suggestionKey = (taskId: string, answer: string) => `${taskId}:${answer}`
		let releasedRounds = 0
		let roundInFlight = false

		const taskIdsInPlanOrder = () =>
			plan.map((taskPlan) => taskIds.get(taskPlan.taskName)).filter((taskId): taskId is string => !!taskId)
		const modeCountForTask = (taskId: string) => modeEvents.filter((event) => event.taskId === taskId).length

		const maybeReleaseRound = () => {
			if (roundInFlight || taskIds.size !== plan.length) {
				return
			}

			const taskIdsInOrder = taskIdsInPlanOrder()
			if (
				taskIdsInOrder.length !== plan.length ||
				!taskIdsInOrder.every((taskId) => pendingSuggestions.has(taskId))
			) {
				return
			}

			roundInFlight = true
			releasedRounds++

			for (const taskId of taskIdsInOrder) {
				const suggestion = pendingSuggestions.get(taskId)
				assert.ok(suggestion, `Expected pending suggestion for task ${taskId}`)
				pendingSuggestions.delete(taskId)
				answeredSuggestions.add(suggestionKey(taskId, suggestion.answer))
				void globalThis.api
					.selectTaskFollowupSuggestion({ taskId, ...suggestion })
					.then((delivered) => {
						if (!delivered) {
							deliveryFailures.push(`${taskId}:${suggestion.answer}`)
						}
					})
					.catch((error: unknown) => {
						deliveryFailures.push(
							`${taskId}:${suggestion.answer}:${error instanceof Error ? error.message : String(error)}`,
						)
					})
			}
		}

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "ask" && message.ask === "followup" && message.text) {
				try {
					const parsed = JSON.parse(message.text) as { suggest?: Array<{ answer: string; mode?: string }> }
					const suggestion = parsed.suggest?.[0]

					if (suggestion && !answeredSuggestions.has(suggestionKey(taskId, suggestion.answer))) {
						pendingSuggestions.set(taskId, suggestion)
						maybeReleaseRound()
					}
				} catch {
					// Ignore partial or malformed follow-up payloads.
				}
			}

			if (message.type === "ask" && message.ask === "completion_result") {
				void globalThis.api.approveTaskAsk(taskId)
			}
		}
		const modeHandler = (taskId: string, mode: string) => {
			modeEvents.push({ taskId, mode })

			if (roundInFlight && taskIdsInPlanOrder().every((id) => modeCountForTask(id) >= releasedRounds)) {
				roundInFlight = false
				maybeReleaseRound()
			}
		}

		globalThis.api.on(RooCodeEventName.Message, messageHandler)
		globalThis.api.on(RooCodeEventName.TaskModeSwitched, modeHandler)

		try {
			for (const [index, taskPlan] of plan.entries()) {
				if (index > 0) {
					await sleep(1_000)
				}

				const taskId = await globalThis.api.startNewTask({
					configuration: {
						mode: "code",
						alwaysAllowModeSwitch: true,
						autoApprovalEnabled: true,
						apiKey: `followup-secret-${taskPlan.taskName}-must-not-persist`,
					},
					text: taskPlan.marker,
					newTab: true,
					preserveOpenTabs: index > 0,
				})
				taskIds.set(taskPlan.taskName, taskId)
				maybeReleaseRound()
			}

			await waitFor(
				() => {
					const expectedSwitches = plan.length * rounds
					return modeEvents.length >= expectedSwitches
				},
				{ timeout: 30_000 },
			).catch((error) => {
				const counts = plan.map((taskPlan) => {
					const taskId = taskIds.get(taskPlan.taskName)
					return `${taskPlan.taskName}:${taskId ? modeCountForTask(taskId) : 0}`
				})
				const deliveryFailureDetail =
					deliveryFailures.length > 0 ? `; suggestion delivery failures: ${deliveryFailures.join(", ")}` : ""
				throw new Error(
					`Timed out after ${releasedRounds} coordinated rounds; mode event counts: ${counts.join(", ")}; pending suggestions: ${pendingSuggestions.size}${deliveryFailureDetail}. ${error instanceof Error ? error.message : String(error)}`,
				)
			})

			for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
				const actualRoundModes = plan.map((taskPlan) => {
					const taskId = taskIds.get(taskPlan.taskName)
					assert.ok(taskId, `Expected task id for task ${taskPlan.taskName}`)
					return modeEvents.filter((event) => event.taskId === taskId).map((event) => event.mode)[roundIndex]
				})
				const expectedRoundModes = plan.map((taskPlan) => {
					const round = taskPlan.rounds[roundIndex]
					assert.ok(round, `Expected round ${roundIndex + 1} for task ${taskPlan.taskName}`)
					return round.mode
				})

				assert.deepStrictEqual(
					actualRoundModes,
					expectedRoundModes,
					`Round ${roundIndex + 1} should count only after all three tasks switch once`,
				)
			}

			for (const taskPlan of plan) {
				const taskId = taskIds.get(taskPlan.taskName)
				assert.ok(taskId, `Expected task id for task ${taskPlan.taskName}`)
				assert.deepStrictEqual(
					modeEvents.filter((event) => event.taskId === taskId).map((event) => event.mode),
					taskPlan.rounds.map((round) => round.mode),
				)
			}

			const viewStates = globalThis.api.getGlobalState("viewStates") as GlobalState["viewStates"]
			assert.ok(viewStates, "Expected persisted viewStates to exist")

			for (const [viewStateId, entry] of Object.entries(viewStates)) {
				const secretStatePath = findSecretStatePath(entry)
				assert.strictEqual(
					secretStatePath,
					undefined,
					`Persisted viewStates.${viewStateId} leaked secret state at ${secretStatePath}`,
				)
			}
		} finally {
			globalThis.api.off(RooCodeEventName.Message, messageHandler)
			globalThis.api.off(RooCodeEventName.TaskModeSwitched, modeHandler)
		}
	})
})
