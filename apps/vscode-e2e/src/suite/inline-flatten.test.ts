import * as assert from "assert"

import { RooCodeEventName, type ClineMessage } from "@roo-code/types"

import {
	FLATTEN_CHILD_RESUME_RESULT,
	FLATTEN_DEPTH2_RESULT,
	FLATTEN_ROOT_PROMPT,
	FLATTEN_ROOT_RESULT,
} from "../fixtures/inline-flatten"
import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitUntilCompleted } from "./utils"

suite("Roo Code Inline Flatten", function () {
	setDefaultSuiteTimeout(this)

	// A three-level new_task chain: root (depth 0) -> child (depth 1) -> depth-2 task.
	// The depth-2 task's own new_task call would exceed maxNestingDepth (default 2), so the
	// tool flattens it inline instead of opening a fourth tab. This crosses real extension-
	// host boundaries (task instances, delegation links, webview events) that unit tests
	// cannot represent.
	test("depth-limit new_task flattens inline: no fourth task opens", async () => {
		const api = globalThis.api
		const says: Record<string, ClineMessage[]> = {}
		let maxStackLength = 0

		const messageHandler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
			if (message.type === "say" && message.partial === false) {
				says[taskId] = says[taskId] || []
				says[taskId].push(message)
			}

			const stackLength = api.getCurrentTaskStack().length
			if (stackLength > maxStackLength) {
				maxStackLength = stackLength
			}
		}

		api.on(RooCodeEventName.Message, messageHandler)

		try {
			const rootTaskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: {
							mode: "ask",
							alwaysAllowModeSwitch: true,
							alwaysAllowSubtasks: true,
							autoApprovalEnabled: true,
							enableCheckpoints: false,
						},
						text: FLATTEN_ROOT_PROMPT,
					}),
			})

			const taskIds = Object.keys(says)
			assert.strictEqual(
				taskIds.length,
				3,
				`Expected exactly 3 tasks (root, child, depth-2); observed ${taskIds.join(", ")}`,
			)

			// The flattened work ran in the depth-2 task's own conversation — its completion
			// carries the inline result. No fourth task exists to carry it.
			const depth2TaskId = taskIds.find(
				(taskId) =>
					taskId !== rootTaskId &&
					says[taskId]?.some(
						({ say, text }) => say === "completion_result" && text?.trim() === FLATTEN_DEPTH2_RESULT,
					),
			)
			assert.ok(depth2TaskId, `Depth-2 task should complete with the inline result "${FLATTEN_DEPTH2_RESULT}"`)

			// The child resumed after its (flattened) subtask returned.
			const childTaskId = taskIds.find((taskId) => taskId !== rootTaskId && taskId !== depth2TaskId)
			assert.ok(
				says[childTaskId!]?.some(
					({ say, text }) => say === "completion_result" && text?.trim() === FLATTEN_CHILD_RESUME_RESULT,
				),
				"Child should resume and complete after the flattened subtask returns",
			)

			// The root resumed last with the chain result.
			assert.strictEqual(
				says[rootTaskId]
					?.filter(({ say }) => say === "completion_result")
					.map(({ text }) => text?.trim())
					.find((text): text is string => !!text),
				FLATTEN_ROOT_RESULT,
				"Root should resume with the chain result after the child returns",
			)

			// The task stack never held more than the three real tasks — flattening opened no tab.
			assert.ok(
				maxStackLength <= 3,
				`Task stack should never exceed 3 (flattened work opens no new task); observed max ${maxStackLength}`,
			)
		} finally {
			api.off(RooCodeEventName.Message, messageHandler)
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await sleep(1_500)
		}
	})
})
