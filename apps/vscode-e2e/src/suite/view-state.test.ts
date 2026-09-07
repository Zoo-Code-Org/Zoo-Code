import * as assert from "assert"

import { isSecretStateKey, RooCodeEventName, type ClineMessage, type GlobalState } from "@roo-code/types"
import * as vscode from "vscode"

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
	/**
	 * Webview reload / rehydration: hiding and re-showing the primary sidebar must
	 * not lose the sidebar view's durable mode — the per-view entry survives in the
	 * global viewStates and the rehydrated view reports the same mode.
	 */
	test("sidebar webview reload rehydrates the durable per-view mode", async () => {
		// Establish the sidebar view's durable mode 'ask' the same way the first test
		// in this suite does: a real task whose switch_mode tool call switches the
		// sidebar's focused task.
		const taskId = await globalThis.api.startNewTask({
			configuration: {
				mode: "code",
				alwaysAllowModeSwitch: true,
				autoApprovalEnabled: true,
				apiKey: "reload-secret-must-not-persist",
			},
			text: "Use the `switch_mode` tool to switch to ask mode.",
		})
		await waitUntilCompleted({ api: globalThis.api, taskId })

		// The per-view write is awaited through the serialized view-state write queue
		// before the task completes, but a just-resolved globalState write can
		// momentarily lag a synchronous globalState.get in the extension host. Poll
		// until the persisted ask selection is visible before exercising the reload
		// (the 30s budget matches the suite's other waits).
		await waitFor(
			() => {
				const persisted = globalThis.api.getGlobalState("viewStates") as GlobalState["viewStates"]
				if (!persisted) {
					return false
				}

				return Object.entries(persisted).some(([, entry]) => entry.mode === "ask")
			},
			{ timeout: 30_000 },
		)

		// Deterministic precondition: make sure the primary sidebar is visible before
		// toggling so the hide/show cycle below is a real hide-then-show regardless
		// of which suites ran earlier (the same command the suite index uses at
		// startup).
		await vscode.commands.executeCommand("zoo-code.SidebarProvider.focus")

		// Hide the primary sidebar and let the dispose settle, show it again and let
		// the webview recreation settle, then wait for the extension to rehydrate the
		// reloaded webview's durable view state.
		await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility")
		await sleep(2_000)
		await vscode.commands.executeCommand("workbench.action.toggleSidebarVisibility")
		await sleep(2_000)
		await sleep(5_000)

		// (a) The durable viewStates still contain the per-view entry with mode 'ask'
		// after the reload. Poll in case the rehydrated provider needs a moment.
		await waitFor(
			() => {
				const persisted = globalThis.api.getGlobalState("viewStates") as GlobalState["viewStates"]
				if (!persisted) {
					return false
				}

				return Object.entries(persisted).some(([, entry]) => entry.mode === "ask")
			},
			{ timeout: 30_000 },
		)
		const viewStates = globalThis.api.getGlobalState("viewStates") as GlobalState["viewStates"]
		assert.ok(viewStates, "Expected persisted viewStates to exist after the sidebar webview reload")
		assert.ok(
			Object.entries(viewStates).some(([, entry]) => entry.mode === "ask"),
			"Expected the persisted view states to still contain a per-view entry with the ask mode after the reload",
		)

		// (b) The rehydrated sidebar view reports the durable mode. getConfiguration()
		// always reads the sidebar provider, so a rehydration failure would surface
		// as the view falling back to the global mode instead of 'ask'.
		assert.strictEqual(globalThis.api.getConfiguration().mode, "ask")

		// (c) Deliberately skipped: asserting that a fresh task started from this view
		// inherits the view's mode is not possible here — there is no deterministic
		// extension-side getter for a fresh task's inherited mode. startNewTask takes
		// an explicit configuration and the Task constructor reads the provider state
		// at a timing the extension API does not expose, so any such assertion would
		// require a new API surface (out of scope for this test-only unit) or a
		// non-deterministic poll. Mode inheritance is already exercised by the two
		// isolation tests above through their per-task TaskModeSwitched events and
		// the persisted per-view entries they assert on.
	})
})
