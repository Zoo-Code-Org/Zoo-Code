import * as assert from "assert"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode"

import {
	RooCodeEventName,
	type ClineMessage,
	type Experiments,
	type ParallelSubtaskInfo,
	type RooCodeSettings,
} from "@roo-code/types"

import { setDefaultSuiteTimeout } from "./test-utils"
import { sleep, waitFor, waitUntilCompleted } from "./utils"

// Probe tags are matched by substring against the LAST user message of each API
// request. They are unique to this suite and timestamp-free by construction; the
// parent prompts never embed a child tag, so a child fixture can never fire on a
// parent request (see fixtures/parallel-subtasks.json).
//
// Turn-2 matching: this extension appends a trailing `<environment_details>` user
// message after every tool result, so a tool-result turn's LAST user message no
// longer carries the probe, and aimock's toolCallId/toolResultContains matchers
// (last-message-only) can never see it. Every post-tool turn instead matches on
// the mode-specific roleDefinition that the host puts in the system prompt, and
// each scenario pins its own model id (via the public settings API) so fixtures
// are scoped per scenario and can never collide with other suites or with the
// global `<environment_details>` fallback fixture in runTest.ts.
//
// Request-shape assertions read captured request bodies from the fetch
// interceptor below, not the aimock journal: the journal caps bodies at 64 KB
// and this extension's requests (full system prompt) always exceed that.
const FANOUT_PARENT_PROMPT =
	"PST_E2E_SMOKE_A: Use the parallel_subtasks tool to run the three read-only investigations, then complete with the final summary."
const CANCEL_PARENT_PROMPT =
	"PST_E2E_CANCEL: Use the parallel_subtasks tool to run the two read-only investigations, then complete with the final summary."
const DEPTH1_PARENT_PROMPT =
	"PST_E2E_DEPTH1: Use the parallel_subtasks tool to run the single read-only investigation, then complete with the final summary."

const FANOUT_MODEL_ID = "pst-e2e-fanout"
const CANCEL_MODEL_ID = "pst-e2e-cancel"
const DEPTH1_MODEL_ID = "pst-e2e-depth1"

const FANOUT_PARENT_RESULT = "PST_E2E_PARENT_A_RESULT"
const DEPTH1_PARENT_RESULT = "PST_E2E_DEPTH1_PARENT_RESULT"

// Written into the probe file in suiteSetup; a successfully approved child read
// returns it in the read_file tool result, so it doubles as the content marker
// the fan-out test asserts on.
const PROBE_FILE_CONTENT_MARKER = "parallel-subtasks probe: fan-out markers"

const FANOUT_CHILDREN = [
	{ key: "a", label: "api-surface", tag: "PST_E2E_CHILD_A", marker: "PST_E2E_CHILD_A_RESULT" },
	{ key: "b", label: "debug-logs", tag: "PST_E2E_CHILD_B", marker: "PST_E2E_CHILD_B_RESULT" },
	{ key: "c", label: "test-plan", tag: "PST_E2E_CHILD_C", marker: "PST_E2E_CHILD_C_RESULT" },
]

const CANCEL_CHILD_TTFT_MS = 15_000
const CANCEL_DRAIN_GRACE_MS = 500

// The parent runs in architect mode so its post-tool turns are matched by the
// architect roleDefinition, never colliding with the code/debug/ask children.
// D4 contract: this configuration sets autoApprovalEnabled: true but grants no
// read access, so a child's read_file ask is not globally auto-approved; it is
// the D4 background-child carve-out (resolveBackgroundChildAsk in Task.ts)
// that approves the read. Non-read asks fail closed (auto-denied). The
// approval fields are pinned explicitly (not merely omitted): startNewTask
// persists this configuration through setValues, so an alwaysAllowReadOnly /
// allowed*Files value inherited from a previously persisted configuration or
// an earlier suite would otherwise reach these tasks and let the read bypass
// the carve-out, masking a regression. The read-result content assertion in
// the fan-out test is the tripwire: remove the carve-out and the result
// carries the denial text instead of the probe file contents.
const scenarioConfiguration: RooCodeSettings = {
	mode: "architect",
	alwaysAllowModeSwitch: true,
	alwaysAllowSubtasks: true,
	autoApprovalEnabled: true,
	enableCheckpoints: false,
	alwaysAllowReadOnly: false,
	allowedReadFiles: [],
	allowedWriteFiles: [],
}

