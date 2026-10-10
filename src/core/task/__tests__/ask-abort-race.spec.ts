import type { ClineMessage } from "@roo-code/types"

import { checkAutoApproval } from "../../auto-approval"
import { MessageQueueService } from "../../message-queue/MessageQueueService"
import { Task } from "../Task"

vi.mock("../../auto-approval", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../auto-approval")>()
	return { ...actual, checkAutoApproval: vi.fn(actual.checkAutoApproval) }
})

function buildTask(getState: () => Promise<Record<string, unknown>>) {
	const task = Object.create(Task.prototype) as Task
	task["abort"] = false
	task["clineMessages"] = []
	task["lastMessageTs"] = undefined
	task["addToClineMessages"] = vi.fn(async () => true)
	task["saveClineMessages"] = vi.fn(async () => true)
	task["updateClineMessage"] = vi.fn(async () => {})
	// Double assertion: `providerRef` is a `WeakRef<ClineProvider>`; `Task.ask` only calls `deref()` and `getState()`.
	task["providerRef"] = { deref: () => ({ getState }) } as unknown as Task["providerRef"]
	Object.defineProperty(task, "messageQueueService", { value: new MessageQueueService() })
	return task
}

function deferred() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => {
		release = resolve
	})
	return { promise, release }
}

describe("Task.ask abort during the auto-approval await", () => {
	it.each([
		["complete", false],
		["undefined", undefined],
		["partial", true],
	] as const)("does not add an ask row when aborted mid-await (partial=%s)", async (_label, partial) => {
		const gate = deferred()
		const task = buildTask(async () => {
			await gate.promise
			return { autoApprovalEnabled: true, alwaysAllowReadOnly: true }
		})

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), partial)
		task["abort"] = true
		gate.release()

		await expect(askPromise).rejects.toThrow(/aborted/)
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		expect(task["lastMessageTs"]).toBeUndefined()
	})

	it("does not add an ask row when aborted while checkAutoApproval is pending", async () => {
		const gate = deferred()
		vi.mocked(checkAutoApproval).mockImplementationOnce(async () => {
			await gate.promise
			return { decision: "ask" }
		})
		const task = buildTask(async () => ({}))

		const askPromise = task.ask("tool", JSON.stringify({ tool: "readFile" }), false)
		await vi.waitFor(() => expect(checkAutoApproval).toHaveBeenCalled())
		task["abort"] = true
		gate.release()

		await expect(askPromise).rejects.toThrow(/aborted/)
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		expect(task["lastMessageTs"]).toBeUndefined()
	})

	it.each([
		["partial update", true],
		["partial completion", false],
	] as const)("leaves an existing partial row untouched on %s when aborted mid-await", async (_label, partial) => {
		const gate = deferred()
		const task = buildTask(async () => {
			await gate.promise
			return {}
		})
		const original: ClineMessage = { ts: 1, type: "ask", ask: "followup", text: "old", partial: true }
		task["clineMessages"] = [{ ...original }]

		const askPromise = task.ask("followup", "new", partial)
		task["abort"] = true
		gate.release()

		await expect(askPromise).rejects.toThrow(/aborted/)
		expect(task["clineMessages"]).toEqual([original])
		expect(task["saveClineMessages"]).not.toHaveBeenCalled()
		expect(task["updateClineMessage"]).not.toHaveBeenCalled()
		expect(task["lastMessageTs"]).toBeUndefined()
	})

	it("releases the claimed queued message when aborted mid-await", async () => {
		const gate = deferred()
		const task = buildTask(async () => {
			await gate.promise
			return {}
		})
		task.messageQueueService.addMessage("queued feedback")

		const askPromise = task.ask("followup", "Q?", false)
		task["abort"] = true
		gate.release()

		await expect(askPromise).rejects.toThrow(/aborted/)
		expect(task["addToClineMessages"]).not.toHaveBeenCalled()
		expect(task.messageQueueService.claimNextMessage()?.text).toBe("queued feedback")
	})
})
