import { RooCodeEventName } from "@roo-code/types"
import type { ClineMessage, ParallelSubtaskInfo } from "@roo-code/types"

import { Task } from "../task/Task"
import type { ClineProvider } from "../webview/ClineProvider"
import { formatResponse } from "../prompts/responses"
import { MAX_REQUESTED_PARALLEL_SUBTASKS } from "../assistant-message/NativeToolCallParser"
import { BaseTool, ToolCallbacks } from "./BaseTool"
import type { PushToolResult, ToolResponse, ToolUse } from "../../shared/tools"
import { writeSubtaskReport } from "../subtask-reports"
import type { BackgroundChildEntry, BackgroundSubtaskSpec } from "../background-subtasks/types"

interface ParallelSubtasksParams {
	tasks: Array<{ label?: string; mode: string; message: string }>
}

/** One-line summary cap for the progress row and the parent-facing result. */
const SUMMARY_MAX_LENGTH = 120

/** Entries kept while coercing a streamed preview; one past the ceiling makes an over-limit call visible. */
const MAX_COERCED_TASKS = MAX_REQUESTED_PARALLEL_SUBTASKS + 1

/** Fan-out the tool contract documents; excess entries are reported as dropped. */
const DOCUMENTED_FAN_OUT = 6

/**
 * Coerces the `tasks` argument from its wire forms (parsed array or JSON
 * string, as partial streaming can deliver either) into complete entries
 * only; entries missing a mode or message are dropped, mirroring
 * `NativeToolCallParser.normalizeParallelSubtaskTasks`. Collection stops one
 * past `MAX_REQUESTED_PARALLEL_SUBTASKS` so a streamed preview of an oversized
 * call stays bounded.
 */
function coerceTasks(value: unknown): ParallelSubtasksParams["tasks"] {
	let entries: unknown = value
	if (typeof value === "string") {
		try {
			entries = JSON.parse(value)
		} catch {
			return []
		}
	}
	if (!Array.isArray(entries)) {
		return []
	}
	const tasks: ParallelSubtasksParams["tasks"] = []
	for (const entry of entries) {
		if (tasks.length >= MAX_COERCED_TASKS) {
			break
		}
		if (typeof entry !== "object" || entry === null) {
			continue
		}
		const record: Record<string, unknown> = { ...entry }
		if (typeof record.mode !== "string" || typeof record.message !== "string") {
			continue
		}
		tasks.push({
			...(typeof record.label === "string" ? { label: record.label } : {}),
			mode: record.mode,
			message: record.message,
		})
	}
	return tasks
}

/**
 * Assigns every child a sibling-unique label: absent labels default to
 * `child-N`, duplicates gain a numeric suffix, and the requested order is
 * kept so reports and the progress panel read like the tool call. Each base
 * remembers the next suffix to try, so the scan advances instead of
 * restarting at `-2` for every duplicate (no quadratic loop over the list).
 */
function buildUniqueSpecs(requested: ParallelSubtasksParams["tasks"]): BackgroundSubtaskSpec[] {
	const used = new Set<string>()
	const nextSuffix = new Map<string, number>()
	return requested.map((entry, index) => {
		const base = entry.label && entry.label.trim() !== "" ? entry.label : `child-${index + 1}`
		let label = base
		let suffix = nextSuffix.get(base) ?? 2
		while (used.has(label)) {
			label = `${base}-${suffix}`
			suffix++
		}
		used.add(label)
		nextSuffix.set(base, suffix)
		return { label, mode: entry.mode, message: entry.message }
	})
}

function summarizeReport(markdown: string): string {
	const firstLine = markdown.split("\n", 1)[0]?.trim() ?? ""
	return firstLine.length > SUMMARY_MAX_LENGTH ? `${firstLine.slice(0, SUMMARY_MAX_LENGTH)}...` : firstLine
}

export class ParallelSubtasksTool extends BaseTool<"parallel_subtasks"> {
	readonly name = "parallel_subtasks" as const

