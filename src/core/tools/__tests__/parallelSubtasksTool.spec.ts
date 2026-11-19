// pnpm --dir src exec vitest run core/tools/__tests__/parallelSubtasksTool.spec.ts

import { RooCodeEventName, type ClineMessage, type ExtensionState } from "@roo-code/types"

import type { AskApproval, HandleError, PushToolResult, ToolUse } from "../../../shared/tools"
import { Task } from "../../task/Task"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { setAbortLatch } from "../../../test-utils/run-state"
import type { ClineProvider } from "../../webview/ClineProvider"
import type { BackgroundChildEntry, BackgroundChildHandle } from "../../background-subtasks/types"

// Keep formatResponse deterministic so the payload assertions read the exact
// text the tool built; toolResult passes through unchanged.
vi.mock("../../prompts/responses", () => ({
	formatResponse: {
		toolError: vi.fn((msg: string) => `Error: ${msg}`),
		toolResult: vi.fn((msg: string) => msg),
		toolDenied: vi.fn(() => "Denied"),
	},
}))

// The report store has its own filesystem suite; here it is a controllable
// stand-in so report-write failures can be injected per test.
vi.mock("../../subtask-reports", () => ({
	writeSubtaskReport: vi.fn(
		async (params: {
			cwd: string
			parentTaskId: string
			childTaskId: string
			label: string
			markdown: string
		}) => ({
			path: `/reports/${params.parentTaskId}/${params.label}-${params.childTaskId}.md`,
			label: params.label,
			taskId: params.childTaskId,
			parentTaskId: params.parentTaskId,
		}),
	),
}))

import { parallelSubtasksTool } from "../ParallelSubtasksTool"
import parallelSubtasksToolDefinition from "../../prompts/tools/native-tools/parallel_subtasks"
import { MAX_REQUESTED_PARALLEL_SUBTASKS } from "../../assistant-message/NativeToolCallParser"
import { writeSubtaskReport } from "../../subtask-reports"

const writeSubtaskReportMock = vi.mocked(writeSubtaskReport)

interface TaskDouble {
	taskId: string
	cwd: string
	abort: boolean
	consecutiveMistakeCount: number
	didToolFailInCurrentTurn: boolean
	recordToolError: ReturnType<typeof vi.fn<(toolName: string) => void>>
	sayAndCreateMissingParamError: ReturnType<typeof vi.fn<(tool: string, param: string) => Promise<string>>>
	say: ReturnType<
		typeof vi.fn<(type: string, text?: string, images?: string[], partial?: boolean) => Promise<ClineMessage>>
	>
	ask: ReturnType<typeof vi.fn<(type: string, text?: string, partial?: boolean) => Promise<unknown>>>
	once: ReturnType<typeof vi.fn<(event: RooCodeEventName, listener: () => void) => void>>
	off: ReturnType<typeof vi.fn<(event: RooCodeEventName, listener: () => void) => void>>
	providerRef: { deref: () => unknown }
	/** The message list the say double maintains, mirroring Task.say semantics. */
	clineMessages: ClineMessage[]
	/** Identity-update notify the panel posts after the first row (Task private). */
	updateClineMessage: ReturnType<typeof vi.fn<(message: ClineMessage) => Promise<void>>>
	/** Persistence the panel triggers when the finalized row lands (Task private). */
	saveClineMessages: ReturnType<typeof vi.fn<() => Promise<boolean>>>
}

interface ProviderDouble {
	spawnBackgroundChildren: ReturnType<typeof vi.fn<ClineProvider["spawnBackgroundChildren"]>>
	abortBackgroundChildren: ReturnType<typeof vi.fn<ClineProvider["abortBackgroundChildren"]>>
}

interface SettleableHandle extends BackgroundChildHandle {
	settle: (entry: Partial<BackgroundChildEntry> & { status: BackgroundChildEntry["status"] }) => void
}

function makeHandle(taskId: string, label: string, mode = "code"): SettleableHandle {
	let resolveDone!: (entry: BackgroundChildEntry) => void
	const done = new Promise<BackgroundChildEntry>((resolve) => {
		resolveDone = resolve
	})
	return {
		taskId,
		label,
		mode,
		done,
		settle: (entry) => resolveDone({ taskId, label, mode, startedAt: 1, finishedAt: 2, ...entry }),
	}
}

/** The sole provider member `Task.ask` reaches for on this path. */
interface AskProviderStub {
	getState: () => Promise<Partial<ExtensionState>>
}

/**
 * A Task instance for exercising the real ask path: only the members `Task.ask`
 * touches are installed. Bracket assignment keeps the private members typed;
 * the provider stand-in satisfies the single `getState()` read this path makes.
 */
function createAskTask(provider: AskProviderStub = { getState: async () => ({}) }): Task {
	const task = Object.create(Task.prototype, {
		taskId: { value: "task-parallel-approval", enumerable: true },
		instanceId: { value: "instance-parallel-approval", enumerable: true },
	}) as Task
	setAbortLatch(task, false)
	task["clineMessages"] = []
	task["askResponse"] = undefined
	task["askResponseText"] = undefined
	task["askResponseImages"] = undefined
	task["lastMessageTs"] = undefined
	task["addToClineMessages"] = vi.fn(async () => {})
	task["saveClineMessages"] = vi.fn(async () => true)
	task["updateClineMessage"] = vi.fn(async () => {})
	task["cancelAutoApprovalTimeout"] = vi.fn(() => {})
	task["checkpointSave"] = vi.fn(async () => {})
	task["emit"] = vi.fn()
	// A double assertion is unavoidable here: `providerRef` is a `WeakRef<ClineProvider>`
	// and the stub is neither, while `Task.ask` only calls `deref()` and `getState()`.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	Object.defineProperty(task, "workspacePath", { value: "/workspace" })
	Object.defineProperty(task, "messageQueueService", { value: new MessageQueueService() })
	return task
}