const TERMINAL_SUBTASK_STATUSES = new Set(["completed", "failed", "aborted"])

// Request capture. aimock's journal caps request bodies at 64 KB and replaces
// larger ones (every real request here carries the full system prompt) with a
// truncation marker, so journal-based content assertions cannot work. The suite
// instead records the exact chat-completion request bodies through a fetch
// interceptor, which also captures the requests that never reach the mock
// (cancelled in-flight children). The interceptor is installed before any task
// starts because the OpenAI SDK resolves fetch at client construction.
type CapturedRequestMessage = {
	role?: string
	content?: unknown
	tool_call_id?: string
}

type CapturedChatRequest = {
	model?: string
	messages?: CapturedRequestMessage[]
}

type CapturedRequest = {
	observedAt: number
	body: CapturedChatRequest
}

const capturedRequests: CapturedRequest[] = []

let restoreFetch: (() => void) | undefined

const installFetchCapture = () => {
	const original = globalThis.fetch
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		try {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
			if (url.includes("/chat/completions") && typeof init?.body === "string") {
				capturedRequests.push({ observedAt: Date.now(), body: JSON.parse(init.body) as CapturedChatRequest })
			}
		} catch {
			// Capture is best-effort; it must never break a request.
		}
		return original.call(globalThis, input, init)
	}) as typeof globalThis.fetch
	restoreFetch = () => {
		globalThis.fetch = original
	}
}

const requestContentText = (content: unknown): string => {
	if (typeof content === "string") {
		return content
	}
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof part === "object" && part !== null && "text" in part
					? String((part as { text?: unknown }).text ?? "")
					: "",
			)
			.join("")
	}
	return ""
}

// Joined text of every user message in the captured request. aimock fixtures match
// on the last user message; joining all of them keeps these helpers a strict
// superset, which is fine because the probe tags only ever appear in task prompts.
const capturedUserText = (captured: CapturedRequest) =>
	(captured.body.messages ?? [])
		.filter((message) => message.role === "user")
		.map((message) => requestContentText(message.content))
		.join("")

const findCapturedToolMessage = (captured: CapturedRequest | undefined, toolCallId: string) =>
	captured?.body.messages?.find((message) => message.role === "tool" && message.tool_call_id === toolCallId)

// Waits for a request carrying `probe` in a user message to be captured and
// returns the capture time, so post-test drains can anchor to the exact request
// this test created (never earlier traffic).
const waitForCapturedRequest = async (probe: string): Promise<number | undefined> => {
	let observedAt: number | undefined

	await waitFor(() => {
		const match = capturedRequests.find((captured) => capturedUserText(captured).includes(probe))
		if (match) {
			observedAt = match.observedAt
		}
		return match !== undefined
	})

	return observedAt
}

// The cancelled children's first SSE chunks are delayed by CANCEL_CHILD_TTFT_MS.
// Wait out the remainder of that window before the next test can open another
// streamed request against the same mock, anchored to the captured request times.
const waitForCancelledChildStreamDrain = async (...requestTimes: Array<number | undefined>) => {
	const anchored = requestTimes.filter((time): time is number => time !== undefined)
	if (anchored.length === 0) {
		return
	}

	const deadlineMs = Math.max(...anchored) + CANCEL_CHILD_TTFT_MS + CANCEL_DRAIN_GRACE_MS
	const remainingMs = deadlineMs - Date.now()
	if (remainingMs > 0) {
		await sleep(remainingMs)
	}
}

type ParallelSubtasksPanel = { tool: string; subtasks: ParallelSubtaskInfo[] }

type PanelRow = { partial: boolean | undefined; panel: ParallelSubtasksPanel }

// The emitter mutates one message object in place (a partial row's `partial` flips
// to false when finalized), so collectors must snapshot primitives at event time;
// keeping the reference would erase the partial flag before assertions run.
type MessageSnapshot = {
	type: string | undefined
	say: string | undefined
	text: string | undefined
	partial: boolean | undefined
}