	async execute(params: ParallelSubtasksParams, task: Task, callbacks: ToolCallbacks): Promise<void> {
		const { askApproval, handleError, pushToolResult } = callbacks
		let provider: ClineProvider | undefined

		try {
			// Validate required parameters.
			if (!params || !Array.isArray(params.tasks) || params.tasks.length === 0) {
				task.consecutiveMistakeCount++
				task.recordToolError("parallel_subtasks")
				task.didToolFailInCurrentTurn = true
				pushToolResult(await task.sayAndCreateMissingParamError("parallel_subtasks", "tasks"))
				return
			}

			// The array is bound at parse time; this is the enforcement point for
			// the hard ceiling. Rejecting before any spec work keeps the approval
			// payload, the progress rows, and the label de-duplication bounded.
			if (params.tasks.length > MAX_REQUESTED_PARALLEL_SUBTASKS) {
				task.consecutiveMistakeCount++
				task.recordToolError("parallel_subtasks")
				task.didToolFailInCurrentTurn = true
				pushToolResult(
					formatResponse.toolError(
						`parallel_subtasks accepts at most ${MAX_REQUESTED_PARALLEL_SUBTASKS} task entries per call; this call exceeded that limit. ` +
							`Split the work into calls of at most ${DOCUMENTED_FAN_OUT} investigations.`,
					),
				)
				return
			}

			const specs = buildUniqueSpecs(params.tasks)
			provider = task.providerRef.deref()

			if (!provider) {
				pushToolResult(formatResponse.toolError("Provider reference lost"))
				return
			}

			task.consecutiveMistakeCount = 0

			// Exactly one user approval point for the whole fan-out (design §11).
			// Protected: a queued follow-up message must not stand in for the
			// approval click (Task.ask exempts protected asks from queue draining),
			// while checkAutoApproval still honors alwaysAllowSubtasks for tool asks.
			const toolMessage = JSON.stringify({
				tool: "parallelSubtasks",
				tasks: specs.map((s) => ({ label: s.label, mode: s.mode, message: s.message })),
			})
			const didApprove = await askApproval("tool", toolMessage, undefined, true)

			if (!didApprove) {
				return
			}

			await this.runFanOut(task, provider, specs, pushToolResult)
		} catch (error) {
			// A tool failure must not leave live children behind (design D8):
			// settle every still-pending child before the error is reported.
			void provider?.abortBackgroundChildren(task.taskId).catch(() => {})
			await handleError("running parallel subtasks", error)
		}
	}

	private async runFanOut(
		task: Task,
		provider: ClineProvider,
		specs: BackgroundSubtaskSpec[],
		pushToolResult: PushToolResult,
	): Promise<void> {
		// Observe the parent's own abort so a cancel that bypasses the provider's
		// cascade still settles every child this tool is awaiting (design D8).
		const onAborted = () => {
			void provider.abortBackgroundChildren(task.taskId).catch(() => {})
		}
		task.once(RooCodeEventName.TaskAborted, onAborted)

		const rows = new Map<string, ParallelSubtaskInfo>()

		// The panel is a single say row (partial:true) created by the first post
		// and updated in place by message identity afterwards. Task.say() cannot
		// carry the updates: it only replaces the LAST partial row of the same
		// type, so any message of another type landing between updates (e.g. a
		// reasoning chunk) would make the next panel post create a second row
		// instead of updating the first, stranding a stale panel beside the real
		// one. The identity update follows Task's own reasoning-row precedent:
		// mutate the captured message, then updateClineMessage(), and persist
		// with saveClineMessages() once the row finalizes. The first post must
		// capture the row by reference from say()'s return value, not by tail
		// position: say() pushes the row before its persistence awaits resolve,
		// so a say of another type landing during that wait appends its own row
		// at the tail and clineMessages.at(-1) would capture that row instead.
		let rowChain: Promise<void> = Promise.resolve()
		let panelMessage: ClineMessage | undefined
		const postRow = async (partial: boolean): Promise<void> => {
			if (task.abort) {
				// Mirror Task.say, which refuses to post once the task is aborting:
				// the chained updates above swallow the throw, while the awaited
				// final post propagates it so no tool result is pushed for an
				// aborted task.
				throw new Error(`[RooCode#say] task ${task.taskId} aborted`)
			}
			const text = JSON.stringify({ tool: "parallelSubtasks", subtasks: Array.from(rows.values()) })
			if (!panelMessage) {
				// First post: say() appends the partial row (or adopts a stale
				// partial tool row left by an earlier interrupted fan-out) and
				// returns the exact row it touched; keep that reference.
				panelMessage = await task.say("tool", text, undefined, true)
				return
			}
			panelMessage.text = text
			if (!partial) {
				panelMessage.partial = false
			}
			await task["updateClineMessage"](panelMessage)
			if (!partial) {
				// The finalized row must survive a restart, not just this session.
				const persisted = await task["saveClineMessages"]()
				if (!persisted) {
					// Retry once: a transient message-file failure should not
					// ship a success payload whose panel the restored chat would
					// render without report links. The retry rewrites messages
					// only; children are not rerun and their reports on disk are
					// left untouched.
					const retried = await task["saveClineMessages"]()
					if (!retried) {
						throw new Error(
							`parallel_subtasks: failed to persist the finalized progress panel for task ${task.taskId}`,
						)
					}
				}
			}
		}
		const enqueueRowUpdate = (): void => {
			rowChain = rowChain.then(() => postRow(true)).catch(() => {})
		}

		// Host-reported "running" transitions (F-09) arrive from inside the
		// scheduler permit, which can be before the rows exist, so they are
		// buffered until the initial post is done.
		const pendingStarts = new Map<string, number>()
		let rowsReady = false
		const applyStart = (taskId: string, startedAt: number): void => {
			const row = rows.get(taskId)
			if (!row) {
				return
			}
			row.status = "running"
			row.startedAt = startedAt
		}
		const flushPendingStarts = (): boolean => {
			if (pendingStarts.size === 0) {
				return false
			}
			for (const [taskId, startedAt] of pendingStarts) {
				applyStart(taskId, startedAt)
			}
			pendingStarts.clear()
			return true
		}

		try {
			const spawned = await provider.spawnBackgroundChildren(task, specs, {
				onChildStarted: (entry) => {
					if (!rowsReady) {
						pendingStarts.set(entry.taskId, entry.startedAt)
						return
					}
					applyStart(entry.taskId, entry.startedAt)
					enqueueRowUpdate()
				},
			})
			const handles = spawned.children
			// Specs the host dropped (the per-call cap slices the batch) still get
			// a terminal row and a result line so nothing vanishes silently.
			const dropped = specs.slice(handles.length)

			for (const handle of handles) {
				rows.set(handle.taskId, {
					taskId: handle.taskId,
					label: handle.label,
					mode: handle.mode,
					status: "queued",
				})
			}
			dropped.forEach((spec, index) => {
				rows.set(`dropped-${index}`, {
					taskId: `dropped-${index}`,
					label: spec.label,
					mode: spec.mode,
					status: "failed",
					// `handles.length` counts the specs the host considered under its
					// cap, not children that actually started: a considered spec can
					// already be a settled failure (unknown mode, cancelled parent).
					error: `Dropped: the request exceeded the per-call limit (${handles.length} of ${specs.length} specs considered)`,
				})
			})

			// A child that acquired its permit before the rows existed is shown
			// as running in the first post instead of queued.
			flushPendingStarts()
			await postRow(true)
			rowsReady = true
			// A start that raced the initial post still needs its own update.
			if (flushPendingStarts()) {
				enqueueRowUpdate()
			}

			for (const handle of handles) {
				void handle.done
					.then((entry) => {
						this.applyEntry(rows.get(handle.taskId), entry)
						enqueueRowUpdate()
					})
					.catch(() => {})
			}

			// done never rejects, so the join always settles, including when the
			// abort cascade above marks every child aborted.
			const entries = await Promise.all(handles.map((handle) => handle.done))
			await rowChain

			for (const entry of entries) {
				if (entry.status !== "completed" || entry.result === undefined) {
					continue
				}
				const row = rows.get(entry.taskId)
				if (!row) {
					continue
				}
				try {
					const report = await writeSubtaskReport({
						cwd: task.cwd,
						parentTaskId: task.taskId,
						childTaskId: entry.taskId,
						label: entry.label,
						markdown: entry.result,
					})
					row.reportPath = report.path
					row.summary = summarizeReport(entry.result)
				} catch (error) {
					// A failed save demotes only that child; the sibling reports
					// are already committed and the rest of the join is unaffected.
					row.status = "failed"
					row.error = `Report write failed: ${error instanceof Error ? error.message : String(error)}`
					row.reportPath = undefined
				}
			}

			await postRow(false)
			pushToolResult(this.buildResultPayload(specs.length, rows))
		} finally {
			task.off(RooCodeEventName.TaskAborted, onAborted)
		}
	}