/**
 * A Task instance for exercising the real say path: `Task.prototype.say` stays
 * intact and only the members say() and the tool touch are installed or
 * doubled. `addToClineMessages` is left for each test to install: it is the
 * persistence boundary say() awaits after pushing its row, so gating it can
 * suspend a post mid-say (a say double that resolves synchronously cannot
 * reproduce that interleaving).
 */
function createPanelIdentityTask(provider: unknown): Task {
	const task = Object.create(Task.prototype, {
		taskId: { value: "task-panel-identity", enumerable: true },
		instanceId: { value: "instance-panel-identity", enumerable: true },
	}) as Task
	setAbortLatch(task, false)
	// Annotated so the empty literal is `ClineMessage[]` and not the `[]` tuple,
	// which would make `messages[0]` a type error.
	const clineMessages: ClineMessage[] = []
	task["clineMessages"] = clineMessages
	task["lastMessageTs"] = undefined
	task["postPartialMessageUpdate"] = vi.fn()
	task["cancelPendingPartialMessageUpdate"] = vi.fn()
	task["recordToolError"] = vi.fn()
	task["sayAndCreateMissingParamError"] = vi.fn(
		async (_tool: string, param: string) => `Missing required parameter: ${param}`,
	)
	// Same WeakRef stand-in as createAskTask: the tool and say() only deref it.
	task["providerRef"] = { deref: () => provider } as unknown as Task["providerRef"]
	Object.defineProperty(task, "workspacePath", { value: "/workspace" })
	return task
}

const PENDING = "pending" as const

/** Resolves "pending" if `promise` has not settled within `ms`. */
function pendingAfter(promise: Promise<unknown>, ms = 250): Promise<"settled" | typeof PENDING> {
	return Promise.race([
		promise.then(() => "settled" as const),
		new Promise<typeof PENDING>((resolve) => setTimeout(() => resolve(PENDING), ms)),
	])
}

