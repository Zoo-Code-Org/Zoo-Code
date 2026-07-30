import * as assert from "assert"

import { isSecretStateKey, RooCodeEventName, type ClineMessage, type GlobalState } from "@roo-code/types"

import { waitUntilCompleted } from "./utils"
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

		globalThis.api.on(RooCodeEventName.TaskModeSwitched, (taskId, mode) => modeEvents.push({ taskId, mode }))
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
			globalThis.api.off(RooCodeEventName.Message, completionHandler)
		}
	})
})