// Every panel update is a say:"tool" row whose text is the panel JSON. The host
// creates one partial row while children run and finalizes it (partial cleared)
// when the join settles, so the snapshots carry one entry per update.
const parsePanelRows = (messages: MessageSnapshot[] | undefined): PanelRow[] =>
	(messages ?? []).flatMap((message) => {
		if (message.type !== "say" || message.say !== "tool" || typeof message.text !== "string") {
			return []
		}
		try {
			const parsed = JSON.parse(message.text) as ParallelSubtasksPanel
			return parsed.tool === "parallelSubtasks" && Array.isArray(parsed.subtasks) && parsed.subtasks.length > 0
				? [{ partial: message.partial, panel: parsed }]
				: []
		} catch {
			return []
		}
	})

const collectMessages = () => {
	const byTask: Record<string, MessageSnapshot[]> = {}
	const handler = ({ taskId, message }: { taskId: string; message: ClineMessage }) => {
		const messages = (byTask[taskId] ??= [])
		messages.push({ type: message.type, say: message.say, text: message.text, partial: message.partial })
	}
	globalThis.api.on(RooCodeEventName.Message, handler)
	return {
		byTask,
		stop: () => globalThis.api.off(RooCodeEventName.Message, handler),
	}
}

const completionResultOf = (messages: MessageSnapshot[] | undefined) =>
	(messages ?? [])
		.filter((message) => message.type === "say" && message.say === "completion_result" && message.partial === false)
		.map((message) => message.text?.trim())
		.find((text): text is string => !!text)