describe("parallelSubtasksTool", () => {
	let taskDouble: TaskDouble
	let task: Task
	let providerDouble: ProviderDouble
	let askApproval: ReturnType<typeof vi.fn<AskApproval>>
	let handleError: ReturnType<typeof vi.fn<HandleError>>
	let pushToolResult: ReturnType<typeof vi.fn<PushToolResult>>

	const sayCalls = () => taskDouble.say.mock.calls

	// The panel is one message identity updated in place: tests read its state
	// from the double's message list, not from the say call log (say only
	// creates the row; identity updates go through updateClineMessage).
	const panelMessages = () =>
		taskDouble.clineMessages.filter((message) => message.type === "say" && message.say === "tool")

	function createTaskDouble(): TaskDouble {
		const double: TaskDouble = {
			taskId: "parent-1",
			cwd: "/workspace",
			abort: false,
			consecutiveMistakeCount: 0,
			didToolFailInCurrentTurn: false,
			recordToolError: vi.fn<(toolName: string) => void>(),
			sayAndCreateMissingParamError: vi.fn(
				async (_tool: string, param: string) => `Missing required parameter: ${param}`,
			),
			say: vi.fn(async (type: string, text?: string, images?: string[], partial?: boolean) => {
				if (double.abort) {
					throw new Error(`[RooCode#say] task ${double.taskId} aborted`)
				}
				// Mirror Task.say's partial semantics so tests can interleave
				// other message types between panel updates: a defined partial
				// flag only updates the LAST message when that message is a
				// partial say row of the same type; every other case appends.
				// Returns the row touched, matching Task.say's contract.
				const last = double.clineMessages.at(-1)
				const isUpdatingPreviousPartial =
					last !== undefined && last.partial === true && last.type === "say" && last.say === type
				if (partial !== undefined && isUpdatingPreviousPartial) {
					last.text = text
					last.images = images
					last.partial = partial
					return last
				}
				const message: ClineMessage = {
					ts: double.clineMessages.length + 1,
					type: "say",
					say: type as ClineMessage["say"],
					text,
					images,
					...(partial !== undefined ? { partial } : {}),
				}
				double.clineMessages.push(message)
				return message
			}),
			ask: vi.fn(async () => ({ response: "yesButtonClicked", text: "", images: [] })),
			once: vi.fn(),
			off: vi.fn(),
			providerRef: { deref: () => providerDouble },
			clineMessages: [],
			updateClineMessage: vi.fn(async () => {}),
			saveClineMessages: vi.fn(async () => true),
		}
		return double
	}

	function makeCallbacks() {
		return { askApproval, handleError, pushToolResult, toolCallId: "call-1" }
	}

	function makeBlock(tasks: unknown): ToolUse<"parallel_subtasks"> {
		return {
			type: "tool_use",
			name: "parallel_subtasks",
			params: {},
			nativeArgs: { tasks } as ToolUse<"parallel_subtasks">["nativeArgs"],
			partial: false,
		}
	}

	function spawnedHandles(...handles: SettleableHandle[]) {
		providerDouble.spawnBackgroundChildren.mockResolvedValue({ children: handles, started: handles.length > 0 })
	}

	beforeEach(() => {
		providerDouble = {
			spawnBackgroundChildren: vi.fn<ClineProvider["spawnBackgroundChildren"]>(async () => ({
				children: [],
				started: false,
			})),
			abortBackgroundChildren: vi.fn<ClineProvider["abortBackgroundChildren"]>(async () => undefined),
		}
		taskDouble = createTaskDouble()
		// The double stands in for a Task on the paths under test only.
		task = taskDouble as unknown as Task
		askApproval = vi.fn<AskApproval>(async () => true)
		handleError = vi.fn<HandleError>(async () => undefined)
		pushToolResult = vi.fn<PushToolResult>()
		writeSubtaskReportMock.mockReset()
		writeSubtaskReportMock.mockImplementation(async (params) => ({
			path: `/reports/${params.parentTaskId}/${params.label}-${params.childTaskId}.md`,
			label: params.label,
			taskId: params.childTaskId,
			parentTaskId: params.parentTaskId,
		}))
	})

	describe("validation", () => {
		it.each([
			["an empty tasks array", { tasks: [] }],
			["a missing tasks parameter", { tasks: undefined }],
		])("takes the mistake path for %s without spawning or asking", async (_case, nativeArgs) => {
			const block = {
				type: "tool_use",
				name: "parallel_subtasks",
				params: {},
				nativeArgs,
				partial: false,
			} as unknown as ToolUse<"parallel_subtasks">

			await parallelSubtasksTool.handle(task, block, makeCallbacks())

			expect(taskDouble.consecutiveMistakeCount).toBe(1)
			expect(taskDouble.recordToolError).toHaveBeenCalledWith("parallel_subtasks")
			expect(taskDouble.didToolFailInCurrentTurn).toBe(true)
			expect(pushToolResult).toHaveBeenCalledWith("Missing required parameter: tasks")
			expect(providerDouble.spawnBackgroundChildren).not.toHaveBeenCalled()
			expect(askApproval).not.toHaveBeenCalled()
			expect(taskDouble.say).not.toHaveBeenCalled()
		})

		it("rejects a list above the hard ceiling before asking, spawning, or posting rows", async () => {
			const tasks = Array.from({ length: MAX_REQUESTED_PARALLEL_SUBTASKS + 1 }, (_value, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))

			await parallelSubtasksTool.handle(task, makeBlock(tasks), makeCallbacks())

			expect(taskDouble.consecutiveMistakeCount).toBe(1)
			expect(taskDouble.recordToolError).toHaveBeenCalledWith("parallel_subtasks")
			expect(taskDouble.didToolFailInCurrentTurn).toBe(true)
			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const text = pushToolResult.mock.calls[0][0] as string
			expect(text).toContain(`at most ${MAX_REQUESTED_PARALLEL_SUBTASKS} task entries per call`)
			expect(text).toContain("at most 6 investigations")
			expect(providerDouble.spawnBackgroundChildren).not.toHaveBeenCalled()
			expect(askApproval).not.toHaveBeenCalled()
			expect(taskDouble.say).not.toHaveBeenCalled()
		})
	})

	describe("request ceiling", () => {
		it("accepts a list at the ceiling and bounds label de-duplication to it", async () => {
			const tasks = Array.from({ length: MAX_REQUESTED_PARALLEL_SUBTASKS }, () => ({
				label: "dup",
				mode: "code",
				message: "same",
			}))

			await parallelSubtasksTool.handle(task, makeBlock(tasks), makeCallbacks())

			expect(providerDouble.spawnBackgroundChildren).toHaveBeenCalledOnce()
			const specs = providerDouble.spawnBackgroundChildren.mock.calls[0][1]
			expect(specs).toHaveLength(MAX_REQUESTED_PARALLEL_SUBTASKS)
			expect(specs[0].label).toBe("dup")
			expect(specs[1].label).toBe("dup-2")
			expect(specs.at(-1)?.label).toBe(`dup-${MAX_REQUESTED_PARALLEL_SUBTASKS}`)
		})

		it("keeps the shipped description consistent with the enforced ceiling", () => {
			const description = parallelSubtasksToolDefinition.function.description ?? ""

			expect(description).toContain(`more than ${MAX_REQUESTED_PARALLEL_SUBTASKS} tasks is rejected`)
			expect(description).toContain("At most 6 children per call")
		})
	})

	describe("spec building", () => {
		it("defaults absent labels, de-duplicates collisions, and preserves order", async () => {
			const handles = [
				makeHandle("c1", "child-1"),
				makeHandle("c2", "child-2"),
				makeHandle("c3", "dup"),
				makeHandle("c4", "dup-2"),
			]
			spawnedHandles(...handles)
			handles.forEach((handle) => handle.settle({ status: "completed", result: "ok" }))

			const block = makeBlock([
				{ mode: "code", message: "first" },
				{ label: "", mode: "debug", message: "second" },
				{ label: "dup", mode: "code", message: "third" },
				{ label: "dup", mode: "code", message: "fourth" },
			])
			await parallelSubtasksTool.handle(task, block, makeCallbacks())

			expect(providerDouble.spawnBackgroundChildren).toHaveBeenCalledOnce()
			const specs = providerDouble.spawnBackgroundChildren.mock.calls[0][1]
			expect(specs.map((spec) => spec.label)).toEqual(["child-1", "child-2", "dup", "dup-2"])
			expect(specs.map((spec) => spec.mode)).toEqual(["code", "debug", "code", "code"])
			expect(specs.map((spec) => spec.message)).toEqual(["first", "second", "third", "fourth"])
		})
	})

	describe("approval", () => {
		it("asks exactly once, naming every spec", async () => {
			const handles = [makeHandle("c1", "api"), makeHandle("c2", "tests")]
			spawnedHandles(...handles)
			handles.forEach((handle) => handle.settle({ status: "completed", result: "ok" }))

			const block = makeBlock([
				{ label: "api", mode: "code", message: "Map the API" },
				{ label: "tests", mode: "debug", message: "Check coverage" },
			])
			await parallelSubtasksTool.handle(task, block, makeCallbacks())

			expect(askApproval).toHaveBeenCalledTimes(1)
			expect(askApproval.mock.calls[0][0]).toBe("tool")
			// `forceApproval` marks the ask protected so a queued follow-up cannot
			// stand in for the click; checkAutoApproval still handles tool asks.
			expect(askApproval.mock.calls[0][2]).toBeUndefined()
			expect(askApproval.mock.calls[0][3]).toBe(true)
			const payload = JSON.parse(askApproval.mock.calls[0][1] ?? "{}") as {
				tool: string
				tasks: Array<{ label: string; mode: string; message: string }>
			}
			expect(payload.tool).toBe("parallelSubtasks")
			expect(payload.tasks).toEqual([
				{ label: "api", mode: "code", message: "Map the API" },
				{ label: "tests", mode: "debug", message: "Check coverage" },
			])
		})

		it("keeps the ask blocked when a follow-up message is queued", async () => {
			const askTask = createAskTask()
			askTask.messageQueueService.addMessage("Double-check the API first")
			askApproval.mockImplementation(async (type, text, _progress, isProtected) => {
				const result = await askTask.ask(type, text, false, undefined, isProtected)
				return result.response === "yesButtonClicked"
			})

			const toolRun = parallelSubtasksTool.handle(
				task,
				makeBlock([{ label: "api", mode: "code", message: "Map the API" }]),
				makeCallbacks(),
			)

			// The queued message must not satisfy the protected fan-out approval.
			expect(await pendingAfter(toolRun)).toBe(PENDING)
			expect(providerDouble.spawnBackgroundChildren).not.toHaveBeenCalled()
			expect(askTask.messageQueueService.isEmpty()).toBe(false)

			askTask.approveAsk()
			await toolRun

			expect(providerDouble.spawnBackgroundChildren).toHaveBeenCalledOnce()
			// The queued text was not consumed as approval feedback.
			expect(askTask.messageQueueService.claimNextMessage()?.text).toBe("Double-check the API first")
		})

		it("starts the fan-out without a click when alwaysAllowSubtasks is on", async () => {
			const askTask = createAskTask({
				getState: async () => ({ autoApprovalEnabled: true, alwaysAllowSubtasks: true }),
			})
			askApproval.mockImplementation(async (type, text, _progress, isProtected) => {
				const result = await askTask.ask(type, text, false, undefined, isProtected)
				return result.response === "yesButtonClicked"
			})

			await parallelSubtasksTool.handle(
				task,
				makeBlock([{ label: "api", mode: "code", message: "Map the API" }]),
				makeCallbacks(),
			)

			expect(askApproval).toHaveBeenCalledWith("tool", expect.any(String), undefined, true)
			expect(providerDouble.spawnBackgroundChildren).toHaveBeenCalledOnce()
			expect(askTask.messageQueueService.isEmpty()).toBe(true)
		})

		it("returns without spawning when the user rejects", async () => {
			askApproval.mockResolvedValue(false)

			const block = makeBlock([{ label: "api", mode: "code", message: "Map the API" }])
			await parallelSubtasksTool.handle(task, block, makeCallbacks())

			expect(providerDouble.spawnBackgroundChildren).not.toHaveBeenCalled()
			expect(taskDouble.say).not.toHaveBeenCalled()
			expect(pushToolResult).not.toHaveBeenCalled()
			expect(handleError).not.toHaveBeenCalled()
		})
	})

	describe("running transitions (F-09)", () => {
		const flushTool = async (ticks = 8): Promise<void> => {
			for (let index = 0; index < ticks; index++) {
				await new Promise((resolve) => setTimeout(resolve, 0))
			}
		}

		const parseLastRow = (): { subtasks: Array<{ label: string; status: string; startedAt?: number }> } =>
			JSON.parse(panelMessages().at(-1)?.text ?? "{}") as {
				subtasks: Array<{ label: string; status: string; startedAt?: number }>
			}

		it("applies a start that beats the first row and a start that arrives later", async () => {
			const first = makeHandle("c1", "one")
			const second = makeHandle("c2", "two")
			let notify: ((entry: BackgroundChildEntry) => void) | undefined
			providerDouble.spawnBackgroundChildren.mockImplementation(async (_parent, _specs, options) => {
				notify = options?.onChildStarted
				// A permit can be acquired while the host is still inside spawn.
				notify?.({ taskId: "c1", label: "one", mode: "code", status: "running", startedAt: 11 })
				return { children: [first, second], started: true }
			})

			const executePromise = parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "one", mode: "code", message: "m1" },
					{ label: "two", mode: "code", message: "m2" },
				]),
				makeCallbacks(),
			)
			await flushTool()

			// The buffered start is already running in the initial post.
			expect(parseLastRow().subtasks).toMatchObject([
				{ label: "one", status: "running", startedAt: 11 },
				{ label: "two", status: "queued" },
			])

			// A start reported after the rows exist updates the row immediately.
			notify?.({ taskId: "c2", label: "two", mode: "code", status: "running", startedAt: 22 })
			await flushTool()
			expect(parseLastRow().subtasks[1]).toMatchObject({ status: "running", startedAt: 22 })

			first.settle({ status: "completed", result: "# One" })
			second.settle({ status: "failed", error: "child exploded" })
			await executePromise

			const final = parseLastRow().subtasks
			expect(final[0]).toMatchObject({ status: "completed" })
			expect(final[1]).toMatchObject({ status: "failed" })
		})
	})

	describe("progress rows", () => {
		/** Polls the panel message until `predicate` holds or the deadline expires. */
		async function waitForLastRow(
			predicate: (row: { subtasks: Array<{ label: string; status: string }> }) => boolean,
			ms = 1000,
		): Promise<void> {
			const deadline = Date.now() + ms
			for (;;) {
				const last = panelMessages().at(-1)
				if (last) {
					const row = JSON.parse(last.text ?? "{}") as {
						subtasks: Array<{ label: string; status: string }>
					}
					if (predicate(row)) {
						return
					}
				}
				if (Date.now() >= deadline) {
					throw new Error("timed out waiting for a progress row update")
				}
				await new Promise((resolve) => setTimeout(resolve, 5))
			}
		}

		it("posts one initial partial row, one update per completion, and a final non-partial row", async () => {
			const handles = [makeHandle("c1", "one"), makeHandle("c2", "two"), makeHandle("c3", "three")]
			spawnedHandles(...handles)

			const executePromise = parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "one", mode: "code", message: "m1" },
					{ label: "two", mode: "code", message: "m2" },
					{ label: "three", mode: "code", message: "m3" },
				]),
				makeCallbacks(),
			)

			// Settle two children out of order and leave "one" pending. Each
			// completion must post its own partial row while the tool is still
			// awaiting the pending child; a tool that batch-posted every update
			// after the join would leave the last row untouched here.
			handles[2].settle({ status: "completed", result: "# Three\nfindings" })
			handles[1].settle({ status: "failed", error: "child exploded" })
			await waitForLastRow((row) => {
				const byLabel = new Map(row.subtasks.map((subtask) => [subtask.label, subtask.status]))
				return (
					byLabel.get("three") === "completed" &&
					byLabel.get("two") === "failed" &&
					byLabel.get("one") === "queued"
				)
			})

			// The join must still be waiting on the pending child.
			expect(await pendingAfter(executePromise)).toBe(PENDING)

			handles[0].settle({ status: "completed", result: "# One\nfindings" })
			await executePromise

			// The panel is created once through say(partial:true) and updated in
			// place by message identity afterwards: one say call, one panel
			// message, one identity update per completion plus the finalize, and
			// one persistence write when the row finalizes.
			expect(taskDouble.say).toHaveBeenCalledTimes(1)
			expect(sayCalls()[0]?.[3]).toBe(true)
			const panels = panelMessages()
			expect(panels).toHaveLength(1)
			expect(taskDouble.updateClineMessage).toHaveBeenCalledTimes(4)
			expect(
				taskDouble.updateClineMessage.mock.calls.every((call) => call[0] === panels[0]),
				"every update must target the same panel message identity",
			).toBe(true)
			expect(taskDouble.saveClineMessages).toHaveBeenCalledTimes(1)
			expect(panels[0]?.partial).toBe(false)

			const initial = JSON.parse(sayCalls()[0]?.[1] ?? "{}") as {
				tool: string
				subtasks: Array<{ status: string }>
			}
			expect(initial.tool).toBe("parallelSubtasks")
			expect(initial.subtasks).toHaveLength(3)
			expect(initial.subtasks.every((subtask) => subtask.status === "queued")).toBe(true)

			const final = JSON.parse(panels[0]?.text ?? "{}") as {
				subtasks: Array<{
					label: string
					status: string
					reportPath?: string
					summary?: string
					error?: string
				}>
			}
			const byLabel = new Map(final.subtasks.map((subtask) => [subtask.label, subtask]))
			expect(byLabel.get("one")).toMatchObject({
				status: "completed",
				reportPath: "/reports/parent-1/one-c1.md",
				summary: "# One",
			})
			expect(byLabel.get("three")).toMatchObject({
				status: "completed",
				reportPath: "/reports/parent-1/three-c3.md",
				summary: "# Three",
			})
			expect(byLabel.get("two")).toMatchObject({ status: "failed", error: "child exploded" })
		})

		it("keeps one finalized panel when a reasoning chunk interleaves between child updates", async () => {
			const handles = [makeHandle("c1", "one"), makeHandle("c2", "two")]
			spawnedHandles(...handles)

			const executePromise = parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "one", mode: "code", message: "m1" },
					{ label: "two", mode: "code", message: "m2" },
				]),
				makeCallbacks(),
			)

			// The initial partial panel exists before any child settles.
			await waitForLastRow((row) => row.subtasks.length === 2)
			expect(panelMessages()).toHaveLength(1)

			// The first completion updates the panel in place.
			handles[1].settle({ status: "completed", result: "# Two" })
			await waitForLastRow((row) =>
				row.subtasks.every((subtask) => subtask.label !== "two" || subtask.status === "completed"),
			)

			// A reasoning chunk lands between updates. Task.say appends it (the
			// last message is a partial tool row of a different type); with
			// say-based panel updates the next row post would create a SECOND
			// panel row instead of updating the first, stranding a stale panel.
			await taskDouble.say("reasoning", "interleaved reasoning", undefined, true)
			expect(taskDouble.clineMessages.at(-1)?.say).toBe("reasoning")

			handles[0].settle({ status: "completed", result: "# One" })
			await executePromise

			// Exactly one panel message exists, it is the finalized one, and the
			// interleaved reasoning row survived as its own message.
			const panels = panelMessages()
			expect(panels).toHaveLength(1)
			expect(panels[0]?.partial).toBe(false)
			const byLabel = new Map(
				(
					JSON.parse(panels[0]?.text ?? "{}") as { subtasks: Array<{ label: string; status: string }> }
				).subtasks.map((subtask) => [subtask.label, subtask.status]),
			)
			expect(byLabel.get("one")).toBe("completed")
			expect(byLabel.get("two")).toBe("completed")
			expect(taskDouble.clineMessages.filter((message) => message.say === "reasoning")).toHaveLength(1)
			expect(taskDouble.saveClineMessages).toHaveBeenCalledTimes(1)
		})
	})

	describe("panel identity under the real Task.say (F-1 regression)", () => {
		it("finalizes the original panel row when a reasoning row lands while the first post is pending", async () => {
			const task = createPanelIdentityTask(providerDouble)
			let openGate = () => {}
			const gate = new Promise<void>((resolve) => {
				openGate = resolve
			})
			// Gate the persistence boundary the real say() awaits after pushing
			// its row: the panel row is in clineMessages while its say() is still
			// suspended, exactly the window the tail-position capture got wrong.
			task["addToClineMessages"] = vi.fn(async (message: ClineMessage) => {
				task["clineMessages"].push(message)
				await gate
			})
			const saveClineMessages = vi.fn(async () => true)
			task["saveClineMessages"] = saveClineMessages
			const updateClineMessage = vi.fn(async (_message: ClineMessage) => {})
			task["updateClineMessage"] = updateClineMessage

			const handles = [makeHandle("c1", "one"), makeHandle("c2", "two")]
			spawnedHandles(...handles)

			const executePromise = parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "one", mode: "code", message: "m1" },
					{ label: "two", mode: "code", message: "m2" },
				]),
				makeCallbacks(),
			)

			// Wait for the panel row to be pushed while its say() is still gated.
			const deadline = Date.now() + 1000
			while (task["clineMessages"].length === 0) {
				if (Date.now() > deadline) {
					throw new Error("timed out waiting for the panel row push")
				}
				await new Promise((resolve) => setTimeout(resolve, 0))
			}

			// A reasoning chunk lands mid-post: say() appends its own row at the
			// tail before the panel's say() has returned, so a tail-position
			// capture would hand the panel updates to the reasoning row.
			const reasoningSay = task.say("reasoning", "interleaved reasoning", undefined, true)
			expect(task["clineMessages"].at(-1)?.say).toBe("reasoning")

			openGate()
			await reasoningSay
			handles[0].settle({ status: "completed", result: "# One" })
			handles[1].settle({ status: "completed", result: "# Two" })
			await executePromise

			// The original panel row is the one that finalizes...
			const panels = task["clineMessages"].filter((message) => message.type === "say" && message.say === "tool")
			expect(panels).toHaveLength(1)
			expect(panels[0]?.partial).toBe(false)
			const finalPanel = JSON.parse(panels[0]?.text ?? "{}") as {
				subtasks: Array<{ label: string; status: string }>
			}
			expect(finalPanel.subtasks.map((row) => row.status)).toEqual(["completed", "completed"])
			// ...every identity update targeted that same row...
			expect(updateClineMessage.mock.calls.length).toBeGreaterThan(0)
			expect(updateClineMessage.mock.calls.every((call) => call[0] === panels[0])).toBe(true)
			// ...the reasoning row kept its own text and partial state...
			const reasoning = task["clineMessages"].filter((message) => message.say === "reasoning")
			expect(reasoning).toHaveLength(1)
			expect(reasoning[0]?.text).toBe("interleaved reasoning")
			expect(reasoning[0]?.partial).toBe(true)
			// ...and the finalized row was persisted exactly once.
			expect(saveClineMessages).toHaveBeenCalledTimes(1)
		})
	})

	describe("panel persistence (F-2)", () => {
		it("retries the final message save once and still reports success", async () => {
			taskDouble.saveClineMessages.mockResolvedValueOnce(false).mockResolvedValue(true)
			const handles = [makeHandle("c1", "one")]
			spawnedHandles(...handles)
			handles[0].settle({ status: "completed", result: "# One" })

			await parallelSubtasksTool.handle(
				task,
				makeBlock([{ label: "one", mode: "code", message: "m1" }]),
				makeCallbacks(),
			)

			expect(taskDouble.saveClineMessages).toHaveBeenCalledTimes(2)
			expect(pushToolResult).toHaveBeenCalledTimes(1)
			expect(handleError).not.toHaveBeenCalled()
			expect(panelMessages()[0]?.partial).toBe(false)
		})

		it("surfaces a persistence error when the final save keeps failing", async () => {
			taskDouble.saveClineMessages.mockResolvedValue(false)
			const handles = [makeHandle("c1", "one")]
			spawnedHandles(...handles)
			handles[0].settle({ status: "completed", result: "# One" })

			await parallelSubtasksTool.handle(
				task,
				makeBlock([{ label: "one", mode: "code", message: "m1" }]),
				makeCallbacks(),
			)

			// One retry, then the persistence failure is surfaced instead of a
			// success payload whose panel the restored chat would render without
			// report links.
			expect(taskDouble.saveClineMessages).toHaveBeenCalledTimes(2)
			expect(pushToolResult).not.toHaveBeenCalled()
			expect(handleError).toHaveBeenCalledTimes(1)
			expect(handleError.mock.calls[0]?.[1]).toBeInstanceOf(Error)
		})
	})

	describe("join and result injection", () => {
		it("pushes one payload naming every child, its status, and the report path", async () => {
			const handles = [makeHandle("c1", "api"), makeHandle("c2", "tests"), makeHandle("c3", "docs")]
			spawnedHandles(...handles)
			handles[0].settle({ status: "completed", result: "# API\nfindings" })
			handles[1].settle({ status: "failed", error: "out of tokens" })
			handles[2].settle({ status: "aborted", error: "cancelled" })

			await parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "api", mode: "code", message: "m1" },
					{ label: "tests", mode: "debug", message: "m2" },
					{ label: "docs", mode: "code", message: "m3" },
				]),
				makeCallbacks(),
			)

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const payload = pushToolResult.mock.calls[0][0]
			expect(typeof payload).toBe("string")
			const text = payload as string
			expect(text).toContain("parallel_subtasks finished: 1/3 children completed.")
			expect(text).toContain("- api: completed. Report: /reports/parent-1/api-c1.md")
			expect(text).toContain("Summary: # API")
			expect(text).toContain("- tests: failed (out of tokens)")
			expect(text).toContain("- docs: aborted (cancelled)")
			expect(text).toContain("read_file")
		})

		it("includes the one-line report summary in the payload for the parent model", async () => {
			const handles = [makeHandle("c1", "api")]
			spawnedHandles(...handles)
			handles[0].settle({ status: "completed", result: "# Findings\n- first\n- second" })

			await parallelSubtasksTool.handle(
				task,
				makeBlock([{ label: "api", mode: "code", message: "m1" }]),
				makeCallbacks(),
			)

			const text = pushToolResult.mock.calls[0][0] as string
			expect(text).toContain("- api: completed. Report: /reports/parent-1/api-c1.md. Summary: # Findings")
			// Only the first line ships to the parent; the full report stays on disk.
			expect(text).not.toContain("- first")
		})

		it("does not count a failed admitted spec as a start in the dropped row", async () => {
			// Seven specs pass the tool ceiling; the host cap considers six. One
			// of the six has an unknown mode, so the host returns a handle that
			// is already settled as failed instead of a live child.
			const handles = Array.from({ length: 6 }, (_value, index) =>
				makeHandle(`c${index}`, `investigation-${index}`),
			)
			handles[1].settle({ status: "failed", error: "Unknown mode: bogus" })
			spawnedHandles(...handles)
			handles.forEach((handle, index) => {
				if (index !== 1) {
					handle.settle({ status: "completed", result: `# ${handle.label}` })
				}
			})

			const tasks = Array.from({ length: 7 }, (_value, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))
			await parallelSubtasksTool.handle(task, makeBlock(tasks), makeCallbacks())

			const text = pushToolResult.mock.calls[0][0] as string
			expect(text).toContain("Dropped: the request exceeded the per-call limit (6 of 7 specs considered)")
			expect(text).not.toContain("6 of 7 started")
		})

		it("keeps the documented drop semantics for a batch above the fan-out but under the ceiling", async () => {
			const handles = Array.from({ length: 6 }, (_value, index) =>
				makeHandle(`c${index}`, `investigation-${index}`),
			)
			spawnedHandles(...handles)
			handles.forEach((handle) => handle.settle({ status: "completed", result: `# ${handle.label}` }))

			const tasks = Array.from({ length: 7 }, (_value, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))
			await parallelSubtasksTool.handle(task, makeBlock(tasks), makeCallbacks())

			const specs = providerDouble.spawnBackgroundChildren.mock.calls[0][1]
			expect(specs).toHaveLength(7)

			const final = JSON.parse(panelMessages().at(-1)?.text ?? "{}") as {
				subtasks: Array<{ taskId: string; status: string; error?: string }>
			}
			expect(final.subtasks).toHaveLength(7)
			expect(final.subtasks.at(-1)).toMatchObject({
				taskId: "dropped-0",
				status: "failed",
				error: "Dropped: the request exceeded the per-call limit (6 of 7 specs considered)",
			})

			const text = pushToolResult.mock.calls[0][0] as string
			expect(text).toContain("parallel_subtasks finished: 6/7 children completed.")
			expect(text).toContain("Dropped: the request exceeded the per-call limit (6 of 7 specs considered)")
		})
	})

	describe("report saving", () => {
		it("writes one report per completed child with the host-side coordinates", async () => {
			const handles = [makeHandle("c1", "api"), makeHandle("c2", "tests")]
			spawnedHandles(...handles)
			handles[0].settle({ status: "completed", result: "# API\nfindings" })
			handles[1].settle({ status: "failed", error: "nope" })

			await parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "api", mode: "code", message: "m1" },
					{ label: "tests", mode: "debug", message: "m2" },
				]),
				makeCallbacks(),
			)

			expect(writeSubtaskReportMock).toHaveBeenCalledTimes(1)
			expect(writeSubtaskReportMock).toHaveBeenCalledWith({
				cwd: "/workspace",
				parentTaskId: "parent-1",
				childTaskId: "c1",
				label: "api",
				markdown: "# API\nfindings",
			})
		})

		it("marks only the affected child failed when a report write fails", async () => {
			writeSubtaskReportMock.mockRejectedValueOnce(new Error("disk full"))
			const handles = [makeHandle("c1", "api"), makeHandle("c2", "tests")]
			spawnedHandles(...handles)
			handles[0].settle({ status: "completed", result: "# API" })
			handles[1].settle({ status: "completed", result: "# Tests" })

			await parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "api", mode: "code", message: "m1" },
					{ label: "tests", mode: "code", message: "m2" },
				]),
				makeCallbacks(),
			)

			const final = JSON.parse(panelMessages().at(-1)?.text ?? "{}") as {
				subtasks: Array<{ label: string; status: string; error?: string; reportPath?: string }>
			}
			const byLabel = new Map(final.subtasks.map((subtask) => [subtask.label, subtask]))
			expect(byLabel.get("api")).toMatchObject({ status: "failed", error: "Report write failed: disk full" })
			expect(byLabel.get("tests")).toMatchObject({
				status: "completed",
				reportPath: "/reports/parent-1/tests-c2.md",
			})

			expect(pushToolResult).toHaveBeenCalledTimes(1)
			const text = pushToolResult.mock.calls[0][0] as string
			expect(text).toContain("- api: failed (Report write failed: disk full)")
			expect(text).toContain("- tests: completed. Report: /reports/parent-1/tests-c2.md")
		})
	})

	describe("abort cascade", () => {
		it("aborts the children when the parent is aborted and never pushes a success result", async () => {
			const handles = [makeHandle("c1", "one"), makeHandle("c2", "two")]
			spawnedHandles(...handles)

			const executePromise = parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "one", mode: "code", message: "m1" },
					{ label: "two", mode: "code", message: "m2" },
				]),
				makeCallbacks(),
			)

			// Let the spawn and the initial row land, then cancel the parent.
			await Promise.resolve()
			await Promise.resolve()
			const listener = taskDouble.once.mock.calls.find((call) => call[0] === RooCodeEventName.TaskAborted)?.[1]
			expect(listener).toBeTypeOf("function")
			taskDouble.abort = true
			listener?.()

			expect(providerDouble.abortBackgroundChildren).toHaveBeenCalledWith("parent-1")

			// The cascade settles each handle; the join still resolves.
			handles[0].settle({ status: "aborted", error: "Parent task was cancelled" })
			handles[1].settle({ status: "aborted", error: "Parent task was cancelled" })
			await executePromise

			expect(pushToolResult).not.toHaveBeenCalled()
			expect(handleError).toHaveBeenCalledTimes(1)
			expect(taskDouble.off).toHaveBeenCalledWith(RooCodeEventName.TaskAborted, listener)
		})
	})

	describe("tool failure", () => {
		it("aborts still-pending children when the tool fails after spawn", async () => {
			const handles = [makeHandle("c1", "one"), makeHandle("c2", "two")]
			// Keep the parent alive through admission; the failure must come from
			// the first row post after the host already admitted live children.
			providerDouble.spawnBackgroundChildren.mockImplementation(async () => {
				taskDouble.abort = true
				return { children: handles, started: true }
			})
			// The abort cascade is what settles the children the tool is awaiting.
			providerDouble.abortBackgroundChildren.mockImplementation(async () => {
				handles.forEach((handle) => handle.settle({ status: "aborted", error: "Parent task was cancelled" }))
			})
			const terminal = handles.map((handle) => handle.done)

			await parallelSubtasksTool.handle(
				task,
				makeBlock([
					{ label: "one", mode: "code", message: "m1" },
					{ label: "two", mode: "code", message: "m2" },
				]),
				makeCallbacks(),
			)

			expect(providerDouble.abortBackgroundChildren).toHaveBeenCalledWith("parent-1")
			expect(handleError).toHaveBeenCalledTimes(1)
			expect(pushToolResult).not.toHaveBeenCalled()
			await expect(Promise.all(terminal)).resolves.toEqual([
				expect.objectContaining({ taskId: "c1", status: "aborted", error: "Parent task was cancelled" }),
				expect.objectContaining({ taskId: "c2", status: "aborted", error: "Parent task was cancelled" }),
			])
		})
	})

	describe("handlePartial", () => {
		it.each([
			["a JSON string", JSON.stringify([{ label: "api", mode: "code", message: "Map it" }])],
			["an already-parsed array", [{ label: "api", mode: "code", message: "Map it" }]],
		])("posts a partial ask row for %s", async (_case, tasks) => {
			const block = {
				type: "tool_use",
				name: "parallel_subtasks",
				params: { tasks: typeof tasks === "string" ? tasks : undefined },
				nativeArgs: typeof tasks === "string" ? undefined : { tasks },
				partial: true,
			} as unknown as ToolUse<"parallel_subtasks">

			await parallelSubtasksTool.handle(task, block, makeCallbacks())

			expect(taskDouble.ask).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({
					tool: "parallelSubtasks",
					tasks: [{ label: "api", mode: "code", message: "Map it" }],
				}),
				true,
			)
		})

		it("bounds the streamed preview to the ceiling plus one", async () => {
			const tasks = Array.from({ length: MAX_REQUESTED_PARALLEL_SUBTASKS + 100 }, (_value, index) => ({
				label: `investigation-${index}`,
				mode: "code",
				message: `Investigation ${index}.`,
			}))
			const block = {
				type: "tool_use",
				name: "parallel_subtasks",
				params: { tasks: JSON.stringify(tasks) },
				nativeArgs: undefined,
				partial: true,
			} as unknown as ToolUse<"parallel_subtasks">

			await parallelSubtasksTool.handle(task, block, makeCallbacks())

			const payload = JSON.parse(taskDouble.ask.mock.calls[0][1] ?? "{}") as { tasks: unknown[] }
			expect(payload.tasks).toHaveLength(MAX_REQUESTED_PARALLEL_SUBTASKS + 1)
		})

		it("prefers the parser's bounded list over the raw streamed params", async () => {
			const nativeTasks = [{ label: "bounded", mode: "code", message: "from nativeArgs" }]
			const block = {
				type: "tool_use",
				name: "parallel_subtasks",
				params: { tasks: JSON.stringify([{ label: "raw", mode: "code", message: "from params" }]) },
				nativeArgs: { tasks: nativeTasks },
				partial: true,
			} as unknown as ToolUse<"parallel_subtasks">

			await parallelSubtasksTool.handle(task, block, makeCallbacks())

			expect(taskDouble.ask).toHaveBeenCalledWith(
				"tool",
				JSON.stringify({ tool: "parallelSubtasks", tasks: nativeTasks }),
				true,
			)
		})
	})
})