	private applyEntry(row: ParallelSubtaskInfo | undefined, entry: BackgroundChildEntry): void {
		if (!row) {
			return
		}
		row.status = entry.status
		row.startedAt = entry.startedAt
		row.finishedAt = entry.finishedAt
		row.error = entry.error
	}

	private buildResultPayload(specCount: number, rows: Map<string, ParallelSubtaskInfo>): ToolResponse {
		const lines: string[] = []
		let completedCount = 0
		for (const row of rows.values()) {
			if (row.status === "completed" && row.reportPath) {
				completedCount++
				// The parent model reads the payload, not the progress rows, so
				// carry the one-line summary alongside the path to the report.
				lines.push(
					row.summary
						? `- ${row.label}: completed. Report: ${row.reportPath}. Summary: ${row.summary}`
						: `- ${row.label}: completed. Report: ${row.reportPath}`,
				)
			} else {
				lines.push(`- ${row.label}: ${row.status}${row.error ? ` (${row.error})` : ""}`)
			}
		}
		const text = [
			`parallel_subtasks finished: ${completedCount}/${specCount} children completed.`,
			...lines,
			"",
			"Each report is a markdown file. Read the ones you need with read_file before acting on the findings.",
		].join("\n")
		return formatResponse.toolResult(text)
	}

	override async handlePartial(task: Task, block: ToolUse<"parallel_subtasks">): Promise<void> {
		// Prefer the parser's already-bounded list: the raw `params.tasks` can be
		// the full streamed array as one JSON string, and re-parsing that on every
		// chunk would defeat the bound at parse time.
		const raw: unknown = block.nativeArgs?.tasks ?? block.params.tasks
		const tasks = coerceTasks(raw)
		const partialMessage = JSON.stringify({
			tool: "parallelSubtasks",
			tasks: tasks.map((entry) => ({
				label: entry.label ?? "",
				mode: entry.mode ?? "",
				message: entry.message ?? "",
			})),
		})

		await task.ask("tool", partialMessage, block.partial).catch(() => {})
	}
}

export const parallelSubtasksTool = new ParallelSubtasksTool()