suite("Roo Code Parallel Subtasks", function () {
	setDefaultSuiteTimeout(this)

	const api = globalThis.api

	let workspaceDir: string
	let probeFilePath: string
	let reportsRoot: string
	let priorExperiments: Experiments | undefined
	let priorModelId: string | undefined
	let priorMode: string | undefined
	let priorAlwaysAllowModeSwitch: boolean | undefined
	let priorAlwaysAllowSubtasks: boolean | undefined
	let priorAutoApprovalEnabled: boolean | undefined
	let priorEnableCheckpoints: boolean | undefined
	let priorAlwaysAllowReadOnly: boolean | undefined
	let priorAllowedReadFiles: string[] | undefined
	let priorAllowedWriteFiles: string[] | undefined

	suiteSetup(async () => {
		// Install before any task starts: the OpenAI SDK resolves fetch at client
		// construction, and suiteSetup runs before every test in this suite.
		installFetchCapture()
		workspaceDir = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ""
		assert.ok(workspaceDir, "parallel-subtasks e2e requires an open workspace folder")
		probeFilePath = path.join(workspaceDir, "parallel-subtasks-probe.txt")
		await fs.writeFile(
			probeFilePath,
			`${PROBE_FILE_CONTENT_MARKER} PST_E2E_CHILD_A PST_E2E_CHILD_B PST_E2E_CHILD_C\n`,
		)
		reportsRoot = path.join(workspaceDir, ".zoocode", "subtask-reports")
		const priorConfiguration = api.getConfiguration()
		priorExperiments = priorConfiguration.experiments
		priorModelId = priorConfiguration.openRouterModelId
		// startNewTask persists scenarioConfiguration through setValues (see the
		// scenarioConfiguration comment below), so every field it pins must be
		// captured here and restored through the same setConfiguration cleanup
		// path, including fields whose prior value is unset.
		priorMode = priorConfiguration.mode
		priorAlwaysAllowModeSwitch = priorConfiguration.alwaysAllowModeSwitch
		priorAlwaysAllowSubtasks = priorConfiguration.alwaysAllowSubtasks
		priorAutoApprovalEnabled = priorConfiguration.autoApprovalEnabled
		priorEnableCheckpoints = priorConfiguration.enableCheckpoints
		// scenarioConfiguration pins these approval fields for the D4 tripwire;
		// capture the prior values so suiteTeardown can restore them through
		// the same setConfiguration cleanup path as the experiments restore.
		priorAlwaysAllowReadOnly = priorConfiguration.alwaysAllowReadOnly
		priorAllowedReadFiles = priorConfiguration.allowedReadFiles
		priorAllowedWriteFiles = priorConfiguration.allowedWriteFiles
		// parallel_subtasks is gated behind the parallelSubtasks experiment (default
		// off). Enable it through the public settings API for the duration of this
		// suite; no test-only backdoor exists or is needed.
		await api.setConfiguration({ experiments: { ...priorExperiments, parallelSubtasks: true } })
	})

	suiteTeardown(async () => {
		try {
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			// Restore every field the suite pinned through startNewTask's persisted
			// configuration. Unset priors are restored as explicit undefined: the
			// public setConfiguration path writes each key through ContextProxy, so
			// skipping an unset key would leave the scenario's pinned value behind.
			await api.setConfiguration({
				experiments: priorExperiments,
				openRouterModelId: priorModelId,
				mode: priorMode,
				alwaysAllowModeSwitch: priorAlwaysAllowModeSwitch,
				alwaysAllowSubtasks: priorAlwaysAllowSubtasks,
				autoApprovalEnabled: priorAutoApprovalEnabled,
				enableCheckpoints: priorEnableCheckpoints,
				alwaysAllowReadOnly: priorAlwaysAllowReadOnly,
				allowedReadFiles: priorAllowedReadFiles,
				allowedWriteFiles: priorAllowedWriteFiles,
			})
		} finally {
			// The interceptor and the shared capture buffer must be released even
			// when task or settings cleanup rejects above: otherwise the next suite
			// inherits a fetch that still appends request bodies to this buffer.
			restoreFetch?.()
			restoreFetch = undefined
			capturedRequests.length = 0
		}
		if (path.resolve(reportsRoot).startsWith(path.resolve(workspaceDir) + path.sep)) {
			await fs.rm(reportsRoot, { recursive: true, force: true }).catch(() => {})
		}
		await fs.unlink(probeFilePath).catch(() => {})
	})

	setup(() => {
		// A fresh capture buffer per test: every assertion below is scoped by
		// its own probe tag, so stale requests from an earlier test can never
		// satisfy a find(). Late requests from a previous task may still land
		// after this clear; the probe tags are the source of truth.
		capturedRequests.length = 0
	})

	test("cancelling the parent mid-fan-out aborts every child", async function () {
		const { byTask, stop } = collectMessages()
		// Attach the abort listener before the task starts: TaskAborted fires during
		// the awaited cancelCurrentTask, so subscribing after the cancel would miss it.
		const abortedTaskIds = new Set<string>()
		const abortedAtByTask = new Map<string, number>()
		const onTaskAborted = (taskId: string) => {
			abortedTaskIds.add(taskId)
			abortedAtByTask.set(taskId, Date.now())
		}
		api.on(RooCodeEventName.TaskAborted, onTaskAborted)
		let childARequestAt: number | undefined
		let childBRequestAt: number | undefined

		try {
			await api.setConfiguration({ openRouterModelId: CANCEL_MODEL_ID })
			const parentTaskId = await api.startNewTask({
				configuration: scenarioConfiguration,
				text: CANCEL_PARENT_PROMPT,
			})

			// Both children must be in-flight (ttft-delayed) at the mock before the
			// cancel lands; otherwise the cascade has nothing to abort.
			childARequestAt = await waitForCapturedRequest("PST_E2E_CANCEL_CHILD_A")
			childBRequestAt = await waitForCapturedRequest("PST_E2E_CANCEL_CHILD_B")

			await waitFor(() => parsePanelRows(byTask[parentTaskId]).length > 0)
			const panelRow = parsePanelRows(byTask[parentTaskId])[0]
			assert.ok(panelRow, "panel row should arrive once the fan-out starts")
			const spawned = panelRow.panel.subtasks
			assert.strictEqual(spawned.length, 2, "two children should be spawned for the cancel scenario")
			// Streaming-progress contract, proven in the pending window: both child
			// requests are captured above and their first chunks are ttft-delayed by
			// CANCEL_CHILD_TTFT_MS, so the children are genuinely in flight here.
			// The panel row observed now must be partial with no child in a terminal
			// status; a host that buffered every panel update until the join settled
			// could not produce this row. Final-state rows are asserted separately
			// after completion in the fan-out test below.
			assert.strictEqual(
				panelRow.partial,
				true,
				"panel row should stream as partial while the ttft-delayed children are pending",
			)
			for (const subtask of spawned) {
				assert.ok(
					!TERMINAL_SUBTASK_STATUSES.has(subtask.status),
					`child ${subtask.label} should still be pending while its first chunk is delayed (got ${subtask.status})`,
				)
			}
			const childTaskIds = spawned.map((subtask) => subtask.taskId)

			const cancelledAt = Date.now()
			await api.cancelCurrentTask()
			await waitFor(() => abortedTaskIds.has(parentTaskId), { timeout: 30_000 })

			// The cancelled children's first chunks are delayed by
			// CANCEL_CHILD_TTFT_MS, so a child continuation that survived the
			// cancel lands inside that window. Wait it out before the settle
			// and traffic assertions: afterwards every surviving child request
			// has been captured and every child status flip has been observed.
			// (The finally drain below is then a no-op on the success path and
			// remains as failure cleanup.)
			await waitForCancelledChildStreamDrain(childARequestAt, childBRequestAt)

			// The fan-out settles: every child persists as interrupted, never completed.
			for (const childTaskId of childTaskIds) {
				await waitFor(async () => (await api.getTaskHistoryItem(childTaskId))?.status === "interrupted")
			}

			// The parent must not resume or complete after the cancel. Its persisted
			// history status is expected to be "interrupted", but a known production
			// race (reported with this suite) leaves the field unset when the cancel
			// lands mid-tool, so the strict invariant asserted here is the fan-out
			// contract: never completed, and the abort was observed above.
			const parentHistory = await api.getTaskHistoryItem(parentTaskId)
			assert.notStrictEqual(
				parentHistory?.status,
				"completed",
				"parent must not complete after the mid-fan-out cancel",
			)

			// No child keeps running: no captured request sent after the cancel
			// carries a child probe in a user message. The drain above already
			// covered the delayed-stream window, so this filter sees every
			// child continuation that could still exist.
			const lateChildTraffic = capturedRequests.filter(
				(captured) =>
					captured.observedAt > cancelledAt && /PST_E2E_CANCEL_CHILD_[AB]/.test(capturedUserText(captured)),
			)
			assert.deepStrictEqual(lateChildTraffic, [], "no child should keep calling the API after the parent cancel")

			// The parent must not resume either. The cancel fixtures provide no
			// parent turn-2 response, so a parent that sent another model request
			// after the abort would 404 and stall: the history assertion above
			// still passes (never "completed"), which is why the parent traffic
			// itself is checked here. Only requests observed after the parent's
			// own TaskAborted event are rejected; its turn-1 request (sent long
			// before the abort) stays permitted through the abort timestamp.
			const parentAbortedAt = abortedAtByTask.get(parentTaskId)
			assert.ok(parentAbortedAt !== undefined, "parent TaskAborted should carry an observation timestamp")
			const lateParentTraffic = capturedRequests.filter(
				(captured) =>
					captured.observedAt > parentAbortedAt && capturedUserText(captured).includes(CANCEL_PARENT_PROMPT),
			)
			assert.deepStrictEqual(lateParentTraffic, [], "parent should not call the API again after its abort")
		} finally {
			api.off(RooCodeEventName.TaskAborted, onTaskAborted)
			stop()
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
			await waitForCancelledChildStreamDrain(childARequestAt, childBRequestAt)
		}
	})

	test("3-way fan-out spawns children, writes reports, and resumes the parent", async function () {
		const { byTask, stop } = collectMessages()

		try {
			// Scope this scenario's fixtures to its own model id (see file header).
			await api.setConfiguration({ openRouterModelId: FANOUT_MODEL_ID })
			const parentTaskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: scenarioConfiguration,
						text: FANOUT_PARENT_PROMPT,
					}),
			})

			const parentMessages = byTask[parentTaskId] ?? []

			// The parent resumed after the fan-out and completed with its marker: the
			// whole chain (spawn -> children run -> join -> tool result) really happened.
			assert.strictEqual(
				completionResultOf(parentMessages),
				FANOUT_PARENT_RESULT,
				"parent should resume and complete after the fan-out",
			)

			// The progress panel streamed partial updates and finalized with every
			// child in a terminal status.
			const rows = parsePanelRows(parentMessages)
			assert.ok(rows.length > 0, "parent should emit at least one parallelSubtasks panel row")
			assert.ok(
				rows.some((row) => row.partial === true),
				"panel should stream partial updates while children run",
			)
			const finalRow = rows.at(-1)
			assert.ok(finalRow, "final panel row should exist")
			assert.notStrictEqual(finalRow.partial, true, "final panel row should be finalized (partial cleared)")
			assert.deepStrictEqual(
				finalRow.panel.subtasks.map((subtask) => subtask.label),
				FANOUT_CHILDREN.map((child) => child.label),
				"final panel row should name every requested child in order",
			)
			for (const subtask of finalRow.panel.subtasks) {
				assert.ok(TERMINAL_SUBTASK_STATUSES.has(subtask.status), `child ${subtask.label} should be terminal`)
				assert.strictEqual(subtask.status, "completed", `child ${subtask.label} should complete`)
				assert.ok(subtask.taskId, `child ${subtask.label} should carry its task id`)
				assert.ok(
					subtask.reportPath !== undefined && /\.zoocode[/\\]subtask-reports[/\\]/.test(subtask.reportPath),
					`child ${subtask.label} should carry a report path under .zoocode/subtask-reports (got ${subtask.reportPath})`,
				)
				assert.ok(
					subtask.reportPath!.includes(parentTaskId),
					`child ${subtask.label} report should live under the parent's report directory`,
				)
			}
			const childTaskIds = finalRow.panel.subtasks.map((subtask) => subtask.taskId)
			assert.strictEqual(
				new Set(childTaskIds).size,
				FANOUT_CHILDREN.length,
				"every child should have its own task id",
			)

			// Reports exist on disk and carry the per-child markers.
			for (const [index, subtask] of finalRow.panel.subtasks.entries()) {
				const report = await fs.readFile(subtask.reportPath!, "utf8")
				const marker = FANOUT_CHILDREN[index]?.marker
				assert.ok(
					marker !== undefined && report.includes(marker),
					`report for ${subtask.label} should contain the child marker`,
				)
			}

			// Children persisted as completed background children; the parent registered them.
			for (const subtask of finalRow.panel.subtasks) {
				const history = await api.getTaskHistoryItem(subtask.taskId)
				assert.strictEqual(history?.status, "completed", `child ${subtask.label} history should be completed`)
				assert.strictEqual(
					history?.parentTaskId,
					parentTaskId,
					`child ${subtask.label} should point at the parent`,
				)
				assert.strictEqual(
					history?.backgroundParentTaskId,
					parentTaskId,
					`child ${subtask.label} should carry the background parent stamp`,
				)
			}
			const parentHistory = await api.getTaskHistoryItem(parentTaskId)
			for (const subtask of finalRow.panel.subtasks) {
				assert.ok(
					parentHistory?.childIds?.includes(subtask.taskId),
					`parent childIds should include ${subtask.taskId}`,
				)
			}

			// The tool result the parent model actually received names every child and
			// pairs it with that child's own report path (matched against the final
			// panel row, not just any path-shaped string): a parent that received the
			// first child's path for every label would pass a label-only check.
			const parentResumeCaptured = capturedRequests.find(
				(captured) =>
					capturedUserText(captured).includes("PST_E2E_SMOKE_A") &&
					findCapturedToolMessage(captured, "call_pst_a_ps_001"),
			)
			const toolResultText = requestContentText(
				findCapturedToolMessage(parentResumeCaptured, "call_pst_a_ps_001")?.content,
			)
			assert.ok(
				toolResultText.includes("parallel_subtasks finished: 3/3"),
				"parent tool result should report 3/3 children completed",
			)
			const reportPathByLabel = new Map(
				finalRow.panel.subtasks.map((subtask) => [subtask.label, subtask.reportPath]),
			)
			for (const child of FANOUT_CHILDREN) {
				const reportPath = reportPathByLabel.get(child.label)
				assert.ok(
					reportPath !== undefined &&
						toolResultText.includes(`- ${child.label}: completed. Report: ${reportPath}`),
					`parent tool result should pair child ${child.label} with its own report path`,
				)
			}

			// Every child ran its own API turns: the read_file result for each child's
			// call left the extension in a follow-up request carrying that child's probe.
			// The assertion is on the RESULT CONTENT, not the message's existence: a
			// denied read produces a tool message under the same tool_call_id carrying
			// the background_policy denial text (the result is replaced without
			// counting a mistake), and the turn-2 fixtures serve attempt_completion
			// regardless of the tool result, so an existence-only check would pass
			// with the D4 carve-out removed. Only an approved read carries the probe
			// file's contents.
			for (const child of FANOUT_CHILDREN) {
				const readResultCaptured = capturedRequests.find(
					(captured) =>
						capturedUserText(captured).includes(child.tag) &&
						findCapturedToolMessage(captured, `call_pst_a_child_${child.key}_read_001`),
				)
				assert.ok(readResultCaptured, `child ${child.label} should send its read_file result back to the API`)
				const readResultText = requestContentText(
					findCapturedToolMessage(readResultCaptured, `call_pst_a_child_${child.key}_read_001`)?.content,
				)
				assert.ok(
					readResultText.includes(PROBE_FILE_CONTENT_MARKER),
					`child ${child.label} read_file result must carry the probe file content (got: ${readResultText.slice(0, 160)}...)`,
				)
			}
		} finally {
			stop()
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
		}
	})

	test("a child calling parallel_subtasks gets a validation error and no grandchild spawns", async function () {
		const { byTask, stop } = collectMessages()

		try {
			await api.setConfiguration({ openRouterModelId: DEPTH1_MODEL_ID })
			const parentTaskId = await waitUntilCompleted({
				api,
				start: () =>
					api.startNewTask({
						configuration: scenarioConfiguration,
						text: DEPTH1_PARENT_PROMPT,
					}),
			})

			assert.strictEqual(
				completionResultOf(byTask[parentTaskId]),
				DEPTH1_PARENT_RESULT,
				"parent should resume and complete after the single-child fan-out",
			)

			const rows = parsePanelRows(byTask[parentTaskId])
			assert.ok(rows.length > 0, "parent should emit at least one parallelSubtasks panel row")
			const finalRowEntry = rows.at(-1)
			assert.ok(finalRowEntry, "final panel row should exist")
			const finalRow = finalRowEntry.panel
			assert.strictEqual(finalRow.subtasks.length, 1, "exactly one child should ever be tracked for the parent")
			const onlySubtask = finalRow.subtasks[0]
			assert.ok(onlySubtask, "the depth-1 child row should exist")
			assert.strictEqual(onlySubtask.status, "completed", "the depth-1 child should still complete")

			// The child's own report survives, proving the child itself completed.
			assert.ok(onlySubtask.reportPath, "the depth-1 child should carry a report path")
			const report = await fs.readFile(onlySubtask.reportPath, "utf8")
			assert.ok(report.includes("PST_E2E_DEPTH1_CHILD_RESULT"), "child report should contain the child marker")

			// The nested parallel_subtasks call was answered with a tool validation
			// error that reached the child model as an error tool result. The child
			// sends several requests, so the denial is located inside the tool
			// result message for the fixture's nested call id (not anywhere in the
			// captured request) and asserted on that message's content.
			const childErrorCaptured = capturedRequests.find(
				(captured) =>
					capturedUserText(captured).includes("PST_E2E_DEPTH1_CHILD") &&
					findCapturedToolMessage(captured, "call_pst_c_child_ps_001") !== undefined,
			)
			assert.ok(childErrorCaptured, "child should send the nested parallel_subtasks result back to the API")
			const nestedErrorText = requestContentText(
				findCapturedToolMessage(childErrorCaptured, "call_pst_c_child_ps_001")?.content,
			)
			assert.ok(
				nestedErrorText.includes("is not allowed in"),
				`child should receive the validation error for the nested parallel_subtasks call (got: ${nestedErrorText.slice(0, 160)}...)`,
			)

			// Depth is structurally capped at 1: the grandchild probe never appears as a
			// user (task) message, so no grandchild task ever started an API turn.
			const grandchildCaptured = capturedRequests.find((captured) =>
				capturedUserText(captured).includes("PST_E2E_DEPTH1_GRANDCHILD"),
			)
			assert.strictEqual(grandchildCaptured, undefined, "no grandchild task should spawn from a background child")
		} finally {
			stop()
			while (api.getCurrentTaskStack().length > 0) {
				await api.clearCurrentTask()
			}
		}
	})
})
